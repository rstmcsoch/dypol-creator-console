import { json } from '../../_lib/util.js';
import { getJob, updateJob, appendLog } from '../../_lib/db.js';

export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  await updateJob(db, job.id, { status: 'rejected', stage: 'Rejected' });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'warn',
    msg: 'Rejected by reviewer — will not publish (artifacts preserved)',
  });
  return json(null, 200, { ok: true, message: 'Video rejected. It will not be published.' });
}
