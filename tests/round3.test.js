/**
 * Round 3 (31 Oct 2026): Engine A dispatch HTTP 500 (transient GitHub errors),
 * Retry = fresh workflow_dispatch through one retryJob(), live step progress
 * from the API, failure labels by step, shared DYPOL_PROVIDER_LIMIT parsing.
 * Run: node --test tests/round3.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const gh = await import(`${ROOT}functions/api/_lib/github.js`);
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const sg = await import(`${ROOT}functions/api/_lib/safeguards.js`);
const flow = await import(`${ROOT}functions/api/_lib/jobflow.js`);
const live = await import(`${ROOT}functions/api/_lib/liveprogress.js`);
const quota = await import(`${ROOT}functions/api/_lib/quota.js`);
const retryLib = await import(`${ROOT}functions/api/_lib/retry.js`);
const { onRequestPost: runPost } = await import(`${ROOT}functions/api/engines/[engine]/run.js`);
const { onRequestPost: jobRetryPost } = await import(`${ROOT}functions/api/jobs/[id]/retry.js`);
const { onRequestPost: runRetryPost } = await import(`${ROOT}functions/api/runs/[id]/retry.js`);
const { onRequestPost: engineRetryPost } = await import(`${ROOT}functions/api/engines/[engine]/retry.js`);
const { onRequestGet: jobProgressGet } = await import(`${ROOT}functions/api/jobs/[id]/progress.js`);
const { onRequestPost: regenPost } = await import(`${ROOT}functions/api/jobs/[id]/regenerate.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const iso = (offSec = 0) => new Date(Date.now() + offSec * 1000).toISOString();
const b64 = (s) => Buffer.from(s).toString('base64');

/* Engine A main.yml dispatch inputs on dypol-integration (d4bcd38, 31 Oct 2026). */
const MAIN_YML = `name: Autonomous AI Course Generator
run-name: "\${{ inputs.job_id || github.run_id }} (\${{ inputs.phase || 'n/a' }})"
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
    inputs:
      phase:
        required: true
        default: 'draft'
        type: choice
        options: [draft, publish, full]
      topic:
        required: false
        default: ''
      language:
        required: false
        default: 'en'
      privacy:
        required: true
        default: 'private'
        type: choice
        options: [private, unlisted, public]
      job_id:
        required: false
        default: ''
      draft_run_id:
        required: false
        default: ''
      review_required:
        required: true
        default: '1'
      auto_publish:
        required: true
        default: '0'
      title_override:
        required: false
        default: ''
      description_override:
        required: false
        default: ''
      reviewer_feedback:
        required: false
        default: ''
        type: string
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
`;
const CHOICES = { phase: ['draft', 'publish', 'full'], privacy: ['private', 'unlisted', 'public'] };

