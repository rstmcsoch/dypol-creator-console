/**
 * Keep only the latest videos (22 Nov 2026): after a video reaches review,
 * older videos beyond the newest N are removed through the manual Delete path
 * (runDeletion). In-progress / uploading / queued videos are skipped, the
 * toggle off does nothing, and YouTube is never called.
 * Run: node --test tests/retention.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const ret = await import(`${ROOT}functions/api/_lib/retention.js`);
const del = await import(`${ROOT}functions/api/_lib/deletejob.js`);
const settingsEp = await import(`${ROOT}functions/api/settings.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';

/* Fake GitHub (empty repos). Any non-GitHub host — YouTube/Google included — fails the test. */
let calls, badHosts, realFetch;
beforeEach(() => {
  calls = []; badHosts = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ method: (opts.method || 'GET').toUpperCase(), url: String(url) });
    if (!/^api\.github\.com$/.test(u.hostname)) { badHosts.push(u.hostname); throw new Error(`unexpected host ${u.hostname}`); }
    const j = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (/\/actions\/runs$/.test(u.pathname)) return j(200, { total_count: 0, workflow_runs: [] });
    return j(404, { message: 'Not Found' });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? { key, body: null, text: async () => store.get(key) } : null; },
    async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })), truncated: false }; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  };
}

async function makeEnv(retention) {
  wh._resetSchemaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    ...(retention ? { retention } : {}),
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', SESSION_SECRET: 's', MEDIA: fakeBucket() };
}
/** n jobs, job-00 oldest … job-(n-1) newest; statuses by index override. */
async function seed(env, n, statuses = {}) {
  const base = Date.parse('2026-11-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const id = `job-${String(i).padStart(2, '0')}-ret`;
    const at = new Date(base + i * 3600e3).toISOString();
    await dbm.insertJob(env.DB, {
      id, engine: 'gemini', title: `Topic ${i}`, topic: `Topic ${i}`, niche: 'tech', format: 'long-form',
      status: statuses[i] || 'needs-review', stage: '', progress: null, description: 'd', tags: [],
      createdAt: at, updatedAt: at, quality: {}, logs: [], runId: null,
    });
    env.MEDIA.store.set(`drafts/${id}/manifest.json`, '{}');
    env.MEDIA.store.set(`drafts/${id}/video.mp4`, 'x');
  }
}
const ids = async (env) => (await env.DB.prepare('SELECT id FROM jobs ORDER BY created_at DESC').all()).results.map((r) => r.id);
const job = (i) => `job-${String(i).padStart(2, '0')}-ret`;

test('defaults: keep only the latest videos is ON with 8, min 3', async () => {
  assert.deepEqual(dbm.DEFAULT_SETTINGS.retention, { keepLatest: true, count: 8 });
  assert.deepEqual(ret.retentionOf({}), { enabled: true, count: 8 });
  assert.equal(ret.clampRetentionCount(1), 3);
  assert.equal(ret.clampRetentionCount('12'), 12);
  assert.equal(ret.clampRetentionCount('junk'), 8);
});

test('prune keeps the 8 newest and removes older ones through the manual Delete path (D1 + R2)', async () => {
  const env = await makeEnv();
  await seed(env, 12, { 1: 'published' });
  await env.DB.prepare("INSERT INTO uploads (id, job_id, youtube_id, at) VALUES ('u1', ?, 'yt-old', '2026-11-01')").bind(job(1)).run().catch(() => {});
  const settings = await dbm.getSettings(env.DB);
  const spy = []; const runDeletionFn = async (...a) => { spy.push(a[3]); return del.runDeletion(...a); };
  const out = await ret.pruneOldJobs(env.DB, env, settings, { maxPasses: 20, runDeletionFn });
  assert.deepEqual(out.deleted.sort(), [job(0), job(1), job(2), job(3)]);
  assert.deepEqual(spy.sort(), [job(0), job(1), job(2), job(3)]);
  assert.deepEqual(await ids(env), [11, 10, 9, 8, 7, 6, 5, 4].map(job));
  for (const i of [0, 1, 2, 3]) assert.ok(![...env.MEDIA.store.keys()].some((k) => k.startsWith(`drafts/${job(i)}/`)), `R2 drafts of ${job(i)} gone`);
  for (const i of [4, 11]) assert.ok(env.MEDIA.store.has(`drafts/${job(i)}/video.mp4`), `R2 drafts of ${job(i)} kept`);
  // Logged in the history feed (outlives the deleted job).
  const feed = (await env.DB.prepare("SELECT sub FROM activity WHERE title = 'Old video removed automatically'").all()).results.map((r) => r.sub);
  assert.equal(feed.length, 4);
  assert.ok(feed.some((s) => s.includes(job(1)) && s.includes('stays on YouTube')));
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM deletions').first().then((r) => r.n), 0);
  assert.deepEqual(badHosts, []);
  assert.ok(calls.every((c) => new URL(c.url).hostname === 'api.github.com'));
});

