/**
 * Cloudflare R2 draft storage (binding MEDIA → bucket dypol-media). Private:
 * objects are only reachable through the login-protected /api routes, the
 * bucket has no public URL.
 *
 * Layout (written by the engines with the S3 API, scripts/dypol_r2.py):
 *   drafts/<job_id>/manifest.json         files, sizes, sprites, chapters, QC markers
 *   drafts/<job_id>/long.mp4 / short.mp4  ORIGINAL renders (720p–1080p, never upscaled)
 *   drafts/<job_id>/*_preview.mp4         review copies (CRF 28, 1 s keyframes, +faststart)
 *   drafts/<job_id>/*_sprite.jpg          scrubber thumbnail strips
 *   drafts/<job_id>/*_captions.vtt, *_thumb.png, qc.json
 *   drafts/<job_id>/hls/<version>/<long|short>/…  HLS stream (master.m3u8, v<i>/ playlists,
 *                                          fMP4 init + 2–4 s segments, poster.jpg); served by
 *                                          /api/hls/… and always left under drafts/
 *
 * A bucket lifecycle rule deletes drafts/ objects after 30 days. Objects of
 * published jobs are moved to published/<job_id>/ (no lifecycle rule) by
 * sweepPublished(), so they are never expired. Deleting a job in the console
 * removes both prefixes (deleteJobObjects).
 */
export const DRAFTS = 'drafts/';
export const PUBLISHED = 'published/';
export const FREE_BYTES = 10 * 1e9;
const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;

export const hasR2 = (env) => !!(env && env.MEDIA && typeof env.MEDIA.get === 'function');

/** The manifest for a job (published/ first, then drafts/), with its prefix. null when not in R2. */
export async function r2Manifest(env, jobId, { preferDrafts = false } = {}) {
  if (!hasR2(env) || !SAFE_ID.test(String(jobId || ''))) return null;
  for (const prefix of preferDrafts ? [DRAFTS, PUBLISHED] : [PUBLISHED, DRAFTS]) {
    try {
      const obj = await env.MEDIA.get(`${prefix}${jobId}/manifest.json`);
      if (!obj) continue;
      const data = JSON.parse(await obj.text());
      if (data && typeof data === 'object') return { ...data, prefix: `${prefix}${jobId}/` };
    } catch { /* unreadable manifest: treat as missing */ }
  }
  return null;
}

/** The R2 key for a file name in the manifest, re-rooted at the manifest's current prefix. */
export function keyFor(manifest, name) {
  const f = manifest?.files?.[name];
  if (!f?.key) return null;
  const base = String(f.key).split('/').pop();
  return `${manifest.prefix}${base}`;
}

/**
 * Which manifest file answers a media request.
 *   kind video  → the job's main video (Engine A long, Engine B Short)
 *   kind short  → the Short
 *   quality full → the original render; otherwise the review copy (falls back to the original)
 */
export function pickR2File(manifest, engine, kind, quality) {
  const files = manifest?.files || {};
  const main = engine === 'verticals' || (!files.long && files.short) ? 'short' : 'long';
  const which = kind === 'short' ? 'short' : kind === 'video' ? main : null;
  if (which) {
    if (quality !== 'full' && files[`${which}_preview`]) return `${which}_preview`;
    return files[which] ? which : null;
  }
  if (kind === 'thumb') return ['long_thumb', 'short_thumb'].find((n) => files[n]) || null;
  if (kind === 'qc') return files.qc ? 'qc' : null;
  return null;
}

/** Parse a single-range Range header against a size. → {offset,length} | null (whole) | 'invalid' */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') { // suffix: last N bytes
    const n = Number(m[2]);
    if (!n) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

const TYPES = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json', vtt: 'text/vtt; charset=utf-8' };

/** Stream an R2 object with HTTP Range support (206 / 416), never buffering it. */
export async function streamR2(env, key, request, { download = false, filename = null, source = 'r2' } = {}) {
  const head = await env.MEDIA.head(key);
  if (!head) return null;
  const size = head.size;
  const range = parseRange(request.headers.get('Range'), size);
  const ext = key.split('.').pop().toLowerCase();
  const headers = new Headers({
    'Content-Type': head.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-DYPOL-Media-Source': source,
    'X-Content-Type-Options': 'nosniff',
  });
  if (head.httpEtag) headers.set('ETag', head.httpEtag);
  if (download) headers.set('Content-Disposition', `attachment; filename="${String(filename || key.split('/').pop()).replace(/"/g, '')}"`);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  const obj = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!obj) return null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers });
}

/** Every key under a prefix (paged). */
export async function listKeys(env, prefix, maxPages = 20) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects || []) out.push({ key: o.key, size: Number(o.size || 0) });
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

