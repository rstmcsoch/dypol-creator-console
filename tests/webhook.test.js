/**
 * GitHub webhook → live progress tests.
 * Run: node --test tests/webhook.test.js
 *
 * Covers: X-Hub-Signature-256 verification (constant-time, raw body),
 * middleware exemption (no session, POST only), event mapping helpers,
 * run linking (run id / job_id in run-name / dispatch time), workflow_run +
 * workflow_job end-to-end against a real SQLite-backed D1 shim, failing-step
 * propagation, replay guard, allowlist, and the progress endpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const { onRequestPost: webhookPost } = await import(`${ROOT}functions/api/webhooks/github.js`);
const { onRequestGet: jobProgressGet } = await import(`${ROOT}functions/api/jobs/[id]/progress.js`);
const { onRequestGet: runProgressGet } = await import(`${ROOT}functions/api/runs/[id]/progress.js`);
const { onRequest: middleware } = await import(`${ROOT}functions/api/_middleware.js`);

const SECRET = 'test-webhook-secret-not-real';
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
let deliverySeq = 0;

function makeEnv() {
  wh._resetSchemaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  return { DB, GITHUB_WEBHOOK_SECRET: SECRET };
}

async function deliver(env, event, payload, { signature, delivery } = {}) {
  const body = JSON.stringify(payload);
  const req = new Request('https://dypol-creator-console.pages.dev/api/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery || `d-${++deliverySeq}`,
      ...(signature === null ? {} : { 'X-Hub-Signature-256': signature || sign(body) }),
    },
    body,
  });
  const res = await webhookPost({ request: req, env });
  return { status: res.status, data: await res.json() };
}

const REPO_A = { full_name: 'rstmcsoch/gemini-youtube-automation' };
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();

async function seed(env, { jobId = 'job-abc123', startedAt = iso(-30) } = {}) {
  await dbm.saveSettings(env.DB, { github: { gemini: { repo: 'rstmcsoch/gemini-youtube-automation', workflow: 'main.yml' } } });
  await dbm.insertJob(env.DB, {
    id: jobId, engine: 'gemini', title: `Topic for ${jobId}`, topic: 'x', niche: 'general', format: 'long-form',
    status: 'dispatched', stage: 'workflow_dispatch sent', progress: null, description: '', tags: [],
    createdAt: startedAt, updatedAt: startedAt, quality: {}, logs: [], runId: null,
  });
  await dbm.insertRun(env.DB, {
    id: `run-${jobId}`, runId: null, engine: 'gemini', workflow: 'main.yml', jobId, startedAt,
    durationSec: null, status: 'in-progress', failureReason: null,
    githubUrl: 'https://github.com/rstmcsoch/gemini-youtube-automation/actions', steps: [], logs: [], artifacts: [],
  });
}

const wrPayload = (action, over = {}) => ({
  action, repository: REPO_A,
  workflow_run: {
    id: 9001, name: 'Main', display_title: 'Main', event: 'workflow_dispatch',
    status: action === 'completed' ? 'completed' : action === 'requested' ? 'queued' : 'in_progress',
    conclusion: null, html_url: 'https://github.com/rstmcsoch/gemini-youtube-automation/actions/runs/9001',
    created_at: iso(-20), run_started_at: iso(-20), updated_at: iso(0), path: '.github/workflows/main.yml',
    ...over,
  },
});
const wjPayload = (action, steps, over = {}) => ({
  action, repository: REPO_A,
  workflow_job: {
    id: 555, run_id: 9001, name: 'build', status: action === 'completed' ? 'completed' : 'in_progress',
    conclusion: null, html_url: 'https://github.com/rstmcsoch/gemini-youtube-automation/actions/runs/9001/job/555',
    started_at: iso(-15), completed_at: null, steps, ...over,
  },
});

/* ---------------- signature verification ---------------- */