let calls, routes, realFetch;
function mockGitHub() {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match(u)) {
        const out = typeof r.res === 'function' ? await r.res(u, opts) : r.res;
        if (out instanceof Response) return out;
        const { status = 200, body = null, headers = {} } = out;
        return new Response(body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
}
const route = (method, match, res) => routes.push({ method, match: typeof match === 'string' ? (u) => u.includes(match) : (u) => match.test(u), res });
const contentsFile = (s) => ({ body: { type: 'file', content: b64(s) } });

async function makeEnv() {
  wh._resetSchemaCache();
  gh._resetInputsCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    orchestration: { maxConcurrency: 2 },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false, dedupe: true },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', SESSION_SECRET: 's', __noRetryWait: true, __dispatchRetryDelaysMs: [0, 0] };
}
async function addJob(env, over = {}) {
  const j = {
    id: over.id || `job-${Math.random().toString(36).slice(2, 8)}`, engine: 'gemini', title: over.title || `Topic ${Math.random()}`,
    topic: over.topic || 'x', niche: 'tech', format: 'long-form', status: 'failed', stage: '', progress: null,
    description: 'd', tags: [], createdAt: iso(-3600), updatedAt: iso(-3600), quality: {}, logs: [], runId: null, ...over,
  };
  await dbm.insertJob(env.DB, j);
  const extra = {};
  for (const k of ['publishRunId', 'reviewNote', 'retryCount']) if (over[k] !== undefined) extra[k] = over[k];
  if (Object.keys(extra).length) await dbm.updateJob(env.DB, j.id, extra);
  return dbm.getJob(env.DB, j.id);
}
const ctx = (env, params = {}, body = {}) => ({
  env, params, request: new Request('https://c.pages.dev/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const getCtx = (env, params = {}) => ({ env, params, request: new Request('https://c.pages.dev/api/x') });
const dispatches = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/dispatches'));

beforeEach(mockGitHub);
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------------- 1. Engine A dispatch payload + HTTP 500 ---------------- */

test('Engine A Run: exact payload matches main.yml (declared keys, string values, valid choices, ≤25 inputs)', async () => {
  const env = await makeEnv();
  route('GET', '/contents/.github/workflows/main.yml', contentsFile(MAIN_YML));
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 200, body: { workflow_run_id: 41200119264, html_url: 'https://github.com/x/actions/runs/41200119264' } });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'How AI blocks robocalls', phase: 'draft' }));
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  const [d] = dispatches();
  const declared = gh.parseDispatchInputs(MAIN_YML);
  assert.equal(d.body.ref, 'dypol-integration');
  assert.equal(d.body.return_run_details, true);
  const keys = Object.keys(d.body.inputs);
  assert.ok(keys.length <= 25 && declared.length <= 25);
  for (const k of keys) {
    assert.ok(declared.includes(k), `undeclared input ${k}`);
    assert.equal(typeof d.body.inputs[k], 'string', `${k} must be a string`);
    if (CHOICES[k]) assert.ok(CHOICES[k].includes(d.body.inputs[k]), `${k}=${d.body.inputs[k]} not an allowed choice`);
  }
  assert.deepEqual(d.body.inputs, {
    phase: 'draft', topic: 'How AI blocks robocalls', privacy: 'unlisted', language: 'en',
    review_required: '1', auto_publish: '0', job_id: d.body.inputs.job_id,
  });
  assert.ok(JSON.stringify(d.body).length < 65535);
});

test('dispatch: a transient GitHub 500 is re-sent and the job starts normally', async () => {
  const env = await makeEnv();
  let n = 0;
  route('POST', '/actions/workflows/main.yml/dispatches', () => (++n === 1 ? { status: 500, body: '' } : { status: 200, body: { workflow_run_id: 7001 } }));
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [] } });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Transient topic one' }));
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  assert.equal(dispatches().length, 2);
  assert.equal(body.ghRunId, '7001');
  assert.equal((await dbm.getJob(env.DB, body.jobId)).runId, '7001');
});

test('dispatch: a 500 that DID create the run is found by run-name and never sent twice', async () => {
  const env = await makeEnv();
  let jobId = null;
  route('POST', '/actions/workflows/main.yml/dispatches', (u, opts) => { jobId = JSON.parse(opts.body).inputs.job_id; return { status: 500, body: { message: 'Server Error' } }; });
  route('GET', '/actions/workflows/main.yml/runs', () => ({ body: { workflow_runs: [{
    id: 7002, event: 'workflow_dispatch', display_title: `${jobId} (draft)`, status: 'queued', created_at: iso(-1), html_url: 'https://github.com/x/actions/runs/7002',
  }] } }));
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Transient topic two' }));
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  assert.equal(dispatches().length, 1, 'no second dispatch once the run exists');
  assert.equal(body.ghRunId, '7002');
});

test('dispatch: persistent 500s fail as "GitHub temporarily unavailable" (not "Upload rejected"), retryable', async () => {
  const env = await makeEnv();
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 500, body: '' });
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [] } });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'How AI blocks robocalls' }));
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.category, 'github_unavailable');
  assert.equal(body.retryable, true);
  assert.equal(dispatches().length, 3, '1 send + 2 re-sends');
  const job = await dbm.getJob(env.DB, body.jobId);
  assert.equal(job.errorCategory, 'github_unavailable');
  assert.match(job.error, /temporarily unavailable/i);
});

test('classifyError: the 30 Oct message is not an upload problem; 4xx are not retried as transient', async () => {
  const msg = 'GitHub API 500 for /repos/rstmcsoch/gemini-youtube-automation/actions/workflows/main.yml/dispatches';
  assert.equal(sg.classifyError(msg).category, 'github_unavailable');
  assert.notEqual(sg.classifyError('Unexpected inputs provided: ["x"]').category, 'github_unavailable');
  const env = await makeEnv();
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 422, body: { message: 'Unexpected inputs provided: ["x"]' } });
  await assert.rejects(gh.dispatchWorkflow('t', { owner: 'o', repo: 'r', workflowFile: 'main.yml', inputs: { job_id: 'j' }, retryDelaysMs: [0, 0] }), /Unexpected inputs/);
  assert.equal(dispatches().length, 1);
  void env;
});

