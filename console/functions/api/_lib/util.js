/**
 * Shared utilities for DYPOL Creator Console Pages Functions.
 * No secrets live in this module — they are read from env (server-side only).
 */
export const TZ = 'Asia/Kolkata';

export function json(res, code, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
  });
}

export async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const nowIso = () => new Date().toISOString();

/* ---------------- Duplicate prevention (normalised topic matching) ----------------
 * Limitations (documented in docs/LIMITATIONS.md):
 *  - exact + singular/plural + stopword-insensitive matching only;
 *  - no semantic similarity (two different titles about the same fact slip through);
 *  - containment heuristic can over-block very short generic topics (>=12 chars only). */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or',
  'is', 'are', 'was', 'were', 'with', 'how', 'why', 'what', 'your', 'you', 'our',
  'can', 'does', 'do', 'guide', 'video', 'vs', 'into', 'from', 'at', 'by', 'it', 'its']);

export function normalizeTopic(title) {
  return String(title || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => {
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // memories → memory
      if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // holes → hole
      return w;
    })
    .join(' ')
    .trim();
}

export async function topicKey(title) {
  const data = new TextEncoder().encode(normalizeTopic(title));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/* ---------------- Password hashing (PBKDF2 via WebCrypto) ----------------
 * Generate a hash with: node scripts/hash-password.js 'your-password'
 * Format: pbkdf2$<iterations>$<saltHex>$<hashHex> */
export async function verifyPassword(password, stored) {
  try {
    const [algo, iterS, saltHex, hashHex] = String(stored || '').split('$');
    if (algo !== 'pbkdf2' || !saltHex || !hashHex) return false;
    const iterations = Number(iterS) || 100000;
    const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
    // constant-time-ish comparison
    if (hex.length !== hashHex.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ hashHex.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

/* ---------------- Session cookie (HMAC-signed, stateless) ---------------- */
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSessionToken(secret, hours = 12) {
  const payload = `${Date.now() + hours * 3600e3}.${Math.random().toString(36).slice(2)}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifySessionToken(token, secret) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await hmac(payload, secret);
  if (expected !== parts[2]) return false;
  return Number(parts[0]) > Date.now();
}

export function cookieHeader(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Session lengths: 7 days by default, 30 days with "Keep me signed in". */
export const SESSION_DAYS_DEFAULT = 7;
export const SESSION_DAYS_REMEMBER = 30;
export function sessionDays(remember) {
  return remember === true || remember === 'true' || remember === 1 || remember === '1' || remember === 'on'
    ? SESSION_DAYS_REMEMBER : SESSION_DAYS_DEFAULT;
}
/** The cookie lives exactly as long as the signed token inside it. */
export const SESSION_COOKIE = (token, days = SESSION_DAYS_DEFAULT) =>
  `dypol_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(days * 86400)}`;
export const CLEAR_COOKIE =
  'dypol_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
