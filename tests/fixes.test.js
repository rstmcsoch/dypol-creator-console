/**
 * Regression tests for the 30 Oct 2026 console fixes (audit bugs 1–17).
 * Run: node --test tests/fixes.test.js
 *
 * A fake GitHub API (global fetch stub) + the SQLite-backed D1 shim drive the
 * REAL Pages Functions. Covers: dypol-integration ref on every contents/runs
 * call, exact-path result reads, publish-run webhook → published / failed,
 * stale reconcile, daily-cap window, return_run_details + run row before
 * dispatch, undeclared-input stripping, regenerate/retry/reject/approve,
 * fallback guard, failure categories + log tail, IP privacy, token health.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const gh = await import(`${ROOT}functions/api/_lib/github.js`);
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const sg = await import(`${ROOT}functions/api/_lib/safeguards.js`);
const flow = await import(`${ROOT}functions/api/_lib/jobflow.js`);
const fb = await import(`${ROOT}functions/api/_lib/fallback.js`);
const { onRequestPost: webhookPost } = await import(`${ROOT}functions/api/webhooks/github.js`);
const { onRequestPost: syncPost } = await import(`${ROOT}functions/api/sync/github.js`);
const { onRequestPost: publishPost } = await import(`${ROOT}functions/api/jobs/[id]/publish.js`);
const { onRequestPost: approvePost } = await import(`${ROOT}functions/api/jobs/[id]/approve.js`);
const { onRequestPost: rejectPost } = await import(`${ROOT}functions/api/jobs/[id]/reject.js`);
const { onRequestPost: regenPost } = await import(`${ROOT}functions/api/jobs/[id]/regenerate.js`);
const { onRequestPost: retryPost } = await import(`${ROOT}functions/api/jobs/[id]/retry.js`);
const { onRequestPost: runPost } = await import(`${ROOT}functions/api/engines/[engine]/run.js`);
const { onRequestPost: schedulePost } = await import(`${ROOT}functions/api/schedule.js`);
const { onRequestPost: loginPost } = await import(`${ROOT}functions/api/auth/login.js`);
const settingsApi = await import(`${ROOT}functions/api/settings.js`);
const { onRequestGet: jobsGet } = await import(`${ROOT}functions/api/jobs/index.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const SECRET = 'whsec-test';
const iso = (offSec = 0) => new Date(Date.now() + offSec * 1000).toISOString();
const b64 = (s) => Buffer.from(s).toString('base64');

/* ---------------- fake GitHub ---------------- */
let calls, routes, realFetch;
function mockGitHub() {
  calls = [];
  routes = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match(u)) {
        const out = typeof r.res === 'function' ? await r.res(u, opts) : r.res;
        if (out instanceof Response) return out;
        const { status = 200, body = null, headers = {} } = out;
        return new Response(body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
          { status, headers });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
}
const route = (method, match, res) => routes.push({ method, match: typeof match === 'string' ? (u) => u.includes(match) : match instanceof RegExp ? (u) => match.test(u) : match, res });
const contentsFile = (obj) => ({ body: { type: 'file', content: b64(typeof obj === 'string' ? obj : JSON.stringify(obj)) } });

const WORKFLOW_A = `name: Main
on:
  workflow_dispatch:
    inputs:
      phase:
        type: string
      topic:
        type: string
      privacy:
        type: string
      job_id:
        type: string
      draft_run_id:
        type: string
      title_override:
        type: string
      description_override:
        type: string
      review_required:
        type: string
      auto_publish:
        type: string
      language:
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
`;

async function makeEnv({ token = true } = {}) {
  wh._resetSchemaCache();
  gh._resetInputsCache();
  settingsApi._resetTokenCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false },
  });
  return { DB, GITHUB_TOKEN: token ? 'ghp_test' : undefined, GITHUB_WEBHOOK_SECRET: SECRET, SESSION_SECRET: 's3cret', __noRetryWait: true };
}

