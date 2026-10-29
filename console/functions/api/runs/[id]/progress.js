import { json } from '../../_lib/util.js';
import { getJob } from '../../_lib/db.js';
import { buildProgress } from '../../_lib/progress.js';

/** GET /api/runs/:id/progress — step-by-step progress for the Run History drawer poll. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const runRow = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(context.params.id).first();
  if (!runRow) return json(null, 404, { error: 'Run not found.', code: 'not-found' });
  const job = runRow.job_id ? await getJob(db, runRow.job_id) : null;
  return json(null, 200, { progress: await buildProgress(db, { job, runRow }) });
}
