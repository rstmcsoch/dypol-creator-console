/**
 * Job lifecycle helpers shared by every dispatch path, the GitHub webhook and
 * the reconciler (sync + throttled reconcile on dashboard list loads).
 *
 *   dispatchForJob      — ONE dispatch helper: strips undeclared inputs, inserts
 *                         the run row BEFORE dispatching, asks GitHub for the
 *                         run id (return_run_details) and stores it on the job.
 *   ingestPublishResult — publish run finished → read dypol-results/<run>.json
 *                         (exact path, dypol-integration) → published + links,
 *                         or publish_failed with a reason.
 *   failJob             — failure reason = category + last ~40 log lines of the
 *                         failed GitHub job.
 *   reconcileJobs       — stale sweep: dispatched >5 min, drafting >25 min,
 *                         uploading >10 min → check the run via the API →
 *                         update, or mark failed / publish_failed.
 */
import { uid, nowIso } from './util.js';
import {
  insertRun, updateRun, getJob, updateJob, appendLog, addActivity, listJobs, runsForJob, rowToRun,
} from './db.js';
import {
  splitRepo, dispatchWorkflow, getWorkflowInputs, filterInputs, integrationRef, getWorkflowRun,
  listRunJobs, fetchJobLogTail, listWorkflowRuns, fetchRunResult,
} from './github.js';
import {
  classifyFailure, recordPublished, findUploadEvidence, FAILURE_CATEGORIES, acquireLock,
} from './safeguards.js';

const ts = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

export const DRAFT_ACTIVE = ['dispatched', 'running', 'generating', 'rendering'];
export const STALE_MS = { dispatched: 5 * 60e3, drafting: 25 * 60e3, uploading: 10 * 60e3 };
// 'uploading' is left alone (its errors clear when the upload resolves) so the
// stale timer for legacy uploads is never reset by this cleanup.
const OK_STATES = ['needs-review', 'awaiting-review', 'approved', 'scheduled', 'published'];

function engineGh(settings, engine) {
  const slug = settings.github?.[engine]?.repo;
  const workflow = settings.github?.[engine]?.workflow;
  return slug && workflow ? { slug, workflow, gh: splitRepo(slug), ref: integrationRef(settings) } : null;
}

/* ---------------- Dispatch ---------------- */

/** Make GitHub run id `ghRunId` belong to local run row `runRowId` (removes an
 *  orphan row the webhook may have created first, unlinks a mis-link). */
async function adoptRunId(db, runRowId, ghRunId) {
  const { results } = await db.prepare('SELECT * FROM runs WHERE run_id = ? AND id != ?').bind(String(ghRunId), runRowId).all();
  for (const r of (results || []).map(rowToRun)) {
    if (!r.jobId) {
      await db.prepare('DELETE FROM runs WHERE id = ?').bind(r.id).run();
    } else {
      await updateRun(db, r.id, { runId: null });
      const other = await getJob(db, r.jobId);
      if (other && String(other.runId) === String(ghRunId)) await updateJob(db, other.id, { runId: null });
      if (other && String(other.publishRunId) === String(ghRunId)) await updateJob(db, other.id, { publishRunId: null });
    }
  }
}

/**
 * Dispatch `phase` for `job` through the single shared path.
 * Throws on GitHub errors (the run row is marked failed first).
 * Returns { runRowId, ghRunId, htmlUrl, stripped, sent }.
 */
