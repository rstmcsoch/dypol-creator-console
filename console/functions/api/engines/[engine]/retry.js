import { json } from '../../_lib/util.js';
import { listRuns, getJob, getSettings, listJobs } from '../../_lib/db.js';
import { retryJob } from '../../_lib/retry.js';

/**
 * POST /api/engines/:engine/retry — retry the engine's most recent failed
 * video with a fresh dispatch (see _lib/retry.js). Read-only guards only; no
 * publishing lock is taken (a draft retry never uploads).
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const engine = context.params.engine;
  if (!['gemini', 'verticals'].includes(engine)) return json(null, 404, { error: 'Unknown engine.', code: 'not-found' });
  const settings = await getSettings(db);
  // The latest run of this engine decides (that is what the Pipelines card shows).
  const latest = (await listRuns(db)).find((r) => r.engine === engine && r.jobId);
  let job = latest ? await getJob(db, latest.jobId) : null;
  if (!job || !['failed', 'cancelled'].includes(job.status)) {
    job = (await listJobs(db, { engine, status: 'failed' }))[0] || null;
  }
  if (!job) return json(null, 404, { error: 'No failed video to retry for this engine.', code: 'not-found' });
  const { status, body } = await retryJob({ db, env: context.env, settings, job, source: 'pipelines' });
  return json(null, status, body);
}
