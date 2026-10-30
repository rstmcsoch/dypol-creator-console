import { json } from './_lib/util.js';

/**
 * GET /api/health — unauthenticated diagnostics. Only what the CONSOLE holds,
 * as booleans (never values, never network calls from this open route).
 * Engine credentials (LLM, stock, YouTube OAuth) live in the engine repos and
 * are verified by successful runs — see the authenticated /api/settings health.
 */
export async function onRequestGet(context) {
  const env = context.env;
  let db = 'ok';
  try { await env.DB.prepare('SELECT 1').first(); } catch { db = 'error'; }
  return json(null, 200, {
    mode: 'live',
    db,
    github: env.GITHUB_TOKEN ? 'configured' : 'missing',
    githubToken: !!env.GITHUB_TOKEN,
    webhookSecret: !!env.GITHUB_WEBHOOK_SECRET,
    sessionSecret: !!env.SESSION_SECRET,
    engineCredentials: 'held-by-engine',
  });
}