async function addJob(env, over = {}) {
  const j = {
    id: over.id || `job-${Math.random().toString(36).slice(2, 8)}`, engine: 'gemini', title: over.title || `Topic ${Math.random()}`,
    topic: 'x', niche: 'tech', format: 'long-form', status: 'needs-review', stage: '', progress: null,
    description: 'd', tags: ['a'], createdAt: iso(-3600), updatedAt: iso(-3600), quality: {}, logs: [], runId: null, ...over,
  };
  await dbm.insertJob(env.DB, j);
  const extra = {};
  for (const k of ['publishRunId', 'uploadingSince', 'videos', 'reviewNote']) if (over[k] !== undefined) extra[k] = over[k];
  if (over.updatedAt) {
    if (Object.keys(extra).length) await dbm.updateJob(env.DB, j.id, extra);
    env.DB._raw.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(over.updatedAt, j.id);
  } else if (Object.keys(extra).length) await dbm.updateJob(env.DB, j.id, extra);
  return dbm.getJob(env.DB, j.id);
}

const ctx = (env, params = {}, body = {}, url = 'https://c.pages.dev/api/x') => ({
  env, params, request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(body) }),
});
const getCtx = (env, url) => ({ env, params: {}, request: new Request(url) });

async function deliver(env, event, payload) {
  const body = JSON.stringify(payload);
  const req = new Request('https://c.pages.dev/api/webhooks/github', {
    method: 'POST',
    headers: {
      'X-GitHub-Event': event, 'X-GitHub-Delivery': `d-${Math.random()}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  const res = await webhookPost({ request: req, env });
  return { status: res.status, data: await res.json() };
}
const wr = (id, over = {}) => ({
  action: over.status === 'completed' ? 'completed' : 'in_progress',
  repository: { full_name: over.repo || A },
  workflow_run: {
    id, name: 'Main', display_title: 'Main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    html_url: `https://github.com/${A}/actions/runs/${id}`, created_at: iso(-120), run_started_at: iso(-120),
    updated_at: iso(-5), path: '.github/workflows/main.yml', ...over,
  },
});

const RESULT_A = (jobId, runId) => ({
  job_id: jobId, run_id: String(runId), status: 'uploaded', visibility: 'unlisted',
  videos: [
    { kind: 'long', youtube_id: 'LONG123abcd', youtube_url: 'https://youtu.be/LONG123abcd' },
    { kind: 'short', youtube_id: 'SHORT12abcd', youtube_url: 'https://youtu.be/SHORT12abcd' },
  ],
  youtube_id: 'LONG123abcd', youtube_url: 'https://youtu.be/LONG123abcd', video_count: 2,
});

beforeEach(() => mockGitHub());
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------------- P0-1: branch everywhere ---------------- */

test('P0-1: contents reads/writes and run listings always target dypol-integration', async () => {
  route('GET', '/contents/', contentsFile({ ok: 1 }));
  route('PUT', '/contents/', { status: 200, body: {} });
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [] } });
  const t = 'tok', o = { owner: 'o', repo: 'r' };
  await gh.fetchRepoFile(t, { ...o, path: 'x.json' });
  await gh.listRepoDir(t, { ...o, path: 'dypol-results' });
  await gh.fetchRepoFile(t, { ...o, path: 'x.json', ref: 'main' }); // forbidden → forced
  await gh.updateRepoFile(t, { ...o, path: 'dypol-control.json', content: '{}' });
  await gh.listWorkflowRuns(t, { ...o, workflowFile: 'main.yml' });
  const reads = calls.filter((c) => c.method === 'GET');
  assert.ok(reads.every((c) => /[?&](ref|branch)=dypol-integration/.test(c.url)), reads.map((c) => c.url).join('\n'));
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.branch, 'dypol-integration');
  assert.equal(gh.integrationRef({ github: { branch: 'main' } }), 'dypol-integration');
  assert.equal(gh.integrationRef(''), 'dypol-integration');
});

