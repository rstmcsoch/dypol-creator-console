import { json } from '../../_lib/util.js';
import { getRun, getJob, getSettings } from '../../_lib/db.js';
import { retryJob } from '../../_lib/retry.js';

/** POST /api/runs/:id/retry — retry the run's job with a fresh dispatch (see _lib/retry.js). */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const run = await getRun(db, context.params.id);
  if (!run) return json(null, 404, { error: 'Run not found.', code: 'not-found' });
  if (!run.jobId) {
    return json(null, 409, { error: 'This run is not linked to a video in the console — start a new run from Pipelines.', code: 'no-job' });
  }
  const job = await getJob(db, run.jobId);
  if (job && run.runId && job.runId && String(job.runId) !== String(run.runId) && !['failed', 'cancelled', 'publish_failed'].includes(job.status)) {
    return json(null, 409, { error: 'This video already has a newer run. Open the video to see it.', code: 'state' });
  }
  const { status, body } = await retryJob({ db, env: context.env, settings: await getSettings(db), job, source: 'run history' });
  return json(null, status, body);
}
