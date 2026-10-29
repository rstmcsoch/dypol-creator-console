import { json } from '../../_lib/util.js';
import { getJob, updateJob, getSettings, listRuns, updateRun, appendLog } from '../../_lib/db.js';
import { splitRepo, cancelRun } from '../../_lib/github.js';

/** POST /api/jobs/:id/cancel — stop an active job (cancels its GitHub run when known). */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (!['dispatched', 'running', 'generating', 'rendering', 'queued'].includes(job.status)) {
    return json(null, 409, { error: `Job is ${job.status}; only active jobs can be cancelled.`, code: 'state' });
  }
  const settings = await getSettings(db);
  const runs = (await listRuns(db)).filter((r) => r.jobId === job.id);
  let ghNote = 'no GitHub run linked';
  for (const r of runs) {
    if (r.runId && context.env.GITHUB_TOKEN && settings.github[job.engine]?.repo) {
      try {
        await cancelRun(context.env.GITHUB_TOKEN, { ...splitRepo(settings.github[job.engine].repo), runId: r.runId });
        ghNote = `GitHub run ${r.runId} cancel requested`;
      } catch (e) { ghNote = `GitHub cancel failed (${e.message}) — record closed anyway`; }
    }
    if (['in-progress', 'queued'].includes(r.status)) await updateRun(db, r.id, { status: 'cancelled' });
  }
  await updateJob(db, job.id, { status: 'cancelled', stage: 'Cancelled', error: 'Cancelled from console' });
  await appendLog(db, await getJob(db, job.id), { ts: new Date().toLocaleTimeString('en-GB'), level: 'warn', msg: `Cancelled from console — ${ghNote}` });
  return json(null, 200, { ok: true, message: `Job cancelled (${ghNote}).` });
}
