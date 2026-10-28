import { json, readBody, nowIso } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, addActivity, getSettings } from '../../_lib/db.js';

/** POST /api/jobs/:id/approve — approval gate; schedules for the next window. */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (!['needs-review', 'awaiting-review'].includes(job.status)) {
    return json(null, 409, { error: 'Only videos awaiting review can be approved.', code: 'state' });
  }
  if (job.quality?.duplicate?.state === 'failed') {
    return json(null, 409, { error: 'Approval blocked — duplicate check failed for this video.', code: 'duplicate' });
  }
  const body = await readBody(context.request);
  const settings = await getSettings(db);
  const when = body.when || new Date(Date.now() + 3600e3).toISOString();

  await updateJob(db, job.id, {
    status: 'scheduled', stage: 'Approved — awaiting publish window', scheduledFor: when,
  });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'ok',
    msg: `Approved — scheduled for ${when} (visibility=${settings.publishing.visibility})`,
  });
  await addActivity(db, { icon: 'check', tone: 'green', title: 'Video approved', sub: job.title });
  return json(null, 200, {
    ok: true,
    message: `Approved. Scheduled for ${new Date(when).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`,
  });
}
