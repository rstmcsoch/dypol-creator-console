import { json } from '../../_lib/util.js';
import { listRuns, getSettings, getJob, updateJob, appendLog } from '../../_lib/db.js';
import { splitRepo, rerunFailedJobs } from '../../_lib/github.js';
import { publishGate } from '../../_lib/safeguards.js';

/**
 * POST /api/engines/:engine/retry — retry the last failed run.
 * Blind-retry protection: if the job's topic is already in the upload registry,
 * we re-sync instead of re-uploading.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const engine = context.params.engine;
  const settings = await getSettings(db);
  const token = context.env.GITHUB_TOKEN;
  const failed = (await listRuns(db)).find((r) => r.engine === engine && r.status === 'failed');
  if (!failed) return json(null, 404, { error: 'No failed run to retry.', code: 'not-found' });

  if (failed.jobId) {
    const job = await getJob(db, failed.jobId);
    if (job) {
      const gate = await publishGate(db, job, settings);
      if (gate.code === 'already-uploaded') {
        await updateJob(db, job.id, {
          status: 'published', youtubeId: gate.youtubeId,
          youtubeUrl: `https://youtu.be/${gate.youtubeId}`,
        });
        await appendLog(db, job, {
          ts: new Date().toLocaleTimeString('en-GB'), level: 'warn',
          msg: `Retry suppressed — upload state verified (id=${gate.youtubeId}). No duplicate upload.`,
        });
        return json(null, 200, { ok: true, message: gate.message });
      }
    }
  }

  if (!token || !failed.runId) {
    return json(null, 409, { error: 'GitHub token or run ID unavailable — retry from the GitHub Actions UI.', code: 'not-configured' });
  }
  const slug = settings.github[engine]?.repo;
  try {
    await rerunFailedJobs(token, { ...splitRepo(slug), runId: failed.runId });
  } catch (err) {
    return json(null, 502, { error: `Retry failed: ${err.message}`, code: 'github' });
  }
  return json(null, 202, { ok: true, message: `Re-run of failed jobs requested for run ${failed.runId}.` });
}
