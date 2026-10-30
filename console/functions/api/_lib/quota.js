/**
 * Quota & health panel data (Overview + Settings).
 *
 * Per engine, from D1 plus the latest runs' logs / result files:
 *  - GitHub token expiry (shared token)
 *  - YouTube uploads today vs the console daily cap (+ estimated API units)
 *  - Last successful upload (the practical "YouTube OAuth OK" signal)
 *  - Cloudflare FLUX quota / Pixabay limit hit today (Engine log lines)
 *  - NVIDIA visual-judge status / calls (draft candidate's judge summary)
 *  - Gemini llm_unavailable failures, last 7 days
 *  - GitHub Actions storage: cache usage + live artifacts vs 500 MB free
 *
 * Cached in D1 (quota_cache) and recomputed at most every 30 minutes.
 * Every GitHub call is charged to a subrequest budget well under the
 * Workers 50-subrequest limit; when the budget runs out, the remaining
 * items say "not checked" instead of failing the request.
 */
import { splitRepo, listWorkflowRuns, listRunJobs, fetchJobLog, checkToken, ghGet, artifactBlobUrl } from './github.js';
import { openRemoteZip, readEntryBytes } from './remotezip.js';
import { utcDayStartIso } from './db.js';

export const REFRESH_MS = 30 * 60e3;
export const SUBREQUEST_BUDGET = 40; // Workers limit is 50; leave headroom
export const ACTIONS_FREE_BYTES = 500 * 1024 * 1024;
export const YT_DAILY_UNITS = 10000;
export const YT_UNITS_PER_VIDEO = 1600 + 50 + 400; // insert + thumbnails.set + captions.insert
const ENGINES = ['gemini', 'verticals'];
const LOG_RUNS_PER_ENGINE = 2;

export class Budget {
  constructor(limit = SUBREQUEST_BUDGET) { this.limit = limit; this.used = 0; this.skipped = []; }
  take(n, what) {
    if (this.used + n > this.limit) { this.skipped.push(what); return false; }
    this.used += n; return true;
  }
}

