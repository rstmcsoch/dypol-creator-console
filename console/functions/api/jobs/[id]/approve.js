import { json } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, addActivity, getSettings } from '../../_lib/db.js';
import { publishJob } from '../../_lib/publish.js';

/**
 * POST /api/jobs/:id/approve — ONE tap: approve AND publish.
 * The reviewer's explicit tap (behind a confirmation dialog in the UI) is the
 * approval; the publish then runs through the same safeguards as Publish
 * (dedupe, daily cap, lock, visibility from Settings). If a safeguard blocks
 * the upload, the job stays approved and the reason is returned.
 * body.publish === false approves only.
 */
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
  let body = {};
  try { body = await context.request.json(); } catch { body = {}; }
  const settings = await getSettings(db);

  await updateJob(db, job.id, { status: 'approved', stage: 'Approved', scheduledFor: null });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), level: 'ok',
    msg: `Approved by reviewer (visibility=${settings.publishing.visibility})`,
  });
  await addActivity(db, { icon: 'check', tone: 'green', title: 'Video approved', sub: job.title, jobId: job.id });
  if (body.publish === false) {
    return json(null, 200, { ok: true, approved: true, message: 'Approved. Tap Publish when ready.' });
  }

  const pub = await publishJob(db, context.env, settings, await getJob(db, job.id));
  if (pub.status >= 400) {
    return json(null, 200, {
      ok: true, approved: true, published: false, code: pub.body.code,
      message: `Approved, but the upload did not start: ${pub.body.error}`,
    });
  }
  return json(null, pub.status, { ...pub.body, approved: true, published: pub.status === 202 || pub.status === 200 });
}
