import { json } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { publishJob, parsePrivacyStatus } from '../../_lib/publish.js';

/**
 * POST /api/jobs/:id/publish — publish an approved job (or retry a failed
 * upload after verifying nothing reached YouTube). All safeguards live in
 * _lib/publish.js#publishJob. The dashboard never uploads bytes itself.
 * Optional body.privacy_status (private|unlisted|public) overrides Settings →
 * visibility for this upload; public needs body.confirm_public === "PUBLISH".
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  let reqBody = {};
  try { reqBody = await context.request.json(); } catch { reqBody = {}; }
  const ps = parsePrivacyStatus(reqBody);
  if (!ps.ok) return json(null, ps.status, ps.body);
  const settings = await getSettings(db);
  const { status, body } = await publishJob(db, context.env, settings, job, { privacyStatus: ps.value });
  return json(null, status, body);
}
