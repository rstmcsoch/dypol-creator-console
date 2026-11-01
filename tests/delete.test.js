/**
 * Delete video (31 Oct 2026): endpoint, lineage, partial failure, idempotency,
 * cap ledger, duplicate guard, guards while deleting, YouTube never touched.
 * GitHub is a stateful in-memory fake; any request to a YouTube/Google host fails the test.
 * Run: node --test tests/delete.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const sg = await import(`${ROOT}functions/api/_lib/safeguards.js`);
const del = await import(`${ROOT}functions/api/_lib/deletejob.js`);
const ep = await import(`${ROOT}functions/api/jobs/[id]/delete.js`);
const { onRequest: middleware } = await import(`${ROOT}functions/api/_middleware.js`);
const util = await import(`${ROOT}functions/api/_lib/util.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const iso = (offSec = 0) => new Date(Date.now() + offSec * 1000).toISOString();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* ---------------- fake GitHub ---------------- */
let gh, calls, realFetch;
function newRepo() {
  return { runs: new Map(), artifacts: new Map(), files: new Map(), commits: [], head: 'c0', commitMsgs: new Map() };
}
function fakeGitHub() {
  gh = { [A]: newRepo(), [B]: newRepo(), fail: [] };
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, path: u.pathname + u.search, body: opts.body ? JSON.parse(opts.body) : null });
    if (!/api\.github\.com$/.test(u.hostname)) throw new Error(`unexpected host ${u.hostname}`);
    for (const f of gh.fail) {
      if (f.method === method && f.match.test(u.pathname)) {
        if (f.times !== undefined && f.times-- <= 0) continue;
        return new Response(JSON.stringify({ message: f.message || 'Resource not accessible by personal access token' }), { status: f.status, headers: f.headers || {} });
      }
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(u.pathname);
    if (!m) return res(404);
    const repo = gh[m[1]];
    if (!repo) return res(404);
    const p = m[2];
    let x;
    if (method === 'GET' && p === '/actions/runs') {
      return res(200, { total_count: repo.runs.size, workflow_runs: [...repo.runs.values()].map((r) => ({ id: r.id, display_title: r.title, status: r.status, event: 'workflow_dispatch' })) });
    }
    if ((x = /^\/actions\/runs\/(\d+)$/.exec(p))) {
      const r = repo.runs.get(x[1]);
      if (method === 'GET') return r ? res(200, { id: Number(x[1]), status: r.status, display_title: r.title }) : res(404);
      if (method === 'DELETE') {
        if (!r) return res(404);
        if (r.status !== 'completed') return res(409, { message: 'Cannot delete an active workflow run' });
        repo.runs.delete(x[1]);
        return new Response(null, { status: 204 });
      }
    }
    if ((x = /^\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/.exec(p)) && method === 'POST') {
      const r = repo.runs.get(x[1]);
      if (!r) return res(404);
      r.cancelCalls = (r.cancelCalls || 0) + 1; r.lastCancel = x[2];
      if (r.stopAfter !== undefined && r.cancelCalls >= r.stopAfter) r.status = 'completed';
      return res(202, {});
    }
    if ((x = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(p)) && method === 'GET') {
      if (!repo.runs.has(x[1])) return res(404);
      const list = [...repo.artifacts.values()].filter((a) => a.run === x[1]);
      return res(200, { total_count: list.length, artifacts: list.map((a) => ({ id: a.id, name: a.name })) });
    }
    if ((x = /^\/actions\/artifacts\/(\d+)$/.exec(p)) && method === 'DELETE') {
      return repo.artifacts.delete(x[1]) ? new Response(null, { status: 204 }) : res(404);
    }
    if ((x = /^\/contents\/(.+)$/.exec(p)) && method === 'GET') {
      const path = decodeURIComponent(x[1]);
      const kids = [...repo.files.keys()].filter((k) => k.startsWith(`${path}/`));
      if (kids.length) return res(200, kids.map((k) => ({ name: k.split('/').pop(), path: k, type: 'file' })));
      if (repo.files.has(path)) return res(200, { type: 'file', content: b64(repo.files.get(path)), sha: 'blob' });
      return res(404);
    }
    if (method === 'GET' && p === '/commits') {
      const path = u.searchParams.get('path');
      const msg = repo.commitMsgs.get(path);
      return res(200, msg ? [{ commit: { message: msg } }] : []);
    }
    if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(p)) && method === 'GET') return res(200, { object: { sha: repo.head } });
    if ((x = /^\/git\/commits\/(.+)$/.exec(p)) && method === 'GET') return res(200, { sha: x[1], tree: { sha: `t-${x[1]}` } });
    if ((x = /^\/git\/trees\/(.+)$/.exec(p)) && method === 'GET') {
      return res(200, { tree: [...repo.files.keys()].map((path) => ({ path, type: 'blob' })) });
    }
    if (method === 'POST' && p === '/git/trees') {
      const body = JSON.parse(opts.body);
      for (const e of body.tree) {
        if (e.sha === null && !repo.files.has(e.path)) return res(422, { message: 'GitHub tree: path not found' });
      }
      repo.pendingTree = body.tree;
      return res(201, { sha: `tree-${repo.commits.length + 1}` });
    }
    if (method === 'POST' && p === '/git/commits') {
      const body = JSON.parse(opts.body);
      return res(201, { sha: `commit-${repo.commits.length + 1}-${body.parents[0]}`, message: body.message });
    }
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(p)) && method === 'PATCH') {
      const body = JSON.parse(opts.body);
      if (repo.moveOnce) { repo.moveOnce = false; repo.head = 'moved'; return res(422, { message: 'Update is not a fast forward' }); }
      for (const e of repo.pendingTree || []) {
        if (e.sha === null) repo.files.delete(e.path); else repo.files.set(e.path, e.content);
      }
      repo.commits.push({ ref: x[1], sha: body.sha, tree: repo.pendingTree });
      repo.head = body.sha;
      return res(200, { object: { sha: body.sha } });
    }
    return res(404);
  };
}
function res(status, body = { message: 'Not Found' }) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const addRun = (slug, id, title, extra = {}) => gh[slug].runs.set(String(id), { id: Number(id), title, status: 'completed', ...extra });
const addArtifact = (slug, id, run, name) => gh[slug].artifacts.set(String(id), { id: Number(id), run: String(run), name });