test('P0-1: Pause/Resume writes dypol-control.json to dypol-integration, never main', async () => {
  const env = await makeEnv();
  route('GET', '/contents/dypol-control.json', { body: { sha: 'abc', type: 'file', content: b64('{}') } });
  route('PUT', '/contents/dypol-control.json', { body: {} });
  const res = await schedulePost(ctx(env, {}, { automationPaused: true }));
  assert.equal(res.status, 200);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.ok(puts.every((p) => p.body.branch === 'dypol-integration'));
  assert.ok(calls.filter((c) => c.method === 'GET').every((c) => c.url.includes('ref=dypol-integration')));
});

test('P0-1: results are read by exact path dypol-results/<run_id>.json (no directory listing)', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'uploading', publishRunId: '555', uploadingSince: Date.now() - 60e3 });
  route('GET', '/contents/dypol-results/555.json?ref=dypol-integration', contentsFile(RESULT_A(job.id, 555)));
  const ev = await sg.findUploadEvidence('t', { owner: 'rstmcsoch', repo: 'gemini-youtube-automation' }, job);
  assert.equal(ev.youtube_id, 'LONG123abcd');
  assert.ok(!calls.some((c) => /contents\/dypol-results(\?|$)/.test(c.url)), 'never lists the directory');
});

/* ---------------- P0-2: publish run → published / publish_failed ---------------- */

test('P0-2: webhook publish run completed → published with long + Short links, cap counts it', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'uploading', runId: '100', publishRunId: '200', uploadingSince: Date.now() - 90e3 });
  await dbm.insertRun(env.DB, { id: 'run-pub', runId: '200', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'publish', startedAt: iso(-90), status: 'in-progress', steps: [], logs: [], artifacts: [] });
  route('GET', '/contents/dypol-results/200.json?ref=dypol-integration', contentsFile(RESULT_A(job.id, 200)));
  const r = await deliver(env, 'workflow_run', wr(200, { updated_at: iso(-2) }));
  assert.equal(r.status, 200);
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'published');
  assert.equal(j.youtubeId, 'LONG123abcd');
  assert.deepEqual(j.videos.map((v) => v.kind), ['long', 'short']);
  assert.equal(j.videos[1].youtube_url, 'https://youtu.be/SHORT12abcd');
  assert.equal(j.runId, '100', 'draft run id kept for preview');
  assert.equal((await dbm.capUsage(env.DB)).total, 1);
});

test('P0-2: webhook publish run failure → publish_failed with category + log tail, and NO fallback', async () => {
  const env = await makeEnv();
  await dbm.saveSettings(env.DB, { orchestration: { mode: 'primary_with_fallback', fallback: 'on_failure' } });
  const job = await addJob(env, { status: 'uploading', runId: '100', publishRunId: '201', uploadingSince: Date.now() - 60e3 });
  await dbm.insertRun(env.DB, { id: 'run-pub2', runId: '201', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'publish', startedAt: iso(-60), status: 'in-progress', steps: [], logs: [], artifacts: [] });
  route('GET', '/actions/runs/201/jobs', { body: { jobs: [{ id: 77, name: 'publish', status: 'completed', conclusion: 'failure', steps: [{ name: 'Upload to YouTube', status: 'completed', conclusion: 'failure' }] }] } });
  route('GET', '/actions/jobs/77/logs', { status: 302, headers: { Location: 'https://blob.example/log.txt' } });
  route('GET', 'blob.example/log.txt', { body: '2026-10-30T10:00:00.0000000Z starting\n2026-10-30T10:00:01.0000000Z googleapiclient.errors.HttpError: quotaExceeded\n' });
  await deliver(env, 'workflow_run', wr(201, { conclusion: 'failure' }));
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'publish_failed');
  assert.equal(j.errorCategory, 'publish');
  assert.match(j.error, /YouTube upload failed/);
  assert.match(j.errorLog, /quotaExceeded/);
  assert.ok(!j.errorLog.includes('2026-10-30T'), 'timestamps stripped');
  const logCall = calls.find((c) => c.url.includes('blob.example'));
  assert.ok(logCall, 'followed the log redirect');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('/dispatches')), 'no fallback after a publish failure');
  assert.equal((await dbm.capUsage(env.DB)).total, 0, 'failed upload frees the cap');
});

