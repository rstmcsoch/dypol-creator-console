/**
 * GitHub webhook support — signature verification, event → job mapping and
 * step-level progress storage (free tier: plain D1, no Durable Objects).
 *
 * Used by:
 *   POST /api/webhooks/github     (live progress push from GitHub)
 *   POST /api/sync/github         (polling fallback; shares findLocalRun)
 *   GET  /api/jobs/:id/progress   (lightweight dashboard poll)
 *
 * Tables (migrations/003.sql; also self-applied idempotently by
 * ensureProgressSchema so a deploy never depends on a manual migration):
 *   gh_jobs            one row per GitHub Actions job (workflow_job events)
 *   job_steps          one row per step of each GitHub Actions job
 *   webhook_deliveries X-GitHub-Delivery ids (replay / duplicate guard)
 *   runs.+conclusion, current_step, completed_at, updated_at
 *   jobs.+current_step
 */
import { nowIso } from './util.js';
import {
  listRuns, insertRun, updateRun, getJob, updateJob, appendLog, addActivity, getSettings,
} from './db.js';
import { classifyError, buildQuality } from './safeguards.js';
import { splitRepo, getWorkflowRun, listRunJobs } from './github.js';
import { maybeDispatchFallback } from './fallback.js';

/* The only repositories whose events are accepted. Settings may override the
 * slug → engine mapping, but a repo outside this allowlist is always ignored. */
export const ENGINE_REPOS = {
  'rstmcsoch/gemini-youtube-automation': 'gemini',
  'rstmcsoch/youtube-shorts-pipeline': 'verticals',
};

export const ACTIVE_JOB_STATUSES = ['dispatched', 'running', 'generating', 'rendering'];
const PROTECTED_JOB_STATUSES = ['published', 'superseded', 'rejected', 'uploading', 'cancelled'];
const TERMINAL_RUN = ['completed', 'failed', 'cancelled'];

/* ---------------- Signature verification ---------------- */

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  return diff === 0;
}

/**
 * Verify GitHub's X-Hub-Signature-256 header ("sha256=<hex>") over the RAW
 * request body bytes with HMAC-SHA256(secret). Returns false for a missing
 * secret, missing/malformed header or mismatch.
 */