beforeEach(fakeGitHub);
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------------- D1 helpers ---------------- */
async function makeEnv() {
  wh._resetSchemaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false, dedupe: true },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', SESSION_SECRET: 's' };
}
async function addJob(env, over = {}) {
  const j = {
    id: over.id || `job-${Math.random().toString(36).slice(2, 8)}-t1`, engine: 'gemini', title: over.title || 'How AI test topic',
    topic: over.topic || over.title || 'How AI test topic', niche: 'tech', format: 'long-form', status: 'failed', stage: '', progress: null,
    description: 'd', tags: [], createdAt: iso(-7200), updatedAt: iso(-7200), quality: {}, logs: [], runId: null, ...over,
  };
  await dbm.insertJob(env.DB, j);
  const extra = {};
  for (const k of ['publishRunId', 'reviewNote', 'videos']) if (over[k] !== undefined) extra[k] = over[k];
  if (Object.keys(extra).length) await dbm.updateJob(env.DB, j.id, extra);
  return dbm.getJob(env.DB, j.id);
}
async function addRunRow(env, { id, runId, engine = 'gemini', jobId, phase = 'draft', logs = [] }) {
  await dbm.insertRun(env.DB, { id: id || `run-${runId}`, runId: runId ? String(runId) : null, engine, workflow: engine === 'gemini' ? 'main.yml' : 'verticals.yml',
    jobId, startedAt: iso(-7000), durationSec: 60, status: 'failed', failureReason: null, githubUrl: null, steps: [], logs, artifacts: [], phase });
}
const count = async (env, sql, ...args) => Number((await env.DB.prepare(sql).bind(...args).first())?.n || 0);
const ctx = (env, id, method = 'POST') => ({ env, params: { id }, request: new Request(`https://c.pages.dev/api/jobs/${id}/delete`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) }) });
async function callDelete(env, id, method = 'POST') { const r = await ep[method === 'GET' ? 'onRequestGet' : method === 'DELETE' ? 'onRequestDelete' : 'onRequestPost'](ctx(env, id, method)); return { status: r.status, body: await r.json() }; }
async function deleteUntilSettled(env, id, max = 10) {
  let last;
  for (let i = 0; i < max; i++) {
    last = await callDelete(env, id);
    if (!['continue', 'waiting'].includes(last.body.state)) return last;
  }
  return last;
}

