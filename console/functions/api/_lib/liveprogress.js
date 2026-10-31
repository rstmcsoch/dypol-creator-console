/**
 * refreshRunFromApi — live step progress for a running GitHub run.
 *
 * workflow_job webhooks only fire when a job is queued / starts / finishes, so
 * a one-job workflow (both engines) shows no step movement between them. When
 * a progress endpoint is polled (or on Sync), this pulls
 * GET /repos/{repo}/actions/runs/{id}/jobs (1 subrequest) and feeds every job
 * through the SAME handler as a workflow_job delivery (steps stored, current
 * step + percent pushed to the job). When every job has finished, the run
 * itself is read (1 more subrequest) and handled like a workflow_run event so
 * the job reaches Needs review / Failed without waiting for the webhook.
 *
 * Throttled per run by a 15 s D1 lock, so many open drawers/tabs cost at most
 * ~4 GitHub calls a minute per run. Read-only towards GitHub.
 */
import { acquireLock } from './safeguards.js';
import { ghGet, getWorkflowRun, splitRepo } from './github.js';
import { handleWorkflowJob, handleWorkflowRun, workflowMatches } from './webhook.js';

export const REFRESH_LOCK_MS = 15000;

export async function refreshRunFromApi(db, env, settings, { ghRunId, engine }) {
  if (!env?.GITHUB_TOKEN || !ghRunId || !/^\d+$/.test(String(ghRunId))) return { skipped: 'no-run' };
  const slug = settings.github?.[engine]?.repo;
  if (!slug) return { skipped: 'not-configured' };
  if (!(await acquireLock(db, `progress:${ghRunId}`, REFRESH_LOCK_MS))) return { skipped: 'throttled' };
  const { owner, repo } = splitRepo(slug);
  let data;
  try {
    data = await ghGet(env.GITHUB_TOKEN, `/repos/${owner}/${repo}/actions/runs/${ghRunId}/jobs?per_page=20`);
  } catch (err) {
    return { error: `jobs unavailable (${err.status || 'error'})` };
  }
  const jobs = (data?.jobs || []).filter((j) => j && j.id);
  for (const wj of jobs) {
    await handleWorkflowJob(db, env, settings, engine, { ...wj, run_id: wj.run_id || Number(ghRunId) }, { repo: slug });
  }
  let finished = false;
  if (jobs.length && jobs.every((j) => j.status === 'completed')) {
    try {
      const r = await getWorkflowRun(env.GITHUB_TOKEN, { owner, repo, runId: ghRunId });
      if (r.status === 'completed' && workflowMatches(r.path, settings.github?.[engine]?.workflow)) {
        await handleWorkflowRun(db, env, settings, engine, {
          runId: String(ghRunId), name: r.name, displayTitle: r.displayTitle, event: r.event,
          status: r.status, conclusion: r.conclusion, githubUrl: r.githubUrl,
          startedAt: r.runStartedAt || r.startedAt, createdAt: r.startedAt, updatedAt: r.updatedAt, path: r.path,
        }, { repo: slug });
        finished = true;
      }
    } catch { /* the webhook / reconcile finishes it */ }
  }
  return { refreshed: true, jobs: jobs.length, finished };
}

/** The GitHub run a job's progress should follow (publish run while uploading). */
export function liveRunIdFor(job) {
  if (!job) return null;
  if (job.status === 'uploading' && job.publishRunId) return String(job.publishRunId);
  if (['dispatched', 'running', 'generating', 'rendering', 'queued'].includes(job.status)) return job.runId ? String(job.runId) : null;
  return null;
}
