import { json } from '../../_lib/util.js';
import { getJob } from '../../_lib/db.js';
import { buildProgress } from '../../_lib/progress.js';

/** GET /api/jobs/:id/progress — step-by-step progress for the job drawer poll. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  return json(null, 200, { progress: await buildProgress(db, { job }) });
}