/** A realistic failed Engine A job with a retry run, an orphan 5xx-dispatched run and committed files. */
async function seedFailedJob(env, { id = 'job-mvv23xmk-0hlhyv', title = 'How AI blocks robocalls' } = {}) {
  const job = await addJob(env, { id, title, runId: '1001' });
  await addRunRow(env, { runId: '1001', jobId: id });
  await addRunRow(env, { id: 'run-retry', runId: '1002', jobId: id });
  await addRunRow(env, { id: 'run-gh-1003', runId: '1003', jobId: null, logs: [{ ts: '—', level: 'info', msg: `Discovered from GitHub webhook: ${id} (draft)` }] });
  addRun(A, 1001, `${id} (draft)`);
  addRun(A, 1002, `${id} (draft)`);
  addRun(A, 1003, `${id} (draft)`); // created by a 5xx dispatch, never linked in D1
  addRun(A, 2000, 'job-other-keep1 (draft)');
  addArtifact(A, 11, 1001, `preview-${id}`);
  addArtifact(A, 12, 1001, `dypol-candidate-${id}`);
  addArtifact(A, 13, 1002, 'dypol-result-1002');
  addArtifact(A, 99, 2000, 'preview-job-other-keep1');
  gh[A].files.set('dypol-results/1002.json', '{"job_id":"x"}');
  gh[A].files.set('dypol-results/2000.json', '{"job_id":"other"}');
  gh[A].files.set('content_plan.json', JSON.stringify({ lessons: [{ title, topic: title, origin: 'dypol-topic-override' }, { title: 'Keep me', topic: 'Keep me' }] }, null, 2));
  gh[A].files.set('images/demo.gif', 'GIF');
  gh[A].commitMsgs.set('images/demo.gif', 'dypol: save plan and verified result for run 1002');
  await env.DB.prepare("INSERT INTO gh_jobs (gh_job_id, gh_run_id, name) VALUES ('j1', '1001', 'build')").run();
  await env.DB.prepare("INSERT INTO job_steps (gh_run_id, gh_job_id, number, name) VALUES ('1001', 'j1', 1, 'Checkout')").run();
  await env.DB.prepare("INSERT INTO locks (name, expires_at) VALUES ('progress:1001', ?)").bind(Date.now() + 9e6).run();
  await dbm.addActivity(env.DB, { icon: 'run', tone: 'blue', title: 'Run started', sub: `${title} · gemini`, jobId: id });
  await env.DB.prepare("INSERT INTO quota_cache (key, data, updated_at) VALUES ('panel-v3', ?, 1)").bind(JSON.stringify({ lastUpload: { title } })).run();
  return job;
}

/* ---------------- tests ---------------- */

test('GET plan lists exactly what will be removed and never mentions deleting from YouTube', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  const r = await callDelete(env, 'job-mvv23xmk-0hlhyv', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.githubRuns, 3, 'D1 runs + the unlinked run found by its run-name');
  assert.equal(r.body.counts.savedFiles, 3);
  assert.equal(r.body.counts.repoFiles, 3, 'result json + demo.gif + content_plan entry');
  assert.equal(r.body.youtubeStays, 0);
  assert.deepEqual(r.body.items.slice(0, 2), ['Dashboard record', '3 GitHub runs (with their logs)']);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'plan is read-only');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM deletions'), 0);
});