let schemaReady = false;
export function _resetQuotaSchema() { schemaReady = false; }
export async function ensureQuotaSchema(db) {
  if (schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS quota_cache (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`).run();
  schemaReady = true;
}

export async function readQuotaCache(db) {
  await ensureQuotaSchema(db);
  const row = await db.prepare('SELECT data, updated_at FROM quota_cache WHERE key = ?').bind('panel').first();
  if (!row) return null;
  try { return { data: JSON.parse(row.data), updatedAt: Number(row.updated_at) }; } catch { return null; }
}

export async function writeQuotaCache(db, data, now = Date.now()) {
  await ensureQuotaSchema(db);
  await db.prepare(`INSERT INTO quota_cache (key, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind('panel', JSON.stringify(data), now).run();
}

/* ---------------- log scanning ---------------- */
const RX = {
  // Engine A: visuals.trip_breaker() → "⚠️ flux quota/limit hit (HTTP 429); skipping flux …"
  flux: /(\bflux\b[^\n]{0,40}(quota\/limit hit|circuit|neurons|daily free allocation))|(FLUX circuit)/i,
  pixabay: /\bpixabay\b[^\n]{0,40}(quota\/limit hit|HTTP 429|rate.?limit)/i,
  judgeCircuit: /visual judge circuit open \(([^)\n]{0,160})\)/i,
  judgeReview: /visual judge needs review/i,
  llm: /DYPOL_FAILURE_CATEGORY=llm_unavailable/,
};

export function scanLog(text) {
  const t = String(text || '');
  const circuit = RX.judgeCircuit.exec(t);
  const line = (rx) => {
    const m = rx.exec(t);
    if (!m) return null;
    const start = t.lastIndexOf('\n', m.index) + 1;
    const end = t.indexOf('\n', m.index);
    return t.slice(start, end < 0 ? undefined : end).replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').trim().slice(0, 200);
  };
  return {
    flux: RX.flux.test(t), fluxLine: line(RX.flux),
    pixabay: RX.pixabay.test(t), pixabayLine: line(RX.pixabay),
    judgeCircuit: circuit ? circuit[1] : null,
    judgeReview: RX.judgeReview.test(t),
    llmUnavailable: RX.llm.test(t),
  };
}

/** Judge summary from Engine A candidate.json or Engine B draft / broll_manifest JSON. */
export function judgeFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = { status: null, calls: 0, circuit: null, needsReview: false, providerLimits: {} };
  const vj = obj.visual_judge;
  if (vj && typeof vj === 'object') {
    const parts = vj.judge_status ? [vj] : Object.values(vj).filter((v) => v && typeof v === 'object');
    for (const p of parts) {
      out.status = out.status || p.judge_status || null;
      out.calls += Number(p.calls || 0);
      if (p.circuit?.state === 'open') out.circuit = p.circuit.reason || 'open';
      if (p.needs_review) out.needsReview = true;
    }
  }
  out.status = out.status || obj.judge_status || obj.visual_judge_status || null;
  if (obj.provider_limits && typeof obj.provider_limits === 'object') out.providerLimits = obj.provider_limits;
  if (Array.isArray(obj.visual_review_reasons) && obj.visual_review_reasons.length) out.needsReview = true;
  return out.status || out.calls || Object.keys(out.providerLimits).length ? out : null;
}

const JUDGE_ENTRY = /(candidates\/[^/]+\/candidate\.json|broll_manifest\.json|drafts\/[^/]+\.json)$/i;

async function readJudge(token, gh, artifact, budget) {
  if (!artifact) return null;
  if (!budget.take(4, 'judge summary')) return { skipped: true };
  try {
    const url = await artifactBlobUrl(token, { ...gh, artifactId: artifact.id });
    if (!url) return null;
    const zip = await openRemoteZip(url);
    const entries = zip.entries.filter((e) => JUDGE_ENTRY.test(e.name))
      .sort((a, b) => (/candidate\.json$/.test(b.name) ? 1 : 0) - (/candidate\.json$/.test(a.name) ? 1 : 0));
    for (const e of entries.slice(0, 1)) {
      const bytes = await readEntryBytes(url, e);
      return judgeFromJson(JSON.parse(new TextDecoder().decode(bytes)));
    }
  } catch { /* artifact expired / unreadable */ }
  return null;
}

/* ---------------- per-engine collection ---------------- */
function videosOf(job) {
  const v = Array.isArray(job.videos) ? job.videos.filter((x) => x && (x.youtube_id || x.youtubeId)) : [];
  if (v.length) return v.length;
  return job.youtubeId ? (job.engine === 'gemini' ? 2 : 1) : 0;
}

async function collectEngine(engine, { token, settings, jobs, now, budget }) {
  const out = {
    engine,
    configured: !!settings.github[engine]?.repo,
    enabled: settings.engines?.[engine]?.enabled !== false,
    uploadsToday: { jobs: 0, videos: 0 },
    lastUpload: null,
    oauth: { state: 'unknown', detail: 'No upload recorded yet' },
    flux: { state: 'unknown', detail: 'Not checked' },
    pixabay: { state: 'unknown', detail: 'Not checked' },
    judge: { state: 'unknown', detail: 'Not checked', calls: null },
    llmUnavailable7d: 0,
    storage: { cacheBytes: null, artifactBytes: null, artifactCount: null },
    logsScanned: 0,
    notes: [],
  };
  const dayStart = utcDayStartIso(now);
  const weekAgo = new Date(now - 7 * 86400e3).toISOString();
  const mine = jobs.filter((j) => j.engine === engine);

  // Uploads today + last successful upload (D1, no subrequests).
  const today = mine.filter((j) => j.publishedAt && j.publishedAt >= dayStart && j.youtubeId);
  out.uploadsToday = { jobs: today.length, videos: today.reduce((n, j) => n + videosOf(j), 0) };
  const published = mine.filter((j) => j.publishedAt && j.youtubeId).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  out.lastUpload = published[0] ? { at: published[0].publishedAt, title: published[0].title, youtubeId: published[0].youtubeId } : null;
  const publishFailsAfter = mine.filter((j) => j.errorCategory === 'publish'
    && (!out.lastUpload || (j.updatedAt || '') > out.lastUpload.at));
  const oauthFail = publishFailsAfter.find((j) => /invalid_grant|oauth|unauthori[sz]ed|token has been expired|revoked/i.test(`${j.error || ''} ${j.errorLog || ''}`));
  if (oauthFail) out.oauth = { state: 'bad', detail: 'A publish after the last upload failed with an OAuth error' };
  else if (out.lastUpload) {
    const ageDays = (now - Date.parse(out.lastUpload.at)) / 86400e3;
    out.oauth = ageDays <= 7
      ? { state: 'ok', detail: 'Uploads are succeeding' }
      : { state: 'warn', detail: `No upload for ${Math.floor(ageDays)} days — OAuth unverified since` };
  }
  out.llmUnavailable7d = mine.filter((j) => j.errorCategory === 'llm_unavailable' && (j.updatedAt || j.createdAt || '') >= weekAgo).length;

  if (!out.configured) { out.notes.push('Repository not set'); return out; }
  if (!token) { out.notes.push('GITHUB_TOKEN missing'); return out; }
  const gh = splitRepo(settings.github[engine].repo);

  // Actions storage (2 calls).
  if (budget.take(1, `${engine} cache usage`)) {
    try {
      const c = await ghGet(token, `/repos/${gh.owner}/${gh.repo}/actions/cache/usage`);
      out.storage.cacheBytes = Number(c?.active_caches_size_in_bytes || 0);
    } catch (err) { out.notes.push(`Cache usage unavailable (${err.status || 'error'})`); }
  }
  let artifacts = [];
  if (budget.take(1, `${engine} artifacts`)) {
    try {
      const a = await ghGet(token, `/repos/${gh.owner}/${gh.repo}/actions/artifacts?per_page=100`);
      artifacts = (a?.artifacts || []).filter((x) => !x.expired);
      out.storage.artifactBytes = artifacts.reduce((n, x) => n + Number(x.size_in_bytes || 0), 0);
      out.storage.artifactCount = artifacts.length;
      if (Number(a?.total_count || 0) > 100) out.notes.push('Over 100 artifacts; storage shows the newest 100');
    } catch (err) { out.notes.push(`Artifacts unavailable (${err.status || 'error'})`); }
  }

  // Latest runs today → logs (FLUX / Pixabay / judge circuit / llm_unavailable lines).
  let runs = [];
  if (budget.take(1, `${engine} runs`)) {
    try {
      runs = await listWorkflowRuns(token, { ...gh, workflowFile: settings.github[engine].workflow, perPage: 10, branch: settings.github.branch });
    } catch (err) { out.notes.push(`Runs unavailable (${err.status || 'error'})`); }
  }
  const todayRuns = runs.filter((r) => r.status === 'completed' && (r.startedAt || '') >= dayStart).slice(0, LOG_RUNS_PER_ENGINE);
  const hits = { flux: null, pixabay: null, circuit: null, review: false, llm: 0 };
  let scanned = 0;
  for (const run of todayRuns) {
    if (!budget.take(1, `${engine} run jobs`)) break;
    let ghJobs = [];
    try { ghJobs = await listRunJobs(token, { ...gh, runId: run.runId }); } catch { continue; }
    for (const gj of ghJobs.filter((j) => j.conclusion && j.conclusion !== 'skipped').slice(0, 2)) {
      if (!budget.take(2, `${engine} job log`)) break;
      const s = scanLog(await fetchJobLog(token, { ...gh, jobId: gj.id }));
      scanned++;
      if (s.flux && !hits.flux) hits.flux = s.fluxLine || 'limit hit';
      if (s.pixabay && !hits.pixabay) hits.pixabay = s.pixabayLine || 'limit hit';
      if (s.judgeCircuit && !hits.circuit) hits.circuit = s.judgeCircuit;
      if (s.judgeReview) hits.review = true;
      if (s.llmUnavailable) hits.llm++;
    }
  }
  out.logsScanned = scanned;

  // Judge summary (and Engine A's provider_limits) from the newest live draft bundle.
  const bundle = artifacts
    .filter((a) => /^(dypol-candidate|draft)-/i.test(a.name))
    .sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : -1))[0];
  const judge = await readJudge(token, gh, bundle, budget);
  const bundleToday = bundle && (bundle.created_at || '') >= dayStart;

  const limits = (judge && bundleToday && judge.providerLimits) || {};
  const limitState = (name, logHit) => {
    if (logHit || limits[name]) return { state: 'bad', detail: `Limit hit today${logHit ? ` · ${String(logHit).slice(0, 90)}` : ''}` };
    if (!todayRuns.length && !bundleToday) return { state: 'unknown', detail: 'No run today' };
    if (!scanned && !bundleToday) return { state: 'unknown', detail: 'Logs not checked' };
    return { state: 'ok', detail: 'No limit hit today' };
  };
  out.flux = limitState('flux', hits.flux);
  out.pixabay = limitState('pixabay', hits.pixabay);
  if (engine === 'verticals' && out.flux.state === 'ok') out.flux.detail += ' (Engine B does not log 429s yet)';
  if (engine === 'verticals' && out.pixabay.state === 'ok') out.pixabay.detail += ' (Engine B does not log 429s yet)';

  if (judge?.skipped) out.judge = { state: 'unknown', detail: 'Not checked (request budget)', calls: null };
  else if (judge && (judge.status || judge.calls)) {
    const circuit = judge.circuit || hits.circuit;
    const status = judge.status || 'unknown';
    out.judge = {
      state: circuit ? 'bad' : status === 'active' || status === 'enabled' || status === 'ok' ? 'ok'
        : status === 'disabled' ? 'off' : 'warn',
      detail: circuit ? `Circuit open: ${String(circuit).slice(0, 80)}` : `Status ${status}${judge.needsReview ? ' · flagged for review' : ''}`,
      calls: judge.calls,
      asOf: bundle?.created_at || null,
    };
  } else if (hits.circuit) out.judge = { state: 'bad', detail: `Circuit open: ${hits.circuit.slice(0, 80)}`, calls: null };
  else if (bundle) out.judge = { state: 'unknown', detail: 'No judge summary in the latest draft', calls: null };
  else out.judge = { state: 'unknown', detail: 'No live draft artifact', calls: null };

  out.llmUnavailable7d = Math.max(out.llmUnavailable7d, hits.llm);
  return out;
}