export async function verifySignature(secret, rawBody, header) {
  if (!secret || !header || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const bytes = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toHex(await crypto.subtle.sign('HMAC', key, bytes));
  return timingSafeEqual(expected, m[1].toLowerCase());
}

/* ---------------- Pure mapping helpers ---------------- */

/** GitHub run/job status+conclusion → console run status. */
export function mapRunStatus(status, conclusion) {
  if (conclusion === 'success') return 'completed';
  if (['failure', 'timed_out', 'startup_failure'].includes(conclusion)) return 'failed';
  if (['cancelled', 'skipped', 'stale', 'neutral'].includes(conclusion)) return 'cancelled';
  if (status === 'completed') return conclusion ? 'failed' : 'completed';
  if (status === 'in_progress') return 'in-progress';
  return 'queued'; // queued | requested | waiting | pending | action_required
}

/** Step status → UI status used by the drawers (done/failed/running/pending/skipped). */
export function mapStepStatus(status, conclusion) {
  if (status === 'completed') {
    if (conclusion === 'success') return 'done';
    if (conclusion === 'skipped') return 'skipped';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'failed';
  }
  if (status === 'in_progress') return 'running';
  return 'pending';
}

/** Repository full_name → engine id, or null when the repo is not allowed. */
export function engineForRepo(fullName, settings) {
  const slug = String(fullName || '').toLowerCase();
  if (!ENGINE_REPOS[slug]) return null;
  for (const engine of ['gemini', 'verticals']) {
    const configured = String(settings?.github?.[engine]?.repo || '').toLowerCase();
    if (configured && configured === slug) return engine;
  }
  return ENGINE_REPOS[slug];
}

/** True when the run's workflow file matches the engine's configured workflow
 *  (unknown path or unconfigured workflow → accept). */
export function workflowMatches(path, configuredWorkflow) {
  if (!path || !configuredWorkflow) return true;
  return String(path).split('/').pop() === String(configuredWorkflow).split('/').pop();
}

/**
 * Match a GitHub run to a console run record — same rules as the sync linker:
 * 1. same GitHub run id, 2. unlinked run whose job_id appears in the run's
 * display title (run-name), 3. unlinked workflow_dispatch run created within
 * 5 minutes of the console dispatch.
 * ghr: { runId, displayTitle, event, startedAt }
 */
export function findLocalRun(runs, engine, ghr) {
  const byId = runs.find((r) => String(r.runId) === String(ghr.runId) && r.engine === engine);
  if (byId) return { run: byId, by: 'run_id' };
  const title = String(ghr.displayTitle || '');
  const byJob = runs.find((r) => !r.runId && r.engine === engine && r.jobId && title.includes(r.jobId));
  if (byJob) return { run: byJob, by: 'job_id' };
  if (ghr.event === 'workflow_dispatch') {
    const ghStart = Date.parse(ghr.startedAt) || 0;
    const candidates = runs
      .filter((r) => !r.runId && r.engine === engine && r.jobId
        && Math.abs(ghStart - (Date.parse(r.startedAt) || 0)) < 5 * 60 * 1000)
      .sort((a, b) => Math.abs(ghStart - Date.parse(a.startedAt)) - Math.abs(ghStart - Date.parse(b.startedAt)));
    if (candidates[0]) return { run: candidates[0], by: 'time' };
  }
  return { run: null, by: null };
}

/** Normalise the workflow_run payload object. */
export function normalizeWorkflowRun(wr) {
  return {
    runId: String(wr.id),
    name: wr.name,
    displayTitle: wr.display_title || wr.name || '',
    event: wr.event,
    status: wr.status,
    conclusion: wr.conclusion,
    githubUrl: wr.html_url,
    startedAt: wr.run_started_at || wr.created_at,
    createdAt: wr.created_at,
    updatedAt: wr.updated_at,
    path: wr.path,
  };
}

/** Current step (first running step, else the last finished one) and the
 *  first failing step across a run's jobs. jobs: [{name, steps:[{name,status,conclusion,number}]}] */
export function summarizeSteps(jobs) {
  let current = null, failing = null, total = 0, finished = 0;
  for (const j of jobs || []) {
    const steps = [...(j.steps || [])].sort((a, b) => (a.number || 0) - (b.number || 0));
    for (const s of steps) {
      total++;
      if (s.status === 'completed') finished++;
      if (!current && s.status === 'in_progress') current = { job: j.name, step: s.name };
      if (!failing && s.status === 'completed' && ['failure', 'timed_out'].includes(s.conclusion)) {
        failing = { job: j.name, step: s.name };
      }
    }
    if (!failing && j.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(j.conclusion)) {
      failing = { job: j.name, step: null };
    }
  }
  if (!current) {
    // Last finished step overall (highest started_at), so the UI shows what happened last.
    const done = (jobs || []).flatMap((j) => (j.steps || []).filter((s) => s.status === 'completed')
      .map((s) => ({ job: j.name, step: s.name, t: Date.parse(s.completed_at || s.completedAt || '') || 0, n: s.number || 0 })));
    done.sort((a, b) => (b.t - a.t) || (b.n - a.n));
    if (done[0]) current = { job: done[0].job, step: done[0].step };
  }
  return { current, failing, total, finished };
}

export function failureText(failing, fallbackName) {
  if (failing?.step) return `Step “${failing.step}” failed${failing.job ? ` in job “${failing.job}”` : ''}`;
  if (failing?.job) return `Job “${failing.job}” failed`;
  return `GitHub Actions run concluded with failure (${fallbackName || 'workflow'})`;
}

/* ---------------- Schema (idempotent, cached per isolate) ---------------- */

let schemaReady = false;
export const PROGRESS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gh_jobs (
    gh_job_id TEXT PRIMARY KEY, gh_run_id TEXT NOT NULL, repo TEXT, name TEXT,
    status TEXT, conclusion TEXT, html_url TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_gh_jobs_run ON gh_jobs(gh_run_id)',
  `CREATE TABLE IF NOT EXISTS job_steps (
    gh_run_id TEXT NOT NULL, gh_job_id TEXT NOT NULL, number INTEGER NOT NULL, name TEXT,
    status TEXT, conclusion TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT,
    PRIMARY KEY (gh_run_id, gh_job_id, number))`,
  'CREATE INDEX IF NOT EXISTS idx_job_steps_run ON job_steps(gh_run_id)',
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, event TEXT, received_at TEXT NOT NULL)`,
];
const ADD_COLUMNS = {
  runs: [['conclusion', 'TEXT'], ['current_step', 'TEXT'], ['completed_at', 'TEXT'], ['updated_at', 'TEXT']],
  jobs: [['current_step', 'TEXT']],
};

export async function ensureProgressSchema(db, { force = false } = {}) {
  if (schemaReady && !force) return;
  for (const sql of PROGRESS_SCHEMA) await db.prepare(sql).run();
  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set((results || []).map((r) => r.name));
    for (const [col, type] of cols) {
      if (!have.has(col)) {
        try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); } catch { /* raced */ }
      }
    }
  }
  schemaReady = true;
}
export function _resetSchemaCache() { schemaReady = false; }

/* ---------------- Storage helpers ---------------- */

async function setRunExtras(db, id, extras) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries({
    conclusion: 'conclusion', currentStep: 'current_step', completedAt: 'completed_at',
  })) {
    if (extras[k] !== undefined) { sets.push(`${col} = ?`); args.push(extras[k]); }
  }
  sets.push('updated_at = ?'); args.push(nowIso());
  args.push(id);
  await db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

async function setJobStep(db, jobId, step) {
  await db.prepare('UPDATE jobs SET current_step = ?, updated_at = ? WHERE id = ?').bind(step, nowIso(), jobId).run();
}

export async function upsertGhJob(db, repo, wj) {
  const t = nowIso();
  // A completed record is never regressed by a late in_progress delivery.
  await db.prepare(`INSERT INTO gh_jobs (gh_job_id, gh_run_id, repo, name, status, conclusion, html_url, started_at, completed_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(gh_job_id) DO UPDATE SET name = excluded.name, status = excluded.status,
      conclusion = excluded.conclusion, html_url = excluded.html_url,
      started_at = COALESCE(excluded.started_at, gh_jobs.started_at),
      completed_at = COALESCE(excluded.completed_at, gh_jobs.completed_at), updated_at = excluded.updated_at
    WHERE gh_jobs.status IS NOT 'completed' OR excluded.status = 'completed'`)
    .bind(String(wj.id), String(wj.run_id), repo, wj.name || null, wj.status || null, wj.conclusion || null,
      wj.html_url || null, wj.started_at || null, wj.completed_at || null, t).run();
  for (const s of wj.steps || []) {
    await db.prepare(`INSERT INTO job_steps (gh_run_id, gh_job_id, number, name, status, conclusion, started_at, completed_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(gh_run_id, gh_job_id, number) DO UPDATE SET name = excluded.name, status = excluded.status,
        conclusion = excluded.conclusion, started_at = COALESCE(excluded.started_at, job_steps.started_at),
        completed_at = COALESCE(excluded.completed_at, job_steps.completed_at), updated_at = excluded.updated_at
      WHERE job_steps.status IS NOT 'completed' OR excluded.status = 'completed'`)
      .bind(String(wj.run_id), String(wj.id), Number(s.number) || 0, s.name || null, s.status || null,
        s.conclusion || null, s.started_at || null, s.completed_at || null, t).run();
  }
}

/** Stored jobs+steps for a GitHub run id, shaped like the workflow_job payload. */
export async function loadRunJobs(db, ghRunId) {
  if (!ghRunId) return [];
  const { results: jobs } = await db.prepare('SELECT * FROM gh_jobs WHERE gh_run_id = ? ORDER BY started_at ASC, gh_job_id ASC')
    .bind(String(ghRunId)).all();
  const { results: steps } = await db.prepare('SELECT * FROM job_steps WHERE gh_run_id = ? ORDER BY number ASC')
    .bind(String(ghRunId)).all();
  return (jobs || []).map((j) => ({
    id: j.gh_job_id, name: j.name, status: j.status, conclusion: j.conclusion, html_url: j.html_url,
    started_at: j.started_at, completed_at: j.completed_at, updated_at: j.updated_at,
    steps: (steps || []).filter((s) => s.gh_job_id === j.gh_job_id).map((s) => ({
      number: s.number, name: s.name, status: s.status, conclusion: s.conclusion,
      started_at: s.started_at, completed_at: s.completed_at,
    })),
  }));
}

/** Delivery-id replay guard. Returns true the first time an id is seen. */
export async function recordDelivery(db, id, event) {
  if (!id) return true;
  const r = await db.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, event, received_at) VALUES (?,?,?)')
    .bind(String(id), event || null, nowIso()).run();
  const changes = r?.meta?.changes ?? r?.changes ?? 1;
  if (Math.random() < 0.05) {
    // Opportunistic prune (keep 7 days).
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
    await db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').bind(cutoff).run();
  }
  return changes > 0;
}

/* ---------------- Event processing ---------------- */

const logTs = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

/**
 * Apply a console run status to the linked job (same transitions as sync).
 * Returns a short description of what changed.
 */
async function applyToJob(db, env, settings, local, status, { failure, currentStep, progress } = {}) {
  if (!local?.jobId) return null;
  const job = await getJob(db, local.jobId);
  if (!job || PROTECTED_JOB_STATUSES.includes(job.status)) return null;
  const active = ACTIVE_JOB_STATUSES.includes(job.status) || job.status === 'queued';
  if (status === 'queued' || status === 'in-progress') {
    if (!active) return null; // never resurrect reviewed/failed jobs from late events
    const running = status === 'in-progress';
    await updateJob(db, job.id, {
      status: running ? 'running' : 'dispatched',
      stage: currentStep ? `Running: ${currentStep}` : running ? 'Running in GitHub Actions' : 'Queued in GitHub Actions',
      progress: progress ?? null,
      runId: local.runId || undefined,
    });
    return running ? 'running' : 'dispatched';
  }
  if (!active) return null;
  if (status === 'completed') {
    await updateJob(db, job.id, {
      status: 'needs-review', stage: 'Ready for review', progress: 100,
      quality: buildQuality(job, {
        oauthConfigured: !!(env.YOUTUBE_CLIENT_SECRET_B64 && env.YOUTUBE_TOKEN_B64),
        hasArtifact: (local.artifacts || []).length > 0 ? true : null,
        durationKnown: job.durationSec ? true : null,
      }),
    });
    await appendLog(db, await getJob(db, job.id), { ts: logTs(), level: 'ok', msg: 'GitHub Actions run succeeded (webhook) — ready for review' });
    await addActivity(db, { icon: 'check', tone: 'violet', title: 'Video ready for review', sub: job.title });
    return 'needs-review';
  }
  if (status === 'failed') {
    const cat = classifyError(failure);
    await updateJob(db, job.id, {
      status: 'failed', stage: failure ? `Failed: ${failure.replace(/^Step “(.+?)”.*$/, '$1')}` : 'Failed',
      error: failure, errorCategory: cat.category, errorRetryable: cat.retryable,
    });
    await appendLog(db, await getJob(db, job.id), { ts: logTs(), level: 'error', msg: `${failure} (webhook)` });
    await addActivity(db, { icon: 'alert', tone: 'red', title: 'Run failed', sub: `${job.title} — ${cat.category}` });
    return 'failed';
  }
  if (status === 'cancelled') {
    await updateJob(db, job.id, { status: 'cancelled', stage: 'Cancelled', error: 'Run cancelled' });
    return 'cancelled';
  }
  return null;
}

/** Progress % from real step counts (never fabricated; capped at 99 while running). */
function stepProgress(summary) {
  if (!summary.total) return null;
  return Math.min(99, Math.round((summary.finished / summary.total) * 100));
}

/**
 * Handle a normalised workflow run (from a workflow_run event, or fetched from
 * the API when a workflow_job event arrives for a not-yet-linked run).
 */
export async function handleWorkflowRun(db, env, settings, engine, ghr, { repo } = {}) {
  const runs = await listRuns(db);
  const status = mapRunStatus(ghr.status, ghr.conclusion);
  const { run: found, by } = findLocalRun(runs, engine, ghr);
  let local = found;
  const workflow = settings.github?.[engine]?.workflow || (ghr.path ? ghr.path.split('/').pop() : 'workflow');

  if (!local) {
    local = {
      id: `run-gh-${ghr.runId}`, runId: ghr.runId, engine, workflow, jobId: null,
      startedAt: ghr.startedAt || nowIso(), durationSec: null, status, failureReason: null,
      githubUrl: ghr.githubUrl, steps: [],
      logs: [{ ts: '—', level: 'info', msg: `Discovered from GitHub webhook: ${ghr.displayTitle || ghr.name}` }],
      artifacts: [],
    };
    try { await insertRun(db, local); } catch { /* concurrent insert of the same run id */ }
    return { linked: false, by: null, runRecord: local.id, status, job: null };
  }

  if (by !== 'run_id') {
    local.runId = ghr.runId;
    if (local.jobId) await updateJob(db, local.jobId, { runId: ghr.runId });
  }

  // Never regress a terminal run to non-terminal on out-of-order delivery.
  const regress = TERMINAL_RUN.includes(local.status) && !TERMINAL_RUN.includes(status) && by === 'run_id';
  const ghJobs = await loadRunJobs(db, ghr.runId);
  let summary = summarizeSteps(ghJobs);
  if (status === 'failed' && !summary.failing && env.GITHUB_TOKEN && repo) {
    try {
      const live = await listRunJobs(env.GITHUB_TOKEN, { ...splitRepo(repo), runId: ghr.runId });
      summary = summarizeSteps(live.map((j) => ({
        name: j.name, status: j.status, conclusion: j.conclusion,
        steps: j.steps.map((s, i) => ({ ...s, number: i + 1 })),
      })));
    } catch { /* keep generic reason */ }
  }
  const failure = status === 'failed' ? failureText(summary.failing, ghr.displayTitle || ghr.name) : null;
  const durationSec = TERMINAL_RUN.includes(status) && ghr.startedAt && ghr.updatedAt
    ? Math.max(0, Math.round((Date.parse(ghr.updatedAt) - Date.parse(ghr.startedAt)) / 1000)) : undefined;

  if (!regress) {
    await updateRun(db, local.id, {
      runId: ghr.runId, status, githubUrl: ghr.githubUrl, startedAt: ghr.startedAt || undefined,
      failureReason: failure, durationSec,
    });
    await setRunExtras(db, local.id, {
      conclusion: ghr.conclusion || null,
      currentStep: summary.current?.step || null,
      completedAt: TERMINAL_RUN.includes(status) ? (ghr.updatedAt || nowIso()) : undefined,
    });
  }
  const jobChange = regress ? null : await applyToJob(db, env, settings, local, status, {
    failure, currentStep: summary.current?.step, progress: stepProgress(summary),
  });
  if (local.jobId && summary.current?.step && !regress) await setJobStep(db, local.jobId, summary.current.step);

  let fallback = null;
  if (status === 'failed' && !regress && local.status !== 'failed') {
    fallback = await maybeDispatchFallback({
      db, token: env.GITHUB_TOKEN, settings, engine, local, displayTitle: ghr.displayTitle,
    });
  }
  return { linked: true, by, runRecord: local.id, status, job: jobChange, failure, fallback: fallback?.message || null };
}

/** Handle a workflow_job event: store steps, push current step to the job. */
export async function handleWorkflowJob(db, env, settings, engine, wj, { repo } = {}) {
  await upsertGhJob(db, repo, wj);
  const runId = String(wj.run_id);
  let local = (await listRuns(db)).find((r) => String(r.runId) === runId && r.engine === engine);

  if (!local && env.GITHUB_TOKEN && repo) {
    // Out-of-order: the job event arrived before the run was linked. Fetch the
    // run once and link it through the normal workflow_run path.
    try {
      const r = await getWorkflowRun(env.GITHUB_TOKEN, { ...splitRepo(repo), runId });
      if (!workflowMatches(r.path, settings.github?.[engine]?.workflow)) return { ignored: 'workflow' };
      await handleWorkflowRun(db, env, settings, engine, {
        runId, name: r.name, displayTitle: r.displayTitle, event: r.event, status: r.status,
        conclusion: r.conclusion, githubUrl: r.githubUrl, startedAt: r.runStartedAt || r.startedAt,
        updatedAt: r.updatedAt, path: r.path,
      }, { repo });
      local = (await listRuns(db)).find((x) => String(x.runId) === runId && x.engine === engine);
    } catch { /* stays unlinked; steps are stored and join later */ }
  }
  if (!local) return { linked: false, stored: true };

  const summary = summarizeSteps(await loadRunJobs(db, runId));
  const step = summary.current?.step || null;
  await setRunExtras(db, local.id, { currentStep: step });
  if (!local.githubUrl || /\/actions$/.test(local.githubUrl)) {
    const runUrl = String(wj.html_url || '').replace(/\/job\/\d+.*$/, '');
    if (runUrl) await updateRun(db, local.id, { githubUrl: runUrl });
  }

  let jobChange = null;
  const jobFailed = wj.status === 'completed' && ['failure', 'timed_out'].includes(wj.conclusion);
  if (jobFailed) {
    const failure = failureText(summary.failing || { job: wj.name, step: null });
    // Run status itself flips on the workflow_run 'completed' event (or sync),
    // which also owns the one-time Mode-1 fallback decision.
    await updateRun(db, local.id, { failureReason: failure });
    jobChange = await applyToJob(db, env, settings, local, 'failed', { failure });
  } else if (!TERMINAL_RUN.includes(local.status)) {
    const status = wj.status === 'in_progress' || summary.finished > 0 ? 'in-progress' : 'queued';
    if (status === 'in-progress' && local.status !== 'in-progress') await updateRun(db, local.id, { status });
    jobChange = await applyToJob(db, env, settings, local, status, { currentStep: step, progress: stepProgress(summary) });
  }
  if (local.jobId && step) await setJobStep(db, local.jobId, step);
  return { linked: true, runRecord: local.id, currentStep: step, job: jobChange };
}

/**
 * Entry point for a verified delivery. Returns { status, body } for the HTTP
 * response (always 2xx for well-formed, verified events so GitHub does not
 * retry ignorable ones).
 */
export async function processEvent(db, env, event, payload, deliveryId) {
  if (event === 'ping') return { status: 200, body: { ok: true, pong: true, zen: payload?.zen || null } };
  if (!['workflow_run', 'workflow_job'].includes(event)) {
    return { status: 202, body: { ok: true, ignored: `event ${event}` } };
  }
  const repo = payload?.repository?.full_name;
  await ensureProgressSchema(db);
  const settings = await getSettings(db);
  const engine = engineForRepo(repo, settings);
  if (!engine) return { status: 202, body: { ok: true, ignored: 'repository not allowed' } };
  if (!(await recordDelivery(db, deliveryId, event))) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  if (event === 'workflow_run') {
    const wr = payload.workflow_run;
    if (!wr?.id) return { status: 400, body: { ok: false, error: 'workflow_run payload missing' } };
    if (!workflowMatches(wr.path, settings.github?.[engine]?.workflow)) {
      return { status: 202, body: { ok: true, ignored: 'workflow not tracked' } };
    }
    const result = await handleWorkflowRun(db, env, settings, engine, normalizeWorkflowRun(wr), { repo });
    return { status: 200, body: { ok: true, event, action: payload.action, engine, ...result } };
  }
  const wj = payload.workflow_job;
  if (!wj?.id || !wj.run_id) return { status: 400, body: { ok: false, error: 'workflow_job payload missing' } };
  const result = await handleWorkflowJob(db, env, settings, engine, wj, { repo });
  return { status: 200, body: { ok: true, event, action: payload.action, engine, ...result } };
}