export async function dispatchForJob({ db, env, settings, job, phase, inputs = {} }) {
  const cfg = engineGh(settings, job.engine);
  if (!env.GITHUB_TOKEN || !cfg) {
    throw Object.assign(new Error('Engine not configured for dispatch (repository/workflow/token).'), { code: 'not-configured' });
  }
  const declared = await getWorkflowInputs(env.GITHUB_TOKEN, { ...cfg.gh, workflowFile: cfg.workflow, ref: cfg.ref });
  const { inputs: sent, stripped } = filterInputs({ ...inputs, phase, job_id: job.id }, declared);
  const runRowId = uid('run');
  await insertRun(db, {
    id: runRowId, runId: null, engine: job.engine, workflow: cfg.workflow, jobId: job.id, phase,
    startedAt: nowIso(), durationSec: null, status: 'queued', failureReason: null,
    githubUrl: `https://github.com/${cfg.slug}/actions`,
    steps: [{ name: 'workflow_dispatch', status: 'pending' }],
    logs: [{
      ts: ts(), level: 'info',
      msg: `Dispatch ${phase} → ${cfg.slug}@${cfg.workflow} on ${cfg.ref}`
        + (stripped.length ? ` (not declared by the workflow, not sent: ${stripped.join(', ')})` : ''),
    }],
    artifacts: [],
  });
  let res;
  try {
    res = await dispatchWorkflow(env.GITHUB_TOKEN, { ...cfg.gh, workflowFile: cfg.workflow, ref: cfg.ref, inputs: sent });
  } catch (err) {
    await updateRun(db, runRowId, { status: 'failed', failureReason: `Dispatch failed: ${err.message}` });
    throw err;
  }
  if (res.runId) {
    await adoptRunId(db, runRowId, res.runId);
    await updateRun(db, runRowId, {
      runId: res.runId,
      githubUrl: res.htmlUrl || `https://github.com/${cfg.slug}/actions/runs/${res.runId}`,
      steps: [{ name: 'workflow_dispatch', status: 'done' }],
    });
    await updateJob(db, job.id, phase === 'publish' ? { publishRunId: res.runId } : { runId: res.runId });
  } else {
    await updateRun(db, runRowId, { steps: [{ name: 'workflow_dispatch', status: 'done' }] });
  }
  return { runRowId, ghRunId: res.runId, htmlUrl: res.htmlUrl, stripped, sent };
}

/* ---------------- Failure reasons ---------------- */

/** Find the failed GitHub job of a run (stored webhook rows first, then API). */
async function failedGhJob(db, token, gh, ghRunId) {
  try {
    const row = await db.prepare(`SELECT gh_job_id, name FROM gh_jobs WHERE gh_run_id = ?
      AND conclusion IN ('failure','timed_out','startup_failure') ORDER BY completed_at DESC LIMIT 1`).bind(String(ghRunId)).first();
    if (row) {
      const step = await db.prepare(`SELECT name FROM job_steps WHERE gh_run_id = ? AND gh_job_id = ?
        AND conclusion IN ('failure','timed_out') ORDER BY number ASC LIMIT 1`).bind(String(ghRunId), row.gh_job_id).first();
      return { id: row.gh_job_id, name: row.name, step: step?.name || null };
    }
  } catch { /* table may be missing in old DBs */ }
  try {
    const jobs = await listRunJobs(token, { ...gh, runId: ghRunId });
    const j = jobs.find((x) => ['failure', 'timed_out', 'startup_failure'].includes(x.conclusion));
    if (j) {
      const s = (j.steps || []).find((x) => ['failure', 'timed_out'].includes(x.conclusion));
      return { id: j.id, name: j.name, step: s?.name || null };
    }
  } catch { /* unavailable */ }
  return null;
}

/**
 * Mark a job failed (draft) or publish_failed (publish) with a categorised,
 * human-readable reason + the failed job's last ~40 log lines.
 */
export async function failJob(db, env, settings, job, { phase = 'draft', ghRunId, failure, cancelled = false, ghJobId } = {}) {
  const cfg = engineGh(settings, job.engine);
  let excerpt = '', where = failure || null;
  if (!cancelled && env.GITHUB_TOKEN && cfg && ghRunId) {
    const fj = ghJobId ? { id: ghJobId } : await failedGhJob(db, env.GITHUB_TOKEN, cfg.gh, ghRunId);
    if (fj?.step && !where) where = `Step “${fj.step}” failed`;
    if (fj?.id) excerpt = await fetchJobLogTail(env.GITHUB_TOKEN, { ...cfg.gh, jobId: fj.id, lines: 40 });
  }
  const cat = cancelled ? { category: phase === 'publish' ? 'publish' : 'unknown', retryable: true }
    : classifyFailure(`${where || ''}\n${excerpt}`, phase);
  const label = cancelled ? 'Run was cancelled' : FAILURE_CATEGORIES[cat.category];
  const error = `${label}${where && !cancelled ? ` — ${where}` : ''}`;
  const patch = phase === 'publish'
    ? { status: 'publish_failed', stage: 'Upload failed — not on YouTube', uploadingSince: null }
    : { status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'Cancelled' : `Failed — ${label}` };
  await updateJob(db, job.id, {
    ...patch, error, errorCategory: cat.category, errorRetryable: cat.retryable, errorLog: excerpt || null,
  });
  await appendLog(db, await getJob(db, job.id), { ts: ts(), level: 'error', msg: `${error}${ghRunId ? ` (GitHub run ${ghRunId})` : ''}` });
  await addActivity(db, {
    icon: 'alert', tone: 'red', title: phase === 'publish' ? 'Upload failed' : 'Run failed', sub: `${job.title} — ${label}`,
  });
  return patch.status;
}

