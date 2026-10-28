/**
 * Session guard for every /api route.
 * Exceptions: /api/auth/* (login/logout) and /api/health (connection probe).
 * Every state-changing route is protected — unauthenticated visitors cannot
 * start production, alter settings, or publish to YouTube.
 *
 * AUDIT hardening: state-changing methods additionally verify the Origin
 * header (CSRF defence-in-depth on top of SameSite=Strict cookies).
 */
import { json, verifySessionToken, cookieHeader } from './_lib/util.js';

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

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
  return context.next();
}
