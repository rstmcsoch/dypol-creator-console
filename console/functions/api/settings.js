import { json, readBody, TZ } from './_lib/util.js';
import { getSettings, saveSettings } from './_lib/db.js';
import { checkToken, setRepoVariable, getRepoVariable } from './_lib/github.js';
import { validateVoice, validateDesignPattern, sanitizeCustomVoices } from './_lib/voices.js';

/** Engine repos whose Actions variables carry the default voice / pattern. */
export const ENGINE_VARIABLE_REPOS = [
  { owner: 'rstmcsoch', repo: 'gemini-youtube-automation' },
  { owner: 'rstmcsoch', repo: 'youtube-shorts-pipeline' },
];
export const VOICE_VARIABLE = 'DYPOL_DEFAULT_VOICE';
export const PATTERN_VARIABLE = 'DYPOL_DEFAULT_PATTERN';

/**
 * Best-effort: copy the console's default voice / pattern into both engine
 * repos' Actions variables with the console's own GitHub token. Never throws —
 * a refusal (e.g. the token lacks "Variables: write") becomes a notice and the
 * console save still stands.
 */
export async function syncEngineDefaults(token, wanted) {
  const vars = [
    wanted.voice ? [VOICE_VARIABLE, wanted.voice] : null,
    wanted.pattern ? [PATTERN_VARIABLE, wanted.pattern] : null,
  ].filter(Boolean);
  const failed = new Map(); // variable name → first repo that refused it
  for (const [name, value] of vars) {
    for (const r of ENGINE_VARIABLE_REPOS) {
      if (!token) { if (!failed.has(name)) failed.set(name, r); continue; }
      try { await setRepoVariable(token, { ...r, name, value }); } catch { if (!failed.has(name)) failed.set(name, r); }
    }
  }
  const confirmed = {};
  if (wanted.voice && !failed.has(VOICE_VARIABLE)) confirmed.voice = wanted.voice;
  if (wanted.pattern && !failed.has(PATTERN_VARIABLE)) confirmed.pattern = wanted.pattern;
  if (!failed.size) return { ok: true, confirmed };
  const still = [];
  for (const [name, r] of failed) {
    let current = null;
    if (token) { try { current = await getRepoVariable(token, { ...r, name }); } catch { current = null; } }
    still.push(current || 'their own default');
  }
  return {
    ok: false, confirmed, failed: [...failed.keys()],
    notice: `Saved in console; engines still use ${still.join(' · ')}`,
  };
}

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

  // Narration voices + design pattern (validated; bad input is refused, not guessed).
  let customVoices = current.customVoices;
  if (body.customVoices !== undefined) {
    try { customVoices = sanitizeCustomVoices(body.customVoices); } catch (err) {
      return json(null, 400, { error: err.message, code: 'bad-voice' });
    }
  }
  const defaultsIn = { ...(body.defaults || {}) };
  if (defaultsIn.voice !== undefined) {
    const v = validateVoice(defaultsIn.voice, customVoices);
    if (!v.ok) return json(null, 400, { error: v.error, code: 'bad-voice' });
    defaultsIn.voice = v.value;
  }
  if (defaultsIn.designPattern !== undefined) {
    const p = validateDesignPattern(defaultsIn.designPattern);
    if (!p.ok) return json(null, 400, { error: p.error, code: 'bad-design-pattern' });
    defaultsIn.designPattern = p.value;
  }

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
    defaults: merge(current.defaults, defaultsIn),
    schedule: merge(current.schedule, body.schedule),
    ...(body.customVoices !== undefined ? { customVoices } : {}),
  });

  // Push a changed default voice / pattern to the engines (best effort).
  const synced = current.engineSync || {};
  const wanted = {
    voice: defaultsIn.voice && defaultsIn.voice !== synced.voice ? defaultsIn.voice : null,
    pattern: defaultsIn.designPattern && defaultsIn.designPattern !== synced.pattern ? defaultsIn.designPattern : null,
  };
  let engineSync;
  if (wanted.voice || wanted.pattern) {
    engineSync = await syncEngineDefaults(context.env.GITHUB_TOKEN, wanted);
    await saveSettings(db, { engineSync: { ...synced, ...engineSync.confirmed, at: new Date().toISOString() } });
  }
  return json(null, 200, {
    ok: true, message: 'Settings saved. Credentials remain in server-side secrets.',
    ...(engineSync ? { engineSync: { ok: engineSync.ok, ...(engineSync.notice ? { notice: engineSync.notice } : {}) } } : {}),
  });
}
