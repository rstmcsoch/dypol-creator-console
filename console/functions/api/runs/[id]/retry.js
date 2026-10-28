import { json } from '../../_lib/util.js';
import { getRun, getSettings, getJob, updateRun, appendLog } from '../../_lib/db.js';
import { splitRepo, rerunFailedJobs } from '../../_lib/github.js';
import { checkPublishGate, releaseLock, recordPublished } from '../../_lib/safeguards.js';

/** POST /api/runs/:id/retry — safe retry of a failed run. */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const run = await getRun(db, context.params.id);
  if (!run) return json(null, 404, { error: 'Run not found.', code: 'not-found' });
  if (run.status !== 'failed') {
    return json(null, 409, { error: 'Only failed runs can be retried.', code: 'state' });
  }

  // Blind-retry protection: verify the upload state before re-running.
  // AUDIT FIX: read-only check — no lock side effects on the retry path.
  if (run.jobId) {
    const job = await getJob(db, run.jobId);
    const settings = await getSettings(db);
    if (job) {
      const gate = await checkPublishGate(db, job, settings);
      if (gate.code === 'already-uploaded') {
        await recordPublished(db, job, gate.youtubeId);
        await appendLog(db, job, {
          ts: new Date().toLocaleTimeString('en-GB'), level: 'warn',
          msg: `Retry suppressed — upload verified (id=${gate.youtubeId}). No duplicate upload.`,
        });
        return json(null, 200, { ok: true, message: gate.message });
      }
    }
  }

  if (!context.env.GITHUB_TOKEN || !run.runId) {
    return json(null, 409, { error: 'GitHub token or run ID unavailable — retry from the GitHub Actions UI.', code: 'not-configured' });
  }
  const settings = await getSettings(db);
  try {
    await rerunFailedJobs(context.env.GITHUB_TOKEN, { ...splitRepo(settings.github[run.engine]?.repo), runId: run.runId });
  } catch (err) {
    return json(null, 502, { error: `Retry failed: ${err.message}`, code: 'github' });
  }
  await updateRun(db, run.id, {
    status: 'in-progress', failureReason: null,
    logs: [...run.logs, { ts: new Date().toLocaleTimeString('en-GB'), level: 'info', msg: 'Re-run of failed jobs requested' }],
  });
  return json(null, 202, { ok: true, message: `Re-run requested for GitHub run ${run.runId}.` });
}
