/**
 * Cloudflare R2 storage (3 Nov 2026): Range streaming behind the login, review
 * copy vs original, player info, published objects moved out of the 30-day
 * drafts/ expiry, storage line, delete removes R2 objects, review player helpers.
 * R2 is an in-memory fake with the binding's API (get/head/put/list/delete).
 * Run: node --test tests/r2.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const r2 = await import(`${ROOT}functions/api/_lib/r2.js`);
const media = await import(`${ROOT}functions/api/jobs/[id]/media.js`);
const storage = await import(`${ROOT}functions/api/storage.js`);
const del = await import(`${ROOT}functions/api/_lib/deletejob.js`);
const { onRequest: middleware } = await import(`${ROOT}functions/api/_middleware.js`);
const player = await import(`${ROOT}assets/js/player.js`);
const delUi = await import(`${ROOT}assets/js/delete.js`);
const settingsPage = await import(`${ROOT}assets/js/pages/settings.js`).catch(() => null);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/* ---------------- fake R2 bucket ---------------- */
function fakeBucket() {
  const store = new Map(); // key -> {bytes, httpMetadata}
  const obj = (key, v, range) => {
    let bytes = v.bytes;
    if (range) bytes = range.suffix ? bytes.slice(-range.suffix) : bytes.slice(range.offset, range.offset + (range.length ?? bytes.length));
    return {
      key, size: v.bytes.length, httpEtag: `"e-${key.length}"`, httpMetadata: v.httpMetadata || {}, customMetadata: {},
      body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes),
    };
  };
  return {
    store,
    async head(key) { const v = store.get(key); return v ? { key, size: v.bytes.length, httpEtag: `"e-${key.length}"`, httpMetadata: v.httpMetadata || {} } : null; },
    async get(key, opts) { const v = store.get(key); return v ? obj(key, v, opts?.range) : null; },
    async put(key, body, opts = {}) {
      const bytes = body instanceof Uint8Array ? body : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer());
      store.set(key, { bytes, httpMetadata: opts.httpMetadata });
    },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
    async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const pre = new Set(), objects = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length), i = rest.indexOf(delimiter);
          if (i >= 0) pre.add(prefix + rest.slice(0, i + 1)); else objects.push({ key: k, size: store.get(k).bytes.length });
        }
        return { objects, delimitedPrefixes: [...pre], truncated: false };
      }
      const start = Number(cursor || 0);
      const page = keys.slice(start, start + limit);
      return { objects: page.map((k) => ({ key: k, size: store.get(k).bytes.length })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
  };
}
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 251);