test('P0-2: draft-run events never touch an uploading job', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'uploading', runId: '300', publishRunId: '301', uploadingSince: Date.now() });
  await dbm.insertRun(env.DB, { id: 'run-d', runId: '300', engine: 'gemini', workflow: 'main.yml', jobId: job.id, startedAt: iso(-900), status: 'completed', steps: [], logs: [], artifacts: [] });
  await deliver(env, 'workflow_run', wr(300, { conclusion: 'failure' }));
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'uploading');
});

test('P0-2: reconcile — legacy uploading job (no publish run id) found via exact-path candidates, published at run time', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'uploading', runId: '400', createdAt: iso(-90000), updatedAt: iso(-86000) });
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [
    { id: 402, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(-85000), updated_at: iso(-84900), display_title: 'Main' },
    { id: 401, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(-86000), updated_at: iso(-85900), display_title: 'Main' },
    { id: 400, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(-89000), updated_at: iso(-88000), display_title: 'Main' },
  ] } });
  route('GET', '/contents/dypol-results/402.json', contentsFile({ job_id: 'job-other', youtube_id: 'zzz' }));
  route('GET', '/contents/dypol-results/401.json', contentsFile(RESULT_A(job.id, 401)));
  route('GET', '/actions/runs/401', { body: { id: 401, status: 'completed', conclusion: 'success', created_at: iso(-86000), updated_at: '2026-10-29T14:02:00Z', html_url: 'h', path: '.github/workflows/main.yml' } });
  const out = await flow.reconcileJobs(env.DB, env, await dbm.getSettings(env.DB), { force: true });
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'published', JSON.stringify(out));
  assert.equal(j.publishRunId, '401');
  assert.equal(j.publishedAt, '2026-10-29T14:02:00Z', 'published_at = run completion, not now');
  assert.ok(!calls.some((c) => c.url.includes('dypol-results/400.json')), 'draft run of the job is not a candidate');
  assert.equal((await dbm.capUsage(env.DB)).total, 0, 'yesterday’s upload does not hold today’s cap');
});

test('P0-2: reconcile — stuck dispatched job with a succeeded run → needs review; uploading >10 min with failed run → publish_failed', async () => {
  const env = await makeEnv();
  const t0 = iso(-90000);
  const d = await addJob(env, { status: 'dispatched', createdAt: t0, updatedAt: t0 });
  await dbm.insertRun(env.DB, { id: 'run-local-d', runId: null, engine: 'gemini', workflow: 'main.yml', jobId: d.id, startedAt: t0, status: 'in-progress', steps: [], logs: [], artifacts: [] });
  const u = await addJob(env, { status: 'uploading', runId: '10', publishRunId: '611', uploadingSince: Date.now() - 11 * 60e3 });
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [
    { id: 610, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: new Date(Date.parse(t0) + 20e3).toISOString(), updated_at: iso(-89000) },
  ] } });
  route('GET', '/actions/runs/610/jobs', { body: { jobs: [] } });
  route('GET', /\/actions\/runs\/610$/, { body: { id: 610, status: 'completed', conclusion: 'success', created_at: t0, updated_at: iso(-89000), html_url: 'h610' } });
  route('GET', '/actions/runs/611/jobs', { body: { jobs: [] } });
  route('GET', /\/actions\/runs\/611$/, { body: { id: 611, status: 'completed', conclusion: 'cancelled', created_at: iso(-700), updated_at: iso(-600), html_url: 'h611' } });
  await flow.reconcileJobs(env.DB, env, await dbm.getSettings(env.DB), { force: true });
  const dj = await dbm.getJob(env.DB, d.id);
  assert.equal(dj.status, 'needs-review');
  assert.equal(dj.runId, '610');
  const row = env.DB._raw.prepare("SELECT run_id, status FROM runs WHERE id = 'run-local-d'").get();
  assert.equal(row.run_id, '610');
  assert.equal(row.status, 'completed');
  const uj = await dbm.getJob(env.DB, u.id);
  assert.equal(uj.status, 'publish_failed');
});