test('verifySignature accepts a valid HMAC-SHA256 over the raw body', async () => {
  const body = '{"zen":"Keep it logically awesome."}';
  assert.equal(await wh.verifySignature(SECRET, body, sign(body)), true);
  assert.equal(await wh.verifySignature(SECRET, new TextEncoder().encode(body), sign(body)), true);
  assert.equal(await wh.verifySignature(SECRET, body, sign(body).toUpperCase().replace('SHA256=', 'sha256=')), true);
});

test('verifySignature rejects wrong secret, tampered body, bad/missing header, empty secret', async () => {
  const body = '{"a":1}';
  assert.equal(await wh.verifySignature(SECRET, body, sign(body, 'other-secret')), false);
  assert.equal(await wh.verifySignature(SECRET, '{"a":2}', sign(body)), false);
  assert.equal(await wh.verifySignature(SECRET, body, null), false);
  assert.equal(await wh.verifySignature(SECRET, body, ''), false);
  assert.equal(await wh.verifySignature(SECRET, body, sign(body).replace('sha256=', 'sha1=')), false);
  assert.equal(await wh.verifySignature(SECRET, body, 'sha256=deadbeef'), false);
  assert.equal(await wh.verifySignature('', body, sign(body, '')), false);
});

test('timingSafeEqual compares full strings including length', () => {
  assert.equal(wh.timingSafeEqual('abc', 'abc'), true);
  assert.equal(wh.timingSafeEqual('abc', 'abd'), false);
  assert.equal(wh.timingSafeEqual('abc', 'abcd'), false);
  assert.equal(wh.timingSafeEqual('abcd', 'abc'), false);
  assert.equal(wh.timingSafeEqual('', ''), true);
});

