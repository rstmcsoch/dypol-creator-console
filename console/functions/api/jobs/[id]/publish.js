import { json, nowIso } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, getSettings, addActivity } from '../../_lib/db.js';
import { publishGate, releaseLock, classifyError, uploadIdempotencyKey, findUploadEvidence, recordPublished } from '../../_lib/safeguards.js';
import { splitRepo, dispatchWorkflow } from '../../_lib/github.js';

/**
 * POST /api/jobs/:id/publish — the one and only publish entry point.
 *
 * Enforcement order (all server-side):
 *   upload-state verification → review gate → publishing lock → duplicate
 *   check → daily cap → dispatch publish phase with the approved metadata.
 *
 * The dashboard NEVER uploads bytes itself — the engine workflow uploads with
 * YOUTUBE_PRIVACY_STATUS and writes dypol-results/<run>.json with the verified
 * YouTube video ID (backed up as a workflow artifact), which the sync step
 * records. A job already 'uploading' is VERIFIED against GitHub evidence
 * before any re-dispatch — a retry can never double-upload.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });

  const settings = await getSettings(db);

  // ---- Blind-retry protection for an upload that may have completed -------
  if (job.status === 'uploading') {
    const slug = settings.github[job.engine]?.repo;
    const evidence = slug && context.env.GITHUB_TOKEN
      ? await findUploadEvidence(context.env.GITHUB_TOKEN, splitRepo(slug), job)
      : null;
    if (evidence?.youtube_id) {
      await recordPublished(db, job, evidence.youtube_id, { url: evidence.youtube_url, videos: evidence.videos });
      await appendLog(db, job, {
        ts: new Date().toLocaleTimeString('en-GB'), level: 'warn',
        msg: `Upload verified from engine evidence (${evidence.youtube_id}) — job recorded as published. No re-dispatch.`,
      });
      return json(null, 200, {
        ok: true,
        message: `Upload verified — already on YouTube (id ${evidence.youtube_id}). No duplicate upload performed.`,
        job: await getJob(db, job.id),
      });
    }
    return json(null, 409, {
      error: 'An upload is already in flight for this job and no verified result has arrived yet. '
        + 'Wait for the workflow to finish, then use “Sync GitHub” to record the real video ID. '
        + 'Re-dispatching now risks a duplicate upload.',
      code: 'upload-in-flight',
    });
  }

  const gate = await publishGate(db, job, settings);
  try {
    if (gate.code === 'already-uploaded') {
      await recordPublished(db, job, gate.youtubeId);
      await appendLog(db, job, { ts: new Date().toLocaleTimeString('en-GB'), level: 'warn', msg: gate.message });
      return json(null, 200, { ok: true, message: gate.message, job: await getJob(db, job.id) });
    }
    if (gate.ok && gate.code === 'already-published') {
      return json(null, 200, { ok: true, message: gate.message, job: await getJob(db, job.id) });
    }
    if (!gate.ok) {
      const cat = classifyError(gate.error);
      await appendLog(db, job, {
        ts: new Date().toLocaleTimeString('en-GB'), level: 'error',
        msg: `Publish blocked — ${gate.error}`,
      });
      await updateJob(db, job.id, {
        publishBlocked: gate.error,
        errorCategory: cat.category, errorRetryable: cat.retryable,
      });
      await addActivity(db, {
        icon: 'lock', tone: 'amber', title: 'Publish blocked', sub: `${job.title} — ${cat.category}`,
      });
      return json(null, gate.code === 'locked' ? 423 : 409, { error: gate.error, code: gate.code });
    }

    // Dispatch the engine's publish phase with the review panel's metadata.
    const slug = settings.github[job.engine]?.repo;
    const workflow = settings.github[job.engine]?.workflow;
    if (!context.env.GITHUB_TOKEN || !slug || !workflow) {
      return json(null, 409, {
        error: 'Engine not configured — cannot dispatch the upload workflow. Configure the repository in Settings.',
        code: 'not-configured',
      });
    }
    try {
      await dispatchWorkflow(context.env.GITHUB_TOKEN, {
        ...splitRepo(slug), workflowFile: workflow, ref: settings.github.branch || 'dypol-integration',
        inputs: {
          phase: 'publish',
          topic: job.topic || job.title,
          job_id: job.id,
          // Engine B handoff: the run that produced the approved draft.
          draft_run_id: job.runId || '',
          privacy: settings.publishing.visibility,
          title_override: job.title,
          description_override: (job.description || '').slice(0, 480),
          // Engine A's workflow has no tags_override input (GitHub rejects
          // unexpected inputs), so only Engine B receives it.
          ...(job.engine === 'gemini' ? {} : { tags_override: (job.tags || []).join(',') }),
          // Policy echo — workflows enforce it too (defence in depth).
          review_required: settings.publishing.reviewRequired ? '1' : '0',
          auto_publish: settings.publishing.autoPublish ? '1' : '0',
        },
      });
    } catch (err) {
      const cat = classifyError(err.message);
      await appendLog(db, job, {
        ts: new Date().toLocaleTimeString('en-GB'), level: 'error',
        msg: `Publish dispatch failed (${cat.category}): ${err.message}`,
      });
      await updateJob(db, job.id, { errorCategory: cat.category, errorRetryable: cat.retryable });
      return json(null, 502, { error: `Publish dispatch failed: ${err.message}`, code: 'github' });
    }

    await updateJob(db, job.id, {
      status: 'uploading', stage: 'Uploading to YouTube…', progress: null,
      publishBlocked: null,
    });
    await appendLog(db, job, {
      ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
      msg: `Publish phase dispatched (visibility=${settings.publishing.visibility}, draft_run=${job.runId || 'same-run'}, idempotency=${uploadIdempotencyKey(job.title, job.id)}) — safeguards passed`,
    });
    return json(null, 202, {
      ok: true,
      message: 'Publishing — safeguards passed (dedupe, cap, lock). Upload runs in GitHub Actions; the video ID is recorded when the workflow reports it.',
      job: await getJob(db, job.id),
    });
  } finally {
    if (gate.lockHeld) await releaseLock(db, 'publish');
  }
}
