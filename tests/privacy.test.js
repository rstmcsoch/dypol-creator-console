/**
 * Per-click upload visibility (5 Nov 2026): the review sheet offers Upload private / Upload unlisted /
 * Publish public. POST /api/jobs/:id/publish and /approve take an optional `privacy_status`
 * (private|unlisted|public; public needs confirm_public "PUBLISH"), validated before anything changes,
 * and dispatch it as `privacy` (+ `privacy_status`, same value). Every existing gate still applies.
 * Also: the review sheet is a centred popup (drawer--popup) and Esc closes only the top layer.
 * Run: node --test tests/privacy.test.js
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const gh = await import(`${ROOT}functions/api/_lib/github.js`);
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const pub = await import(`${ROOT}functions/api/_lib/publish.js`);
const settingsApi = await import(`${ROOT}functions/api/settings.js`);
const { onRequestPost: publishPost } = await import(`${ROOT}functions/api/jobs/[id]/publish.js`);
const { onRequestPost: approvePost } = await import(`${ROOT}functions/api/jobs/[id]/approve.js`);
const layers = await import(`${ROOT}assets/js/layers.js`);
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const iso = (s = 0) => new Date(Date.now() + s * 1000).toISOString();

let calls, routes, realFetch;
beforeEach(() => {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const method = (opts.method || 'GET').toUpperCase();
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts); // dev server
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match(u)) {
        const { status = 200, body = null } = r.res;
        return new Response(body === null ? null : JSON.stringify(body), { status });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const route = (method, match, res) => routes.push({ method, match: (u) => u.includes(match), res });
const dispatches = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/dispatches'));

async function makeEnv() {
  wh._resetSchemaCache(); gh._resetInputsCache(); settingsApi._resetTokenCache();
  const DB = createD1(read('schema.sql'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'w', SESSION_SECRET: 's', __noRetryWait: true };
}
async function addJob(env, over = {}) {
  const j = { id: over.id || `job-${Math.random().toString(36).slice(2, 8)}`, engine: 'gemini', title: `Topic ${Math.random()}`, topic: 'x',
    niche: 'tech', format: 'long-form', status: 'needs-review', stage: '', progress: null, description: 'd', tags: ['a'],
    createdAt: iso(-3600), updatedAt: iso(-60), quality: {}, logs: [], runId: '700', ...over };
  await dbm.insertJob(env.DB, j);
  return dbm.getJob(env.DB, j.id);
}
const ctx = (env, params, body = {}) => ({ env, params, request: new Request('https://c.pages.dev/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

/* ---------------- validation ---------------- */
test('privacy_status: absent → Settings default; valid values pass; anything else is a 400', () => {
  assert.deepEqual(pub.parsePrivacyStatus({}), { ok: true, value: null });
  assert.deepEqual(pub.parsePrivacyStatus({ privacy_status: '' }), { ok: true, value: null });
  assert.deepEqual(pub.parsePrivacyStatus({ privacy_status: 'private' }), { ok: true, value: 'private' });
  assert.deepEqual(pub.parsePrivacyStatus({ privacy_status: 'unlisted' }), { ok: true, value: 'unlisted' });
  for (const bad of ['PUBLIC', 'secret', 'Private ', 1, true, ['public'], { v: 'public' }]) {
    const r = pub.parsePrivacyStatus({ privacy_status: bad });
    assert.equal(r.ok, false, `rejects ${JSON.stringify(bad)}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'validation');
  }
  const noConfirm = pub.parsePrivacyStatus({ privacy_status: 'public' });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.body.code, 'confirm-public');
  assert.equal(pub.parsePrivacyStatus({ privacy_status: 'public', confirm_public: 'publish' }).ok, false, 'exact PUBLISH only');
  assert.deepEqual(pub.parsePrivacyStatus({ privacy_status: 'public', confirm_public: 'PUBLISH' }), { ok: true, value: 'public' });
});

test('publish: privacy_status is dispatched as privacy (and privacy_status) with the same value', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'approved' });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 701 } });
  const res = await publishPost(ctx(env, { id: job.id }, { privacy_status: 'private' }));
  assert.equal(res.status, 202);
  const d = dispatches()[0];
  assert.equal(d.body.inputs.privacy, 'private');
  if ('privacy_status' in d.body.inputs) assert.equal(d.body.inputs.privacy_status, 'private');
  const body = await res.json();
  assert.match(body.message, /Uploading as private/);
});

test('publish: invalid privacy_status → 400, nothing dispatched, job untouched', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'approved' });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 702 } });
  const res = await publishPost(ctx(env, { id: job.id }, { privacy_status: 'everyone' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'validation');
  const pubNoType = await publishPost(ctx(env, { id: job.id }, { privacy_status: 'public' }));
  assert.equal(pubNoType.status, 400);
  assert.equal((await pubNoType.json()).code, 'confirm-public');
  assert.equal(dispatches().length, 0);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'approved');
});

test('publish: no privacy_status keeps the Settings visibility', async () => {
  const env = await makeEnv();
  const job = await addJob(env, { status: 'approved' });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 703 } });
  const res = await publishPost(ctx(env, { id: job.id }, {}));
  assert.equal(res.status, 202);
  assert.equal(dispatches()[0].body.inputs.privacy, 'unlisted');
});

test('approve: invalid privacy_status → 400 before anything changes', async () => {
  const env = await makeEnv();
  const job = await addJob(env);
  const res = await approvePost(ctx(env, { id: job.id }, { privacy_status: 'loud' }));
  assert.equal(res.status, 400);
  assert.equal((await dbm.getJob(env.DB, job.id)).status, 'needs-review');
  assert.equal(dispatches().length, 0);
});

test('approve: Publish public with PUBLISH typed approves + dispatches public', async () => {
  const env = await makeEnv();
  const job = await addJob(env);
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 704 } });
  const res = await approvePost(ctx(env, { id: job.id }, { privacy_status: 'public', confirm_public: 'PUBLISH' }));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.approved, true);
  assert.equal(dispatches()[0].body.inputs.privacy, 'public');
  const j = await dbm.getJob(env.DB, job.id);
  assert.equal(j.status, 'uploading');
});

test('approve: gates still hold with privacy_status (needs-fixes confirm, duplicate, state)', async () => {
  const env = await makeEnv();
  const fx = await addJob(env, { quality: { engine: { verdict: 'needs_fixes', failures: ['peak too loud'] } } });
  const r1 = await approvePost(ctx(env, { id: fx.id }, { privacy_status: 'private' }));
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).code, 'needs-fixes');
  const dup = await addJob(env, { quality: { duplicate: { state: 'failed' } } });
  const r2 = await approvePost(ctx(env, { id: dup.id }, { privacy_status: 'private' }));
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).code, 'duplicate');
  const done = await addJob(env, { status: 'published' });
  const r3 = await approvePost(ctx(env, { id: done.id }, { privacy_status: 'unlisted' }));
  assert.equal(r3.status, 409);
  assert.equal(dispatches().length, 0);
});

/* ---------------- Esc layering + popup ---------------- */
test('Esc closes only the top layer: confirm first, then the popup', () => {
  assert.equal(layers.escapeTarget({ modalOpen: true, drawerOpen: true }), 'modal');
  assert.equal(layers.escapeTarget({ modalOpen: false, drawerOpen: true }), 'drawer');
  assert.equal(layers.escapeTarget({ modalOpen: true, drawerOpen: false }), 'modal');
  assert.equal(layers.escapeTarget({}), null);
  const app = read('assets/js/app.js');
  const handler = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf("document.getElementById('modal-wrap').addEventListener"));
  assert.match(handler, /escapeTarget\(/);
  assert.match(handler, /if \(target === 'modal'\) closeModal\(\);\s*else if \(target === 'drawer'\) closeDrawer\(\);/);
  assert.ok(!/closeDrawer\(\);\s*closeModal\(\);/.test(handler), 'no longer closes both at once');
});

test('review sheet is a centred popup; the technical-history drawer stays a side sheet', () => {
  assert.equal(layers.popupKind('review'), true);
  assert.equal(layers.popupKind(''), false);
  const ui = read('assets/js/ui.js');
  assert.match(ui, /classList\.toggle\('drawer--popup', popup\)/);
  const q = read('assets/js/pages/queue.js');
  assert.match(q, /openDrawer\(\{[^}]*kind: 'review' \}\)/);
  assert.match(q, /dataset\.kind = 'review'/);
  const runs = read('assets/js/pages/runs.js');
  assert.match(runs, /openDrawer\(\{ title: 'Run details', body, foot \}\)/);
  assert.match(runs, /dataset\.kind = ''/);
  const css = read('assets/css/reskin.css');
  const block = css.slice(css.indexOf('.drawer.drawer--popup {'));
  assert.match(block, /width: 90vw; height: 90vh/);
  assert.match(block, /transform: translate\(-50%, -50%\) scale\(\.96\)/);
  assert.match(block, /@media \(max-width: 768px\)[\s\S]*?width: 100vw/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(block, /transition: transform var\(--dur-med\) var\(--ease-out\), opacity var\(--dur-med\) var\(--ease-out\)/);
  const html = read('index.html');
  assert.match(html, /id="drawer-scrim"/);
  assert.match(html, /id="drawer-close"/);
});

test('review sheet offers three upload options, each behind a confirm; Public needs PUBLISH typed', () => {
  const q = read('assets/js/pages/queue.js');
  for (const [ps, label] of [['private', 'Upload private'], ['unlisted', 'Upload unlisted'], ['public', 'Publish public']]) {
    assert.match(q, new RegExp(`uploadBtn\\('${ps}', '${label}'`));
  }
  const fn = q.slice(q.indexOf('async function uploadWithPrivacy'), q.indexOf('/** Second, explicit confirm'));
  assert.match(fn, /fixesConfirm\(j\)/, 'needs-fixes confirm still first');
  assert.match(fn, /privacyConfirm\(/);
  assert.match(fn, /privacy_status: ps/);
  assert.match(fn, /confirm_public = 'PUBLISH'/);
  assert.match(fn, /canApprove \? 'approve' : 'publish'/);
  assert.match(fn, /b\.disabled = true; \/\/ double-submission guard/);
  assert.match(fn, /input\.value\.trim\(\) === 'PUBLISH'/);
  // Existing actions stay.
  assert.match(q, /btn\('approve', 'Approve & publish'/);
  assert.match(q, /btn\('regenerate', 'Redo'/);
  assert.match(q, /btn\('reject', 'Reject'/);
});

/* ---------------- dev server mirror ---------------- */
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;
let server; let cookie = '';
async function req(method, p, body) {
  const res = await realFetchDev(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
const realFetchDev = globalThis.fetch;
before(async () => {
  server = spawn('node', [path.join(new URL('..', import.meta.url).pathname, 'dev', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DYPOL_ADMIN_PASSWORD: 'pw' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await realFetchDev(`${BASE}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await req('POST', '/api/auth/login', { password: 'pw' });
});
after(() => { server?.kill('SIGTERM'); });

test('dev server mirrors privacy_status validation on /publish and /approve', async () => {
  const list = await req('GET', '/api/jobs');
  const review = list.data.jobs.find((j) => j.status === 'needs-review');
  assert.ok(review, 'demo data has a video waiting for review');
  const bad = await req('POST', `/api/jobs/${review.id}/approve`, { privacy_status: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'validation');
  const noType = await req('POST', `/api/jobs/${review.id}/approve`, { privacy_status: 'public' });
  assert.equal(noType.status, 400);
  assert.equal(noType.data.code, 'confirm-public');
  const still = await req('GET', `/api/jobs/${review.id}`);
  assert.equal(still.data.job.status, 'needs-review', 'nothing changed');
  const badPub = await req('POST', `/api/jobs/${review.id}/publish`, { privacy_status: 7 });
  assert.equal(badPub.status, 400);
  const ok = await req('POST', `/api/jobs/${review.id}/approve`, { privacy_status: 'private' });
  assert.ok([202, 409, 423].includes(ok.status), `approve+publish ran the gates (got ${ok.status})`);
  if (ok.status === 202) {
    const j = await req('GET', `/api/jobs/${review.id}`);
    assert.ok(j.data.job.logs.some((l) => /visibility=private/.test(l.msg)));
  }
});
