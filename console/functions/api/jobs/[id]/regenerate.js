import { json, readBody, uid, nowIso } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, insertJob, addActivity, getSettings } from '../../_lib/db.js';
import { classifyError, buildQuality } from '../../_lib/safeguards.js';
import { dispatchForJob } from '../../_lib/jobflow.js';

/** Max reviewer feedback sent as a workflow input (full note stays in D1). */
export const FEEDBACK_INPUT_MAX = 1500;

/**
 * POST /api/jobs/:id/regenerate { feedback? } — dispatch a NEW generation job
 * linked to the original (parent_job_id + attempt) through the shared dispatch
 * helper (run row first, GitHub run id stored). Reviewer feedback (reject
 * reason, or body.feedback) is stored on the new job and passed as the
 * `reviewer_feedback` input ONLY if the engine workflow declares it.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const original = await getJob(db, context.params.id);
  if (!original) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (['published', 'uploading'].includes(original.status)) {
    return json(null, 409, { error: 'Published or uploading videos cannot be regenerated — create a new topic instead.', code: 'state' });
  }
  const settings = await getSettings(db);
  if (settings.schedule.automationPaused) {
    return json(null, 409, { error: 'Automation is paused. Resume scheduling before regenerating.', code: 'paused' });
  }
  const body = await readBody(context.request);
  const feedback = String(body.feedback || original.reviewNote || '').trim();

  const child = {
    id: uid('job'), engine: original.engine,
    title: original.title, topic: original.topic || original.title,
    niche: original.niche, format: original.format,
    status: 'dispatched', stage: 'Redo sent to engine', progress: null,
    description: original.description, tags: [...(original.tags || [])],
    durationSec: null, thumbnail: null,
    createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
    youtubeId: null, youtubeUrl: null, error: null,
    errorCategory: null, errorRetryable: null,
    quality: buildQuality(original, {}),
    logs: [{
      ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
      msg: `Regeneration attempt ${(original.attempt || 1) + 1} — parent job ${original.id}`,
    }],
    runId: null, parentJobId: original.id, attempt: (original.attempt || 1) + 1,
    publishBlocked: null, duplicateOf: null, demo: false,
  };
  await insertJob(db, child);
  if (feedback) await updateJob(db, child.id, { reviewNote: `Feedback from previous attempt: ${feedback}` });

  let result;
  try {
    result = await dispatchForJob({
      db, env: context.env, settings, job: child, phase: 'draft',
      inputs: {
        topic: child.topic,
        privacy: settings.publishing.visibility,
        language: settings.defaults?.language || 'en',
        review_required: settings.publishing.reviewRequired ? '1' : '0',
        auto_publish: settings.publishing.autoPublish ? '1' : '0',
        title_override: child.title,
        description_override: (child.description || '').slice(0, 480),
        ...(child.engine === 'verticals' ? { niche: child.niche || 'tech' } : {}),
        ...(feedback ? { reviewer_feedback: feedback.slice(0, FEEDBACK_INPUT_MAX) } : {}),
      },
    });
  } catch (err) {
    const cat = classifyError(err.message);
    await updateJob(db, child.id, {
      status: 'failed', stage: 'Could not start', error: `Regenerate dispatch failed (${cat.category}): ${err.message}`,
      errorCategory: cat.category, errorRetryable: cat.retryable,
    });
    return json(null, 502, { error: `Regenerate dispatch failed (${cat.category}): ${err.message}`, code: 'github', jobId: child.id });
  }

  const feedbackSent = !!feedback && !result.stripped.includes('reviewer_feedback');
  if (feedback) {
    await appendLog(db, await getJob(db, child.id), {
      ts: new Date().toLocaleTimeString('en-GB'), level: feedbackSent ? 'ok' : 'warn',
      msg: feedbackSent ? 'Reviewer feedback sent to the engine (reviewer_feedback input)'
        : 'Reviewer feedback saved here but NOT sent — the engine workflow has no reviewer_feedback input yet',
    });
  }
  if (!['published', 'rejected'].includes(original.status)) {
    await updateJob(db, original.id, { status: 'superseded', stage: `Superseded by attempt ${child.attempt}` });
  }
  await appendLog(db, original, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
    msg: `Regenerated as new attempt ${child.attempt} (job ${child.id}) — history preserved`,
  });
  await addActivity(db, { icon: 'refresh', tone: 'blue', title: 'Regeneration dispatched', sub: `${original.title} · attempt ${child.attempt}` });

  return json(null, 202, {
    ok: true, jobId: child.id, attempt: child.attempt, ghRunId: result.ghRunId, feedbackSent,
    message: `Redo started as attempt ${child.attempt}.`
      + (feedback && !feedbackSent ? ' Your feedback is saved but the engine cannot read it yet.' : ''),
  });
}