async function makeEnv({ withR2 = true } = {}) {
  wh._resetSchemaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: 'o/a', workflow: 'main.yml' }, verticals: { repo: 'o/b', workflow: 'verticals.yml' }, branch: 'dypol-integration' },
  });
  return { DB, SESSION_SECRET: 's', ...(withR2 ? { MEDIA: fakeBucket() } : {}) };
}
async function addJob(env, over = {}) {
  const j = { id: 'job-r2test-aa1', engine: 'gemini', title: 'R2 topic', topic: 'R2 topic', niche: 'tech', format: 'long-form', status: 'needs-review',
    stage: '', progress: null, description: 'd', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quality: {}, logs: [], runId: null, ...over };
  await dbm.insertJob(env.DB, j);
  if (over.youtubeId) await dbm.updateJob(env.DB, j.id, { youtubeId: over.youtubeId });
  return j;
}
async function seedDraft(env, id = 'job-r2test-aa1', { prefix = 'drafts/', engine = 'gemini' } = {}) {
  const B = env.MEDIA;
  const k = (n) => `${prefix}${id}/${n}`;
  const files = engine === 'gemini'
    ? { long: 5000, long_preview: 1200, short: 3000, short_preview: 900, long_sprite: 50, long_captions: 40 }
    : { short: 3000, short_preview: 900, short_sprite: 50 };
  const manifest = { v: 1, job_id: id, engine, files: {}, sprites: {}, chapters: {}, markers: {}, resolution: {} };
  for (const [name, size] of Object.entries(files)) {
    const ext = name.endsWith('sprite') ? 'jpg' : name.endsWith('captions') ? 'vtt' : 'mp4';
    await B.put(k(`${name}.${ext}`), bytes(size, name.length), { httpMetadata: { contentType: ext === 'mp4' ? 'video/mp4' : ext === 'jpg' ? 'image/jpeg' : 'text/vtt' } });
    manifest.files[name] = { key: `drafts/${id}/${name}.${ext}`, size, w: name.includes('preview') ? 960 : 1920, h: name.includes('preview') ? 540 : 1080, duration: 61.2, fps: 30 };
  }
  manifest.sprites.long = { key: `drafts/${id}/long_sprite.jpg`, interval: 0.62, count: 100, cols: 10, rows: 10, tw: 160, th: 90 };
  manifest.chapters.long = [{ t: 0, title: 'Intro' }, { t: 20.5, title: 'How it works' }];
  manifest.markers.long = [{ t: 12, end: 14.5, kind: 'silence', label: '2.5 s silence at 12.0 s' }];
  await B.put(k('manifest.json'), JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  return manifest;
}
const mediaReq = (env, id, qs, headers = {}) => media.onRequestGet({
  env, params: { id }, request: new Request(`https://c.pages.dev/api/jobs/${id}/media?${qs}`, { headers }),
});

/* ---------------- Range parsing ---------------- */
test('parseRange: start-end, open end, suffix, invalid', () => {
  assert.deepEqual(r2.parseRange('bytes=0-99', 1000), { offset: 0, length: 100 });
  assert.deepEqual(r2.parseRange('bytes=900-', 1000), { offset: 900, length: 100 });
  assert.deepEqual(r2.parseRange('bytes=-10', 1000), { offset: 990, length: 10 });
  assert.deepEqual(r2.parseRange('bytes=990-5000', 1000), { offset: 990, length: 10 });
  assert.equal(r2.parseRange(null, 1000), null);
  assert.equal(r2.parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(r2.parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(r2.parseRange('items=0-1', 1000), 'invalid');
});

/* ---------------- media endpoint ---------------- */
test('media streams the R2 review copy with Range (206) — no GitHub needed', async () => {
  const env = await makeEnv();
  await addJob(env);
  await seedDraft(env);
  const res = await mediaReq(env, 'job-r2test-aa1', 'kind=video', { Range: 'bytes=100-199' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 100-199/1200');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Length'), '100');
  assert.equal(res.headers.get('X-DYPOL-Media-Source'), 'r2');
  assert.match(res.headers.get('Cache-Control'), /^private/);
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...got], [...bytes(1200, 'long_preview'.length).slice(100, 200)]);
  const whole = await mediaReq(env, 'job-r2test-aa1', 'kind=video');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Content-Length'), '1200');
  const bad = await mediaReq(env, 'job-r2test-aa1', 'kind=video', { Range: 'bytes=5000-' });
  assert.equal(bad.status, 416);
});

test('quality=full streams the ORIGINAL render; download sets attachment; Short and captions/sprite work', async () => {
  const env = await makeEnv();
  await addJob(env);
  await seedDraft(env);
  const full = await mediaReq(env, 'job-r2test-aa1', 'kind=video&quality=full&download=1', { Range: 'bytes=0-' });
  assert.equal(full.status, 206);
  assert.equal(full.headers.get('Content-Range'), 'bytes 0-4999/5000');
  assert.equal(full.headers.get('X-DYPOL-Media-Source'), 'r2-original');
  assert.match(full.headers.get('Content-Disposition'), /attachment; filename="job-r2test-aa1-long\.mp4"/);
  const short = await mediaReq(env, 'job-r2test-aa1', 'kind=short');
  assert.equal(short.headers.get('Content-Length'), '900');
  const cap = await mediaReq(env, 'job-r2test-aa1', 'kind=captions&video=long');
  assert.equal(cap.status, 200);
  assert.match(cap.headers.get('Content-Type'), /text\/vtt/);
  const sp = await mediaReq(env, 'job-r2test-aa1', 'kind=sprite&video=long');
  assert.equal(sp.status, 200);
  const noSp = await mediaReq(env, 'job-r2test-aa1', 'kind=sprite&video=short');
  assert.equal(noSp.status, 404);
});

test('info gives the player data (chapters, QC markers, sprite geometry) and never leaks keys', async () => {
  const env = await makeEnv();
  await addJob(env);
  await seedDraft(env);
  const res = await mediaReq(env, 'job-r2test-aa1', 'kind=info');
  const info = await res.json();
  assert.equal(info.source, 'r2');
  assert.equal(info.main, 'long');
  assert.equal(info.videos.long.chapters.length, 2);
  assert.equal(info.videos.long.markers[0].kind, 'silence');
  assert.deepEqual(info.videos.long.sprite, { interval: 0.62, count: 100, cols: 10, rows: 10, tw: 160, th: 90 });
  assert.equal(info.videos.long.captions, true);
  assert.deepEqual(info.videos.long.preview, { w: 960, h: 540, size: 1200 });
  assert.doesNotMatch(JSON.stringify(info), /drafts\/|dypol-media|r2\.cloudflarestorage/);
});

test('without R2 objects the media route falls back to GitHub artifacts (unchanged)', async () => {
  const env = await makeEnv();
  await addJob(env);
  const info = await (await mediaReq(env, 'job-r2test-aa1', 'kind=info')).json();
  assert.equal(info.source, 'artifacts');
  const res = await mediaReq(env, 'job-r2test-aa1', 'kind=video');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'no-run', 'reached the artifact path');
  const noBinding = await makeEnv({ withR2: false });
  await addJob(noBinding);
  assert.equal((await (await mediaReq(noBinding, 'job-r2test-aa1', 'kind=info')).json()).source, 'artifacts');
});

