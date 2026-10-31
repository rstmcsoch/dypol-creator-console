/**
 * D1 data access for DYPOL Creator Console.
 * Binding name: DB (see wrangler.toml). Row shapes match the /api contract.
 */
import { uid, nowIso, topicKey, TZ } from './util.js';

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function rowToJob(r) {
  return {
    id: r.id, engine: r.engine, title: r.title, topic: r.topic,
    niche: r.niche, format: r.format, status: r.status, stage: r.stage,
    progress: r.progress === null || r.progress === undefined ? null : r.progress,
    description: r.description,
    tags: parse(r.tags, []), durationSec: r.duration_sec, thumbnail: r.thumbnail,
    createdAt: r.created_at, updatedAt: r.updated_at,
    scheduledFor: r.scheduled_for, publishedAt: r.published_at,
    youtubeId: r.youtube_id, youtubeUrl: r.youtube_url, error: r.error,
    errorCategory: r.error_category || null,
    errorRetryable: r.error_retryable === null || r.error_retryable === undefined ? null : !!r.error_retryable,
    quality: parse(r.quality, {}), logs: parse(r.logs, []),
    runId: r.run_id,
    parentJobId: r.parent_job_id || null,
    attempt: r.attempt || 1,
    publishBlocked: r.publish_blocked,
    duplicateOf: parse(r.duplicate_of, null),
    currentStep: r.current_step || null,
    publishRunId: r.publish_run_id || null,
    uploadingSince: r.uploading_since ? Number(r.uploading_since) : null,
    reviewNote: r.review_note || null,
    retryCount: Number(r.retry_count || 0),
    videos: parse(r.videos, []),
    errorLog: r.error_log || null,
    demo: false,
  };
}

export function rowToRun(r) {
  return {
    id: r.id, runId: r.run_id, engine: r.engine, workflow: r.workflow,
    jobId: r.job_id, startedAt: r.started_at, durationSec: r.duration_sec,
    status: r.status, failureReason: r.failure_reason, githubUrl: r.github_url,
    steps: parse(r.steps, []), logs: parse(r.logs, []), artifacts: parse(r.artifacts, []),
    conclusion: r.conclusion || null, currentStep: r.current_step || null, completedAt: r.completed_at || null,
    phase: r.phase || null,
    inputs: parse(r.inputs, null),
    demo: false,
  };
}

export async function listJobs(db, { status, engine, type, niche, since, q, sort } = {}) {
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const args = [];
  if (status) {
    const set = status.split(',');
    const cond = set.map((s) => {
      if (s === 'needs-review') { args.push('needs-review', 'awaiting-review'); return "(status = ? OR status = ?)"; }
      args.push(s); return 'status = ?';
    }).join(' OR ');
    sql += ` AND (${cond})`;
  }
  if (engine) { sql += ' AND engine = ?'; args.push(engine); }
  if (type) { sql += ' AND format = ?'; args.push(type); }
  if (niche) { sql += ' AND niche = ?'; args.push(niche); }
  if (since) { sql += ' AND substr(created_at,1,10) >= ?'; args.push(since); }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    sql += ' AND (LOWER(title) LIKE ? OR LOWER(COALESCE(topic,\'\')) LIKE ? OR LOWER(COALESCE(tags,\'\')) LIKE ?)';
    args.push(like, like, like);
  }
  sql += sort === 'oldest' ? ' ORDER BY updated_at ASC'
    : sort === 'status' ? ' ORDER BY status ASC'
    : ' ORDER BY updated_at DESC';
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map(rowToJob);
}

export async function getJob(db, id) {
  const r = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return r ? rowToJob(r) : null;
}