test('P0-2: reconcile is throttled for list loads, forced for Sync; never dispatches', async () => {
  const env = await makeEnv();
  route('GET', '/actions/workflows/', { body: { workflow_runs: [] } });
  const s = await dbm.getSettings(env.DB);
  const first = await flow.reconcileJobs(env.DB, env, s);
  const second = await flow.reconcileJobs(env.DB, env, s);
  assert.equal(first.skipped, undefined);
  assert.equal(second.skipped, 'throttled');
  const forced = await flow.reconcileJobs(env.DB, env, s, { force: true });
  assert.equal(forced.skipped, undefined);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

/* ---------------- P0-3: daily cap ---------------- */

test('P0-3: daily cap = published since 00:00 UTC + uploading within 6 h', async () => {
  const env = await makeEnv();
  const now = Date.now();
  await addJob(env, { status: 'published', publishedAt: new Date(now - 30 * 3600e3).toISOString() }); // yesterday
  await addJob(env, { status: 'uploading', uploadingSince: now - 7 * 3600e3 }); // stale
  await addJob(env, { status: 'uploading', updatedAt: new Date(now).toISOString() }); // legacy row: no uploading_since
  let u = await dbm.capUsage(env.DB, now);
  assert.equal(u.total, 0);
  await addJob(env, { status: 'uploading', uploadingSince: now - 3600e3 });
  await addJob(env, { status: 'published', publishedAt: new Date(Math.max(Date.parse(dbm.utcDayStartIso(now)) + 1000, now - 1000)).toISOString() });
  u = await dbm.capUsage(env.DB, now);
  assert.equal(u.published, 1);
  assert.equal(u.uploading, 1);
  const j = await addJob(env, { status: 'approved' });
  const gate = await sg.checkPublishGate(env.DB, j, await dbm.getSettings(env.DB));
  assert.equal(gate.code, 'daily-cap');
});

/* ---------------- P1: dispatch helper ---------------- */

test('P1: dispatch uses return_run_details, inserts the run row BEFORE dispatch, stores the run id; strips undeclared inputs', async () => {
  const env = await makeEnv();
  route('GET', '/contents/.github/workflows/main.yml', contentsFile(WORKFLOW_A));
  let rowAtDispatch = null;
  route('POST', '/actions/workflows/main.yml/dispatches', async (u, opts) => {
    rowAtDispatch = env.DB._raw.prepare('SELECT * FROM runs').all();
    return { status: 200, body: { workflow_run_id: 9911, html_url: 'https://github.com/x/actions/runs/9911' } };
  });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Brand new topic about quantum dots', phase: 'draft' }));
  const data = await res.json();
  assert.equal(res.status, 202, JSON.stringify(data));
  assert.equal(rowAtDispatch.length, 1, 'run row existed when the dispatch went out');
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.equal(d.body.return_run_details, true);
  assert.equal(d.body.ref, 'dypol-integration');
  assert.ok(!('niche' in d.body.inputs) && !('context' in d.body.inputs));
  const job = await dbm.getJob(env.DB, data.jobId);
  assert.equal(job.runId, '9911');
  const run = env.DB._raw.prepare('SELECT * FROM runs WHERE job_id = ?').get(data.jobId);
  assert.equal(run.run_id, '9911');
  assert.equal(run.phase, 'draft');
});

test('P1: dispatch falls back gracefully when GitHub returns 204 (no run details)', async () => {
  const env = await makeEnv();
  route('POST', '/dispatches', { status: 204, body: null });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Another unique topic: tidal energy' }));
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal((await dbm.getJob(env.DB, data.jobId)).runId, null);
  assert.ok(env.DB._raw.prepare('SELECT * FROM runs WHERE job_id = ?').get(data.jobId));
});

test('P1: filterInputs / parseDispatchInputs', () => {
  assert.deepEqual(gh.parseDispatchInputs(WORKFLOW_A).slice(0, 3), ['phase', 'topic', 'privacy']);
  const { inputs, stripped } = gh.filterInputs({ phase: 'draft', fallback_of: 'x', tags_override: 'a,b' }, gh.STATIC_WORKFLOW_INPUTS['main.yml']);
  assert.deepEqual(inputs, { phase: 'draft' });
  assert.deepEqual(stripped.sort(), ['fallback_of', 'tags_override']);
});

test('P1: publish dispatch stores publish_run_id + uploading_since and keeps the draft run id', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'approved', runId: '700' });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 701 } });
  const res = await publishPost(ctx(env, { id: job.id }));
  assert.equal(res.status, 202);
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'uploading');
  assert.equal(j.runId, '700');
  assert.equal(j.publishRunId, '701');
  assert.ok(j.uploadingSince > Date.now() - 10e3);
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.equal(d.body.inputs.draft_run_id, '700');
  assert.equal(d.body.inputs.privacy, 'unlisted');
  assert.ok(!('tags_override' in d.body.inputs), 'Engine A does not declare tags_override');
});

