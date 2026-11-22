/**
 * Keep only the latest videos (owner's request, 22 Nov 2026).
 *
 * After a video reaches review, older videos beyond the newest N (default 8,
 * min 3) are removed with the SAME code path as the manual Delete button
 * (runDeletion: GitHub runs + logs + artifacts, committed files, R2
 * drafts/<id>/ + published/<id>/, every D1 row). Linked versions are never
 * pulled in (include = []), exactly like a manual delete with nothing ticked.
 *
 * Never touches YouTube: a published video stays on YouTube; only the console
 * copy goes. Videos being made, queued, waiting to upload or uploading are
 * skipped (they still count toward the newest N).
 *
 * One deletion pass per trigger by default (Workers Free: 50 subrequests per
 * request). A pass that pauses leaves its `deletions` row; the next trigger
 * resumes it, because the job is still beyond the newest N.
 */
import { getJob, appendLog, addActivity } from './db.js';
import { runDeletion } from './deletejob.js';

export const RETENTION_DEFAULT = 8;
export const RETENTION_MIN = 3;
export const RETENTION_MAX = 50;
/** Jobs that are being made, queued, waiting for upload or uploading. */
export const RETENTION_SKIP = ['queued', 'dispatched', 'running', 'generating', 'rendering',
  'uploading', 'approved', 'scheduled'];

export function clampRetentionCount(v, fallback = RETENTION_DEFAULT) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(RETENTION_MIN, Math.min(RETENTION_MAX, n));
}

/** { enabled, count } from settings (default ON, 8). */
export function retentionOf(settings) {
  const r = settings?.retention || {};
  return { enabled: r.keepLatest !== false, count: clampRetentionCount(r.count) };
}

const logTs = () => new Date().toISOString().slice(11, 19);

/**
 * Remove videos older than the newest N. Returns
 * { enabled, count, deleted:[ids], skipped:[ids], pending:[ids], refused }.
 */
export async function pruneOldJobs(db, env, settings, { maxPasses = 1, runDeletionFn = runDeletion, now = Date.now() } = {}) {
  const { enabled, count } = retentionOf(settings);
  const out = { enabled, count, deleted: [], skipped: [], pending: [], refused: null };
  if (!enabled || !db) return out;
  const { results } = await db.prepare('SELECT id, status FROM jobs ORDER BY created_at DESC, id DESC').all();
  const older = (results || []).slice(count);
  if (!older.length) return out;
  // Resume deletions already under way first, then oldest first.
  let started = new Set();
  try {
    const { results: d } = await db.prepare('SELECT job_id FROM deletions').all();
    started = new Set((d || []).map((r) => r.job_id));
  } catch { /* table missing: nothing under way */ }
  const candidates = [];
  for (const j of older) {
    if (RETENTION_SKIP.includes(j.status)) { out.skipped.push(j.id); continue; }
    candidates.push(j);
  }
  candidates.reverse();
  candidates.sort((a, b) => Number(started.has(b.id)) - Number(started.has(a.id)));

  let passes = 0;
  for (const j of candidates) {
    if (passes >= maxPasses) { out.pending.push(j.id); continue; }
    const job = await getJob(db, j.id);
    if (!job) continue;
    if (!started.has(j.id)) {
      try {
        await appendLog(db, job, { ts: logTs(), level: 'info', msg: `Removing automatically — only the latest ${count} videos are kept. Nothing is deleted from YouTube.` });
      } catch { /* log is best effort */ }
    }
    passes += 1;
    const r = await runDeletionFn(db, env, settings, j.id, { include: [], now });
    if (r?.state === 'done') {
      out.deleted.push(j.id);
      // Feed row without job_id so it outlives the deleted video (id only, no title).
      try {
        await addActivity(db, {
          icon: 'trash', tone: 'muted', title: 'Old video removed automatically',
          sub: `Keep only the latest ${count} videos · ${job.engine || 'video'} · ${j.id}${job.youtubeId || job.status === 'published' ? ' · stays on YouTube' : ''}`,
        });
      } catch { /* feed is best effort */ }
    } else if (r?.state === 'refused') {
      out.refused = r.error || 'refused';
      if (r.code === 'github') break; // no GitHub token: nothing can be removed
    } else {
      out.pending.push(j.id);
    }
  }
  return out;
}

/** Fire-and-forget prune after a video reached review. Never throws. */
export function pruneInBackground(context, settings) {
  const env = context?.env;
  if (!env?.DB) return null;
  const p = (async () => {
    const s = settings || (await (await import('./db.js')).getSettings(env.DB));
    return pruneOldJobs(env.DB, env, s);
  })().catch(() => null);
  if (typeof context.waitUntil === 'function') context.waitUntil(p);
  return p;
}
