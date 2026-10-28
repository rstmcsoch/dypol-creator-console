import { json } from '../../_lib/util.js';
import { getRun, getSettings, getJob } from '../../_lib/db.js';
import { splitRepo, getWorkflowRun, listRunJobs, listRunArtifacts } from '../../_lib/github.js';

/** GET /api/runs/:id — run detail enriched with real GitHub job/step data. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const run = await getRun(db, context.params.id);
  if (!run) return json(null, 404, { error: 'Run not found.', code: 'not-found' });

  if (context.env.GITHUB_TOKEN && run.runId) {
    const settings = await getSettings(db);
    const slug = settings.github[run.engine]?.repo;
    try {
      const gh = splitRepo(slug);
      const [detail, jobs, artifacts] = await Promise.all([
        getWorkflowRun(context.env.GITHUB_TOKEN, { ...gh, runId: run.runId }),
        listRunJobs(context.env.GITHUB_TOKEN, { ...gh, runId: run.runId }),
        listRunArtifacts(context.env.GITHUB_TOKEN, { ...gh, runId: run.runId }),
      ]);
      run.status = detail.conclusion === 'success' ? 'completed'
        : detail.conclusion === 'failure' ? 'failed'
        : detail.status;
      run.githubUrl = detail.githubUrl;
      run.artifacts = artifacts;
      const failedJob = jobs.find((j) => j.conclusion === 'failure');
      run.failureReason = failedJob ? `Job “${failedJob.name}” failed` : run.failureReason;
      run.steps = jobs.flatMap((j) => j.steps.map((s) => ({
        name: `${j.name} › ${s.name}`,
        status: s.conclusion === 'success' ? 'done' : s.conclusion === 'failure' ? 'failed' : s.status,
      })));
    } catch { /* keep registry copy */ }
  }
  if (run.jobId) {
    const job = await getJob(db, run.jobId);
    run.jobTitle = job?.title || null;
  }
  return json(null, 200, { run });
}
