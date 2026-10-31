import { json } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { retryJob } from '../../_lib/retry.js';

/**
 * POST /api/jobs/:id/retry — fresh workflow_dispatch for a failed job (same
 * job, same inputs, latest code; max 2 retries). A failed upload is retried
 * through the publish path (the drawer confirms first). See _lib/retry.js.
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  const { status, body } = await retryJob({
    db, env: context.env, settings: await getSettings(db), job, source: 'video drawer', allowPublish: true,
  });
  return json(null, status, body);
}