/* ---------------- Publish result ingestion ---------------- */

/**
 * The publish run `ghRunId` completed successfully: read its verified result
 * (dypol-results/<run>.json on dypol-integration, artifact backup) and mark the
 * job published with every YouTube id (Engine A: long + Short). If no result
 * exists the job becomes publish_failed (re-checked by later syncs).
 */
export async function ingestPublishResult(db, env, settings, job, ghRunId, { completedAt } = {}) {
  const cfg = engineGh(settings, job.engine);
  if (!cfg || !env.GITHUB_TOKEN) return null;
  let ev = await findUploadEvidence(env.GITHUB_TOKEN, cfg.gh, job, { runIds: [ghRunId] });
  if (!ev && env.__noRetryWait !== true) {
    await new Promise((r) => setTimeout(r, 2500)); // contents API can lag the run by a moment
    ev = await findUploadEvidence(env.GITHUB_TOKEN, cfg.gh, job, { runIds: [ghRunId] });
  }
  if (ev?.youtube_id) {
    await recordPublished(db, job, ev.youtube_id, {
      url: ev.youtube_url, videos: ev.videos || [], publishedAt: completedAt || nowIso(),
      publishRunId: ev.run_id || ghRunId,
    });
    const ids = (ev.videos || []).map((v) => `${v.kind || 'video'} ${v.youtube_id}`).join(', ') || ev.youtube_id;
    await appendLog(db, await getJob(db, job.id), {
      ts: ts(), level: 'ok', msg: `Published (${ev.visibility || settings.publishing?.visibility || 'unlisted'}) — ${ids} · result dypol-results/${ev.run_id || ghRunId}.json`,
    });
    return 'published';
  }
  await updateJob(db, job.id, {
    status: 'publish_failed', stage: 'Upload result missing', uploadingSince: null,
    publishRunId: String(ghRunId),
    error: `${FAILURE_CATEGORIES.publish} — the publish run finished but no result file dypol-results/${ghRunId}.json was found on ${cfg.ref}. Check YouTube Studio before publishing again; the next Sync re-checks automatically.`,
    errorCategory: 'publish', errorRetryable: true,
  });
  await appendLog(db, await getJob(db, job.id), { ts: ts(), level: 'error', msg: `Publish run ${ghRunId} succeeded but no result file was found` });
  return 'publish_failed';
}

/* ---------------- Reconciliation ---------------- */

async function linkRunRow(db, job, phase, ghRun, status) {
  const ghId = String(ghRun.runId);
  let row = (await db.prepare('SELECT * FROM runs WHERE run_id = ?').bind(ghId).first());
  if (!row) {
    row = (await runsForJob(db, job.id, phase)).find((r) => !r.runId);
    if (row) row = { id: row.id };
  }
  const patch = {
    runId: ghId, status, githubUrl: ghRun.githubUrl, jobId: job.id, phase,
    ...(status !== 'in-progress' && status !== 'queued' && ghRun.startedAt && ghRun.updatedAt
      ? { durationSec: Math.max(0, Math.round((Date.parse(ghRun.updatedAt) - Date.parse(ghRun.runStartedAt || ghRun.startedAt)) / 1000)) } : {}),
  };
  if (row) {
    await updateRun(db, row.id, patch);
  } else {
    await insertRun(db, {
      id: uid('run'), runId: ghId, engine: job.engine, workflow: ghRun.path?.split('/').pop() || 'workflow', jobId: job.id, phase,
      startedAt: ghRun.runStartedAt || ghRun.startedAt || nowIso(), durationSec: patch.durationSec ?? null,
      status, failureReason: null, githubUrl: ghRun.githubUrl, steps: [],
      logs: [{ ts: ts(), level: 'info', msg: 'Linked by reconcile' }], artifacts: [],
    });
  }
}