/* ---------------- 2. Retry = fresh dispatch through retryJob ---------------- */

test('retry: resends the stored inputs (incl. reviewer_feedback) with current policy; links the new run to the same job', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Retry inputs topic', runId: '800' });
  await dbm.insertRun(env.DB, {
    id: 'run-old', runId: '800', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-900), status: 'failed',
    inputs: { phase: 'draft', job_id: job.id, topic: 'Retry inputs topic', privacy: 'public', language: 'en', review_required: '0', auto_publish: '1', reviewer_feedback: 'Fewer crowd shots' },
  });
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 200, body: { workflow_run_id: 801 } });
  const res = await jobRetryPost(ctx(env, { id: job.id }));
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  const d = dispatches()[0].body;
  assert.equal(d.inputs.reviewer_feedback, 'Fewer crowd shots');
  assert.equal(d.inputs.topic, 'Retry inputs topic');
  assert.equal(d.inputs.privacy, 'unlisted', 'policy comes from settings, not the old run');
  assert.equal(d.inputs.review_required, '1');
  assert.equal(d.inputs.auto_publish, '0');
  assert.equal(d.inputs.phase, 'draft');
  assert.equal(d.inputs.job_id, job.id);
  const fresh = await dbm.getJob(env.DB, job.id);
  assert.equal(fresh.runId, '801');
  const row = env.DB._raw.prepare('SELECT * FROM runs WHERE run_id = ?').get('801');
  assert.equal(row.job_id, job.id);
  assert.equal(JSON.parse(row.inputs).reviewer_feedback, 'Fewer crowd shots', 'inputs stored for the next retry');
});

test('retry: max 2 per job; a dispatch GitHub refuses does not use one up', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Retry cap topic' });
  let fail = true;
  route('POST', '/actions/workflows/main.yml/dispatches', () => (fail ? { status: 500, body: '' } : { status: 200, body: { workflow_run_id: Math.floor(Math.random() * 1e6) } }));
  route('GET', '/actions/workflows/main.yml/runs', { body: { workflow_runs: [] } });
  const r0 = await jobRetryPost(ctx(env, { id: job.id }));
  assert.equal(r0.status, 502);
  assert.equal((await dbm.getJob(env.DB, job.id)).retryCount, 0);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'failed');
  fail = false;
  for (const n of [1, 2]) {
    assert.equal((await jobRetryPost(ctx(env, { id: job.id }))).status, 202);
    assert.equal((await dbm.getJob(env.DB, job.id)).retryCount, n);
    await dbm.updateJob(env.DB, job.id, { status: 'failed' });
  }
  const r3 = await jobRetryPost(ctx(env, { id: job.id }));
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).code, 'retry-limit');
});

test('retry: duplicate guard exempts the job’s own parent chain but blocks unrelated jobs', async () => {
  const env = await makeEnv();
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 200, body: { workflow_run_id: 901 } });
  const parent = await addJob(env, { title: 'Lineage topic', status: 'needs-review' });
  const child = await addJob(env, { title: 'Lineage topic', status: 'failed', parentJobId: parent.id });
  assert.deepEqual(await retryLib.lineageIds(env.DB, child), [child.id, parent.id]);
  assert.equal((await jobRetryPost(ctx(env, { id: child.id }))).status, 202, 'own parent is not a duplicate');

  const other = await addJob(env, { title: 'Unrelated dup topic', status: 'needs-review' });
  const lone = await addJob(env, { title: 'Unrelated dup topic', status: 'failed' });
  const res = await jobRetryPost(ctx(env, { id: lone.id }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'duplicate');
  void other;
});