/** Delete every R2 object of these jobs (drafts/ and published/). Returns the number deleted. */
export async function deleteJobObjects(env, jobIds) {
  if (!hasR2(env)) return 0;
  let n = 0;
  for (const id of jobIds) {
    if (!SAFE_ID.test(String(id || ''))) continue;
    for (const prefix of [DRAFTS, PUBLISHED]) {
      const keys = (await listKeys(env, `${prefix}${id}/`, 10)).map((o) => o.key);
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        if (chunk.length) { await env.MEDIA.delete(chunk); n += chunk.length; }
      }
    }
  }
  return n;
}

/** Count R2 objects of these jobs (for the delete confirm sheet). */
export async function countJobObjects(env, jobIds) {
  if (!hasR2(env)) return 0;
  let n = 0;
  for (const id of jobIds) {
    if (!SAFE_ID.test(String(id || ''))) continue;
    for (const prefix of [DRAFTS, PUBLISHED]) n += (await listKeys(env, `${prefix}${id}/`, 1)).length;
  }
  return n;
}

/** Copy one object to a new key, streaming (known length), then delete the old key. */
async function moveObject(env, from, to) {
  const obj = await env.MEDIA.get(from);
  if (!obj) return false;
  let body = obj.body;
  if (typeof FixedLengthStream === 'function') {
    // eslint-disable-next-line no-undef
    const { readable, writable } = new FixedLengthStream(obj.size);
    obj.body.pipeTo(writable);
    body = readable;
  }
  await env.MEDIA.put(to, body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  await env.MEDIA.delete(from);
  return true;
}

/**
 * Move the R2 objects of published jobs from drafts/ to published/, so the
 * 30-day drafts/ lifecycle rule never removes them. Bounded per call
 * (maxJobs); safe to run repeatedly (webhook, storage view).
 */
export async function sweepPublished(env, db, { maxJobs = 1 } = {}) {
  if (!hasR2(env) || !db) return { moved: 0 };
  const top = await env.MEDIA.list({ prefix: DRAFTS, delimiter: '/', limit: 1000 });
  const ids = (top.delimitedPrefixes || []).map((p) => p.slice(DRAFTS.length).replace(/\/$/, '')).filter((id) => SAFE_ID.test(id));
  if (!ids.length) return { moved: 0 };
  const ph = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT id FROM jobs WHERE id IN (${ph}) AND (status = 'published' OR youtube_id IS NOT NULL)`).bind(...ids).all();
  let moved = 0;
  for (const r of (results || []).slice(0, maxJobs)) {
    // HLS parts stay under drafts/ (hundreds of small files; the player falls back to
    // the MP4 review copy once the 30-day rule removes them).
    const keys = (await listKeys(env, `${DRAFTS}${r.id}/`, 5)).filter((o) => !o.key.includes('/hls/'));
    // manifest last, so a half-moved job is still readable from drafts/
    keys.sort((a, b) => (a.key.endsWith('manifest.json') ? 1 : 0) - (b.key.endsWith('manifest.json') ? 1 : 0));
    for (const o of keys) await moveObject(env, o.key, `${PUBLISHED}${o.key.slice(DRAFTS.length)}`);
    moved++;
  }
  return { moved };
}

/** Storage use for Settings → Advanced. */
export async function storageUsage(env) {
  if (!hasR2(env)) return { configured: false };
  const all = await listKeys(env, '', 50);
  const sum = (pre) => all.filter((o) => o.key.startsWith(pre));
  const jobs = (list, pre) => new Set(list.map((o) => o.key.slice(pre.length).split('/')[0])).size;
  const d = sum(DRAFTS), p = sum(PUBLISHED);
  const bytes = all.reduce((n, o) => n + o.size, 0);
  return {
    configured: true, bytes, objects: all.length, limitBytes: FREE_BYTES,
    drafts: { bytes: d.reduce((n, o) => n + o.size, 0), jobs: jobs(d, DRAFTS) },
    published: { bytes: p.reduce((n, o) => n + o.size, 0), jobs: jobs(p, PUBLISHED) },
    draftsExpireDays: 30,
  };
}

const HLS_BASE = /^drafts\/([A-Za-z0-9._-]{1,100})\/hls\/([A-Za-z0-9_-]{1,40})\/(long|short)\/$/;
/** Player URLs for the HLS streams in a manifest: {long|short: {master, poster, renditions, segment}}. */
export function hlsInfo(manifest, jobId) {
  const out = {};
  for (const [kind, e] of Object.entries(manifest?.hls || {})) {
    const m = HLS_BASE.exec(String(e?.base || ''));
    if (!m || m[1] !== jobId || m[3] !== kind) continue;
    const root = `/api/hls/${encodeURIComponent(jobId)}/${m[2]}/${kind}/`;
    out[kind] = {
      master: `${root}master.m3u8`,
      poster: e.poster ? `${root}poster.jpg` : null,
      segment: Number(e.segment) || null,
      renditions: (e.renditions || []).slice(0, 6).map(({ w, h, kbps }) => ({ w, h, kbps })),
    };
  }
  return out;
}