test('P1: approve is one tap = approve + publish dispatch; blocked publish keeps it approved', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'needs-review', runId: '800' });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 801 } });
  const res = await approvePost(ctx(env, { id: job.id }));
  assert.equal(res.status, 202);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'uploading');

  await dbm.saveSettings(env.DB, { publishing: { dailyCap: 1 } });
  const j2 = await addJob(env, { status: 'needs-review', runId: '802' });
  const r2 = await approvePost(ctx(env, { id: j2.id }));
  const b2 = await r2.json();
  assert.equal(b2.published, false);
  assert.equal(b2.code, 'daily-cap');
  assert.equal((await dbm.getJob(env.DB, j2.id)).status, 'approved');
});

test('P1: regenerate goes through the helper (run row + run id) and handles reviewer feedback', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'needs-review', runId: '900' });
  const rej0 = await rejectPost(ctx(env, { id: job.id }, {}));
  assert.equal(rej0.status, 400, 'reason required');
  const rej = await rejectPost(ctx(env, { id: job.id }, { reason: 'Too much stock footage of crowds' }));
  assert.equal(rej.status, 200);
  assert.equal((await dbm.getJob(env.DB, job.id)).reviewNote, 'Too much stock footage of crowds');

  // A workflow WITHOUT a reviewer_feedback input: feedback is kept, not sent.
  let workflowYaml = WORKFLOW_A;
  gh._resetInputsCache();
  route('GET', '/contents/.github/workflows/main.yml', () => contentsFile(workflowYaml));
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 901 } });
  const res = await regenPost(ctx(env, { id: job.id }));
  const data = await res.json();
  assert.equal(res.status, 202);
  assert.equal(data.feedbackSent, false, 'this main.yml has no reviewer_feedback input');
  const child = await dbm.getJob(env.DB, data.jobId);
  assert.equal(child.runId, '901');
  assert.match(child.reviewNote, /crowds/);
  assert.ok(env.DB._raw.prepare('SELECT * FROM runs WHERE job_id = ? AND run_id = ?').get(child.id, '901'));
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.ok(!('reviewer_feedback' in d.body.inputs));

  // When the workflow declares reviewer_feedback, it is sent (capped).
  gh._resetInputsCache();
  workflowYaml = WORKFLOW_A.replace('      language:\n', '      reviewer_feedback:\n        type: string\n      language:\n');
  const job2 = await addJob(env, { status: 'rejected', reviewNote: 'x'.repeat(3000), title: 'Different title for regen 2' });
  const res2 = await regenPost(ctx(env, { id: job2.id }));
  assert.equal((await res2.json()).feedbackSent, true);
  const d2 = calls.filter((c) => c.url.includes('/dispatches')).pop();
  assert.equal(d2.body.inputs.reviewer_feedback.length, 1500);
});

test('P1: reject is refused while uploading', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'uploading' });
  const res = await rejectPost(ctx(env, { id: job.id }, { reason: 'nope nope' }));
  assert.equal(res.status, 409);
});

