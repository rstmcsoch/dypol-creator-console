import { json } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { buildProgress } from '../../_lib/progress.js';
import { refreshRunFromApi, liveRunIdFor } from '../../_lib/liveprogress.js';

/** GET /api/jobs/:id/progress — step-by-step progress for the job drawer poll.
 *  While the job's run is in flight, steps are refreshed from the GitHub API
 *  (throttled to once per 15 s per run) before the D1 read. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  let job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  const ghRunId = liveRunIdFor(job);
  if (ghRunId) {
    try {
      const r = await refreshRunFromApi(db, context.env, await getSettings(db), { ghRunId, engine: job.engine });
      if (r?.refreshed) job = await getJob(db, job.id);
    } catch { /* fall back to stored webhook data */ }
  }
  return json(null, 200, { progress: await buildProgress(db, { job }) });
}