/** Compute the whole panel. `deps` lets tests inject a clock. */
export async function collectQuota(env, { settings, jobs, capUsage, now = Date.now() }) {
  const token = env.GITHUB_TOKEN;
  const budget = new Budget();
  let tokenInfo = { state: 'unknown', detail: 'GITHUB_TOKEN missing', expiresAt: null };
  if (token && budget.take(1, 'token')) {
    const t = await checkToken(token);
    const days = t.expiresAt && !Number.isNaN(Date.parse(t.expiresAt)) ? (Date.parse(t.expiresAt) - now) / 86400e3 : null;
    tokenInfo = {
      state: !t.ok ? 'bad' : days === null ? 'ok' : days < 0 ? 'bad' : days < 14 ? 'warn' : 'ok',
      detail: !t.ok ? (t.message || 'Rejected') : days === null ? 'Valid · no expiry reported' : `Expires in ${Math.max(0, Math.floor(days))} days`,
      expiresAt: t.expiresAt || null,
    };
  }
  const engines = [];
  for (const engine of ENGINES) engines.push(await collectEngine(engine, { token, settings, jobs, now, budget }));

  const used = engines.reduce((n, e) => n + (e.storage.cacheBytes || 0) + (e.storage.artifactBytes || 0), 0);
  const ytVideos = engines.reduce((n, e) => n + e.uploadsToday.videos, 0);
  const cap = Number(settings.publishing?.dailyCap ?? 2);
  return {
    generatedAt: new Date(now).toISOString(),
    nextRefreshAt: new Date(now + REFRESH_MS).toISOString(),
    dayStartUtc: utcDayStartIso(now),
    token: tokenInfo,
    youtube: {
      capJobs: cap,
      usedJobs: capUsage?.total ?? engines.reduce((n, e) => n + e.uploadsToday.jobs, 0),
      videosToday: ytVideos,
      estUnits: ytVideos * YT_UNITS_PER_VIDEO,
      dailyUnits: YT_DAILY_UNITS,
    },
    storage: {
      usedBytes: used,
      freeBytes: ACTIONS_FREE_BYTES,
      pct: Math.round((used / ACTIONS_FREE_BYTES) * 100),
      state: used > ACTIONS_FREE_BYTES * 0.9 ? 'bad' : used > ACTIONS_FREE_BYTES * 0.7 ? 'warn' : 'ok',
    },
    engines,
    subrequests: { used: budget.used, limit: budget.limit, skipped: budget.skipped },
  };
}
