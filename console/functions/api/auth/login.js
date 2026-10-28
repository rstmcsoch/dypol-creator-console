import { json, readBody, verifyPassword, createSessionToken, SESSION_COOKIE } from '../_lib/util.js';

/**
 * POST /api/auth/login — password checked against a PBKDF2 hash secret.
 * AUDIT hardening: per-IP sliding-window throttle (5 attempts / 60 s) stored
 * server-side. Constant error message, no detail leakage.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60000;

export async function onRequestPost(context) {
  const db = context.env.DB;
  const body = await readBody(context.request);
  const ip = context.request.headers.get('CF-Connecting-IP')
    || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';

  const key = `throttle:login:${ip}`;
  let attempts = [];
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    attempts = row ? JSON.parse(row.value) : [];
  } catch { attempts = []; }
  const now = Date.now();
  attempts = (Array.isArray(attempts) ? attempts : []).filter((t) => now - t < WINDOW_MS);
  if (attempts.length >= MAX_ATTEMPTS) {
    return json(null, 429, { error: 'Too many sign-in attempts. Try again in a minute.', code: 'throttled' });
  }
  attempts.push(now);
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, JSON.stringify(attempts)).run();

  const stored = context.env.ADMIN_PASSWORD_HASH || '';
  const ok = await verifyPassword(String(body.password || ''), stored);
  if (!ok) {
    return json(null, 401, { error: 'Invalid console password.', code: 'auth' });
  }
  const token = await createSessionToken(context.env.SESSION_SECRET || '', 12);
  return json(null, 200, { ok: true }, { 'Set-Cookie': SESSION_COOKIE(token) });
}
