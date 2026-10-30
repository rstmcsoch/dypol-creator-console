/**
 * Round 2 (30 Oct 2026): "Keep me signed in" sessions, ranged artifact
 * streaming (preview-first media), and the Quota & health panel.
 * Run: node --test tests/round2.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const util = await import(`${ROOT}functions/api/_lib/util.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const rz = await import(`${ROOT}functions/api/_lib/remotezip.js`);
const quota = await import(`${ROOT}functions/api/_lib/quota.js`);
const media = await import(`${ROOT}functions/api/jobs/[id]/media.js`);
const quotaApi = await import(`${ROOT}functions/api/quota.js`);
const { onRequestPost: loginPost } = await import(`${ROOT}functions/api/auth/login.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';

/* ---------------- helpers ---------------- */
function makeZip(entries, { stored = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rz-'));
  const zipPath = join(dir, 'a.zip');
  const py = join(dir, 'mk.py');
  const data = join(dir, 'data.json');
  writeFileSync(data, JSON.stringify(entries));
  writeFileSync(py, `
import json, zipfile
entries = json.load(open(${JSON.stringify(data)}))
stored = set(${JSON.stringify(stored)})
z = zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w')
for e in entries:
    z.writestr(e['name'], bytes(e['bytes']) if 'bytes' in e else e['content'],
               zipfile.ZIP_STORED if e['name'] in stored else zipfile.ZIP_DEFLATED)
z.close()
`);
  execSync(`python3 ${py}`);
  return new Uint8Array(readFileSync(zipPath));
}

const VIDEO = Array.from({ length: 300000 }, (_, i) => (i * 31 + 7) % 251);
const LONG_FULL = Array.from({ length: 200000 }, (_, i) => (i * 17) % 256);

let calls; let routes; let realFetch;
function mock() {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const h = opts.headers || {};
    calls.push({ url: u, method, range: h.Range || h.range || null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && r.match(u)) {
        const out = typeof r.res === 'function' ? await r.res(u, opts) : r.res;
        if (out instanceof Response) return out;
        const { status = 200, body = null, headers = {} } = out;
        return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
}
const route = (method, match, res) => routes.push({ method, match: typeof match === 'string' ? (u) => u.includes(match) : (u) => match.test(u), res });

/** A blob store that honours Range like Azure storage (or ignores it when rangeless). */
function blob(bytes, { rangeless = false } = {}) {
  return (u, opts = {}) => {
    const range = (opts.headers || {}).Range;
    if (!range || rangeless) return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    let [, a, b] = /bytes=(\d*)-(\d*)/.exec(range);
    let start; let end;
    if (a === '') { start = Math.max(0, bytes.length - Number(b)); end = bytes.length - 1; } else { start = Number(a); end = b === '' ? bytes.length - 1 : Math.min(Number(b), bytes.length - 1); }
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  };
}

async function makeEnv() {
  wh._resetSchemaCache();
  quota._resetQuotaSchema();
  media._resetMediaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', SESSION_SECRET: 's3cret' };
}
const getCtx = (env, url, params = {}, headers = {}) => ({ env, params, request: new Request(url, { headers }) });

beforeEach(mock);
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------------- sessions ---------------- */
test('login: default session is 7 days, "Keep me signed in" is 30 days; secure cookie flags kept', async () => {
  const salt = 'c2FsdA==';
  const env = await makeEnv();
  // Build a PBKDF2 hash the same way scripts/hash-password.cjs does, via util.verifyPassword's format.
  const hashOut = execSync(`node ${ROOT}scripts/hash-password.cjs pw-test-123`).toString();
  const stored = (/(pbkdf2[^\s'"]+)/.exec(hashOut) || [])[1];
  assert.ok(stored, `hash script printed a hash: ${hashOut.slice(0, 80)}`);
  env.ADMIN_PASSWORD_HASH = stored;
  const post = (body, ip) => ({ env, params: {}, request: new Request('https://c.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }) });
  for (const [body, days, ip] of [[{ password: 'pw-test-123' }, 7, '203.0.113.1'], [{ password: 'pw-test-123', remember: true }, 30, '203.0.113.2']]) {
    const res = await loginPost(post(body, ip));
    assert.equal(res.status, 200);
    const cookie = res.headers.get('Set-Cookie');
    assert.match(cookie, new RegExp(`Max-Age=${days * 86400}(;|$)`));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);
    const token = /dypol_session=([^;]+)/.exec(cookie)[1];
    assert.equal(await util.verifySessionToken(token, 's3cret'), true);
    const exp = Number(token.split('.')[0]);
    assert.ok(Math.abs(exp - (Date.now() + days * 86400e3)) < 60e3, 'token expiry matches cookie lifetime');
    void salt;
  }
  assert.equal(util.sessionDays('on'), 30);
  assert.equal(util.sessionDays(undefined), 7);
  assert.equal(util.sessionDays('false'), 7);
});

test('login page offers "Keep me signed in" and sends it', () => {
  const html = readFileSync(`${ROOT}index.html`, 'utf8');
  assert.match(html, /id="login-remember"/);
  assert.match(html, /Keep me signed in/);
  const app = readFileSync(`${ROOT}assets/js/app.js`, 'utf8');
  assert.match(app, /login-remember/);
  const api = readFileSync(`${ROOT}assets/js/api.js`, 'utf8');
  assert.match(api, /remember: !!remember/);
});

/* ---------------- remote zip ---------------- */
test('remotezip: lists a remote zip from its tail and streams a STORED entry with Range (206)', async () => {
  const zip = makeZip([{ name: 'preview_long.mp4', bytes: VIDEO }, { name: 'preview_short.mp4', bytes: VIDEO.slice(0, 5000) }], { stored: ['preview_long.mp4', 'preview_short.mp4'] });
  route('GET', 'blob.example/preview', blob(zip));
  const z = await rz.openRemoteZip('https://blob.example/preview');
  assert.deepEqual(z.entries.map((e) => e.name), ['preview_long.mp4', 'preview_short.mp4']);
  const e = z.entries[0];
  assert.equal(e.method, 0);
  const out = await rz.streamEntry(z.url, e, { range: 'bytes=1000-1999', contentType: 'video/mp4' });
  assert.equal(out.status, 206);
  assert.equal(out.headers['Content-Range'], `bytes 1000-1999/${VIDEO.length}`);
  assert.equal(out.headers['Content-Length'], '1000');
  const got = new Uint8Array(await new Response(out.body).arrayBuffer());
  assert.deepEqual([...got], VIDEO.slice(1000, 2000));
  // Never fetched the whole zip: every storage call was a Range request.
  assert.ok(calls.filter((c) => c.url.includes('blob.example')).every((c) => c.range));
  const whole = await rz.streamEntry(z.url, e, { dataOfs: out.dataOfs });
  assert.equal(whole.status, 200);
  assert.equal((await new Response(whole.body).arrayBuffer()).byteLength, VIDEO.length);
  assert.deepEqual(rz.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(rz.parseRange('bytes=500-', 100), { invalid: true });
});

test('remotezip: DEFLATE entry is inflated as a stream; Range-ignoring storage raises RangeUnsupported', async () => {
  const zip = makeZip([{ name: 'long_video_x.mp4', bytes: LONG_FULL }, { name: 'candidates/j1/candidate.json', content: '{"a":1}' }]);
  route('GET', 'blob.example/full', blob(zip));
  route('GET', 'blob.example/norange', blob(zip, { rangeless: true }));
  const z = await rz.openRemoteZip('https://blob.example/full');
  const e = z.entries.find((x) => x.name === 'long_video_x.mp4');
  assert.equal(e.method, 8);
  const out = await rz.streamEntry(z.url, e, { range: 'bytes=0-10' });
  assert.equal(out.status, 200, 'deflated entries answer 200 (no Range)');
  const got = new Uint8Array(await new Response(out.body).arrayBuffer());
  assert.deepEqual([...got], LONG_FULL);
  const json = await rz.readEntryBytes(z.url, z.entries[1]);
  assert.equal(new TextDecoder().decode(json), '{"a":1}');
  await assert.rejects(rz.openRemoteZip('https://blob.example/norange'), rz.RangeUnsupported);
});

/* ---------------- media endpoint ---------------- */
async function mediaEnv({ preview = true, rangeless = false } = {}) {
  const env = await makeEnv();
  await dbm.insertJob(env.DB, { id: 'job-m1', engine: 'gemini', title: 'T', topic: 't', niche: 'tech', format: 'long-form', status: 'needs-review', stage: '', progress: null, description: '', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quality: {}, logs: [], runId: '555' });
  const previewZip = makeZip([{ name: 'preview_long.mp4', bytes: VIDEO }, { name: 'preview_short.mp4', bytes: VIDEO.slice(0, 4000) }], { stored: ['preview_long.mp4', 'preview_short.mp4'] });
  const fullZip = makeZip([{ name: 'long_video_x.mp4', bytes: LONG_FULL }, { name: 'short_video_x.mp4', bytes: LONG_FULL.slice(0, 3000) }, { name: 'thumbnails_long_x/thumbnail.png', bytes: [137, 80, 78, 71] }]);
  route('GET', `/repos/${A}/actions/runs/555/artifacts`, { body: { artifacts: [
    { id: 1, name: 'dypol-candidate-job-m1', size_in_bytes: 100e6, expired: false },
    ...(preview ? [{ id: 2, name: 'preview-job-m1', size_in_bytes: previewZip.length, expired: false }] : []),
    { id: 3, name: 'dypol-result-555', size_in_bytes: 900, expired: false },
  ] } });
  route('GET', /actions\/artifacts\/1\/zip/, () => (rangeless ? new Response(fullZip, { status: 200 }) : new Response(null, { status: 302, headers: { Location: 'https://blob.example/full1' } })));
  route('GET', /actions\/artifacts\/2\/zip/, { status: 302, headers: { Location: 'https://blob.example/prev2' } });
  route('GET', 'blob.example/full1', blob(fullZip));
  route('GET', 'blob.example/prev2', blob(previewZip));
  return env;
}

test('media: video prefers the preview artifact and streams it with Range', async () => {
  const env = await mediaEnv();
  const res = await media.onRequestGet(getCtx(env, 'https://c.pages.dev/api/jobs/job-m1/media?kind=video', { id: 'job-m1' }, { Range: 'bytes=0-99' }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('X-DYPOL-Media-Source'), 'preview');
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], VIDEO.slice(0, 100));
  assert.ok(!calls.some((c) => c.url.includes('artifacts/1/zip')), 'full artifact untouched');
  const short = await media.onRequestGet(getCtx(env, 'https://c.pages.dev/api/jobs/job-m1/media?kind=short', { id: 'job-m1' }));
  assert.equal(short.status, 200);
  assert.equal((await short.arrayBuffer()).byteLength, 4000);
});

test('media: falls back to the full artifact without a preview; quality=full + download stays available', async () => {
  const env = await mediaEnv({ preview: false });
  const res = await media.onRequestGet(getCtx(env, 'https://c.pages.dev/api/jobs/job-m1/media?kind=video', { id: 'job-m1' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-DYPOL-Media-Source'), 'full');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], LONG_FULL);

  const env2 = await mediaEnv({ preview: true });
  const dl = await media.onRequestGet(getCtx(env2, 'https://c.pages.dev/api/jobs/job-m1/media?kind=video&quality=full&download=1', { id: 'job-m1' }));
  assert.equal(dl.headers.get('X-DYPOL-Media-Source'), 'full');
  assert.match(dl.headers.get('Content-Disposition'), /attachment; filename="long_video_x\.mp4"/);
  assert.equal((await dl.arrayBuffer()).byteLength, LONG_FULL.length);
  const th = await media.onRequestGet(getCtx(env2, 'https://c.pages.dev/api/jobs/job-m1/media?kind=thumb', { id: 'job-m1' }));
  assert.equal(th.headers.get('Content-Type'), 'image/png');
});

test('media: storage without Range support falls back to the whole-zip download', async () => {
  const env = await mediaEnv({ preview: false, rangeless: true });
  const res = await media.onRequestGet(getCtx(env, 'https://c.pages.dev/api/jobs/job-m1/media?kind=video', { id: 'job-m1' }));
  assert.equal(res.status, 200);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], LONG_FULL);
});

test('media: artifact ordering — preview first only for video/short', () => {
  const arts = [{ id: 1, name: 'dypol-candidate-x', sizeInBytes: 1e8 }, { id: 2, name: 'preview-x', sizeInBytes: 1e6 }, { id: 3, name: 'final-videos', sizeInBytes: 1e8 }];
  assert.deepEqual(media.orderArtifacts(arts, 'video', 'preview').map((a) => a.id), [2, 1, 3]);
  assert.deepEqual(media.orderArtifacts(arts, 'video', 'full').map((a) => a.id), [1, 3]);
  assert.deepEqual(media.orderArtifacts(arts, 'thumb', 'preview').map((a) => a.id), [1, 3]);
  assert.deepEqual(media.pickEntry(['preview_short.mp4'], 'video'), ['preview_short.mp4'], 'Engine B preview serves kind=video');
});

/* ---------------- quota panel ---------------- */
test('quota: log scanning finds FLUX / Pixabay limits, judge circuit and llm_unavailable', () => {
  const log = [
    '2026-10-30T07:01:00.0000000Z ⚠️ flux quota/limit hit (HTTP 429); skipping flux for the rest of this run and continuing',
    '2026-10-30T07:02:00.0000000Z ⚠️ pixabay quota/limit hit (HTTP 429); skipping pixabay',
    '⚠️ visual judge circuit open (3 consecutive timeouts); finishing with mechanical filters only.',
    'DYPOL_FAILURE_CATEGORY=llm_unavailable',
  ].join('\n');
  const s = quota.scanLog(log);
  assert.equal(s.flux, true);
  assert.match(s.fluxLine, /^⚠️ flux quota\/limit hit/);
  assert.equal(s.pixabay, true);
  assert.equal(s.judgeCircuit, '3 consecutive timeouts');
  assert.equal(s.llmUnavailable, true);
  const clean = quota.scanLog('Segment 1: Pixabay clip 123 (6s)\nAdded 2 FLUX frame(s)');
  assert.equal(clean.flux, false);
  assert.equal(clean.pixabay, false);
});

test('quota: judge summary from Engine A candidate.json and Engine B draft', () => {
  const a = quota.judgeFromJson({ visual_judge: { long: { judge_status: 'active', calls: 7, circuit: { state: 'closed' } }, short: { judge_status: 'active', calls: 3, circuit: { state: 'closed' } } }, provider_limits: { flux: { reason: 'HTTP 429' } } });
  assert.equal(a.status, 'active');
  assert.equal(a.calls, 10);
  assert.ok(a.providerLimits.flux);
  const b = quota.judgeFromJson({ visual_judge_status: 'disabled', visual_review_reasons: [] });
  assert.equal(b.status, 'disabled');
  assert.equal(quota.judgeFromJson({ nothing: 1 }), null);
});

function quotaRoutes({ today }) {
  route('GET', 'api.github.com/user', { body: { login: 'x' }, headers: { 'github-authentication-token-expiration': new Date(Date.now() + 40 * 86400e3).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') } });
  for (const [repo, wf, runId] of [[A, 'main.yml', '901'], [B, 'verticals.yml', '902']]) {
    route('GET', `/repos/${repo}/actions/cache/usage`, { body: { active_caches_size_in_bytes: 50 * 1024 * 1024 } });
    route('GET', `/repos/${repo}/actions/artifacts?per_page=100`, { body: { total_count: 2, artifacts: [
      { id: runId === '901' ? 11 : 12, name: runId === '901' ? 'dypol-candidate-j1' : 'draft-j2', size_in_bytes: 100 * 1024 * 1024, expired: false, created_at: today },
      { id: 99, name: 'old', size_in_bytes: 400 * 1024 * 1024, expired: true, created_at: today },
    ] } });
    route('GET', `/repos/${repo}/actions/workflows/${wf}/runs`, { body: { workflow_runs: [{ id: Number(runId), status: 'completed', conclusion: 'success', created_at: today }] } });
    route('GET', `/repos/${repo}/actions/runs/${runId}/jobs`, { body: { jobs: [{ id: Number(runId) * 10, name: 'build', status: 'completed', conclusion: 'success' }] } });
  }
  route('GET', '/actions/jobs/9010/logs', { status: 302, headers: { Location: 'https://logs.example/a' } });
  route('GET', '/actions/jobs/9020/logs', { status: 302, headers: { Location: 'https://logs.example/b' } });
  route('GET', 'logs.example/a', { body: '⚠️ flux quota/limit hit (HTTP 429); skipping flux\nall good' });
  route('GET', 'logs.example/b', { body: 'Segment 1: Pixabay clip 1 (6s)' });
  const candA = makeZip([{ name: 'long_video.mp4', bytes: [1, 2, 3] }, { name: 'candidates/j1/candidate.json', content: JSON.stringify({ visual_judge: { long: { judge_status: 'active', calls: 5, circuit: { state: 'closed' } } }, provider_limits: {} }) }]);
  const candB = makeZip([{ name: 'drafts/x.json', content: JSON.stringify({ visual_judge_status: 'active' }) }]);
  route('GET', /actions\/artifacts\/11\/zip/, { status: 302, headers: { Location: 'https://blob.example/ca' } });
  route('GET', /actions\/artifacts\/12\/zip/, { status: 302, headers: { Location: 'https://blob.example/cb' } });
  route('GET', 'blob.example/ca', blob(candA));
  route('GET', 'blob.example/cb', blob(candB));
}

test('quota API: per-engine panel within the subrequest budget, cached in D1 for 30 min', async () => {
  const env = await makeEnv();
  const now = new Date().toISOString();
  quotaRoutes({ today: now });
  await dbm.insertJob(env.DB, { id: 'job-p1', engine: 'gemini', title: 'P', topic: 'p', niche: 'tech', format: 'long-form', status: 'published', stage: '', progress: null, description: '', tags: [], createdAt: now, updatedAt: now, quality: {}, logs: [], runId: '1' });
  await dbm.updateJob(env.DB, 'job-p1', { publishedAt: now, youtubeId: 'vid1', videos: [{ kind: 'long', youtube_id: 'vid1' }, { kind: 'short', youtube_id: 'vid2' }] });
  await dbm.insertJob(env.DB, { id: 'job-f1', engine: 'verticals', title: 'F', topic: 'f', niche: 'tech', format: 'short', status: 'failed', stage: '', progress: null, description: '', tags: [], createdAt: now, updatedAt: now, quality: {}, logs: [], runId: '2' });
  await dbm.updateJob(env.DB, 'job-f1', { errorCategory: 'llm_unavailable', error: 'Gemini 503' });

  const res = await quotaApi.onRequestGet(getCtx(env, 'https://c.pages.dev/api/quota'));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.cached, false);
  assert.ok(d.subrequests.used <= quota.SUBREQUEST_BUDGET && d.subrequests.used < 50, `used ${d.subrequests.used}`);
  const ghCalls = calls.length;
  assert.ok(ghCalls < 50, `${ghCalls} fetches`);
  assert.equal(d.token.state, 'ok');
  assert.equal(d.youtube.capJobs, 2);
  assert.equal(d.youtube.videosToday, 2);
  const [ea, eb] = d.engines;
  assert.equal(ea.uploadsToday.videos, 2);
  assert.equal(ea.oauth.state, 'ok');
  assert.equal(ea.flux.state, 'bad');
  assert.equal(ea.pixabay.state, 'ok');
  assert.equal(ea.judge.calls, 5);
  assert.equal(ea.judge.state, 'ok');
  assert.equal(ea.storage.artifactBytes, 100 * 1024 * 1024, 'expired artifacts excluded');
  assert.equal(eb.llmUnavailable7d, 1);
  assert.equal(eb.flux.state, 'ok');
  assert.equal(d.storage.usedBytes, 300 * 1024 * 1024);
  assert.equal(d.storage.state, 'ok');

  // Second call within 30 min: served from D1, no GitHub calls at all.
  calls.length = 0;
  const again = await (await quotaApi.onRequestGet(getCtx(env, 'https://c.pages.dev/api/quota?refresh=1'))).json();
  assert.equal(again.cached, true);
  assert.equal(calls.length, 0);
  // Older than 30 min → recomputed.
  env.DB._raw.prepare("UPDATE quota_cache SET updated_at = ? WHERE key = 'panel'").run(Date.now() - 31 * 60e3);
  const fresh = await (await quotaApi.onRequestGet(getCtx(env, 'https://c.pages.dev/api/quota'))).json();
  assert.equal(fresh.cached, false);
});

test('quota: the budget stops GitHub calls instead of exceeding the subrequest limit', async () => {
  const b = new quota.Budget(3);
  assert.equal(b.take(2, 'x'), true);
  assert.equal(b.take(2, 'y'), false);
  assert.deepEqual(b.skipped, ['y']);
});

test('panel is wired on Overview and Settings and keeps safeguards untouched', () => {
  const ov = readFileSync(`${ROOT}assets/js/pages/overview.js`, 'utf8');
  const st = readFileSync(`${ROOT}assets/js/pages/settings.js`, 'utf8');
  assert.match(ov, /mountQuotaPanel\(root, 'quota-panel'\)/);
  assert.match(st, /mountQuotaPanel\(root, 'quota-panel-settings'\)/);
  const q = readFileSync(`${ROOT}functions/api/quota.js`, 'utf8');
  assert.ok(!/dispatchWorkflow|publish\(|saveSettings/.test(q), 'quota endpoint is read-only');
  assert.equal(dbm.DEFAULT_SETTINGS.publishing.dailyCap, 2);
  assert.equal(dbm.DEFAULT_SETTINGS.publishing.autoPublish, false);
  assert.equal(dbm.DEFAULT_SETTINGS.publishing.reviewRequired, true);
});
