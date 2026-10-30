import { json, readBody } from '../../_lib/util.js';
import { getJob, updateJob, appendLog } from '../../_lib/db.js';

/** States a reviewer may reject from (never while uploading or after publishing). */
export const REJECTABLE = ['needs-review', 'awaiting-review', 'approved', 'scheduled', 'failed', 'publish_failed', 'queued'];

/** POST /api/jobs/:id/reject { reason } — a reason is required and stored;
 *  Regenerate passes it to the engine as reviewer feedback. */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (!REJECTABLE.includes(job.status)) {
    return json(null, 409, {
      error: job.status === 'uploading' ? 'This video is uploading right now and cannot be rejected.'
        : `A ${job.status} video cannot be rejected.`,
      code: 'state',
    });
  }
  const body = await readBody(context.request);
  const reason = String(body.reason || '').trim().slice(0, 2000);
  if (reason.length < 3) {
    return json(null, 400, { error: 'Say briefly why (at least a few words) — it is used as feedback for the redo.', code: 'validation' });
  }
  await updateJob(db, job.id, { status: 'rejected', stage: 'Rejected', reviewNote: reason });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), level: 'warn',
    msg: `Rejected by reviewer: ${reason}`,
  });
  return json(null, 200, { ok: true, message: 'Rejected. It will not be published. Use Regenerate to redo it with your feedback.' });
}
