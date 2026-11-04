/**
 * HLS streaming (3 Nov 2026): /api/hls serves playlists + fMP4 parts from the
 * private R2 binding behind the login, immutable caching + edge cache, Range,
 * player info carries the stream URLs, published sweep leaves HLS in drafts/,
 * player picks hls.js / native HLS and starts low.
 * Run: node --test tests/hls.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const r2 = await import(`${ROOT}functions/api/_lib/r2.js`);
const util = await import(`${ROOT}functions/api/_lib/util.js`);
const hlsRoute = await import(`${ROOT}functions/api/hls/[[path]].js`);
const media = await import(`${ROOT}functions/api/jobs/[id]/media.js`);
const { onRequest: middleware } = await import(`${ROOT}functions/api/_middleware.js`);
const player = await import(`${ROOT}assets/js/player.js`);
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


const ID = 'job-hls-aa1';
const VER = 'r41650724820-1';
const BASE = `drafts/${ID}/hls/${VER}/short/`;
async function makeEnv() {
  wh._resetSchemaCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  return { DB, SESSION_SECRET: 's', MEDIA: fakeBucket() };
}
async function seed(env) {
  const B = env.MEDIA;
  await B.put(`${BASE}master.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=360x640\nv0/index.m3u8\n');
  await B.put(`${BASE}v0/index.m3u8`, '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:2.0,\nseg_00000.m4s\n#EXT-X-ENDLIST\n');
  await B.put(`${BASE}v0/init_0.mp4`, new Uint8Array(900));
  await B.put(`${BASE}v0/seg_00000.m4s`, Uint8Array.from({ length: 5000 }, (_, i) => i % 251));
  await B.put(`${BASE}poster.jpg`, new Uint8Array(300));
  const manifest = { v: 1, job_id: ID, engine: 'verticals', files: { short: { key: `drafts/${ID}/short.mp4`, size: 10, w: 1080, h: 1920, duration: 47 } },
    sprites: {}, chapters: {}, markers: {}, resolution: {},
    hls: { short: { base: BASE, master: 'master.m3u8', segment: 2, segments: 96, poster: 'poster.jpg', renditions: [{ w: 360, h: 640, kbps: 750 }, { w: 1080, h: 1920, kbps: 5625 }] } } };
  await B.put(`drafts/${ID}/manifest.json`, JSON.stringify(manifest));
  await B.put(`drafts/${ID}/short.mp4`, new Uint8Array(10));
  return manifest;
}
function fakeCache() {
  const m = new Map();
  return { m, async match(req) { const r = m.get(new URL(req.url).href); return r ? r.clone() : undefined; },
    async put(req, res) { m.set(new URL(req.url).href, new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers })); } };
}
const get = (env, path, headers = {}, waits = []) => hlsRoute.onRequestGet({
  env, params: { path: path.split('/') }, waitUntil: (p) => waits.push(p),
  request: new Request(`https://c.pages.dev/api/hls/${path}`, { headers }),
});

test('hlsKey accepts only stream files under drafts/<job>/hls/<version>/<kind>/', () => {
  assert.equal(hlsRoute.hlsKey([ID, VER, 'short', 'master.m3u8']), `${BASE}master.m3u8`);
  assert.equal(hlsRoute.hlsKey([ID, VER, 'long', 'v3', 'seg_00012.m4s']), `drafts/${ID}/hls/${VER}/long/v3/seg_00012.m4s`);
  assert.equal(hlsRoute.hlsKey([ID, VER, 'short', 'v0', 'init_0.mp4']), `${BASE}v0/init_0.mp4`);
  for (const bad of [[ID, VER, 'short', '..', 'manifest.json'], [ID, VER, 'other', 'master.m3u8'], ['../x', VER, 'short', 'master.m3u8'],
    [ID, VER, 'short', 'short.mp4'], [ID, 'v/../x', 'short', 'master.m3u8'], [ID, VER, 'short']]) {
    assert.equal(hlsRoute.hlsKey(bad), null, bad.join('/'));
  }
});

test('serves playlists and parts with the right types and immutable caching; 404 otherwise', async () => {
  const env = await makeEnv(); await seed(env);
  globalThis.caches = undefined;
  const m = await get(env, `${ID}/${VER}/short/master.m3u8`);
  assert.equal(m.status, 200);
  assert.equal(m.headers.get('Content-Type'), 'application/vnd.apple.mpegurl');
  assert.match(m.headers.get('Cache-Control'), /private, max-age=31536000, immutable/);
  assert.match(await m.text(), /v0\/index\.m3u8/);
  const s = await get(env, `${ID}/${VER}/short/v0/seg_00000.m4s`);
  assert.equal(s.headers.get('Content-Type'), 'video/iso.segment');
  assert.equal((await s.arrayBuffer()).byteLength, 5000);
  const i = await get(env, `${ID}/${VER}/short/v0/init_0.mp4`);
  assert.equal(i.headers.get('Content-Type'), 'video/mp4');
  assert.equal((await get(env, `${ID}/${VER}/short/v0/seg_00099.m4s`)).status, 404);
  assert.equal((await get(env, `${ID}/${VER}/short/../manifest.json`)).status, 404);
});

test('Range on a part answers 206 from R2 and bypasses the cache', async () => {
  const env = await makeEnv(); await seed(env);
  globalThis.caches = { default: fakeCache() };
  const r = await get(env, `${ID}/${VER}/short/v0/seg_00000.m4s`, { Range: 'bytes=100-199' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 100-199/5000');
  assert.equal(r.headers.get('X-DYPOL-Cache'), 'BYPASS');
  assert.equal(new Uint8Array(await r.arrayBuffer())[0], 100 % 251);
  assert.equal((await get(env, `${ID}/${VER}/short/v0/seg_00000.m4s`, { Range: 'bytes=9000-' })).status, 416);
  globalThis.caches = undefined;
});

test('edge cache: first read MISS from R2, second HIT without touching R2', async () => {
  const env = await makeEnv(); await seed(env);
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  const waits = [];
  const a = await get(env, `${ID}/${VER}/short/v0/seg_00000.m4s`, {}, waits);
  assert.equal(a.headers.get('X-DYPOL-Cache'), 'MISS');
  assert.equal((await a.arrayBuffer()).byteLength, 5000);
  await Promise.all(waits);
  const stored = [...cache.m.values()][0];
  assert.match(stored.headers.get('Cache-Control'), /^public, max-age=31536000, immutable/); // edge copy
  let r2reads = 0;
  const orig = env.MEDIA.get; env.MEDIA.get = async (...x) => { r2reads++; return orig.apply(env.MEDIA, x); };
  const b = await get(env, `${ID}/${VER}/short/v0/seg_00000.m4s`);
  assert.equal(b.headers.get('X-DYPOL-Cache'), 'HIT');
  assert.match(b.headers.get('Cache-Control'), /^private/); // browser copy stays private
  assert.equal((await b.arrayBuffer()).byteLength, 5000);
  assert.equal(r2reads, 0);
  globalThis.caches = undefined;
});

test('login required for /api/hls; signed-in requests skip the DB schema check', async () => {
  const env = await makeEnv();
  const out = await middleware({ env, request: new Request(`https://c.pages.dev/api/hls/${ID}/${VER}/short/master.m3u8`), next: () => new Response('leak') });
  assert.equal(out.status, 401);
  const token = await util.createSessionToken('s');
  let dbTouched = false;
  const env2 = { ...env, DB: new Proxy(env.DB, { get(t, k) { dbTouched = true; return t[k]; } }) };
  const ok = await middleware({ env: env2, request: new Request(`https://c.pages.dev/api/hls/${ID}/${VER}/short/master.m3u8`, { headers: { Cookie: `dypol_session=${token}` } }), next: () => new Response('ok') });
  assert.equal(await ok.text(), 'ok');
  assert.equal(dbTouched, false);
});

test('player info carries the stream URLs (no bucket keys) and reads drafts/ first for drafts', async () => {
  const env = await makeEnv(); const manifest = await seed(env);
  const info = media.playerInfo({ id: ID, engine: 'verticals' }, { ...manifest, prefix: `drafts/${ID}/` });
  assert.equal(info.hls.short.master, `/api/hls/${ID}/${VER}/short/master.m3u8`);
  assert.equal(info.hls.short.poster, `/api/hls/${ID}/${VER}/short/poster.jpg`);
  assert.equal(info.hls.short.segment, 2);
  assert.ok(!JSON.stringify(info).includes('drafts/'));
  // a manifest pointing at another job's folder is ignored
  assert.deepEqual(r2.hlsInfo({ hls: { short: { base: `drafts/other/hls/${VER}/short/` } } }, ID), {});
  const seen = [];
  const env3 = { MEDIA: { get: async (k) => { seen.push(k); return null; } } };
  await r2.r2Manifest(env3, ID, { preferDrafts: true });
  assert.ok(seen[0].startsWith('drafts/'));
});

test('publishing moves the draft files but leaves the HLS parts under drafts/', async () => {
  const env = await makeEnv(); await seed(env);
  await dbm.insertJob(env.DB, { id: ID, engine: 'verticals', title: 't', topic: 't', niche: 'tech', format: 'short', status: 'published', stage: '', progress: null,
    description: '', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quality: {}, logs: [], runId: null });
  await r2.sweepPublished(env, env.DB, { maxJobs: 2 });
  const keys = [...env.MEDIA.store.keys()];
  assert.ok(keys.includes(`published/${ID}/manifest.json`));
  assert.ok(keys.includes(`${BASE}v0/seg_00000.m4s`));
  assert.ok(!keys.some((k) => k.startsWith(`published/${ID}/hls/`)));
  assert.equal(await r2.deleteJobObjects(env, [ID]) > 5, true);
  assert.equal([...env.MEDIA.store.keys()].length, 0);
});

test('player: hls.js where MediaSource exists, native HLS for Safari without it, starts on the lowest rendition', () => {
  assert.equal(player.streamMode({ MediaSource: function () {} }), 'hlsjs');
  assert.equal(player.streamMode({ ManagedMediaSource: function () {} }), 'hlsjs');
  assert.equal(player.streamMode({}, { canPlayType: () => 'maybe' }), 'native');
  assert.equal(player.streamMode({}, { canPlayType: () => '' }), 'none');
  assert.equal(player.HLS_CONFIG.startLevel, 0);
  assert.equal(player.HLS_CONFIG.capLevelToPlayerSize, true);
  assert.equal(player.HLS_CONFIG.lowLatencyMode, false);
  assert.ok(player.HLS_CONFIG.maxBufferLength <= 10); // small buffer while paused
  assert.match(player.HLS_URL, /^\/assets\/vendor\/hls\.light-[\d.]+\.min\.mjs$/);
  assert.ok(existsSync(`${ROOT}${player.HLS_URL.slice(1)}`), 'vendored hls.js present');
  assert.match(read('console/_headers'), /\/assets\/vendor\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/);
});

test('check screen warms hls.js before the player data arrives and defers the picture credits', () => {
  const q = read('console/assets/js/pages/queue.js');
  assert.match(q, /warmPlayer\(\); \/\/ hls\.js loads in parallel/);
  assert.match(q, /mountPlayer\(playerBox, \{ jobId: j\.id, media, info, engine: j\.engine, openedAt \}\)/);
  assert.match(q, /\}, 2500\);/);
  const p = read('console/assets/js/player.js');
  assert.match(p, /v\.preload = sm \? 'auto' : 'metadata'/);
  assert.match(p, /Preview unavailable/);
  assert.match(p, /attachStream/);
});
