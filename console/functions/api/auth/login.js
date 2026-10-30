import { json, readBody, verifyPassword, createSessionToken, SESSION_COOKIE } from '../_lib/util.js';

/**
 * POST /api/auth/login — password checked against a PBKDF2 hash secret.
 * Per-client sliding-window throttle (5 attempts / 60 s). The client IP is
 * never stored: the throttle key is SHA-256(SESSION_SECRET + IP), kept in its
 * own table (login_throttle) that no API response ever returns.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60000;

export async function hashClient(ip, salt) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt || 'dypol'}|${ip}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  const body = await readBody(context.request);
  const ip = context.request.headers.get('CF-Connecting-IP')
    || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const key = await hashClient(ip, context.env.SESSION_SECRET);
  const now = Date.now();

  let attempts = [];
  try {
    const row = await db.prepare('SELECT attempts FROM login_throttle WHERE key_hash = ?').bind(key).first();
    attempts = row ? JSON.parse(row.attempts) : [];
  } catch { attempts = []; }
  attempts = (Array.isArray(attempts) ? attempts : []).filter((t) => now - t < WINDOW_MS);
  if (attempts.length >= MAX_ATTEMPTS) {
    return json(null, 429, { error: 'Too many sign-in attempts. Try again in a minute.', code: 'throttled' });
  }
  attempts.push(now);
  try {
    await db.prepare(`INSERT INTO login_throttle (key_hash, attempts, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key_hash) DO UPDATE SET attempts = excluded.attempts, updated_at = excluded.updated_at`)
      .bind(key, JSON.stringify(attempts), now).run();
    if (Math.random() < 0.1) await db.prepare('DELETE FROM login_throttle WHERE updated_at < ?').bind(now - 3600e3).run();
  } catch { /* throttle storage unavailable — still check the password */ }

  const stored = context.env.ADMIN_PASSWORD_HASH || '';
  const ok = await verifyPassword(String(body.password || ''), stored);
  if (!ok) {
    return json(null, 401, { error: 'Invalid console password.', code: 'auth' });
  }
  const token = await createSessionToken(context.env.SESSION_SECRET || '', 12);
  return json(null, 200, { ok: true }, { 'Set-Cookie': SESSION_COOKIE(token) });
}
