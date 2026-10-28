import { json, readBody } from '../../_lib/util.js';
import { listRuns, getSettings, updateJob, listJobs } from '../../_lib/db.js';
import { splitRepo, cancelRun } from '../../_lib/github.js';

/** POST /api/engines/:engine/cancel { runId? } — cancels the active GitHub Actions run. */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const engine = context.params.engine;
  const body = await readBody(context.request);
  const settings = await getSettings(db);
  const token = context.env.GITHUB_TOKEN;
  if (!token) return json(null, 409, { error: 'GITHUB_TOKEN not configured.', code: 'not-configured' });

  const runs = (await listRuns(db)).filter((r) => r.engine === engine && r.status === 'in-progress');
  const target = runs.find((r) => r.id === body.runId) || runs[0];
  if (!target?.runId) {
    return json(null, 404, { error: 'No in-progress GitHub run found for this engine.', code: 'not-found' });
  }
  const slug = settings.github[engine]?.repo;
  try {
    await cancelRun(token, { ...splitRepo(slug), runId: target.runId });
  } catch (err) {
    return json(null, 502, { error: `Cancel request failed: ${err.message}`, code: 'github' });
  }
  // Mark associated jobs cancelled (keeps partial artifacts).
  const jobs = (await listJobs(db, {})).filter((j) => j.runId === target.id && ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
  for (const j of jobs) {
    await updateJob(db, j.id, { status: 'cancelled', stage: 'Cancelled', error: 'Cancelled by user' });
  }
  return json(null, 200, { ok: true, message: `Cancellation requested for GitHub run ${target.runId}.` });
}
