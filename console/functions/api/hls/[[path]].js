/**
 * GET /api/hls/<job_id>/<version>/<long|short>/<file>
 *
 * Segmented adaptive streaming (HLS, fMP4) for the review player, straight from
 * the private R2 binding MEDIA — the bucket stays private, every request passes
 * the console login first (functions/api/_middleware.js checks the session
 * cookie before this runs, so the edge cache below is only ever read by a
 * signed-in reviewer).
 *
 * Files (written by the engines, scripts/dypol_r2.py):
 *   drafts/<job_id>/hls/<version>/<kind>/master.m3u8        lowest rendition first
 *   drafts/<job_id>/hls/<version>/<kind>/v<i>/index.m3u8    VOD media playlist
 *   drafts/<job_id>/hls/<version>/<kind>/v<i>/init_<i>.mp4  fMP4 init segment (~1 KB)
 *   drafts/<job_id>/hls/<version>/<kind>/v<i>/seg_00000.m4s 2 s (Short) / 4 s (long) parts
 *   drafts/<job_id>/hls/<version>/<kind>/poster.jpg         first frame
 *
 * <version> is unique per render, so everything is immutable: the browser keeps
 * it for a year and Cloudflare's edge cache (caches.default, per data centre)
 * serves repeat requests without touching R2. Range requests are answered from
 * R2 (206) and never cached.
 */
import { parseRange } from '../_lib/r2.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_VER = /^[A-Za-z0-9_-]{1,40}$/;
const FILE = /^(master\.m3u8|poster\.jpg|v\d{1,2}\/(index\.m3u8|init(_\d{1,2})?\.mp4|seg_\d{3,6}\.m4s))$/;
export const HLS_TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
};
export const IMMUTABLE = 'private, max-age=31536000, immutable';

/** params.path → R2 key, or null when the path is not an HLS file we serve. */
export function hlsKey(parts) {
  const p = Array.isArray(parts) ? parts : String(parts || '').split('/');
  if (p.length < 4) return null;
  const [jobId, ver, kind, ...rest] = p;
  const file = rest.join('/');
  if (!SAFE_ID.test(jobId) || !SAFE_VER.test(ver) || !['long', 'short'].includes(kind) || !FILE.test(file)) return null;
  return `drafts/${jobId}/hls/${ver}/${kind}/${file}`;
}

function headersFor(key, obj, extra = {}) {
  const ext = key.split('.').pop().toLowerCase();
  const h = new Headers({
    'Content-Type': HLS_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': IMMUTABLE,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  if (obj?.httpEtag) h.set('ETag', obj.httpEtag);
  return h;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const key = hlsKey(context.params.path);
  if (!key) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!env.MEDIA) return new Response('Storage not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });

  const url = new URL(request.url);
  const rangeHeader = request.headers.get('Range');
  // Edge cache: keyed by the clean URL (no cookie, no query) — only reached after the login check.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

  if (!rangeHeader && cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('Cache-Control', IMMUTABLE);
        h.set('X-DYPOL-Cache', 'HIT');
        if (request.headers.get('If-None-Match') && request.headers.get('If-None-Match') === h.get('ETag')) {
          return new Response(null, { status: 304, headers: h });
        }
        return new Response(hit.body, { status: 200, headers: h });
      }
    } catch { /* cache unavailable: read R2 */ }
  }

  if (rangeHeader) {
    const head = await env.MEDIA.head(key);
    if (!head) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const range = parseRange(rangeHeader, head.size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: headersFor(key, head, { 'Content-Range': `bytes */${head.size}` }) });
    }
    const obj = await env.MEDIA.get(key, range ? { range } : undefined);
    if (!obj) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const h = headersFor(key, obj, { 'X-DYPOL-Cache': 'BYPASS' });
    if (!range) { h.set('Content-Length', String(head.size)); return new Response(obj.body, { status: 200, headers: h }); }
    h.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    h.set('Content-Length', String(range.length));
    return new Response(obj.body, { status: 206, headers: h });
  }

  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const h = headersFor(key, obj, { 'X-DYPOL-Cache': 'MISS' });
  h.set('Content-Length', String(obj.size));
  if (cache && typeof obj.body?.tee === 'function') {
    const [a, b] = obj.body.tee();
    const ch = new Headers(h);
    ch.set('Cache-Control', 'public, max-age=31536000, immutable'); // edge copy only; the browser gets "private"
    ch.delete('X-DYPOL-Cache');
    const put = cache.put(cacheKey, new Response(b, { status: 200, headers: ch })).catch(() => {});
    if (typeof context.waitUntil === 'function') context.waitUntil(put);
    return new Response(a, { status: 200, headers: h });
  }
  return new Response(obj.body, { status: 200, headers: h });
}

export async function onRequestHead(context) {
  const key = hlsKey(context.params.path);
  if (!key || !context.env.MEDIA) return new Response(null, { status: 404 });
  const head = await context.env.MEDIA.head(key);
  if (!head) return new Response(null, { status: 404 });
  const h = headersFor(key, head);
  h.set('Content-Length', String(head.size));
  return new Response(null, { status: 200, headers: h });
}
