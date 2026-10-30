import { json } from '../_lib/util.js';
import { listRuns, updateRun, getSettings } from '../_lib/db.js';
import { splitRepo, listWorkflowRuns, listRunArtifacts, integrationRef } from '../_lib/github.js';
import { ensureProgressSchema, handleWorkflowRun } from '../_lib/webhook.js';
import { reconcileJobs } from '../_lib/jobflow.js';

/**
 * POST /api/sync/github — reconcile the console with GitHub Actions
 * (the webhook is the normal path; this repairs anything it missed).
 *
 *  1. Recent runs of each engine workflow on dypol-integration are passed
 *     through the SAME handler as webhook deliveries (link → status → job
 *     transition, including publish runs → published / publish_failed).
 *  2. Stale jobs are reconciled (dispatched >5 min, drafting >25 min,
 *     uploading >10 min) by asking the API about their run; publish results
 *     are read by exact path dypol-results/<run_id>.json on dypol-integration.
 *  3. Run rows that never got a GitHub run within 90 min are closed.
 * Never dispatches drafts or publishes (fallback only fires for a draft
 * failure that happened in the last 30 minutes).
 */
const STALE_RUN_MS = 90 * 60 * 1000;

export async function onRequestPost(context) {
  const env = context.env;
  const db = env.DB;
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return json(null, 409, { ok: false, message: 'GITHUB_TOKEN not configured — cannot sync from GitHub.' });
  }
  await ensureProgressSchema(db);
  const settings = await getSettings(db);
  const runEnv = { ...env, __noRetryWait: true };
  let updated = 0;
  const messages = [];

  for (const engine of ['gemini', 'verticals']) {
    const slug = settings.github[engine]?.repo;
    const workflow = settings.github[engine]?.workflow;
    if (!slug || !workflow) continue;
    const gh = splitRepo(slug);
    let ghRuns = [];
    try {
      ghRuns = await listWorkflowRuns(token, { ...gh, workflowFile: workflow, perPage: 15, branch: integrationRef(settings) });
    } catch (err) {
      messages.push(`${engine}: ${err.message}`);
      continue;
    }
    // Oldest first so linking follows dispatch order.
    for (const r of [...ghRuns].reverse()) {
      try {
        const res = await handleWorkflowRun(db, runEnv, settings, engine, {
          runId: r.runId, name: r.name, displayTitle: r.displayTitle || r.name, event: r.event,
          status: r.status, conclusion: r.conclusion, githubUrl: r.githubUrl,
          startedAt: r.startedAt, createdAt: r.startedAt, updatedAt: r.updatedAt, path: `.github/workflows/${workflow}`,
        }, { repo: slug });
        if (res?.job) { updated++; messages.push(`run ${r.runId}: job → ${res.job}`); }
        if (res?.fallback) messages.push(res.fallback);
      } catch (err) {
        messages.push(`run ${r.runId}: ${err.message}`);
      }
    }
  }

  let rec = { changes: [] };
  try {
    rec = await reconcileJobs(db, runEnv, settings, { force: true });
    updated += rec.changes.length;
    messages.push(...rec.changes);
  } catch (err) { messages.push(`reconcile failed — ${err.message}`); }

  // Enrich a few completed runs with their artifact list (free-tier
  // subrequest budget: keep this small; later syncs continue).
  let enriched = 0;
  for (const local of (await listRuns(db)).filter((x) => x.status === 'completed' && x.runId
    && !(x.artifacts || []).length && settings.github[x.engine]?.repo)) {
    if (enriched >= 3) break;
    enriched++;
    try {
      const artifacts = await listRunArtifacts(token, { ...splitRepo(settings.github[local.engine].repo), runId: local.runId });
      if (artifacts.length) { await updateRun(db, local.id, { artifacts }); updated++; }
    } catch { /* non-fatal */ }
  }

  try {
    const cutoff = Date.now() - STALE_RUN_MS;
    for (const r of await listRuns(db)) {
      if (!r.runId && ['in-progress', 'queued'].includes(r.status) && (Date.parse(r.startedAt) || 0) < cutoff) {
        await updateRun(db, r.id, { status: 'failed', failureReason: 'No matching GitHub Actions run found' });
        updated++;
      }
    }
  } catch (err) { messages.push(`stale run cleanup failed — ${err.message}`); }

  return json(null, 200, {
    ok: true, updated, changes: messages,
    message: `Sync complete — ${updated} update(s).` + (messages.length ? ` ${messages.slice(0, 6).join(' · ')}` : ''),
  });
}
