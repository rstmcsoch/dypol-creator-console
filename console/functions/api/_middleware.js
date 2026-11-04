/**
 * Session guard for every /api route.
 * Exceptions: /api/auth/* (login/logout), /api/health (connection probe) and
 * POST /api/webhooks/github (authenticated by its own HMAC signature check —
 * unsigned / wrongly signed deliveries are rejected by the handler).
 * Every state-changing route is protected — unauthenticated visitors cannot
 * start production, alter settings, or publish to YouTube.
 *
 * AUDIT hardening: state-changing methods additionally verify the Origin
 * header (CSRF defence-in-depth on top of SameSite=Strict cookies).
 */
import { json, verifySessionToken, cookieHeader } from './_lib/util.js';
import { ensureProgressSchema } from './_lib/webhook.js';
import { isDeleting } from './_lib/deletejob.js';

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // GitHub webhook: no cookie, no Origin; the handler verifies
  // X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET before doing anything.
  if (path === '/api/webhooks/github') {
    if (method !== 'POST') return json(null, 405, { ok: false, error: 'Use POST.' });
    return context.next();
  }

  // CSRF: for state-changing requests, if an Origin header exists it must
  // match this deployment (browsers always send Origin on POST).
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const origin = request.headers.get('Origin');
    if (origin) {
      const originHost = new URL(origin).host;
      if (originHost !== url.host && originHost !== request.headers.get('Host')) {
        return json(null, 403, { error: 'Cross-origin request rejected.', code: 'csrf' });
      }
    }
  }

  const open = path === '/api/health'
    || path === '/api/auth/login'
    || path === '/api/auth/logout';

  if (!open) {
    const token = cookieHeader(request, 'dypol_session');
    const valid = await verifySessionToken(token, context.env.SESSION_SECRET || '');
    if (!valid) {
      return json(null, 401, { error: 'Sign in required.', code: 'auth' });
    }
  }
  // Video streaming (HLS playlists/segments): read-only, signed in above. Skip the
  // per-isolate DB schema check so the first segment is never delayed by D1.
  if (path.startsWith('/api/hls/') && (method === 'GET' || method === 'HEAD')) return context.next();
  // Idempotent, cached per isolate: new columns exist before any handler runs.
  if (context.env?.DB) {
    try { await ensureProgressSchema(context.env.DB); } catch { /* handler reports DB errors */ }
    // A video being deleted takes no other changes (approve, publish, retry,
    // redo, reject, edit, schedule, stop) until the deletion finishes.
    const m = /^\/api\/jobs\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (m && m[2] !== 'delete' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      && await isDeleting(context.env.DB, decodeURIComponent(m[1]))) {
      return json(null, 409, { error: 'This video is being deleted.', code: 'deleting' });
    }
  }
  return context.next();
}