test('full delete removes runs, artifacts, files, every D1 row — in order, no YouTube call', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  await addJob(env, { id: 'job-other-keep1', title: 'Another video' });
  const r = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.body.state, 'done', JSON.stringify(r.body));
  // GitHub
  assert.deepEqual([...gh[A].runs.keys()], ['2000']);
  assert.deepEqual([...gh[A].artifacts.keys()], ['99']);
  assert.ok(!gh[A].files.has('dypol-results/1002.json'));
  assert.ok(gh[A].files.has('dypol-results/2000.json'));
  assert.ok(!gh[A].files.has('images/demo.gif'), 'demo.gif was written by this job');
  const plan = JSON.parse(gh[A].files.get('content_plan.json'));
  assert.deepEqual(plan.lessons.map((l) => l.title), ['Keep me']);
  assert.equal(gh[A].commits.length, 1, 'one commit per repo');
  assert.equal(gh[A].commits[0].ref, 'dypol-integration');
  const msg = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/commits')).body.message;
  assert.ok(!/robocall/i.test(msg), 'commit message carries no title');
  // order: every artifact delete precedes its run delete; files after runs
  const idx = (pred) => calls.findIndex(pred);
  assert.ok(idx((c) => c.method === 'DELETE' && c.path.endsWith('/artifacts/11')) < idx((c) => c.method === 'DELETE' && /runs\/1001$/.test(c.path)));
  assert.ok(idx((c) => c.method === 'DELETE' && /runs\/1003$/.test(c.path)) < idx((c) => c.method === 'POST' && c.path.endsWith('/git/trees')));
  assert.ok(calls.every((c) => !/main/.test(c.path.split('/git/ref')[1] || '')), 'never touches main');
  // D1
  for (const [t, where] of [['jobs', "id = 'job-mvv23xmk-0hlhyv'"], ['runs', "job_id = 'job-mvv23xmk-0hlhyv' OR run_id IN ('1001','1002','1003')"],
    ['gh_jobs', "gh_run_id = '1001'"], ['job_steps', "gh_run_id = '1001'"], ['locks', "name = 'progress:1001'"],
    ['activity', "job_id = 'job-mvv23xmk-0hlhyv'"], ['deletions', '1=1'], ['quota_cache', '1=1']]) {
    assert.equal(await count(env, `SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`), 0, t);
  }
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM runs WHERE instr(logs, 'job-mvv23xmk-0hlhyv') > 0"), 0);
  assert.ok(await dbm.getJob(env.DB, 'job-other-keep1'), 'other jobs untouched');
});

test('lineage: later attempts (Redo children) go too, the earlier attempt stays', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-parent-aa1', title: 'Lineage topic', status: 'superseded' });
  await addJob(env, { id: 'job-child-bb1', title: 'Lineage topic', parentJobId: 'job-parent-aa1', status: 'failed', runId: '3001' });
  await addJob(env, { id: 'job-grand-cc1', title: 'Lineage topic', parentJobId: 'job-child-bb1', status: 'needs-review', runId: '3002' });
  addRun(A, 3001, 'job-child-bb1 (draft)'); addRun(A, 3002, 'job-grand-cc1 (draft)'); addRun(A, 3000, 'job-parent-aa1 (draft)');
  const plan = await callDelete(env, 'job-child-bb1', 'GET');
  assert.deepEqual(plan.body.attempts.map((a) => a.id).sort(), ['job-child-bb1', 'job-grand-cc1']);
  const r = await deleteUntilSettled(env, 'job-child-bb1');
  assert.equal(r.body.state, 'done');
  assert.ok(await dbm.getJob(env.DB, 'job-parent-aa1'));
  assert.equal(await dbm.getJob(env.DB, 'job-grand-cc1'), null);
  assert.deepEqual([...gh[A].runs.keys()], ['3000']);
});

test('a video being made is stopped first, then deleted (force-cancel after 60 s)', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-live-run1', status: 'running', runId: '4001' });
  addRun(A, 4001, 'job-live-run1 (draft)', { status: 'in_progress', stopAfter: 2 });
  const first = await callDelete(env, 'job-live-run1');
  assert.equal(first.body.state, 'waiting');
  assert.equal(gh[A].runs.get('4001').lastCancel, 'cancel');
  // pretend the first cancel was > 60 s ago
  const d = await env.DB.prepare('SELECT done FROM deletions').first();
  const done = JSON.parse(d.done); done.cancelAt['4001'] = Date.now() - 61e3;
  await env.DB.prepare('UPDATE deletions SET done = ?').bind(JSON.stringify(done)).run();
  const second = await callDelete(env, 'job-live-run1');
  assert.equal(gh[A].runs.has('4001') ? gh[A].runs.get('4001').lastCancel : 'force-cancel', 'force-cancel');
  const last = second.body.state === 'done' ? second : await deleteUntilSettled(env, 'job-live-run1');
  assert.equal(last.body.state, 'done');
  assert.equal(gh[A].runs.size, 0);
});

