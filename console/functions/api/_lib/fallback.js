/**
 * Mode-1 fallback (shared by POST /api/sync/github and the GitHub webhook).
 *
 * Dispatches the Verticals engine ONLY when the primary (gemini) DRAFT run
 * genuinely failed moments ago, the job never reached upload, the topic is not
 * a duplicate, and the orchestration policy + engine toggle allow it.
 * The fallback is its own job (parent = the failed job) dispatched through the
 * shared helper, so undeclared inputs are stripped and a run row exists.
 * Returns a short message (or null when nothing was dispatched).
 */
import { uid, nowIso } from './util.js';
import { getJob, insertJob, updateJob, addActivity } from './db.js';
import { findDuplicate, buildQuality } from './safeguards.js';
import { dispatchForJob } from './jobflow.js';
import { isDeleting } from './deletejob.js';

export const FALLBACK_FRESH_MS = 30 * 60 * 1000;

export async function maybeDispatchFallback({ db, env, token, settings, engine, local, displayTitle, completedAt, now = Date.now() }) {
  const e = env || { GITHUB_TOKEN: token, DB: db };
  if (engine !== 'gemini' || !e.GITHUB_TOKEN) return null;
  if (settings.orchestration?.mode !== 'primary_with_fallback') return null;
  if (settings.orchestration?.fallback === 'never') return null;
  if (settings.engines?.verticals?.enabled === false) return null;
  if (!settings.github?.verticals?.repo) return null;
  if (local?.phase === 'publish') return null;
  // Never on replayed history (sync of old runs): only a failure that just happened.
  const done = Date.parse(completedAt || '') || 0;
  if (!done || now - done > FALLBACK_FRESH_MS) return null;
  const job = local?.jobId ? await getJob(db, local.jobId) : null;
  if (!job) return null;
  if (await isDeleting(db, job.id)) return null;
  if (job.publishRunId || ['uploading', 'publish_failed', 'published', 'approved', 'scheduled'].includes(job.status)) return null;
  const title = job.title || displayTitle;
  const dup = title && settings.publishing?.dedupe ? await findDuplicate(db, title, job.id) : null;
  if (dup || !title || job.youtubeId) return null;
  const child = {
    id: uid('job'), engine: 'verticals', title, topic: job.topic || title, niche: job.niche || 'tech', format: 'short',
    status: 'dispatched', stage: 'Fallback sent to Verticals', progress: null, description: '', tags: [],
    durationSec: null, thumbnail: null, createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
    youtubeId: null, youtubeUrl: null, error: null, errorCategory: null, errorRetryable: null,
    quality: buildQuality({ title, description: '', tags: [] }, {}),
    logs: [{ ts: new Date().toLocaleTimeString('en-GB'), level: 'info', msg: `Fallback for failed Gemini job ${job.id}` }],
    runId: null, parentJobId: job.id, attempt: 1, publishBlocked: null, duplicateOf: null, demo: false,
  };
  await insertJob(db, child);
  try {
    await dispatchForJob({
      db, env: e, settings, job: child, phase: 'draft',
      inputs: {
        topic: child.topic, privacy: settings.publishing.visibility, language: settings.defaults?.language || 'en',
        niche: child.niche, review_required: settings.publishing.reviewRequired ? '1' : '0',
        auto_publish: settings.publishing.autoPublish ? '1' : '0',
        fallback_of: job.id, // stripped automatically unless the workflow declares it
      },
    });
    await addActivity(db, { icon: 'zap', tone: 'amber', title: 'Fallback engine dispatched', sub: title, jobId: child.id });
    return { dispatched: true, jobId: child.id, message: `fallback: Verticals v3 dispatched for “${title}” (primary draft genuinely failed)` };
  } catch (err) {
    await updateJob(db, child.id, { status: 'failed', stage: 'Fallback dispatch failed', error: err.message, errorCategory: 'dispatch' });
    return { dispatched: false, message: `fallback dispatch failed: ${err.message}` };
  }
}