test('Engine B: the main video is the Short', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-r2b-bb1', engine: 'verticals', format: 'short' });
  await seedDraft(env, 'job-r2b-bb1', { engine: 'verticals' });
  const res = await mediaReq(env, 'job-r2b-bb1', 'kind=video');
  assert.equal(res.headers.get('Content-Length'), '900');
  const info = await (await mediaReq(env, 'job-r2b-bb1', 'kind=info')).json();
  assert.equal(info.main, 'short');
});

test('media is login-protected (middleware) — the bucket is never public', async () => {
  const env = await makeEnv();
  const res = await middleware({ env, request: new Request('https://c.pages.dev/api/jobs/x/media?kind=video'), next: () => new Response('leak') });
  assert.equal(res.status, 401);
  const toml = read('console/wrangler.toml');
  assert.match(toml, /\[\[r2_buckets\]\]\s*\nbinding = "MEDIA"\s*\nbucket_name = "dypol-media"/);
  assert.doesNotMatch(read('console/functions/api/_lib/r2.js') + read('console/functions/api/jobs/[id]/media.js'), /r2\.dev|publicUrl|createPresigned/i);
});

/* ---------------- lifecycle protection + storage line ---------------- */
test('published jobs move from drafts/ to published/ (outside the 30-day expiry); drafts stay', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-pub-cc1', status: 'published', youtubeId: 'yt123' });
  await addJob(env, { id: 'job-draft-dd1', status: 'needs-review' });
  await seedDraft(env, 'job-pub-cc1');
  await seedDraft(env, 'job-draft-dd1');
  const out = await r2.sweepPublished(env, env.DB, { maxJobs: 5 });
  assert.equal(out.moved, 1);
  const keys = [...env.MEDIA.store.keys()];
  assert.ok(keys.some((k) => k === 'published/job-pub-cc1/long.mp4'));
  assert.ok(!keys.some((k) => k.startsWith('drafts/job-pub-cc1/')));
  assert.ok(keys.some((k) => k.startsWith('drafts/job-draft-dd1/')));
  // still playable from its new place
  const res = await mediaReq(env, 'job-pub-cc1', 'kind=video&quality=full');
  assert.equal(res.headers.get('Content-Length'), '5000');
  const info = await (await mediaReq(env, 'job-pub-cc1', 'kind=info')).json();
  assert.equal(info.stored, 'published');
});

