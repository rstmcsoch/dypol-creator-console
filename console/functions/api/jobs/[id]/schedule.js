import { json, readBody } from '../../_lib/util.js';
import { getJob, updateJob, appendLog } from '../../_lib/db.js';

/** POST /api/jobs/:id/schedule { when: ISO } */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  const body = await readBody(context.request);
  if (!body.when) return json(null, 400, { error: 'Missing "when" (ISO timestamp).', code: 'validation' });

  const patch = { scheduledFor: body.when };
  if (['needs-review', 'awaiting-review', 'queued'].includes(job.status)) {
    patch.status = 'scheduled';
    patch.stage = 'Scheduled';
  }
  await updateJob(db, job.id, patch);
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'ok',
    msg: `Scheduled for ${body.when}`,
  });
  return json(null, 200, {
    ok: true,
    message: `Scheduled for ${new Date(body.when).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`,
  });
}