const runStatus = (r) => (r.status !== 'completed' ? (r.status === 'in_progress' ? 'in-progress' : 'queued')
  : r.conclusion === 'success' ? 'completed' : ['cancelled', 'skipped', 'stale'].includes(r.conclusion) ? 'cancelled' : 'failed');

/** Locate the GitHub run for a stale job (stored id → run rows → API search). */
async function locateRun(db, env, cfg, job, phase, cache) {
  const known = phase === 'publish' ? job.publishRunId : job.runId;
  if (known) return String(known);
  const rows = await runsForJob(db, job.id, phase);
  const withId = rows.find((r) => r.runId);
  if (withId) return String(withId.runId);
  const key = `${cfg.slug}/${cfg.workflow}`;
  if (!cache[key]) {
    try { cache[key] = await listWorkflowRuns(env.GITHUB_TOKEN, { ...cfg.gh, workflowFile: cfg.workflow, perPage: 60, branch: cfg.ref }); }
    catch { cache[key] = []; }
  }
  const linked = new Set(((await db.prepare("SELECT run_id FROM runs WHERE run_id IS NOT NULL AND job_id IS NOT NULL AND job_id != ?")
    .bind(job.id).all()).results || []).map((r) => String(r.run_id)));
  const ghRuns = cache[key].filter((r) => r.event === 'workflow_dispatch' && !linked.has(String(r.runId)));
  const byTitle = ghRuns.find((r) => String(r.displayTitle || '').includes(job.id));
  if (byTitle) return byTitle.runId;
  if (phase === 'publish') {
    // Legacy uploads dispatched before run ids were stored: read candidates'
    // results by exact path and match on job_id.
    const after = Date.parse(job.createdAt) || 0;
    const cands = ghRuns.filter((r) => r.status === 'completed' && String(r.runId) !== String(job.runId)
      && (Date.parse(r.startedAt) || 0) >= after).slice(0, 10);
    for (const r of cands) {
      try {
        const res = await fetchRunResult(env.GITHUB_TOKEN, { ...cfg.gh, runId: r.runId, ref: cfg.ref });
        if (res?.job_id === job.id && res.youtube_id) return r.runId;
      } catch { /* skip */ }
    }
    return null;
  }
  const t0 = Date.parse(job.createdAt) || 0;
  const near = ghRuns.filter((r) => Math.abs((Date.parse(r.startedAt) || 0) - t0) < 5 * 60e3)
    .sort((a, b) => Math.abs(Date.parse(a.startedAt) - t0) - Math.abs(Date.parse(b.startedAt) - t0));
  return near[0]?.runId || null;
}

/**
 * Reconcile stale jobs against GitHub. Throttled to once per 2 min via the
 * locks table unless `force` (manual Sync). Never dispatches anything.
 */
