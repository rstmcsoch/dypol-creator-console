/**
 * Lightweight progress payload for the dashboard poll (D1 only — no GitHub
 * API calls, so polling every few seconds is free-tier safe).
 */
import { ensureProgressSchema, loadRunJobs, summarizeSteps, mapStepStatus, ACTIVE_JOB_STATUSES } from './webhook.js';

const secs = (a, b) => (a ? Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000)) : null);

export async function buildProgress(db, { job = null, runRow = null } = {}) {
  await ensureProgressSchema(db);
  let run = runRow;
  // While uploading (and after), show the PUBLISH run's steps.
  const usePublish = job && job.publishRunId && ['uploading', 'publish_failed', 'published'].includes(job.status);
  if (!run && usePublish) {
    run = await db.prepare('SELECT * FROM runs WHERE run_id = ? ORDER BY started_at DESC LIMIT 1').bind(String(job.publishRunId)).first();
  }
  if (!run && job) {
    run = (job.runId && await db.prepare('SELECT * FROM runs WHERE run_id = ? ORDER BY started_at DESC LIMIT 1').bind(String(job.runId)).first())
      || await db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1').bind(job.id).first();
  }
  const ghRunId = run?.run_id || (usePublish ? job.publishRunId : job?.runId) || null;
  const ghJobs = await loadRunJobs(db, ghRunId);
  const summary = summarizeSteps(ghJobs);
  const runStatus = run?.status || null;
  const runDone = ['completed', 'failed', 'cancelled'].includes(runStatus);
  const runActive = ['in-progress', 'queued'].includes(runStatus);
  // Poll while the job is in flight (or a publish run is uploading it).
  const active = job
    ? ACTIVE_JOB_STATUSES.includes(job.status) || job.status === 'uploading'
    : runActive;
  const done = !active;
  const updatedAt = [run?.updated_at, ...ghJobs.map((j) => j.updated_at)].filter(Boolean).sort().pop() || null;
  return {
    jobId: job?.id || run?.job_id || null,
    jobStatus: job?.status || null,
    stage: job?.stage || null,
    error: job?.error || null,
    currentStep: summary.current?.step || run?.current_step || null,
    failingStep: summary.failing?.step || null,
    stepsTotal: summary.total,
    stepsFinished: summary.finished,
    done,
    pollAfterMs: done ? null : 7000,
    source: ghJobs.length ? 'webhook' : 'registry',
    updatedAt,
    run: run ? {
      id: run.id, runId: run.run_id, status: run.status, conclusion: run.conclusion || null,
      htmlUrl: run.github_url || null, startedAt: run.started_at || null,
      completedAt: run.completed_at || null, failureReason: run.failure_reason || null,
      elapsedSec: secs(run.started_at, run.completed_at || (runDone ? run.updated_at : null)),
    } : null,
    jobs: ghJobs.map((j) => ({
      id: j.id, name: j.name, status: mapStepStatus(j.status, j.conclusion), conclusion: j.conclusion,
      htmlUrl: j.html_url, startedAt: j.started_at, completedAt: j.completed_at,
      elapsedSec: secs(j.started_at, j.completed_at),
      steps: j.steps.map((s) => ({
        number: s.number, name: s.name, status: mapStepStatus(s.status, s.conclusion), conclusion: s.conclusion,
        startedAt: s.started_at, completedAt: s.completed_at,
        elapsedSec: s.status === 'queued' || s.status === 'pending' ? null : secs(s.started_at, s.completed_at),
      })),
    })),
  };
}
