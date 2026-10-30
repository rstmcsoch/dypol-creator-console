import { json } from '../../_lib/util.js';
import { getJob, getSettings, updateJob, appendLog, updateRun, runsForJob } from '../../_lib/db.js';
import { checkPublishGate, classifyError } from '../../_lib/safeguards.js';
import { splitRepo, rerunFailedJobs } from '../../_lib/github.js';

/**
 * POST /api/jobs/:id/retry — safe retry of a failed job's run.
 * Preserves attempt history (attempt counter + logs); verifies upload state
 * first so a retry can never double-upload.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (job.status === 'publish_failed') {
    // A failed UPLOAD is retried through the publish path (verifies nothing
    // reached YouTube first) — never by re-running the publish run blindly.
    const { publishJob } = await import('../../_lib/publish.js');
    const { status, body } = await publishJob(db, context.env, await getSettings(db), job);
    return json(null, status, body);
  }
  if (job.status !== 'failed') {
    return json(null, 409, { error: 'Only failed jobs can be retried. Use Regenerate for new attempts.', code: 'state' });
  }
  const settings = await getSettings(db);
  const retryLimit = settings.orchestration.retryLimit ?? 2;
  if ((job.attempt || 1) > retryLimit) {
    return json(null, 409, {
      error: `Retry limit reached (${retryLimit}). Use Regenerate for a deliberate new attempt.`,
      code: 'retry-limit',
    });
  }

  // Blind-retry protection.
  const gate = await checkPublishGate(db, job, settings);
  if (gate.code === 'already-uploaded') {
    const { recordPublished } = await import('../../_lib/safeguards.js');
    await recordPublished(db, job, gate.youtubeId);
    return json(null, 200, { ok: true, message: gate.message });
  }

  // Look the run up by job_id (run rows store both the local id and the
  // GitHub run id); fall back to the GitHub id kept on the job.
  const rows = await runsForJob(db, job.id, 'draft');
  let run = rows.find((r) => r.runId && job.runId && String(r.runId) === String(job.runId)) || rows.find((r) => r.runId) || null;
  if (!run && job.runId) {
    run = { id: null, runId: String(job.runId), logs: [] };
  }
  if (!context.env.GITHUB_TOKEN || !run?.runId) {
    return json(null, 409, { error: 'No GitHub run to retry — use Regenerate to dispatch a fresh run.', code: 'not-configured' });
  }
  try {
    await rerunFailedJobs(context.env.GITHUB_TOKEN, {
      ...splitRepo(settings.github[job.engine]?.repo), runId: run.runId,
    });
  } catch (err) {
    const cat = classifyError(err.message);
    return json(null, 502, { error: `Retry failed (${cat.category}): ${err.message}`, code: 'github' });
  }

  await updateJob(db, job.id, {
    status: 'dispatched', stage: 'Retry sent to engine', error: null,
    errorCategory: null, errorRetryable: null, errorLog: null,
    attempt: (job.attempt || 1),
  });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
    msg: `Retry ${job.attempt || 1}/${retryLimit} dispatched for GitHub run ${run.runId} — upload state verified first`,
  });
  if (run.id) {
    await updateRun(db, run.id, {
      status: 'in-progress', failureReason: null,
      logs: [...(run.logs || []), { ts: new Date().toLocaleTimeString('en-GB'), level: 'info', msg: 'Re-run of failed jobs requested' }],
    });
  }
  return json(null, 202, { ok: true, message: `Retry dispatched for run ${run.runId} (attempt ${job.attempt || 1}).` });
}