test('partial failure keeps a tombstone with what remains; Retry delete finishes it; no orphans', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  gh.fail.push({ method: 'DELETE', match: /\/actions\/artifacts\/12$/, status: 403 });
  const r = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.body.state, 'partial');
  assert.ok(r.body.errors.some((e) => /1001/.test(e)));
  assert.equal(r.body.remaining.githubRuns, 1);
  assert.ok(await dbm.getJob(env.DB, 'job-mvv23xmk-0hlhyv'), 'job row is the tombstone');
  assert.ok(await count(env, "SELECT COUNT(*) AS n FROM runs WHERE run_id = '1001'"), 'its run row too');
  const list = await (await (await import(`${ROOT}functions/api/jobs/index.js`)).onRequestGet({ env, request: new Request('https://c.pages.dev/api/jobs'), waitUntil() {} })).json();
  assert.equal(list.jobs.find((j) => j.id === 'job-mvv23xmk-0hlhyv').deletion.state, 'partial');
  assert.ok(gh[A].runs.has('1001') && !gh[A].runs.has('1002'), 'the rest already went');
  gh.fail = [];
  const again = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(again.body.state, 'done');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM deletions'), 0);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM runs WHERE run_id IN ('1001','1002','1003')"), 0);
  assert.equal(gh[A].runs.size, 1);
});

test('idempotent: deleting again (or after GitHub already lost the run) is a clean done', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  gh[A].runs.delete('1002'); // already gone on GitHub
  const r = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.body.state, 'done');
  const again = await callDelete(env, 'job-mvv23xmk-0hlhyv', 'DELETE');
  assert.equal(again.status, 200);
  assert.equal(again.body.state, 'done');
  assert.equal(again.body.alreadyGone, true);
  assert.equal((await callDelete(env, 'job-mvv23xmk-0hlhyv', 'GET')).status, 404);
});

test('published video: YouTube is never called; only youtube_id + topic hash stay as the guard; cap slot stays used', async () => {
  const env = await makeEnv();
  const id = 'job-pub-today1';
  await addJob(env, { id, engine: 'verticals', title: 'How AI spots fakes', status: 'published', runId: '5001', publishRunId: '5002',
    youtubeId: 'YT_SHORT_1', publishedAt: iso(-60), videos: [{ kind: 'short', youtube_id: 'YT_SHORT_1' }] });
  await sg.recordPublished(env.DB, await dbm.getJob(env.DB, id), 'YT_SHORT_1', { publishedAt: iso(-60) });
  addRun(B, 5001, `${id} (draft)`); addRun(B, 5002, `${id} (publish)`);
  addArtifact(B, 51, 5001, `draft-${id}`); addArtifact(B, 52, 5002, 'upload-result-5002');
  gh[B].files.set(`dypol-drafts/${id}.json`, '{}'); gh[B].files.set('dypol-results/5002.json', '{}');
  const before = await dbm.capUsage(env.DB);
  assert.equal(before.published, 1);
  const plan = await callDelete(env, id, 'GET');
  assert.equal(plan.body.youtubeStays, 1);
  const r = await deleteUntilSettled(env, id);
  assert.equal(r.body.state, 'done');
  assert.equal(r.body.youtubeStays, 1);
  assert.ok(calls.every((c) => !/\/youtube\/v3|videos\?|googleapis/i.test(c.path)), 'no YouTube call (the fake also throws on any non-GitHub host)');
  assert.equal(gh[B].files.size, 0);
  assert.equal(gh[B].runs.size, 0);
  const ups = (await env.DB.prepare('SELECT * FROM uploads').all()).results;
  assert.equal(ups.length, 1);
  assert.equal(ups[0].youtube_id, 'YT_SHORT_1');
  assert.equal(ups[0].job_id, null);
  assert.equal(ups[0].idempotency_key, null);
  assert.equal((await dbm.capUsage(env.DB)).published, 1, 'deleting does not give back today\'s upload slot');
  const dup = await sg.findDuplicate(env.DB, 'How AI spots fakes');
  assert.ok(dup?.deleted, 'the same topic is still blocked');
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM jobs WHERE id = ?", id), 0);
});

test('a video uploading right now is refused', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-upl-now1', status: 'uploading' });
  const r = await callDelete(env, 'job-upl-now1');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'uploading');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM deletions'), 0);
});

test('shared title: content_plan entry and legacy feed rows of another video are kept', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  await addJob(env, { id: 'job-mvwdt0x9-vvcl8l', title: 'How AI blocks robocalls', status: 'needs-review' });
  await env.DB.prepare("INSERT INTO activity (id, ts, icon, tone, title, sub) VALUES ('legacy1', ?, 'check', 'violet', 'Video ready for review', 'How AI blocks robocalls')").bind(iso()).run();
  const plan = await callDelete(env, 'job-mvv23xmk-0hlhyv', 'GET');
  assert.equal(plan.body.counts.planShared, 1);
  const r = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.body.state, 'done');
  assert.equal(JSON.parse(gh[A].files.get('content_plan.json')).lessons.length, 2);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM activity WHERE id = 'legacy1'"), 1);
  assert.ok(await dbm.getJob(env.DB, 'job-mvwdt0x9-vvcl8l'));
});

