import { json } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { publishJob } from '../../_lib/publish.js';

/**
 * POST /api/jobs/:id/publish — publish an approved job (or retry a failed
 * upload after verifying nothing reached YouTube). All safeguards live in
 * _lib/publish.js#publishJob. The dashboard never uploads bytes itself.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  const settings = await getSettings(db);
  const { status, body } = await publishJob(db, context.env, settings, job);
  return json(null, status, body);
}
