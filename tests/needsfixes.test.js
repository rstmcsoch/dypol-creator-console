/**
 * "needs_fixes" from the engines (4 Nov 2026): hard automatic QC failures are read from the engine
 * result (Engine A dypol-results/<run>.json, Engine B dypol-drafts/<job>.json), stored as
 * quality.engine, shown as a badge in To check + the failed checks on the review sheet, and approval
 * (or scheduling) needs an explicit confirm. Run: node --test tests/needsfixes.test.js
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
const flow = await import(`${ROOT}functions/api/_lib/jobflow.js`);
const eq = await import(`${ROOT}functions/api/_lib/engineqc.js`);
const settingsApi = await import(`${ROOT}functions/api/settings.js`);
const { onRequestPost: webhookPost } = await import(`${ROOT}functions/api/webhooks/github.js`);
const { onRequestPost: approvePost } = await import(`${ROOT}functions/api/jobs/[id]/approve.js`);
const { onRequestPost: schedulePost } = await import(`${ROOT}functions/api/jobs/[id]/schedule.js`);
const { onRequestGet: jobGet } = await import(`${ROOT}functions/api/jobs/[id]/index.js`);
const { onRequestGet: jobsGet } = await import(`${ROOT}functions/api/jobs/index.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const SECRET = 'whsec-test';
const iso = (s = 0) => new Date(Date.now() + s * 1000).toISOString();
const b64 = (s) => Buffer.from(s).toString('base64');
const FAILS = ['long: true peak -0.2 dBTP (limit -1 dBTP)', 'short: picture static for 4.1 s at 12.0 s (limit 3.5 s)'];

let calls, routes, realFetch;
beforeEach(() => {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match(u)) {
        const { status = 200, body = null } = typeof r.res === 'function' ? await r.res(u) : r.res;
        return new Response(body === null ? null : JSON.stringify(body), { status });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const route = (method, match, res) => routes.push({ method, match: typeof match === 'string' ? (u) => u.includes(match) : (u) => match.test(u), res });
const file = (obj) => ({ body: { type: 'file', content: b64(JSON.stringify(obj)) } });

async function makeEnv() {
  wh._resetSchemaCache(); gh._resetInputsCache(); settingsApi._resetTokenCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: SECRET, SESSION_SECRET: 's', __noRetryWait: true };
}
async function addJob(env, over = {}) {
  const j = { id: over.id || `job-${Math.random().toString(36).slice(2, 8)}`, engine: 'gemini', title: `T ${Math.random()}`, topic: 'x',
    niche: 'tech', format: 'long-form', status: 'needs-review', stage: '', progress: null, description: 'd', tags: ['a'],
    createdAt: iso(-3600), updatedAt: iso(-60), quality: {}, logs: [], runId: null, ...over };
  await dbm.insertJob(env.DB, j);
  return dbm.getJob(env.DB, j.id);
}
const ctx = (env, params = {}, body = {}) => ({ env, params, request: new Request('https://c.pages.dev/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const getCtx = (env, params = {}, url = 'https://c.pages.dev/api/jobs') => ({ env, params, request: new Request(url), waitUntil: () => {} });
async function deliver(env, payload) {
  const body = JSON.stringify(payload);
  const res = await webhookPost({ env, request: new Request('https://c.pages.dev/api/webhooks/github', { method: 'POST', body, headers: {
    'X-GitHub-Event': 'workflow_run', 'X-GitHub-Delivery': `d-${Math.random()}`,
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}` } }) });
  return res.status;
}

test('verdictFrom reads both engines’ shapes; engineCheck labels it', () => {
  assert.deepEqual(eq.verdictFrom({ needs_fixes: true, quality: { verdict: 'needs_fixes', hard_failures: FAILS } }), { verdict: 'needs_fixes', failures: FAILS });
  assert.deepEqual(eq.verdictFrom({ needs_fixes: false, quality: { verdict: 'ok', hard_failures: [] } }), { verdict: 'ok', failures: [] });
  assert.equal(eq.verdictFrom({ status: 'draft_only' }), null, 'old results without a verdict');
  const c = eq.engineCheck({ verdict: 'needs_fixes', failures: FAILS });
  assert.equal(c.state, 'failed'); assert.match(c.label, /Needs fixes — 2 automatic checks failed/);
  assert.equal(eq.engineCheck(null).verdict, 'not_checked');
});

test('webhook: Engine A draft run completed with needs_fixes → To check, quality.engine failed, warn log', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'running', runId: '700' });
  await dbm.insertRun(env.DB, { id: 'r700', runId: '700', engine: 'gemini', workflow: 'main.yml', jobId: job.id, phase: 'draft', startedAt: iso(-600), status: 'in-progress', steps: [], logs: [], artifacts: [] });
  route('GET', '/contents/dypol-results/700.json?ref=dypol-integration', file({ job_id: job.id, status: 'draft_only', needs_fixes: true, quality: { verdict: 'needs_fixes', hard_failures: FAILS } }));
  route('GET', '/actions/runs/700/jobs', { body: { jobs: [] } });
  assert.equal(await deliver(env, { action: 'completed', repository: { full_name: A }, workflow_run: {
    id: 700, name: 'Main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: 'h', created_at: iso(-600),
    run_started_at: iso(-600), updated_at: iso(-2), path: '.github/workflows/main.yml' } }), 200);
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'needs-review');
  assert.equal(j.quality.engine.verdict, 'needs_fixes');
  assert.deepEqual(j.quality.engine.failures, FAILS);
  assert.match(j.stage, /needs fixes/);
  assert.ok(j.logs.some((l) => l.level === 'warn' && /needs fixes/.test(l.msg)));
});

test('reconcile: completed draft run reads the Engine B handoff dypol-drafts/<job>.json', async () => {
  const env = await makeEnv();
  const t0 = iso(-90000);
  const job = await addJob(env, { engine: 'verticals', status: 'dispatched', runId: '640', createdAt: t0, updatedAt: t0 });
  route('GET', '/actions/runs/640/jobs', { body: { jobs: [] } });
  route('GET', /\/actions\/runs\/640$/, { body: { id: 640, status: 'completed', conclusion: 'success', created_at: t0, updated_at: iso(-89000), html_url: 'h' } });
  route('GET', `/contents/dypol-drafts/${job.id}.json?ref=dypol-integration`, file({ job_id: job.id, needs_fixes: true, quality: { verdict: 'needs_fixes', hard_failures: ['en: resolution 540x960 is outside 720x1280-1080x1920'] } }));
  await flow.reconcileJobs(env.DB, env, await dbm.getSettings(env.DB), { force: true });
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'needs-review');
  assert.equal(j.quality.engine.verdict, 'needs_fixes');
  assert.match(j.quality.engine.failures[0], /resolution 540x960/);
});

test('approve: needs_fixes is refused without the explicit confirm; allowed (and logged) with it', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { runId: '800', quality: { engine: eq.engineCheck({ verdict: 'needs_fixes', failures: FAILS }) } });
  const r1 = await approvePost(ctx(env, { id: job.id }, {}));
  assert.equal(r1.status, 409);
  const b1 = await r1.json();
  assert.equal(b1.code, 'needs-fixes'); assert.deepEqual(b1.failures, FAILS);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'needs-review', 'nothing approved');
  assert.ok(!calls.some((c) => c.url.includes('/dispatches')), 'nothing dispatched');

  const r2 = await approvePost(ctx(env, { id: job.id }, { confirmNeedsFixes: true, publish: false }));
  assert.equal(r2.status, 200);
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'approved');
  assert.ok(j.logs.some((l) => /confirmed approval despite failed checks/.test(l.msg)));
});

test('approve: a draft without needs_fixes still approves with one confirm (unchanged)', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { runId: '810', quality: { engine: eq.engineCheck({ verdict: 'ok', failures: [] }) } });
  const r = await approvePost(ctx(env, { id: job.id }, { publish: false }));
  assert.equal(r.status, 200);
});

test('schedule cannot side-step the confirm', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { quality: { engine: eq.engineCheck({ verdict: 'needs_fixes', failures: FAILS }) } });
  const r = await schedulePost(ctx(env, { id: job.id }, { when: iso(86400) }));
  assert.equal(r.status, 409);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'needs-review');
});

test('GET job / list back-fill the verdict once for older drafts, then keep it', async () => {
  const env = await makeEnv();
  const a = await addJob(env, { runId: '901' });
  const b = await addJob(env, { engine: 'verticals', runId: '902' });
  route('GET', '/contents/dypol-results/901.json', file({ needs_fixes: true, quality: { verdict: 'needs_fixes', hard_failures: FAILS } }));
  route('GET', `/contents/dypol-drafts/${b.id}.json`, file({ needs_fixes: false, quality: { verdict: 'ok', hard_failures: [] } }));
  const res = await jobsGet(getCtx(env, {}, 'https://c.pages.dev/api/jobs?status=needs-review'));
  const data = await res.json();
  const byId = Object.fromEntries((data.data?.jobs || data.jobs).map((j) => [j.id, j]));
  assert.equal(byId[a.id].quality.engine.verdict, 'needs_fixes');
  assert.equal(byId[b.id].quality.engine.verdict, 'ok');
  const n = calls.filter((c) => c.url.includes('/contents/dypol-')).length;
  const one = await jobGet(getCtx(env, { id: a.id }));
  const jd = (await one.json());
  assert.deepEqual((jd.data?.job || jd.job).quality.engine.failures, FAILS, 'GET keeps quality.engine');
  await jobsGet(getCtx(env, {}, 'https://c.pages.dev/api/jobs?status=needs-review'));
  assert.equal(calls.filter((c) => c.url.includes('/contents/dypol-')).length, n, 'no second fetch');
});

test('UI: badge in To check, failed checks on the review sheet, approve only after a ticked confirm', () => {
  const q = readFileSync(`${ROOT}assets/js/pages/queue.js`, 'utf8');
  const ui = readFileSync(`${ROOT}assets/js/ui.js`, 'utf8');
  assert.match(ui, /export function needsFixesBadge/);
  assert.match(ui, />Needs fixes\$\{n \? ` · \$\{n\}` : ''\}<\/span>/);
  assert.match(q, /statusPill\(j\.status\)\}\$\{\['needs-review', 'awaiting-review'\]\.includes\(j\.status\) \? needsFixesBadge\(j\)/);
  assert.match(q, /id="needs-fixes" role="alert"/);
  assert.match(q, /fixes\.map\(\(f\) => `<li>\$\{esc\(f\)\}<\/li>`\)/);
  assert.match(q, /'Approve anyway…'/);
  assert.match(q, /id="fx-ok" disabled aria-disabled="true"/);
  assert.match(q, /payload = \{ confirmNeedsFixes: true \}/);
  assert.match(q, /Fix the failed checks: /, 'Redo pre-fills the failures as feedback');
  const css = readFileSync(`${ROOT}assets/css/app.css`, 'utf8');
  assert.match(css, /\.fixes__list/);
});