test('legacy feed rows of a unique title are removed', async () => {
  const env = await makeEnv();
  await seedFailedJob(env, { id: 'job-uniq-tt1', title: 'A unique topic' });
  await env.DB.prepare("INSERT INTO activity (id, ts, icon, tone, title, sub) VALUES ('legacy2', ?, 'alert', 'red', 'Run failed', 'A unique topic — Render failed')").bind(iso()).run();
  await env.DB.prepare("INSERT INTO activity (id, ts, icon, tone, title, sub) VALUES ('legacy3', ?, 'alert', 'red', 'Run failed', 'A unique topic extended — other')").bind(iso()).run();
  const r = await deleteUntilSettled(env, 'job-uniq-tt1');
  assert.equal(r.body.state, 'done');
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM activity WHERE id = 'legacy2'"), 0);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM activity WHERE id = 'legacy3'"), 1);
});

test('subrequest budget: a big job is finished over several passes', async () => {
  const env = await makeEnv();
  const id = 'job-big-many1';
  await addJob(env, { id, runId: '6000' });
  for (let i = 0; i < 8; i++) {
    addRun(A, 6000 + i, `${id} (draft)`);
    for (let k = 0; k < 4; k++) addArtifact(A, 60000 + i * 10 + k, 6000 + i, `a${k}`);
  }
  const first = await callDelete(env, id);
  assert.equal(first.body.state, 'continue');
  const perPass = calls.length;
  assert.ok(perPass <= del.DELETE_BUDGET + 1, `pass used ${perPass} GitHub calls`);
  const r = await deleteUntilSettled(env, id);
  assert.equal(r.body.state, 'done');
  assert.equal(gh[A].runs.size, 0);
  assert.equal(gh[A].artifacts.size, 0);
});

test('rate limit pauses (no failure) and the branch moving mid-commit is retried once', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  gh.fail.push({ method: 'DELETE', match: /\/actions\/runs\/1001$/, status: 403, times: 1, headers: { 'retry-after': '1', 'x-ratelimit-remaining': '0' }, message: 'API rate limit exceeded' });
  gh[A].moveOnce = true;
  const first = await callDelete(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(first.body.state, 'continue');
  assert.equal(first.body.retryAfterMs, 1000);
  const r = await deleteUntilSettled(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.body.state, 'done');
  assert.equal(gh[A].commits.length, 1);
});

test('while deleting: other changes are refused and a late webhook cannot recreate rows', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-live-run2', status: 'running', runId: '7001' });
  addRun(A, 7001, 'job-live-run2 (draft)', { status: 'in_progress' });
  assert.equal((await callDelete(env, 'job-live-run2')).body.state, 'waiting');
  const token = await util.createSessionToken('s');
  const mw = await middleware({
    env, request: new Request('https://c.pages.dev/api/jobs/job-live-run2/approve', { method: 'POST', headers: { Cookie: `dypol_session=${token}`, Origin: 'https://c.pages.dev' } }),
    next: async () => new Response('passed'),
  });
  assert.equal(mw.status, 409);
  assert.equal((await mw.json()).code, 'deleting');
  // the delete route itself still passes the guard
  const mw2 = await middleware({
    env, request: new Request('https://c.pages.dev/api/jobs/job-live-run2/delete', { method: 'POST', headers: { Cookie: `dypol_session=${token}`, Origin: 'https://c.pages.dev' } }),
    next: async () => new Response('passed'),
  });
  assert.equal(await mw2.text(), 'passed');
  // cross-origin delete is rejected (CSRF)
  const mw3 = await middleware({
    env, request: new Request('https://c.pages.dev/api/jobs/job-live-run2/delete', { method: 'POST', headers: { Cookie: `dypol_session=${token}`, Origin: 'https://evil.example' } }),
    next: async () => new Response('passed'),
  });
  assert.equal(mw3.status, 403);
  // no session → 401
  const mw4 = await middleware({ env, request: new Request('https://c.pages.dev/api/jobs/job-live-run2/delete', { method: 'POST' }), next: async () => new Response('passed') });
  assert.equal(mw4.status, 401);
  // finish, then a late workflow_run event for an unknown run of the deleted job
  gh[A].runs.get('7001').status = 'completed';
  assert.equal((await deleteUntilSettled(env, 'job-live-run2')).body.state, 'done');
  const settings = await dbm.getSettings(env.DB);
  const out = await wh.handleWorkflowRun(env.DB, env, settings, 'gemini', { runId: '7999', status: 'completed', conclusion: 'cancelled', displayTitle: 'job-live-run2 (draft)', startedAt: iso(-60), updatedAt: iso() }, { repo: A });
  assert.equal(out.ignored, 'deleted-job');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM runs'), 0);
});

