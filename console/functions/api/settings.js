import { json, readBody, TZ } from './_lib/util.js';
import { getSettings, saveSettings } from './_lib/db.js';

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

export async function onRequestGet(context) {
  const env = context.env;
  const settings = await getSettings(env.DB);
  settings.github.tokenConfigured = !!env.GITHUB_TOKEN;

  // YouTube connection state machine (never "connected" on file presence alone).
  const hasClient = !!env.YOUTUBE_CLIENT_SECRET_B64;
  const hasToken = !!env.YOUTUBE_TOKEN_B64;
  settings.youtube = {
    state: !hasClient || !hasToken ? 'missing-credentials' : 'configured-untested',
    channelName: env.YOUTUBE_CHANNEL_NAME || null,
  };

  return json(null, 200, {
    ...settings,
    health: {
      mode: 'live',
      db: await env.DB.prepare('SELECT 1').first().then(() => 'ok').catch(() => 'error'),
      github: env.GITHUB_TOKEN ? 'configured' : 'missing',
      githubToken: !!env.GITHUB_TOKEN,
      geminiKey: !!env.GEMINI_API_KEY,
      youtubeOAuth: hasClient && hasToken,
      youtubeState: settings.youtube.state,
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