test('handler: unsigned / badly signed / unconfigured deliveries are rejected', async () => {
  const env = makeEnv();
  assert.equal((await deliver(env, 'ping', { zen: 'x' }, { signature: null })).status, 401);
  assert.equal((await deliver(env, 'ping', { zen: 'x' }, { signature: sign('{}') })).status, 401);
  assert.equal((await deliver({ ...env, GITHUB_WEBHOOK_SECRET: '' }, 'ping', { zen: 'x' })).status, 503);
  const ok = await deliver(env, 'ping', { zen: 'x', hook_id: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.pong, true);
});

/* ---------------- middleware ---------------- */

test('middleware: webhook route bypasses session auth (POST only); other routes still need a session', async () => {
  const next = () => new Response('next', { status: 299 });
  const env = { SESSION_SECRET: 's' };
  const post = await middleware({ request: new Request('https://x.dev/api/webhooks/github', { method: 'POST', body: '{}' }), env, next });
  assert.equal(post.status, 299);
  const get = await middleware({ request: new Request('https://x.dev/api/webhooks/github'), env, next });
  assert.equal(get.status, 405);
  const jobs = await middleware({ request: new Request('https://x.dev/api/jobs'), env, next });
  assert.equal(jobs.status, 401);
  const progress = await middleware({ request: new Request('https://x.dev/api/jobs/j1/progress'), env, next });
  assert.equal(progress.status, 401, 'progress endpoint stays behind the session');
});

/* ---------------- mapping helpers ---------------- */

test('mapRunStatus / mapStepStatus', () => {
  assert.equal(wh.mapRunStatus('queued', null), 'queued');
  assert.equal(wh.mapRunStatus('requested', null), 'queued');
  assert.equal(wh.mapRunStatus('in_progress', null), 'in-progress');
  assert.equal(wh.mapRunStatus('completed', 'success'), 'completed');
  assert.equal(wh.mapRunStatus('completed', 'failure'), 'failed');
  assert.equal(wh.mapRunStatus('completed', 'timed_out'), 'failed');
  assert.equal(wh.mapRunStatus('completed', 'cancelled'), 'cancelled');
  assert.equal(wh.mapStepStatus('completed', 'success'), 'done');
  assert.equal(wh.mapStepStatus('completed', 'failure'), 'failed');
  assert.equal(wh.mapStepStatus('completed', 'skipped'), 'skipped');
  assert.equal(wh.mapStepStatus('in_progress', null), 'running');
  assert.equal(wh.mapStepStatus('queued', null), 'pending');
});

test('engineForRepo allowlist + workflowMatches', () => {
  assert.equal(wh.engineForRepo('rstmcsoch/gemini-youtube-automation', {}), 'gemini');
  assert.equal(wh.engineForRepo('RSTMCSOCH/youtube-shorts-pipeline', {}), 'verticals');
  assert.equal(wh.engineForRepo('someone/else', {}), null);
  assert.equal(wh.engineForRepo('rstmcsoch/dypol-creator-console', {}), null);
  assert.equal(wh.workflowMatches('.github/workflows/main.yml', 'main.yml'), true);
  assert.equal(wh.workflowMatches('.github/workflows/ci.yml', 'main.yml'), false);
  assert.equal(wh.workflowMatches(undefined, 'main.yml'), true);
});

test('findLocalRun: run id, then job_id in run-name, then dispatch time window', () => {
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  const runs = [
    { id: 'a', runId: '77', engine: 'gemini', jobId: 'job-a', startedAt: new Date(t0).toISOString() },
    { id: 'b', runId: null, engine: 'gemini', jobId: 'job-b', startedAt: new Date(t0 - 3600e3).toISOString() },
    { id: 'c', runId: null, engine: 'gemini', jobId: 'job-c', startedAt: new Date(t0 + 60e3).toISOString() },
  ];
  assert.equal(wh.findLocalRun(runs, 'gemini', { runId: '77' }).by, 'run_id');
  const byJob = wh.findLocalRun(runs, 'gemini', { runId: '78', displayTitle: 'Draft · job-b' });
  assert.deepEqual([byJob.run.id, byJob.by], ['b', 'job_id']);
  const byTime = wh.findLocalRun(runs, 'gemini', { runId: '79', event: 'workflow_dispatch', startedAt: new Date(t0 + 90e3).toISOString() });
  assert.deepEqual([byTime.run.id, byTime.by], ['c', 'time']);
  assert.equal(wh.findLocalRun(runs, 'gemini', { runId: '80', event: 'schedule', startedAt: new Date(t0 + 90e3).toISOString() }).run, null);
  assert.equal(wh.findLocalRun(runs, 'verticals', { runId: '77' }).run, null);
});

test('summarizeSteps: current step, failing step and counts', () => {
  const s = wh.summarizeSteps([{ name: 'build', status: 'in_progress', steps: [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
    { number: 2, name: 'Generate script', status: 'in_progress' },
    { number: 3, name: 'Render', status: 'queued' },
  ] }]);
  assert.equal(s.current.step, 'Generate script');
  assert.equal(s.failing, null);
  assert.deepEqual([s.finished, s.total], [1, 3]);
  const f = wh.summarizeSteps([{ name: 'build', status: 'completed', conclusion: 'failure', steps: [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
    { number: 2, name: 'Render video', status: 'completed', conclusion: 'failure' },
    { number: 3, name: 'Upload', status: 'completed', conclusion: 'skipped' },
  ] }]);
  assert.deepEqual(f.failing, { job: 'build', step: 'Render video' });
  assert.match(wh.failureText(f.failing), /Step “Render video” failed in job “build”/);
});

test('ensureProgressSchema upgrades a pre-003 database in place', async () => {
  wh._resetSchemaCache();
  const DB = createD1(`CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT);`);
  await wh.ensureProgressSchema(DB);
  await wh.ensureProgressSchema(DB, { force: true }); // idempotent
  const cols = (t) => DB._raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['conclusion', 'current_step', 'completed_at', 'updated_at']) assert.ok(cols('runs').includes(c), c);
  assert.ok(cols('jobs').includes('current_step'));
  assert.ok(cols('job_steps').includes('number'));
  assert.ok(cols('gh_jobs').includes('html_url'));
});

