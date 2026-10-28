import { json } from './_lib/util.js';
import { listJobs } from './_lib/db.js';

export async function onRequestGet(context) {
  const jobs = await listJobs(context.env.DB, {});
  return json(null, 200, {
    user: 'admin',
    mode: 'live',
    pendingReview: jobs.filter((j) => ['needs-review', 'awaiting-review'].includes(j.status)).length,
  });
}