test('retry: upload guard — own upload → published; lineage upload → nothing to retry; unrelated → blocked', async () => {
  const env = await makeEnv();
  const util = await import(`${ROOT}functions/api/_lib/util.js`);
  const own = await addJob(env, { title: 'Uploaded own topic' });
  await dbm.recordUpload(env.DB, { topicKey: await util.topicKey(own.title), youtubeId: 'OWN12345678', jobId: own.id });
  const r1 = await jobRetryPost(ctx(env, { id: own.id }));
  assert.equal(r1.status, 200);
  assert.equal((await dbm.getJob(env.DB, own.id)).status, 'published');

  const parent = await addJob(env, { title: 'Uploaded lineage topic', status: 'superseded' });
  const child = await addJob(env, { title: 'Uploaded lineage topic', parentJobId: parent.id });
  await dbm.recordUpload(env.DB, { topicKey: await util.topicKey(child.title), youtubeId: 'PAR12345678', jobId: parent.id });
  const r2 = await jobRetryPost(ctx(env, { id: child.id }));
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).code, 'already-uploaded');

  const stranger = await addJob(env, { title: 'Uploaded stranger topic' });
  await dbm.recordUpload(env.DB, { topicKey: await util.topicKey(stranger.title), youtubeId: 'OTH12345678', jobId: 'job-someone-else' });
  const r3 = await jobRetryPost(ctx(env, { id: stranger.id }));
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).code, 'duplicate');
  assert.equal(dispatches().length, 0);
});

test('retry: Run History and Pipelines retries use the same fresh dispatch; no publish lock taken or needed', async () => {
  const env = await makeEnv();
  route('POST', '/actions/workflows/main.yml/dispatches', { status: 200, body: { workflow_run_id: 1001 } });
  const job = await addJob(env, { title: 'Run history retry topic', runId: '1000' });
  await dbm.insertRun(env.DB, { id: 'run-a', runId: '1000', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-60), status: 'failed' });
  // A held publish lock must not block a draft retry.
  await sg.acquireLock(env.DB, 'publish', 60000);
  const r1 = await runRetryPost(ctx(env, { id: 'run-a' }));
  assert.equal(r1.status, 202, JSON.stringify(await r1.clone().json()));
  assert.equal((await dbm.getJob(env.DB, job.id)).runId, '1001');
  assert.ok(!calls.some((c) => c.url.includes('rerun')));

  await dbm.updateJob(env.DB, job.id, { status: 'failed' });
  const r2 = await engineRetryPost(ctx(env, { engine: 'gemini' }));
  assert.equal(r2.status, 202, JSON.stringify(await r2.clone().json()));
  assert.equal(dispatches().length, 2);
  assert.equal((await dbm.getJob(env.DB, job.id)).retryCount, 2);
  const locks = env.DB._raw.prepare("SELECT name FROM locks WHERE name = 'publish'").all();
  assert.equal(locks.length, 1, 'the retry path neither took nor released the publish lock');
});