/* ---------------- end-to-end event mapping ---------------- */

test('workflow_run + workflow_job: link, live steps, failing step marks job failed', async () => {
  const env = makeEnv();
  await seed(env);

  // requested → linked by job_id in run-name
  let r = await deliver(env, 'workflow_run', wrPayload('requested', { display_title: 'Gemini draft job-abc123' }));
  assert.equal(r.status, 200);
  assert.equal(r.data.by, 'job_id');
  let job = await dbm.getJob(env.DB, 'job-abc123');
  assert.equal(job.runId, '9001');
  assert.equal(job.status, 'dispatched');

  // job in progress with steps
  r = await deliver(env, 'workflow_job', wjPayload('in_progress', [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: iso(-15), completed_at: iso(-14) },
    { number: 2, name: 'Generate script', status: 'in_progress', started_at: iso(-14) },
    { number: 3, name: 'Render video', status: 'queued' },
  ]));
  assert.equal(r.data.currentStep, 'Generate script');
  job = await dbm.getJob(env.DB, 'job-abc123');
  assert.equal(job.status, 'running');
  assert.equal(job.stage, 'Running: Generate script');
  assert.equal(job.currentStep, 'Generate script');
  assert.equal(job.progress, 33);

  // replayed delivery id is ignored
  const dup = await deliver(env, 'workflow_job', wjPayload('in_progress', []), { delivery: 'same-id' });
  assert.equal(dup.status, 200);
  const dup2 = await deliver(env, 'workflow_job', wjPayload('in_progress', []), { delivery: 'same-id' });
  assert.equal(dup2.data.duplicate, true);

  // progress endpoint (while running)
  let pr = await (await jobProgressGet({ env, params: { id: 'job-abc123' } })).json();
  assert.equal(pr.progress.done, false);
  assert.equal(pr.progress.pollAfterMs, 7000);
  assert.equal(pr.progress.currentStep, 'Generate script');
  assert.equal(pr.progress.jobs[0].steps.length, 3);
  assert.equal(pr.progress.jobs[0].steps[1].status, 'running');
  assert.equal(pr.progress.run.htmlUrl, 'https://github.com/rstmcsoch/gemini-youtube-automation/actions/runs/9001');

  // job completes with a failing step
  r = await deliver(env, 'workflow_job', wjPayload('completed', [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: iso(-15), completed_at: iso(-14) },
    { number: 2, name: 'Generate script', status: 'completed', conclusion: 'success', started_at: iso(-14), completed_at: iso(-8) },
    { number: 3, name: 'Render video', status: 'completed', conclusion: 'failure', started_at: iso(-8), completed_at: iso(-1) },
  ], { conclusion: 'failure', completed_at: iso(-1) }));
  job = await dbm.getJob(env.DB, 'job-abc123');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Render video/);
  assert.equal(job.stage, 'Failed: Render video');

  // a late in_progress delivery must not regress the stored step
  await deliver(env, 'workflow_job', wjPayload('in_progress', [
    { number: 3, name: 'Render video', status: 'in_progress', started_at: iso(-8) },
  ]));
  const stepRow = env.DB._raw.prepare('SELECT status, conclusion FROM job_steps WHERE number = 3').get();
  assert.equal(stepRow.conclusion, 'failure');

  // run completes as failure → run row gets step-level reason + conclusion
  r = await deliver(env, 'workflow_run', wrPayload('completed', { conclusion: 'failure' }));
  assert.equal(r.data.status, 'failed');
  const run = env.DB._raw.prepare("SELECT * FROM runs WHERE id = 'run-job-abc123'").get();
  assert.equal(run.status, 'failed');
  assert.equal(run.conclusion, 'failure');
  assert.match(run.failure_reason, /Step “Render video” failed/);
  assert.ok(run.completed_at);
  assert.equal(r.data.fallback, null, 'no fallback without token / with Engine B disabled');

  pr = await (await jobProgressGet({ env, params: { id: 'job-abc123' } })).json();
  assert.equal(pr.progress.done, true);
  assert.equal(pr.progress.failingStep, 'Render video');
  const rp = await (await runProgressGet({ env, params: { id: 'run-job-abc123' } })).json();
  assert.equal(rp.progress.done, true);
  assert.equal(rp.progress.run.conclusion, 'failure');
});