export async function insertJob(db, job) {
  await db.prepare(`INSERT INTO jobs
    (id, engine, title, topic, topic_key, niche, format, status, stage, progress,
     description, tags, duration_sec, thumbnail, created_at, updated_at, scheduled_for,
     published_at, youtube_id, youtube_url, error, error_category, error_retryable,
     quality, logs, run_id, parent_job_id, attempt, publish_blocked, duplicate_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      job.id, job.engine, job.title, job.topic, await topicKey(job.title),
      job.niche, job.format, job.status, job.stage, job.progress,
      job.description, JSON.stringify(job.tags || []), job.durationSec, job.thumbnail,
      job.createdAt, job.updatedAt, job.scheduledFor, job.publishedAt,
      job.youtubeId, job.youtubeUrl, job.error,
      job.errorCategory || null,
      job.errorRetryable === undefined ? null : (job.errorRetryable ? 1 : 0),
      JSON.stringify(job.quality || {}), JSON.stringify(job.logs || []),
      job.runId, job.parentJobId || null, job.attempt || 1,
      job.publishBlocked, job.duplicateOf ? JSON.stringify(job.duplicateOf) : null,
    ).run();
  return job;
}

export async function updateJob(db, id, patch) {
  const map = {
    status: 'status', stage: 'stage', progress: 'progress', description: 'description',
    error: 'error', scheduledFor: 'scheduled_for', publishedAt: 'published_at',
    youtubeId: 'youtube_id', youtubeUrl: 'youtube_url', runId: 'run_id',
    publishBlocked: 'publish_blocked', durationSec: 'duration_sec', thumbnail: 'thumbnail',
    title: 'title', topic: 'topic', niche: 'niche', format: 'format',
    errorCategory: 'error_category', attempt: 'attempt', parentJobId: 'parent_job_id',
    publishRunId: 'publish_run_id', uploadingSince: 'uploading_since', reviewNote: 'review_note',
    errorLog: 'error_log', retryCount: 'retry_count',
  };
  const sets = [], args = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); args.push(patch[k]); }
  }
  if (patch.errorRetryable !== undefined) { sets.push('error_retryable = ?'); args.push(patch.errorRetryable ? 1 : 0); }
  if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(patch.tags)); }
  if (patch.quality !== undefined) { sets.push('quality = ?'); args.push(JSON.stringify(patch.quality)); }
  if (patch.logs !== undefined) { sets.push('logs = ?'); args.push(JSON.stringify(patch.logs)); }
  if (patch.videos !== undefined) { sets.push('videos = ?'); args.push(patch.videos ? JSON.stringify(patch.videos) : null); }
  if (patch.duplicateOf !== undefined) { sets.push('duplicate_of = ?'); args.push(patch.duplicateOf ? JSON.stringify(patch.duplicateOf) : null); }
  sets.push('updated_at = ?'); args.push(nowIso());
  args.push(id);
  await db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

export async function appendLog(db, job, entry) {
  const logs = [...(job.logs || []), entry];
  await updateJob(db, job.id, { logs });
  return logs;
}

/* ---------------- runs ---------------- */
export async function listRuns(db) {
  const { results } = await db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 200').all();
  return results.map(rowToRun);
}

export async function getRun(db, id) {
  const r = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  return r ? rowToRun(r) : null;
}

export async function insertRun(db, run) {
  const cols = ['id', 'run_id', 'engine', 'workflow', 'job_id', 'started_at', 'duration_sec', 'status',
    'failure_reason', 'github_url', 'steps', 'logs', 'artifacts'];
  const vals = [run.id, run.runId, run.engine, run.workflow, run.jobId, run.startedAt,
    run.durationSec, run.status, run.failureReason, run.githubUrl,
    JSON.stringify(run.steps || []), JSON.stringify(run.logs || []), JSON.stringify(run.artifacts || [])];
  // Optional columns (added by ensureProgressSchema) only when set, so legacy DBs still insert.
  if (run.phase) { cols.push('phase'); vals.push(run.phase); }
  if (run.inputs) { cols.push('inputs'); vals.push(JSON.stringify(run.inputs)); }
  await db.prepare(`INSERT INTO runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...vals).run();
}

/** Most recent run rows for a job (newest first), optionally one phase. */
export async function runsForJob(db, jobId, phase) {
  const { results } = await db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 20')
    .bind(jobId).all();
  return results.map(rowToRun).filter((r) => !phase || (r.phase || 'draft') === phase);
}

export async function updateRun(db, id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries({
    runId: 'run_id', status: 'status', failureReason: 'failure_reason',
    durationSec: 'duration_sec', githubUrl: 'github_url', startedAt: 'started_at',
    phase: 'phase', jobId: 'job_id',
  })) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); args.push(patch[k]); }
  }
  for (const [k, col] of [['steps', 'steps'], ['logs', 'logs'], ['artifacts', 'artifacts'], ['inputs', 'inputs']]) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); args.push(JSON.stringify(patch[k])); }
  }
  args.push(id);
  await db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

