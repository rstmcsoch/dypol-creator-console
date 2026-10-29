/**
 * Mode-1 fallback (shared by POST /api/sync/github and the GitHub webhook).
 *
 * Dispatches the Verticals engine ONLY when the primary (gemini) run genuinely
 * failed, the job has no upload anywhere, the topic is not a duplicate, and the
 * orchestration policy + engine toggle allow it. Returns a short message
 * (or null when nothing was dispatched).
 */
import { getJob, addActivity } from './db.js';
import { splitRepo, dispatchWorkflow } from './github.js';
import { findDuplicate } from './safeguards.js';

export async function maybeDispatchFallback({ db, token, settings, engine, local, displayTitle }) {
  if (engine !== 'gemini' || !token) return null;
  if (settings.orchestration?.mode !== 'primary_with_fallback') return null;
  if (settings.orchestration?.fallback === 'never') return null;
  if (settings.engines?.verticals?.enabled === false) return null;
  const job = local?.jobId ? await getJob(db, local.jobId) : null;
  const title = job?.title || displayTitle;
  const dup = title && settings.publishing?.dedupe ? await findDuplicate(db, title, job?.id) : null;
  const uploaded = job?.youtubeId || job?.status === 'published';
  if (dup || !title || uploaded) return null;
  try {
    await dispatchWorkflow(token, {
      ...splitRepo(settings.github.verticals.repo), workflowFile: settings.github.verticals.workflow,
      ref: settings.github.branch || 'dypol-integration',
      inputs: {
        phase: 'draft', topic: title, privacy: settings.publishing.visibility,
        job_id: job?.id || '', fallback_of: local?.id || '',
      },
    });
    await addActivity(db, { icon: 'zap', tone: 'amber', title: 'Fallback engine dispatched', sub: title });
    return { dispatched: true, message: `fallback: Verticals v3 dispatched for “${title}” (primary genuinely failed)` };
  } catch (e) {
    return { dispatched: false, message: `fallback dispatch failed: ${e.message}` };
  }
}