test('P1 (round 3): drawer Retry is a FRESH dispatch on dypol-integration linked to the same job (never rerun)', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'failed', runId: '1200' });
  await dbm.insertRun(env.DB, { id: 'run-local-x', runId: '1200', engine: 'gemini', workflow: 'main.yml', jobId: job.id, startedAt: iso(-600), status: 'failed', steps: [], logs: [], artifacts: [] });
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 200, body: { workflow_run_id: 1201 } });
  const res = await retryPost(ctx(env, { id: job.id }));
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  assert.ok(!calls.some((c) => c.url.includes('rerun')), 'never re-runs the old commit');
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.equal(d.body.ref, 'dypol-integration');
  assert.equal(d.body.inputs.job_id, job.id);
  const fresh = await dbm.getJob(env.DB, job.id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.runId, '1201');
  assert.equal(fresh.retryCount, 1);
});

test('P1: fallback strips undeclared inputs, creates its own job, never fires on old history or publish runs', async () => {
  const env = await makeEnv();
  const settings = { ...(await dbm.getSettings(env.DB)), orchestration: { mode: 'primary_with_fallback', fallback: 'on_failure' } };
  const job = await addJob(env, { status: 'failed', title: 'Fallback topic unique 123', runId: '1300' });
  const local = { id: 'r', runId: '1300', jobId: job.id, phase: 'draft' };
  assert.equal(await fb.maybeDispatchFallback({ db: env.DB, env, settings, engine: 'gemini', local, completedAt: iso(-3 * 3600) }), null, 'old failure');
  assert.equal(await fb.maybeDispatchFallback({ db: env.DB, env, settings, engine: 'gemini', local: { ...local, phase: 'publish' }, completedAt: iso(-10) }), null, 'publish run');
  route('POST', '/actions/workflows/verticals.yml/dispatches', { status: 200, body: { workflow_run_id: 1301 } });
  const out = await fb.maybeDispatchFallback({ db: env.DB, env, settings, engine: 'gemini', local, completedAt: iso(-10) });
  assert.equal(out.dispatched, true);
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.ok(!('fallback_of' in d.body.inputs));
  assert.notEqual(d.body.inputs.job_id, job.id);
  const child = await dbm.getJob(env.DB, out.jobId);
  assert.equal(child.engine, 'verticals');
  assert.equal(child.parentJobId, job.id);
  assert.equal(child.runId, '1301');
});

/* ---------------- P1: health ---------------- */

test('P1: settings health checks only console-held things; token expiry header surfaced; engines "verified by run"', async () => {
  const env = await makeEnv();
  route('GET', 'api.github.com/user', { body: { login: 'x' }, headers: { 'github-authentication-token-expiration': '2027-01-26 00:00:00 UTC' } });
  await addJob(env, { status: 'published', publishedAt: '2026-10-29T14:02:00.000Z' });
  const res = await settingsApi.onRequestGet(getCtx(env, 'https://c.pages.dev/api/settings'));
  const body = await res.json();
  assert.equal(body.health.githubTokenValid, true);
  assert.equal(body.health.githubTokenExpiresAt, '2027-01-26T00:00:00.000Z');
  assert.equal(body.health.webhookSecret, true);
  assert.ok(!('geminiKey' in body.health) && !('youtubeOAuth' in body.health), 'no false "Missing" for engine-held secrets');
  assert.equal(body.youtube.state, 'verified-by-upload');
  assert.equal(body.health.engines.gemini.lastUpload, '2026-10-29T14:02:00.000Z');
});

/* ---------------- P2 ---------------- */