test('workflow_run success → job ready for review (never published by the webhook)', async () => {
  const env = makeEnv();
  await seed(env, { jobId: 'job-ok1' });
  await deliver(env, 'workflow_run', wrPayload('in_progress', { id: 42, display_title: 'run' }));
  let job = await dbm.getJob(env.DB, 'job-ok1');
  assert.equal(job.runId, '42', 'linked by dispatch time');
  assert.equal(job.status, 'running');
  await deliver(env, 'workflow_run', wrPayload('completed', { id: 42, conclusion: 'success' }));
  job = await dbm.getJob(env.DB, 'job-ok1');
  assert.equal(job.status, 'needs-review');
  assert.equal(job.youtubeId, null);
  // late in_progress after completion: no regression
  await deliver(env, 'workflow_run', wrPayload('in_progress', { id: 42 }));
  job = await dbm.getJob(env.DB, 'job-ok1');
  assert.equal(job.status, 'needs-review');
  const run = env.DB._raw.prepare("SELECT status FROM runs WHERE id = 'run-job-ok1'").get();
  assert.equal(run.status, 'completed');
});

test('protected jobs (uploading/published) are never changed by webhook events', async () => {
  const env = makeEnv();
  await seed(env, { jobId: 'job-up' });
  await dbm.updateJob(env.DB, 'job-up', { status: 'uploading', runId: '7' });
  await dbm.updateRun(env.DB, 'run-job-up', { runId: '7' });
  await deliver(env, 'workflow_run', wrPayload('completed', { id: 7, conclusion: 'failure' }));
  assert.equal((await dbm.getJob(env.DB, 'job-up')).status, 'uploading');
});

test('ignored: other repos, untracked workflows, other events; unknown runs are recorded, not linked', async () => {
  const env = makeEnv();
  await seed(env, { jobId: 'job-z', startedAt: iso(-7200) });
  let r = await deliver(env, 'workflow_run', { ...wrPayload('completed'), repository: { full_name: 'evil/repo' } });
  assert.equal(r.status, 202);
  r = await deliver(env, 'workflow_run', wrPayload('completed', { path: '.github/workflows/ci.yml' }));
  assert.equal(r.status, 202);
  r = await deliver(env, 'push', { repository: REPO_A });
  assert.equal(r.status, 202);
  r = await deliver(env, 'workflow_run', wrPayload('in_progress', { id: 31337, event: 'schedule' }));
  assert.equal(r.status, 200);
  assert.equal(r.data.linked, false);
  assert.equal((await dbm.getJob(env.DB, 'job-z')).runId, null);
  assert.ok(env.DB._raw.prepare("SELECT id FROM runs WHERE id = 'run-gh-31337'").get());
  // workflow_job for an unlinked run (no token to fetch it): steps stored for later
  r = await deliver(env, 'workflow_job', wjPayload('in_progress', [{ number: 1, name: 'Set up job', status: 'in_progress' }], { run_id: 999 }));
  assert.equal(r.status, 200);
  assert.equal(r.data.linked, false);
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) n FROM job_steps WHERE gh_run_id = '999'").get().n, 1);
});

test('malformed JSON with a valid signature → 400', async () => {
  const env = makeEnv();
  const body = 'not json';
  const res = await webhookPost({ request: new Request('https://x.dev/api/webhooks/github', {
    method: 'POST', headers: { 'X-GitHub-Event': 'workflow_run', 'X-Hub-Signature-256': sign(body) }, body,
  }), env });
  assert.equal(res.status, 400);
});
