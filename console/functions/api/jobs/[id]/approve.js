import { json } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, addActivity, getSettings } from '../../_lib/db.js';
import { publishJob, parsePrivacyStatus } from '../../_lib/publish.js';
import { needsFixes } from '../../_lib/engineqc.js';

/**
 * POST /api/jobs/:id/approve — ONE tap: approve AND publish.
 * The reviewer's explicit tap (behind a confirmation dialog in the UI) is the
 * approval; the publish then runs through the same safeguards as Publish
 * (dedupe, daily cap, lock, visibility from Settings). If a safeguard blocks
 * the upload, the job stays approved and the reason is returned.
 * body.publish === false approves only.
 * A draft the video maker marked "needs_fixes" is only approved with
 * body.confirmNeedsFixes === true (the reviewer ticked "I've seen the failed
 * checks" in a second confirm); otherwise 409 code "needs-fixes".
 * Optional body.privacy_status (private|unlisted|public) is validated before
 * anything changes and used for this upload; public needs
 * body.confirm_public === "PUBLISH".
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  let job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (!['needs-review', 'awaiting-review'].includes(job.status)) {
    return json(null, 409, { error: 'Only videos awaiting review can be approved.', code: 'state' });
  }
  if (job.quality?.duplicate?.state === 'failed') {
    return json(null, 409, { error: 'Approval blocked — duplicate check failed for this video.', code: 'duplicate' });
  }
  let body = {};
  try { body = await context.request.json(); } catch { body = {}; }
  const ps = parsePrivacyStatus(body);
  if (!ps.ok) return json(null, ps.status, ps.body);
  if (needsFixes(job) && body.confirmNeedsFixes !== true) {
    return json(null, 409, {
      error: 'The video maker marked this video “needs fixes”. Look at the failed checks and confirm before approving.',
      code: 'needs-fixes', failures: job.quality.engine.failures || [],
    });
  }
  const settings = await getSettings(db);
  if (needsFixes(job)) {
    await appendLog(db, job, {
      ts: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), level: 'warn',
      msg: `Reviewer confirmed approval despite failed checks: ${(job.quality.engine.failures || []).join('; ').slice(0, 400)}`,
    });
    job = await getJob(db, job.id);
  }

  await updateJob(db, job.id, { status: 'approved', stage: 'Approved', scheduledFor: null });
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), level: 'ok',
    msg: `Approved by reviewer (visibility=${ps.value || settings.publishing.visibility})`,
  });
  await addActivity(db, { icon: 'check', tone: 'green', title: 'Video approved', sub: job.title, jobId: job.id });
  if (body.publish === false) {
    return json(null, 200, { ok: true, approved: true, message: 'Approved. Tap Publish when ready.' });
  }

  const pub = await publishJob(db, context.env, settings, await getJob(db, job.id), { privacyStatus: ps.value });
  if (pub.status >= 400) {
    return json(null, 200, {
      ok: true, approved: true, published: false, code: pub.body.code,
      message: `Approved, but the upload did not start: ${pub.body.error}`,
    });
  }
  return json(null, pub.status, { ...pub.body, approved: true, published: pub.status === 202 || pub.status === 200 });
}