/* ---------------- uploads / activity ---------------- */
export async function recordUpload(db, { topicKey: key, youtubeId, jobId, idempotencyKey }) {
  await db.prepare('INSERT INTO uploads (id, topic_key, youtube_id, job_id, at, idempotency_key) VALUES (?,?,?,?,?,?)')
    .bind(uid('up'), key, youtubeId, jobId, nowIso(), idempotencyKey || null).run();
}

export async function findUploadByKey(db, key) {
  return db.prepare('SELECT * FROM uploads WHERE topic_key = ? ORDER BY at DESC LIMIT 1').bind(key).first();
}

/** Start of the current UTC day as ISO (all stored timestamps are UTC ISO). */
export function utcDayStartIso(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Daily-cap usage: jobs PUBLISHED since 00:00 UTC today + jobs UPLOADING that
 * started within the last 6 h (older uploads are stale and are reconciled, so
 * they can never hold the cap forever). Counted per job, not per video.
 */
export async function capUsage(db, now = Date.now()) {
  const dayStart = utcDayStartIso(now);
  const pub = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published' AND published_at >= ?")
    .bind(dayStart).first();
  const sixH = now - 6 * 3600e3;
  const { results } = await db.prepare("SELECT uploading_since FROM jobs WHERE status = 'uploading'").all();
  // Every upload dispatched by this build stamps uploading_since; a row
  // without it predates the fix and is left to the reconciler (not counted).
  const uploading = (results || []).filter((r) => r.uploading_since && Number(r.uploading_since) >= sixH).length;
  return { published: Number(pub?.n || 0), uploading, total: Number(pub?.n || 0) + uploading, dayStart };
}

export async function uploadsOnDate(db, dateStr) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE substr(at,1,10) = ?").bind(dateStr).first();
  return Number(r?.n || 0);
}

export async function addActivity(db, { icon, tone, title, sub }) {
  await db.prepare('INSERT INTO activity (id, ts, icon, tone, title, sub) VALUES (?,?,?,?,?,?)')
    .bind(uid('act'), nowIso(), icon, tone, title, sub).run();
}

export async function listActivity(db, limit = 8) {
  const { results } = await db.prepare('SELECT * FROM activity ORDER BY ts DESC LIMIT ?').bind(limit).all();
  return results;
}

/* ---------------- settings ---------------- */
export const DEFAULT_SETTINGS = {
  github: {
    gemini: { repo: '', workflow: 'main.yml' },
    verticals: { repo: '', workflow: 'verticals.yml' },
    branch: 'dypol-integration', tokenConfigured: false,
  },
  engines: {
    gemini: { enabled: true },
    verticals: { enabled: false },
  },
  orchestration: {
    mode: 'primary_with_fallback', fallback: 'on_failure', alternate: 'days',
    maxConcurrency: 1, retryLimit: 2,
  },
  publishing: {
    reviewRequired: true, autoPublish: false, dedupe: true, publishLock: true,
    visibility: 'private', dailyCap: 2, draftMode: false,
  },
  defaults: { format: 'per_engine', language: 'en', niche: 'general', engine: 'gemini' },
  schedule: {
    timezone: TZ, frequency: 'daily', windowStart: '18:00', windowEnd: '21:00',
    automationPaused: false,
  },
};

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of results) {
    // Login-throttle rows are not settings (and must never reach a response).
    if (String(r.key).startsWith('throttle:')) continue;
    try {
      const path = r.key.split('.');
      let node = out;
      for (let i = 0; i < path.length - 1; i++) node = node[path[i]] = node[path[i]] || {};
      node[path[path.length - 1]] = JSON.parse(r.value);
    } catch { /* ignore malformed rows */ }
  }
  return out;
}

export async function saveSettings(db, incoming) {
  const flat = (obj, prefix = '') => Object.entries(obj || {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flat(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v]]);
  for (const [k, v] of flat(incoming)) {
    await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(k, JSON.stringify(v)).run();
  }
}
