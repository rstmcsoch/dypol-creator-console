/**
 * The single publish path (used by POST /jobs/:id/publish and by the one-tap
 * POST /jobs/:id/approve). Enforcement order (server-side):
 *   upload-state verification → review gate → publishing lock → duplicate
 *   check → daily cap → dispatch the engine's publish phase (shared helper).
 * Returns { status, body } for the HTTP response.
 */
import { getJob, updateJob, appendLog, addActivity } from './db.js';
import {
  publishGate, releaseLock, classifyError, uploadIdempotencyKey, findUploadEvidence, recordPublished,
} from './safeguards.js';
import { splitRepo } from './github.js';
import { dispatchForJob } from './jobflow.js';
import { isDeleting } from './deletejob.js';

const ts = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

export async function publishJob(db, env, settings, job) {
  if (await isDeleting(db, job.id)) return { status: 409, body: { error: 'This video is being deleted.', code: 'deleting' } };
  // ---- Blind-retry protection for an upload that may have completed -------
  if (job.status === 'uploading' || job.status === 'publish_failed') {
    const slug = settings.github[job.engine]?.repo;
    const evidence = slug && env.GITHUB_TOKEN && job.publishRunId
      ? await findUploadEvidence(env.GITHUB_TOKEN, splitRepo(slug), job)
      : null;
    if (evidence?.youtube_id) {
      await recordPublished(db, job, evidence.youtube_id, {
        url: evidence.youtube_url, videos: evidence.videos, publishRunId: job.publishRunId,
      });
      await appendLog(db, job, {
        ts: ts(), level: 'warn',
        msg: `Upload verified from engine result (${evidence.youtube_id}) — job recorded as published. No re-dispatch.`,
      });
      return { status: 200, body: {
        ok: true,
        message: `Already on YouTube (id ${evidence.youtube_id}) — recorded, no duplicate upload.`,
        job: await getJob(db, job.id),
      } };
    }
    if (job.status === 'uploading') {
      return { status: 409, body: {
        error: 'An upload is already running for this job. The result appears here automatically when it finishes '
          + '(stuck uploads are checked after 10 minutes). Publishing again now could upload twice.',
        code: 'upload-in-flight',
      } };
    }
  }

  const gate = await publishGate(db, job, settings);
  try {
    if (gate.code === 'already-uploaded') {
      await recordPublished(db, job, gate.youtubeId);
      await appendLog(db, job, { ts: ts(), level: 'warn', msg: gate.message });
      return { status: 200, body: { ok: true, message: gate.message, job: await getJob(db, job.id) } };
    }
    if (gate.ok && gate.code === 'already-published') {
      return { status: 200, body: { ok: true, message: gate.message, job: await getJob(db, job.id) } };
    }
    if (!gate.ok) {
      const cat = classifyError(gate.error);
      await appendLog(db, job, { ts: ts(), level: 'error', msg: `Publish blocked — ${gate.error}` });
      await updateJob(db, job.id, { publishBlocked: gate.error });
      await addActivity(db, { icon: 'lock', tone: 'amber', title: 'Publish blocked', sub: `${job.title} — ${cat.category}`, jobId: job.id });
      return { status: gate.code === 'locked' ? 423 : 409, body: { error: gate.error, code: gate.code } };
    }

    try {
      await dispatchForJob({
        db, env, settings, job, phase: 'publish',
        inputs: {
          topic: job.topic || job.title,
          // Engine handoff: the run that produced the approved draft.
          draft_run_id: job.runId || '',
          privacy: settings.publishing.visibility,
          title_override: job.title,
          description_override: (job.description || '').slice(0, 480),
          // Stripped automatically for workflows that don't declare it (Engine A).
          tags_override: (job.tags || []).join(','),
          // Policy echo — workflows enforce it too (defence in depth).
          review_required: settings.publishing.reviewRequired ? '1' : '0',
          auto_publish: settings.publishing.autoPublish ? '1' : '0',
        },
      });
    } catch (err) {
      const cat = classifyError(err.message);
      await appendLog(db, job, { ts: ts(), level: 'error', msg: `Publish dispatch failed (${cat.category}): ${err.message}` });
      await updateJob(db, job.id, { errorCategory: cat.category, errorRetryable: cat.retryable, error: `Publish dispatch failed: ${err.message}` });
      return { status: 502, body: { error: `Publish dispatch failed: ${err.message}`, code: 'github' } };
    }

    await updateJob(db, job.id, {
      status: 'uploading', stage: 'Uploading to YouTube…', progress: null,
      publishBlocked: null, uploadingSince: Date.now(),
      error: null, errorCategory: null, errorRetryable: null, errorLog: null,
    });
    const fresh = await getJob(db, job.id);
    await appendLog(db, fresh, {
      ts: ts(), level: 'info',
      msg: `Publish dispatched (visibility=${settings.publishing.visibility}, draft_run=${job.runId || 'same-run'}, publish_run=${fresh.publishRunId || 'pending'}, idempotency=${uploadIdempotencyKey(job.title, job.id)}) — safeguards passed`,
    });
    return { status: 202, body: {
      ok: true,
      message: `Uploading as ${settings.publishing.visibility}. The YouTube link appears here when the upload finishes (about 1–3 minutes).`,
      job: await getJob(db, job.id),
    } };
  } finally {
    if (gate.lockHeld) await releaseLock(db, 'publish');
  }
}
