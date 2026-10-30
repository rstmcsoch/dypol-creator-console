import { json, readBody, TZ } from './_lib/util.js';
import { getSettings, saveSettings } from './_lib/db.js';
import { checkToken } from './_lib/github.js';

/**
 * GET/PUT /api/settings.
 * Secrets are never returned — only boolean "configured" flags.
 * AUDIT: settings now cover engine enable/disable, default engine/niche,
 * max concurrency, retry limit and draft mode — all enforced server-side in
 * the dispatch/publish paths (a control that only changes appearance is
 * defective).
 */
const DEFAULTS_EXTRA = {
  engines: {
    gemini: { enabled: true },
    verticals: { enabled: false },
  },
  orchestrationExtra: {},
};

let tokenCache = null; // { at, value } — GitHub /user probe, 10 min per isolate
export function _resetTokenCache() { tokenCache = null; }

/** Last proof that each engine's own credentials work (from real runs). */
async function engineEvidence(db) {
  const out = {};
  for (const engine of ['gemini', 'verticals']) {
    const pub = await db.prepare("SELECT published_at FROM jobs WHERE engine = ? AND status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1")
      .bind(engine).first().catch(() => null);
    const draft = await db.prepare("SELECT COALESCE(completed_at, started_at) AS t FROM runs WHERE engine = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1")
      .bind(engine).first().catch(() => null);
    out[engine] = { lastUpload: pub?.published_at || null, lastSuccessfulRun: draft?.t || null };
  }
  return out;
}

export async function onRequestGet(context) {
  const env = context.env;
  const settings = await getSettings(env.DB);
  settings.github.tokenConfigured = !!env.GITHUB_TOKEN;

  if (!tokenCache || Date.now() - tokenCache.at > 600000) {
    tokenCache = { at: Date.now(), value: await checkToken(env.GITHUB_TOKEN) };
  }
  const token = tokenCache.value;
  const evidence = await engineEvidence(env.DB);
  const lastUpload = [evidence.gemini.lastUpload, evidence.verticals.lastUpload].filter(Boolean).sort().pop() || null;

  // YouTube OAuth is held by the engine repos; the console can only report
  // what the last successful upload proved — never a false "Missing".
  settings.youtube = {
    state: lastUpload ? 'verified-by-upload' : 'held-by-engine',
    lastUpload,
    channelName: env.YOUTUBE_CHANNEL_NAME || null,
  };

  return json(null, 200, {
    ...settings,
    health: {
      mode: 'live',
      db: await env.DB.prepare('SELECT 1').first().then(() => 'ok').catch(() => 'error'),
      github: env.GITHUB_TOKEN ? (token.ok ? 'valid' : 'invalid') : 'missing',
      githubToken: !!env.GITHUB_TOKEN,
      githubTokenValid: !!token.ok,
      githubTokenMessage: token.message,
      githubTokenExpiresAt: token.expiresAt || null,
      webhookSecret: !!env.GITHUB_WEBHOOK_SECRET,
      engines: evidence,
      youtubeState: settings.youtube.state,
      youtubeLastUpload: lastUpload,
      youtubeAnalytics: !!(env.YOUTUBE_ANALYTICS_TOKEN_B64 || env.YOUTUBE_OAUTH_REFRESH_TOKEN),
      channelName: env.YOUTUBE_CHANNEL_NAME || null,
    },
  });
}

export async function onRequestPut(context) {
  const body = await readBody(context.request);
  const db = context.env.DB;
  const current = await getSettings(db);
  const merge = (a, b) => ({ ...a, ...(b || {}) });

  // Validated settings (safe defaults on bad input).
  const concurrency = body.orchestration?.maxConcurrency;
  const retryLimit = body.orchestration?.retryLimit;
  const dailyCap = body.publishing?.dailyCap;

  await saveSettings(db, {
    github: merge(current.github, body.github),
    orchestration: {
      ...merge(current.orchestration, body.orchestration),
      maxConcurrency: Math.max(1, Math.min(3, Number(concurrency) || current.orchestration.maxConcurrency || 1)),
      retryLimit: Math.max(0, Math.min(5, Number(retryLimit) || (current.orchestration.retryLimit ?? 2))),
    },
    publishing: {
      ...merge(current.publishing, body.publishing),
      dailyCap: dailyCap ? Math.max(1, Math.min(10, Number(dailyCap))) : current.publishing.dailyCap,
    },
    engines: merge(current.engines, body.engines),
    defaults: merge(current.defaults, body.defaults),
    schedule: merge(current.schedule, body.schedule),
  });
  return json(null, 200, { ok: true, message: 'Settings saved. Credentials remain in server-side secrets.' });
}
