import { json } from './_lib/util.js';

/**
 * GET /api/health — unauthenticated diagnostics.
 * Reports only booleans about secrets (never values).
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
    geminiKey: !!env.GEMINI_API_KEY,
    youtubeOAuth: !!(env.YOUTUBE_CLIENT_SECRET_B64 && env.YOUTUBE_TOKEN_B64),
    youtubeAnalytics: !!env.YOUTUBE_ANALYTICS_TOKEN_B64,
  });
}