test('GET /api/storage reports use of the free 10 GB and the expiry rule', async () => {
  const env = await makeEnv();
  await addJob(env);
  await seedDraft(env);
  const body = await (await storage.onRequestGet({ env, request: new Request('https://c.pages.dev/api/storage') })).json();
  assert.equal(body.configured, true);
  assert.equal(body.drafts.jobs, 1);
  assert.equal(body.limitBytes, 10e9);
  assert.ok(body.bytes > 10000);
  assert.equal(body.draftsExpireDays, 30);
  const none = await (await storage.onRequestGet({ env: await makeEnv({ withR2: false }), request: new Request('https://c.pages.dev/api/storage') })).json();
  assert.equal(none.configured, false);
  if (settingsPage?.storageText) {
    assert.match(settingsPage.storageText(body), /of 10\.00 GB free storage used .* 1 draft .* removed after 30 days; published videos are kept/);
    assert.match(settingsPage.storageText({ configured: false }), /isn’t connected/);
  }
  assert.match(read('console/assets/js/pages/settings.js'), /id="storage-line"/);
});

/* ---------------- delete removes R2 objects ---------------- */
test('deleting a job removes its R2 objects (drafts/ and published/), and only its own', async () => {
  const env = await makeEnv();
  await addJob(env, { id: 'job-del-ee1', status: 'failed' });
  await addJob(env, { id: 'job-keep-ff1', status: 'needs-review' });
  await seedDraft(env, 'job-del-ee1');
  await seedDraft(env, 'job-del-ee1', { prefix: 'published/' });
  await seedDraft(env, 'job-keep-ff1');
  const plan = await del.buildPlan(env.DB, env, await dbm.getSettings(env.DB), 'job-del-ee1');
  assert.equal(plan.counts.storedFiles, 14);
  assert.ok(del.describePlan(plan).includes('14 stored video files'));
  const out = await del.runDeletion(env.DB, { ...env, GITHUB_TOKEN: '' }, await dbm.getSettings(env.DB), 'job-del-ee1');
  assert.equal(out.state, 'refused', 'without GitHub nothing is deleted');
  // GitHub fake: nothing to remove, every call answers 404/empty.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.github.com') throw new Error(`unexpected host ${u.hostname}`);
    if (/\/actions\/runs$/.test(u.pathname)) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    if (/\/git\/ref\//.test(u.pathname)) return new Response(JSON.stringify({ object: { sha: 'c0' } }), { status: 200 });
    if (/\/git\/commits\//.test(u.pathname)) return new Response(JSON.stringify({ tree: { sha: 't0' } }), { status: 200 });
    if (/\/git\/trees\//.test(u.pathname)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  try {
    let r;
    for (let i = 0; i < 6; i++) { r = await del.runDeletion(env.DB, { ...env, GITHUB_TOKEN: 't' }, await dbm.getSettings(env.DB), 'job-del-ee1'); if (!['continue', 'waiting'].includes(r.state)) break; }
    assert.equal(r.state, 'done');
  } finally { globalThis.fetch = realFetch; }
  const keys = [...env.MEDIA.store.keys()];
  assert.ok(!keys.some((k) => k.includes('job-del-ee1')));
  assert.ok(keys.some((k) => k.startsWith('drafts/job-keep-ff1/')));
});

/* ---------------- review player helpers ---------------- */
test('player helpers: time format, sprite tiles, next QC marker, speed, keys', () => {
  assert.equal(player.fmtTime(0), '0:00');
  assert.equal(player.fmtTime(65.9), '1:05');
  assert.equal(player.fmtTime(3725), '1:02:05');
  const sp = { interval: 2, count: 30, cols: 10, rows: 3, tw: 160, th: 90 };
  assert.deepEqual(player.spriteTile(sp, 0), { x: 0, y: 0, w: 160, h: 90, i: 0 });
  assert.deepEqual(player.spriteTile(sp, 25), { x: 320, y: 90, w: 160, h: 90, i: 12 });
  assert.equal(player.spriteTile(sp, 999).i, 29);
  const marks = [{ t: 30 }, { t: 10 }];
  assert.equal(player.nextMarker(marks, 0).t, 10);
  assert.equal(player.nextMarker(marks, 10).t, 30);
  assert.equal(player.nextMarker(marks, 31).t, 10, 'wraps');
  assert.equal(player.nextSpeed(1, 1), 1.5);
  assert.equal(player.nextSpeed(2, 1), 2);
  assert.equal(player.nextSpeed(0.5, -1), 0.5);
  assert.deepEqual(player.SPEEDS, [0.5, 1, 1.5, 2]);
  assert.equal(player.SKIP, 5);
  assert.equal(player.keyAction(' '), 'toggle');
  assert.equal(player.keyAction('ArrowLeft'), 'back');
  assert.equal(player.keyAction('.'), 'frameFwd');
  assert.equal(player.keyAction('f'), 'fullscreen');
  assert.equal(player.keyAction('c'), 'captions');
  assert.equal(player.keyAction('q'), 'nextQc');
  assert.equal(player.keyAction('7'), 'pct7');
  assert.equal(player.keyAction('x'), null);
});

test('timestamped review notes feed the reject / redo reason', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  player.saveNotes('job-1', [{ t: 75, video: 'long', text: 'Intro too slow' }, { t: 3, video: 'short', text: 'Text cut off' }, { t: 12, video: 'long', text: 'Blurry image' }], store);
  const notes = player.getNotes('job-1', store);
  assert.equal(notes.length, 3);
  assert.equal(player.notesToReason(notes), '0:12 — Blurry image\n1:15 — Intro too slow\n0:03 (Short) — Text cut off');
  assert.deepEqual(player.getNotes('job-2', store), []);
  const q = read('console/assets/js/pages/queue.js');
  assert.match(q, /notesToReason\(getNotes\(j\.id\)\)/);
  assert.match(q, /prefill: notesText/);
});

test('the browser’s default player is gone from the review sheet; custom player streams with preload=metadata', () => {
  const q = read('console/assets/js/pages/queue.js');
  assert.doesNotMatch(q, /<video controls/);
  assert.match(q, /mountPlayer\(playerBox/);
  const p = read('console/assets/js/player.js');
  assert.match(p, /preload="metadata"/);
  assert.match(p, /playsinline/);
  assert.match(p, /quality=full/);
  assert.match(p, /download=1/);
  assert.match(p, /kind: 'captions'/);
  assert.doesNotMatch(p, /\bimport\b.*(hls|video\.js|plyr)/i, 'no heavy library');
  assert.ok(p.length < 40000, 'lightweight');
});

/* ---------------- delete confirm sheet: linked versions ---------------- */
test('confirm sheet lists each linked version (maker, title, status) unticked; ticked ones are collected', () => {
  const plan = { id: 'job-root', counts: { attempts: 1, githubRuns: 1 }, linked: [
    { id: 'job-kid-1', engine: 'verticals', title: 'Spam calls Short', status: 'needs-review', included: false },
    { id: 'job-kid-2', engine: 'gemini', title: 'Spam calls v2', status: 'published', onYouTube: true, included: false },
  ] };
  const html = delUi.confirmHtml([{ id: 'job-root', title: 'Spam calls' }], [plan]);
  assert.match(html, /Linked versions \(2\)/);
  assert.match(html, /Spam calls Short/);
  assert.match(html, /Spam calls v2/);
  assert.match(html, /kept<\/strong> unless you tick them/);
  assert.equal((html.match(/class="del-linked__box"/g) || []).length, 2);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /on YouTube \(stays there\)/);
  const none = delUi.confirmHtml([{ id: 'x', title: 'T' }], [{ counts: { attempts: 1 }, linked: [] }]);
  assert.doesNotMatch(none, /Linked versions/);
  const fakeRoot = { querySelectorAll: () => [{ dataset: { root: 'job-root', linked: 'job-kid-2' } }] };
  assert.deepEqual(delUi.tickedLinked(fakeRoot), { 'job-root': ['job-kid-2'] });
  assert.match(read('console/assets/js/delete.js'), /include: r\.include \|\| \[\]/);
});

test('docs/UI-V2.md documents the player, R2 storage and the linked-versions confirm', () => {
  const doc = read('docs/UI-V2.md');
  assert.match(doc, /Review player/);
  assert.match(doc, /R2/);
  assert.match(doc, /tick/i);
});