test('retry: a failed upload is never re-sent from Run History / Pipelines (drawer only)', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Publish failed topic', status: 'publish_failed', publishRunId: '1100' });
  await dbm.insertRun(env.DB, { id: 'run-p', runId: '1100', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'publish', startedAt: iso(-60), status: 'failed' });
  const res = await runRetryPost(ctx(env, { id: 'run-p' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'publish-retry-from-drawer');
  assert.equal(dispatches().length, 0);
});

test('retry: a run row GitHub refused (no run id, failed) never captures the retry’s run', async () => {
  const runs = [
    { id: 'refused', runId: null, engine: 'gemini', jobId: 'job-1', startedAt: iso(-30), status: 'failed' },
    { id: 'fresh', runId: null, engine: 'gemini', jobId: 'job-1', startedAt: iso(-5), status: 'queued' },
  ];
  const m = wh.findLocalRun(runs, 'gemini', { runId: '5', displayTitle: 'job-1 (draft)', event: 'workflow_dispatch', startedAt: iso(-4) });
  assert.equal(m.run.id, 'fresh');
  const m2 = wh.findLocalRun([runs[0]], 'gemini', { runId: '5', displayTitle: 'job-1 (draft)', event: 'workflow_dispatch', startedAt: iso(-4) });
  assert.equal(m2.run, null);
});

test('regenerate and run share buildDraftInputs (feedback capped, policy from settings)', async () => {
  const s = await dbm.getSettings((await makeEnv()).DB);
  const i = flow.buildDraftInputs(s, 'verticals', { topic: 't', reviewerFeedback: 'x'.repeat(2000), context: 'c' });
  assert.equal(i.reviewer_feedback.length, 1500);
  assert.equal(i.niche, 'general');
  assert.equal(i.privacy, 'unlisted');
  assert.equal(i.context, 'c');
  assert.ok(Object.values(i).every((v) => typeof v === 'string'));
  void regenPost;
});

/* ---------------- 3. Live progress from the API ---------------- */

const apiJobs = (runId, steps, jobStatus = 'in_progress', conclusion = null) => ({ body: { jobs: [{
  id: 55, run_id: runId, name: 'build-and-deploy', status: jobStatus, conclusion, html_url: `https://github.com/x/actions/runs/${runId}/job/55`,
  started_at: iso(-200), completed_at: jobStatus === 'completed' ? iso(-1) : null,
  steps: steps.map(([name, status, concl], i) => ({ name, status, conclusion: concl || null, number: i + 1, started_at: iso(-200 + i), completed_at: status === 'completed' ? iso(-199 + i) : null })),
}] } });

test('live progress: polling refreshes steps from the API (15 s throttle), percent = step index / total, capped 99', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Live progress topic', status: 'running', runId: '3000' });
  await dbm.insertRun(env.DB, { id: 'run-l', runId: '3000', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-200), status: 'in-progress' });
  let steps = [['Set up job', 'completed', 'success'], ['Checkout', 'completed', 'success'], ['Install', 'in_progress'], ['Run pipeline', 'queued']];
  route('GET', '/actions/runs/3000/jobs', () => apiJobs(3000, steps));
  const r1 = await jobProgressGet(getCtx(env, { id: job.id }));
  const p1 = (await r1.json()).progress;
  assert.equal(p1.currentStep, 'Install');
  assert.equal(p1.percent, 50);
  const j1 = await dbm.getJob(env.DB, job.id);
  assert.equal(j1.progress, 50);
  assert.match(j1.stage, /Install/);

  steps = [['Set up job', 'completed', 'success'], ['Checkout', 'completed', 'success'], ['Install', 'completed', 'success'], ['Run pipeline', 'in_progress']];
  await jobProgressGet(getCtx(env, { id: job.id }));
  assert.equal(calls.filter((c) => c.url.includes('/runs/3000/jobs')).length, 1, 'second poll within 15 s is served from D1');
  env.DB._raw.prepare('DELETE FROM locks').run(); // 15 s later
  const p3 = (await (await jobProgressGet(getCtx(env, { id: job.id }))).json()).progress;
  assert.equal(p3.currentStep, 'Run pipeline');
  assert.equal(p3.percent, 75);
  assert.equal(wh.stepPercent([{ steps: [{ number: 1, status: 'completed' }, { number: 2, status: 'completed' }] }]), 99);
});

test('live progress: all jobs done → run read once and the job reaches Needs review without a webhook', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Live done topic', status: 'running', runId: '3100' });
  await dbm.insertRun(env.DB, { id: 'run-d', runId: '3100', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-300), status: 'in-progress' });
  route('GET', '/actions/runs/3100/jobs', apiJobs(3100, [['Set up job', 'completed', 'success'], ['Run pipeline', 'completed', 'success']], 'completed', 'success'));
  route('GET', /\/actions\/runs\/3100$/, { body: { id: 3100, name: 'Main', display_title: `${job.id} (draft)`, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/actions/runs/3100', created_at: iso(-300), run_started_at: iso(-300), updated_at: iso(-1), path: '.github/workflows/main.yml' } });
  const p = (await (await jobProgressGet(getCtx(env, { id: job.id }))).json()).progress;
  const fresh = await dbm.getJob(env.DB, job.id);
  assert.equal(fresh.status, 'needs-review');
  assert.equal(p.percent, 100);
  assert.equal(p.done, true);
});

test('progress: a dispatch GitHub refused shows no ever-growing elapsed time', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { title: 'Refused topic', status: 'failed' });
  await dbm.insertRun(env.DB, { id: 'run-r', runId: null, engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-86400), status: 'failed' });
  const p = (await (await jobProgressGet(getCtx(env, { id: job.id }))).json()).progress;
  assert.equal(p.run.elapsedSec, null);
  assert.equal(p.run.neverStarted, true);
  assert.equal(calls.length, 0, 'no API call for a job that is not running');
});

test('live progress: refresh is a no-op without a GitHub run id or token', async () => {
  const env = await makeEnv();
  const s = await dbm.getSettings(env.DB);
  assert.equal((await live.refreshRunFromApi(env.DB, env, s, { ghRunId: null, engine: 'gemini' })).skipped, 'no-run');
  assert.equal((await live.refreshRunFromApi(env.DB, { ...env, GITHUB_TOKEN: '' }, s, { ghRunId: '1', engine: 'gemini' })).skipped, 'no-run');
  assert.equal(live.liveRunIdFor({ status: 'uploading', publishRunId: '9', runId: '8' }), '9');
  assert.equal(live.liveRunIdFor({ status: 'needs-review', runId: '8' }), null);
});