test('prune skips videos being made, queued, waiting to upload or uploading', async () => {
  const env = await makeEnv();
  await seed(env, 12, { 0: 'running', 1: 'uploading', 2: 'queued', 3: 'scheduled', 4: 'dispatched' });
  const out = await ret.pruneOldJobs(env.DB, env, await dbm.getSettings(env.DB), { maxPasses: 20 });
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(out.skipped.sort(), [job(0), job(1), job(2), job(3)]);
  assert.equal((await ids(env)).length, 12);

  const env2 = await makeEnv();
  await seed(env2, 11, { 0: 'rendering', 1: 'failed', 2: 'generating' });
  const out2 = await ret.pruneOldJobs(env2.DB, env2, await dbm.getSettings(env2.DB), { maxPasses: 20 });
  assert.deepEqual(out2.deleted, [job(1)]);
  assert.ok((await ids(env2)).includes(job(0)) && (await ids(env2)).includes(job(2)));
});

test('toggle off does nothing; a custom count is honoured', async () => {
  const env = await makeEnv({ keepLatest: false, count: 8 });
  await seed(env, 12);
  let called = 0;
  const out = await ret.pruneOldJobs(env.DB, env, await dbm.getSettings(env.DB), { maxPasses: 20, runDeletionFn: async () => { called++; return { state: 'done' }; } });
  assert.equal(out.enabled, false);
  assert.equal(called, 0);
  assert.equal((await ids(env)).length, 12);
  assert.equal(calls.length, 0);

  const env2 = await makeEnv({ keepLatest: true, count: 5 });
  await seed(env2, 7);
  await ret.pruneOldJobs(env2.DB, env2, await dbm.getSettings(env2.DB), { maxPasses: 20 });
  assert.deepEqual(await ids(env2), [6, 5, 4, 3, 2].map(job));
});

test('one deletion pass per trigger by default; the next trigger continues', async () => {
  const env = await makeEnv();
  await seed(env, 10);
  const s = await dbm.getSettings(env.DB);
  const a = await ret.pruneOldJobs(env.DB, env, s);
  assert.deepEqual(a.deleted, [job(0)]);
  assert.deepEqual(a.pending, [job(1)]);
  const b = await ret.pruneOldJobs(env.DB, env, s);
  assert.deepEqual(b.deleted, [job(1)]);
  assert.equal((await ids(env)).length, 8);
});

test('webhook "ready for review" triggers the prune in the background; other events do not', async () => {
  const src = readFileSync(`${ROOT}functions/api/webhooks/github.js`, 'utf8');
  assert.match(src, /body\?\.job === 'needs-review'\) pruneInBackground\(context\)/);
  const flow = readFileSync(`${ROOT}functions/api/_lib/jobflow.js`, 'utf8');
  assert.match(flow, /endsWith\(': needs-review'\)[\s\S]{0,200}pruneOldJobs/);
  const env = await makeEnv();
  await seed(env, 9);
  const waits = [];
  const p = ret.pruneInBackground({ env, waitUntil: (x) => waits.push(x) });
  assert.equal(waits.length, 1);
  const out = await p;
  assert.deepEqual(out.deleted, [job(0)]);
  assert.deepEqual(badHosts, []);
});

test('settings PUT stores the toggle and number (min 3)', async () => {
  const env = await makeEnv();
  const put = (body) => settingsEp.onRequestPut({ env, request: new Request('https://c.pages.dev/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let r = await put({ retention: { keepLatest: false, count: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual((await dbm.getSettings(env.DB)).retention, { keepLatest: false, count: 3 });
  r = await put({ publishing: { dailyCap: 2 } });
  assert.deepEqual((await dbm.getSettings(env.DB)).retention, { keepLatest: false, count: 3 });
  r = await put({ retention: { keepLatest: true, count: 10 } });
  assert.deepEqual((await dbm.getSettings(env.DB)).retention, { keepLatest: true, count: 10 });
  const ui = readFileSync(`${ROOT}assets/js/pages/settings.js`, 'utf8');
  assert.match(ui, /Keep only the latest videos/);
  assert.match(ui, /id="s-keep-n"/);
});