export async function reconcileJobs(db, env, settings, { force = false, now = Date.now() } = {}) {
  if (!env.GITHUB_TOKEN) return { skipped: 'no-token', changes: [] };
  if (!force && !(await acquireLock(db, 'reconcile', 120000))) return { skipped: 'throttled', changes: [] };
  const changes = [];
  const cache = {};
  const jobs = await listJobs(db, {});

  // Clear stale error categories left on jobs that later succeeded.
  for (const j of jobs) {
    if (OK_STATES.includes(j.status) && (j.errorCategory || j.error)) {
      await updateJob(db, j.id, { error: null, errorCategory: null, errorRetryable: null, errorLog: null });
    }
  }

  for (const job of jobs) {
    const cfg = engineGh(settings, job.engine);
    if (!cfg) continue;
    let phase = null;
    const updated = Date.parse(job.updatedAt || job.createdAt) || 0;
    if (job.status === 'uploading') {
      const since = job.uploadingSince || updated;
      if (now - since > STALE_MS.uploading) phase = 'publish';
    } else if (job.status === 'dispatched') {
      if (now - updated > STALE_MS.dispatched) phase = 'draft';
    } else if (['running', 'generating', 'rendering'].includes(job.status)) {
      const rows = await runsForJob(db, job.id, 'draft');
      const start = Date.parse(rows[0]?.startedAt || '') || updated;
      if (now - Math.max(start, 0) > STALE_MS.drafting) phase = 'draft';
    } else if (job.status === 'publish_failed' && job.publishRunId && job.errorCategory === 'publish'
      && now - updated < 48 * 3600e3 && (force || now - updated > 60e3)) {
      // A missing/late result file: re-check by exact path (cheap) and recover.
      const ev = await findUploadEvidence(env.GITHUB_TOKEN, cfg.gh, job).catch(() => null);
      if (ev?.youtube_id) {
        await recordPublished(db, job, ev.youtube_id, { url: ev.youtube_url, videos: ev.videos || [], publishRunId: job.publishRunId });
        await appendLog(db, await getJob(db, job.id), { ts: ts(), level: 'ok', msg: `Upload result found on re-check — ${ev.youtube_id}` });
        changes.push(`${job.title}: published (recovered)`);
      }
      continue;
    }
    if (!phase) continue;

    try {
      const ghRunId = await locateRun(db, env, cfg, job, phase, cache);
      if (!ghRunId) {
        if (phase === 'publish') {
          await failJob(db, env, settings, job, {
            phase, failure: 'No publish run could be found for this upload after 10 minutes. Check YouTube Studio before publishing again.',
          });
          changes.push(`${job.title}: publish_failed (no run)`);
        } else {
          await updateJob(db, job.id, {
            status: 'failed', stage: 'Never started',
            error: job.status === 'dispatched'
              ? 'No GitHub run started for this job within 5 minutes — the dispatch was probably rejected.'
              : 'No GitHub run found for this job.',
            errorCategory: 'unknown', errorRetryable: true,
          });
          changes.push(`${job.title}: failed (no run)`);
        }
        continue;
      }
      const r = await getWorkflowRun(env.GITHUB_TOKEN, { ...cfg.gh, runId: ghRunId });
      const st = runStatus(r);
      await linkRunRow(db, job, phase, r, st);
      if (phase === 'publish') {
        if (!job.publishRunId) await updateJob(db, job.id, { publishRunId: String(ghRunId) });
        const fresh = await getJob(db, job.id);
        if (st === 'completed') {
          const out = await ingestPublishResult(db, env, settings, fresh, ghRunId, { completedAt: r.updatedAt });
          changes.push(`${job.title}: ${out}`);
        } else if (st === 'failed' || st === 'cancelled') {
          await failJob(db, env, settings, fresh, { phase, ghRunId, cancelled: st === 'cancelled' });
          changes.push(`${job.title}: publish_failed`);
        }
        continue;
      }
      if (!job.runId) await updateJob(db, job.id, { runId: String(ghRunId) });
      const fresh = await getJob(db, job.id);
      if (st === 'completed') {
        await updateJob(db, job.id, {
          status: 'needs-review', stage: 'Ready for review', progress: 100,
          error: null, errorCategory: null, errorRetryable: null, errorLog: null,
        });
        await appendLog(db, fresh, { ts: ts(), level: 'ok', msg: `GitHub run ${ghRunId} succeeded — ready for review (reconciled)` });
        await addActivity(db, { icon: 'check', tone: 'violet', title: 'Video ready for review', sub: job.title });
        changes.push(`${job.title}: needs-review`);
      } else if (st === 'failed' || st === 'cancelled') {
        await failJob(db, env, settings, fresh, { phase, ghRunId, cancelled: st === 'cancelled' });
        changes.push(`${job.title}: ${st}`);
      } else if (job.status === 'dispatched' && st === 'in-progress') {
        await updateJob(db, job.id, { status: 'running', stage: 'Working on it' });
        changes.push(`${job.title}: running`);
      }
    } catch (err) {
      changes.push(`${job.title}: reconcile error — ${err.message}`);
    }
  }
  return { changes };
}

/** Fire-and-forget reconcile for dashboard list loads (throttled). */
export function backgroundReconcile(context, settings) {
  const env = context.env;
  if (!env?.GITHUB_TOKEN || !env.DB) return;
  const p = (async () => {
    const s = settings || (await (await import('./db.js')).getSettings(env.DB));
    await reconcileJobs(env.DB, env, s);
  })().catch(() => {});
  if (typeof context.waitUntil === 'function') context.waitUntil(p);
  return p;
}
