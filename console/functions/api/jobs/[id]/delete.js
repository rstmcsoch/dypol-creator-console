import { json, readBody } from '../../_lib/util.js';
import { getJob, getSettings } from '../../_lib/db.js';
import { buildPlan, describePlan, runDeletion, pendingDeletions, GhBudget } from '../../_lib/deletejob.js';

/**
 * Delete video — removes the job (and its later attempts) from the dashboard,
 * GitHub (runs + logs, saved files/artifacts, committed files on
 * dypol-integration) and D1. NEVER deletes anything from YouTube.
 * Admin session + same-origin check come from _middleware.js.
 *
 * GET    /api/jobs/:id/delete  → what will be removed (read-only)
 * POST   /api/jobs/:id/delete  → do one pass; repeat while state is
 * DELETE /api/jobs/:id/delete     'continue' / 'waiting' (honour retryAfterMs)
 */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const id = context.params.id;
  const job = await getJob(db, id);
  if (!job) return json(null, 404, { error: 'This video is already gone.', code: 'not-found' });
  const settings = await getSettings(db);
  const pending = (await pendingDeletions(db)).get(id) || null;
  try {
    const plan = await buildPlan(db, context.env, settings, id, new GhBudget(40));
    return json(null, 200, {
      ok: true, jobId: id, pending,
      items: describePlan(plan),
      counts: plan.counts,
      attempts: plan.jobs.map((j) => ({ id: j.id, status: j.status, onYouTube: j.onYouTube })),
      youtubeStays: plan.counts.youtubeStays,
      beingMade: plan.counts.beingMade,
      uploading: plan.jobs.some((j) => j.status === 'uploading'),
      notes: plan.notes,
    });
  } catch (e) {
    if (e.pause) return json(null, 503, { error: 'GitHub is busy right now — try again in a minute.', code: 'github_unavailable' });
    throw e;
  }
}

async function run(context) {
  const db = context.env.DB;
  const id = context.params.id;
  await readBody(context.request); // no options: YouTube is never touched
  const settings = await getSettings(db);
  const out = await runDeletion(db, context.env, settings, id);
  const code = out.state === 'refused' ? 409 : out.state === 'busy' ? 202 : 200;
  return json(null, code, { ok: out.state === 'done', jobId: id, ...out });
}
export const onRequestPost = run;
export const onRequestDelete = run;