test('two tabs: the second request while the first holds the lease answers busy', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  await env.DB.prepare(`INSERT INTO deletions (job_id, state, plan, done, lease_owner, lease_exp, created_at, updated_at)
    VALUES ('job-mvv23xmk-0hlhyv', 'active', ?, '{}', 'other-tab', ?, 1, 1)`)
    .bind(JSON.stringify({ v: 1, jobs: [{ id: 'job-mvv23xmk-0hlhyv' }], runs: [], files: {}, counts: {} }), Date.now() + 30e3).run();
  const r = await callDelete(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.status, 202);
  assert.equal(r.body.state, 'busy');
  assert.equal(calls.length, 0);
});

test('missing GitHub token: refused, nothing deleted (no orphaned GitHub data)', async () => {
  const env = await makeEnv();
  await seedFailedJob(env);
  delete env.GITHUB_TOKEN;
  const r = await callDelete(env, 'job-mvv23xmk-0hlhyv');
  assert.equal(r.status, 409);
  assert.ok(await dbm.getJob(env.DB, 'job-mvv23xmk-0hlhyv'));
});

/* ---------------- UI: confirm sheet wording ---------------- */
const delUi = await import(`${ROOT}assets/js/delete.js`);
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

test('confirm sheet lists exactly what goes; published = one line "stays on YouTube"; no typed confirmation', () => {
  const plan = { counts: { attempts: 1, githubRuns: 3, savedFiles: 4, repoFiles: 2 }, youtubeStays: 0, beingMade: 0 };
  const s = delUi.summarize([plan]);
  assert.deepEqual(s.items, ['Dashboard record', '3 GitHub runs with their logs', '4 saved files on GitHub', '2 files in the code repository']);
  const html = delUi.confirmHtml([{ id: 'x', title: 'T', statusLabel: 'Didn’t finish' }], [plan]);
  assert.doesNotMatch(html, /YouTube/);
  assert.match(html, /doesn’t give back today’s upload slot/);
  const pub = delUi.confirmHtml([{ id: 'x', title: 'T' }], [{ ...plan, youtubeStays: 2 }]);
  assert.equal((pub.match(/stays on YouTube/g) || []).length, 1);
  assert.match(pub, /nothing is deleted from YouTube/);
  const making = delUi.confirmHtml([{ id: 'x', title: 'T' }], [{ ...plan, beingMade: 1 }]);
  assert.match(making, /stopped first/);
  const bulk = delUi.summarize([plan, { ...plan, youtubeStays: 1 }, { counts: { attempts: 1 }, uploading: true }]);
  assert.equal(bulk.items[0], '3 dashboard records');
  assert.equal(bulk.onYouTube, 1);
  assert.equal(bulk.uploading, 1);
  const src = read('assets/js/delete.js') + read('assets/js/pages/queue.js');
  assert.doesNotMatch(src, /type DELETE|youtubeConfirm|youtube-confirm/i, 'no typed-DELETE step, no YouTube flag');
  assert.match(read('assets/js/pages/queue.js'), /danger-zone/);
  assert.match(read('assets/js/pages/queue.js'), /bulk-delete/);
  // Delete never sits next to Approve in the sticky action bar
  const foot = read('assets/js/pages/queue.js').split('const foot =')[1].split(';')[0];
  assert.doesNotMatch(foot, /delete/i);
});

test('server code never calls YouTube and safeguards are unchanged', () => {
  const lib = read('functions/api/_lib/deletejob.js') + read('functions/api/jobs/[id]/delete.js');
  assert.doesNotMatch(lib, /googleapis|youtube\/v3|videos\.delete/i);
  const dbSrc = read('functions/api/_lib/db.js');
  assert.match(dbSrc, /visibility: 'private', dailyCap: 2/);
  assert.match(dbSrc, /reviewRequired: true, autoPublish: false/);
});