/* ---------------- 4. Failure labels by step ---------------- */

test('failure labels: step name decides when the engine logged no category; a logged category wins', async () => {
  assert.deepEqual(sg.classifyByStep('📦 Install dependencies and patch ImageMagick'),
    { category: 'setup_failed', label: 'Setup failed: dependency install', retryable: true });
  assert.equal(sg.classifyByStep('⬇️ Checkout repository').label, 'Setup failed: checkout');
  assert.equal(sg.classifyByStep('Block upload if reviewed text contains personal names').category, 'content_gate');
  assert.equal(sg.classifyByStep('Upload the reviewed video to YouTube').category, 'publish');
  assert.equal(sg.classifyByStep('📤 Upload console preview artifact').category, 'handoff');
  assert.equal(sg.classifyByStep('🎬 Build small preview copies for the console').category, 'render');
  assert.equal(sg.classifyByStep('🚀 Run DYPOL phase-aware production pipeline'), null, 'generic step → log text decides');
  assert.equal(sg.loggedCategory('x\nDYPOL_FAILURE_CATEGORY=llm_unavailable\nPipeline failed.'), 'llm_unavailable');
  assert.equal(sg.loggedCategory('DYPOL_FAILURE_CATEGORY=made_up'), null);

  const env = await makeEnv();
  const s = await dbm.getSettings(env.DB);
  const j1 = await addJob(env, { title: 'Setup fail topic', status: 'running' });
  await flow.failJob(env.DB, { ...env, GITHUB_TOKEN: '' }, s, j1, { phase: 'draft', ghRunId: '41070589645', failure: 'Step “📦 Install dependencies and patch ImageMagick” failed in job “build-and-deploy”' });
  const f1 = await dbm.getJob(env.DB, j1.id);
  assert.equal(f1.errorCategory, 'setup_failed');
  assert.match(f1.error, /^Setup failed: dependency install/);
  assert.equal(f1.stage, 'Failed — Setup failed: dependency install');

  route('GET', '/actions/jobs/77/logs', { status: 200, body: 'boom\nDYPOL_FAILURE_CATEGORY=llm_unavailable\nPipeline failed.' });
  const j2 = await addJob(env, { title: 'Logged cat topic', status: 'running' });
  await flow.failJob(env.DB, env, s, j2, { phase: 'draft', ghRunId: '9', ghJobId: '77', failure: 'Step “🚀 Run DYPOL phase-aware production pipeline” failed' });
  assert.equal((await dbm.getJob(env.DB, j2.id)).errorCategory, 'llm_unavailable');
});

/* ---------------- 5. Quota parser reads both engines' limit lines ---------------- */

test('quota: DYPOL_PROVIDER_LIMIT lines from Engine A and Engine B (incl. Wikimedia) are read; old A lines still are', () => {
  const b = quota.scanLog('2026-10-31T10:00:00.0000000Z DYPOL_PROVIDER_LIMIT provider=pixabay status=429 action=skip_for_rest_of_run\n'
    + 'DYPOL_PROVIDER_LIMIT provider=wikimedia status=429 action=skip_for_rest_of_run\n');
  assert.equal(b.pixabay, true);
  assert.equal(b.wikimedia, true);
  assert.equal(b.flux, false);
  assert.deepEqual(b.providers.sort(), ['pixabay', 'wikimedia']);
  assert.match(b.pixabayLine, /^DYPOL_PROVIDER_LIMIT provider=pixabay/);
  const a = quota.scanLog('⚠️ flux quota/limit hit (HTTP 429); skipping flux for the rest of this run\nDYPOL_PROVIDER_LIMIT provider=flux action=skip_for_rest_of_run');
  assert.equal(a.flux, true);
  assert.equal(quota.scanLog('⚠️ pixabay quota/limit hit (HTTP 429); skipping').pixabay, true, 'pre-round-3 Engine A line');
  assert.equal(quota.scanLog('fetched 12 pixabay hits').pixabay, false);
  assert.equal(quota.CACHE_KEY, 'panel-v4');
});
