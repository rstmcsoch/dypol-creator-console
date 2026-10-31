import { json } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { buildProgress } from '../../_lib/progress.js';
import { refreshRunFromApi } from '../../_lib/liveprogress.js';

/** GET /api/runs/:id/progress — step-by-step progress for the Run History drawer poll.
 *  An in-flight run is refreshed from the GitHub API first (15 s throttle per run). */
export async function onRequestGet(context) {
  const db = context.env.DB;
  let runRow = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(context.params.id).first();
  if (!runRow) return json(null, 404, { error: 'Run not found.', code: 'not-found' });
  if (runRow.run_id && ['queued', 'in-progress'].includes(runRow.status)) {
    try {
      const r = await refreshRunFromApi(db, context.env, await getSettings(db), { ghRunId: runRow.run_id, engine: runRow.engine });
      if (r?.refreshed) runRow = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(context.params.id).first();
    } catch { /* stored data */ }
  }
  const job = runRow.job_id ? await getJob(db, runRow.job_id) : null;
  return json(null, 200, { progress: await buildProgress(db, { job, runRow }) });
}