test('P2: failure categories', () => {
  assert.equal(sg.classifyFailure('httpx.RemoteProtocolError: Server disconnected').category, 'llm_unavailable');
  assert.equal(sg.classifyFailure('503 UNAVAILABLE. The model is overloaded').category, 'llm_unavailable');
  assert.equal(sg.classifyFailure('Name gate BLOCKED: "Wall Street"').category, 'content_gate');
  assert.equal(sg.classifyFailure('python scripts/validate_no_personal_names.py exited 1').category, 'content_gate');
  assert.equal(sg.classifyFailure('ffmpeg exited with code 1').category, 'render');
  assert.equal(sg.classifyFailure('Pixabay 429 rate limit').category, 'asset');
  assert.equal(sg.classifyFailure('/home/runner/work/gemini-youtube-automation/x.py line 3 Error').category, 'unknown', 'repo path is not a signal');
  assert.equal(sg.classifyFailure('anything', 'publish').category, 'publish');
  assert.equal(sg.classifyError("Unexpected inputs provided: [\"tags_override\"]").category, 'dispatch');
});

test('P2: a later success clears stale error categories', async () => {
  const env = await makeEnv();
  const j = await addJob(env, { status: 'needs-review', errorCategory: 'unknown', error: 'old tags_override error' });
  await dbm.updateJob(env.DB, j.id, { errorCategory: 'unknown', error: 'old' });
  route('GET', '/actions/workflows/', { body: { workflow_runs: [] } });
  await flow.reconcileJobs(env.DB, env, await dbm.getSettings(env.DB), { force: true });
  const after = await dbm.getJob(env.DB, j.id);
  assert.equal(after.errorCategory, null);
});

test('P2: login never stores or returns client IPs; legacy throttle rows are purged', async () => {
  const env = await makeEnv();
  env.DB._raw.prepare("INSERT INTO settings (key, value) VALUES ('throttle:login:198.51.100.7', '[1]')").run();
  wh._resetSchemaCache();
  await wh.ensureProgressSchema(env.DB);
  env.ADMIN_PASSWORD_HASH = 'pbkdf2$1$00$00';
  const r = await loginPost(ctx(env, {}, { password: 'x' }));
  assert.equal(r.status, 401);
  const dump = JSON.stringify(env.DB._raw.prepare('SELECT * FROM settings').all()) + JSON.stringify(env.DB._raw.prepare('SELECT * FROM login_throttle').all());
  assert.ok(!dump.includes('203.0.113.9') && !dump.includes('198.51.100.7'), dump);
  route('GET', 'api.github.com/user', { body: {} });
  const s = await (await settingsApi.onRequestGet(getCtx(env, 'https://c.pages.dev/api/settings'))).json();
  assert.ok(!JSON.stringify(s).includes('throttle'));
});

test('P2: jobs list reports counts for every status and the cap', async () => {
  const env = await makeEnv();
  await addJob(env, { status: 'publish_failed' });
  await addJob(env, { status: 'rejected' });
  const res = await jobsGet(getCtx(env, 'https://c.pages.dev/api/jobs'));
  const body = await res.json();
  assert.equal(body.counts.publish_failed, 1);
  assert.equal(body.counts.rejected, 1);
  assert.equal(body.cap.limit, 2);
});

test('P0: Sync resolves stuck jobs end-to-end without dispatching anything', async () => {
  const env = await makeEnv();
  const t0 = iso(-90000);
  const up = await addJob(env, { status: 'uploading', runId: '1500', createdAt: iso(-95000), updatedAt: t0 });
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [
    { id: 1501, name: 'Main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(-89000), updated_at: '2026-10-29T14:00:00Z', html_url: 'h', display_title: 'Main' },
  ] } });
  route('GET', '/actions/workflows/verticals.yml/runs', { body: { workflow_runs: [] } });
  route('GET', '/contents/dypol-results/1501.json', contentsFile(RESULT_A(up.id, 1501)));
  route('GET', /\/actions\/runs\/1501$/, { body: { id: 1501, status: 'completed', conclusion: 'success', created_at: iso(-89000), updated_at: '2026-10-29T14:00:00Z', html_url: 'h' } });
  route('GET', '/artifacts', { body: { artifacts: [] } });
  const res = await syncPost(ctx(env));
  const body = await res.json();
  assert.equal(res.status, 200);
  const j = await dbm.getJob(env.DB, up.id);
  assert.equal(j.status, 'published', JSON.stringify(body));
  assert.equal(j.videos.length, 2);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'sync never dispatches');
});
