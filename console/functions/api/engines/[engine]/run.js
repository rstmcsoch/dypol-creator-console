import { json, readBody, uid, nowIso } from '../../_lib/util.js';
import { getSettings, insertJob, insertRun, addActivity, listJobs } from '../../_lib/db.js';
import { findDuplicate, classifyError, buildQuality, ERROR_CATEGORIES } from '../../_lib/safeguards.js';
import { splitRepo, dispatchWorkflow } from '../../_lib/github.js';

/**
 * POST /api/engines/:engine/run  { topic?, phase? }
 * Dispatches the engine's GitHub Actions workflow (workflow_dispatch) and
 * registers the job/run in the central job registry. All secrets stay server-side.
 *
 * AUDIT gates added: engine-enabled check, configurable max concurrency,
 * honest initial state (status 'dispatched', progress null — no fabricated %).
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const engine = context.params.engine;
  if (!['gemini', 'verticals'].includes(engine)) {
    return json(null, 404, { error: 'Unknown engine.', code: 'not-found' });
  }
  const settings = await getSettings(db);
  const body = await readBody(context.request);

  if (settings.engines?.[engine]?.enabled === false) {
    return json(null, 409, {
      error: `${engine === 'gemini' ? 'Gemini Automation' : 'Verticals v3'} is disabled in Settings. Enable it before dispatching jobs (running jobs are unaffected).`,
      code: 'engine-disabled',
    });
  }
  if (settings.schedule.automationPaused && body.force !== true) {
    return json(null, 409, { error: 'Automation is paused. Resume scheduling before starting runs (or use a forced manual run).', code: 'paused' });
  }
  const slug = settings.github[engine]?.repo;
  const workflow = settings.github[engine]?.workflow;
  if (!slug || !workflow) {
    return json(null, 409, { error: `Engine ${engine} is not configured (repository/workflow missing in Settings).`, code: 'not-configured' });
  }
  if (!context.env.GITHUB_TOKEN) {
    return json(null, 409, { error: 'GITHUB_TOKEN secret is not configured on the server.', code: 'not-configured' });
  }

  // Concurrency gate (server-side, configurable).
  const maxConcurrent = settings.orchestration.maxConcurrency ?? 1;
  const active = (await listJobs(db, {})).filter((j) =>
    ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
  if (active.length >= maxConcurrent) {
    return json(null, 409, {
      error: `Concurrency limit reached (${maxConcurrent} active job(s)). Wait for a running job to finish or raise “Maximum concurrency” in Settings.`,
      code: 'concurrency-limit',
    });
  }

  // Duplicate gate BEFORE dispatch (cheap prevention).
  const title = String(body.topic || '').trim();
  if (title && settings.publishing.dedupe) {
    const dup = await findDuplicate(db, title);
    if (dup) {
      return json(null, 409, {
        error: `Duplicate topic blocked — “${title}” matches “${dup.job.title}” (normalised key ${dup.key}).`,
        code: 'duplicate', duplicateOf: { id: dup.job.id, title: dup.job.title, key: dup.key },
      });
    }
  }

  // Phase semantics + review-gate bypass protection: 'full' means generate AND
  // upload in one run — only permitted when the configured policy explicitly
  // allows automatic publishing. Under review-required (the default) a
  // 'full' request is demoted to 'draft' — a successful workflow dispatch is
  // never an approval.
  const requested = ['draft', 'publish', 'full'].includes(body.phase) ? body.phase : 'draft';
  const autoAllowed = settings.publishing.autoPublish === true && settings.publishing.reviewRequired === false;
  const phase = requested === 'full' && !autoAllowed ? 'draft' : requested;
  const demoted = requested === 'full' && phase === 'draft';
  const inputs = {
    phase,
    ...(title ? { topic: title } : {}),
    privacy: settings.publishing.visibility,
    language: settings.defaults.language || 'en',
    review_required: settings.publishing.reviewRequired ? '1' : '0',
    auto_publish: settings.publishing.autoPublish ? '1' : '0',
    ...(body.titleOverride ? { title_override: body.titleOverride } : {}),
    ...(body.descriptionOverride ? { description_override: body.descriptionOverride } : {}),
  };

  const job = {
    id: uid('job'), engine,
    title: title || `${engine === 'gemini' ? 'Gemini Automation' : 'Verticals v3'} run ${new Date().toLocaleString('en-IN')}`,
    topic: title || null, niche: body.niche || settings.defaults.niche || 'general',
    format: engine === 'gemini' ? 'long-form' : 'short',
    status: 'dispatched', stage: 'workflow_dispatch sent', progress: null,
    description: '', tags: [], durationSec: null, thumbnail: null,
    createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
    youtubeId: null, youtubeUrl: null, error: null, errorCategory: null, errorRetryable: null,
    quality: buildQuality({ title, description: '', tags: [] }, { oauthConfigured: false }),
    logs: [
      { ts: new Date().toLocaleTimeString('en-GB'), level: 'info', msg: `workflow_dispatch → ${slug}@${workflow} (phase=${phase})` },
      { ts: new Date().toLocaleTimeString('en-GB'), level: 'ok', msg: 'Duplicate check passed before dispatch' },
    ],
    runId: null, parentJobId: null, attempt: 1, publishBlocked: null, duplicateOf: null,
    demo: false,
  };
  await insertJob(db, job);

  try {
    await dispatchWorkflow(context.env.GITHUB_TOKEN, {
      ...splitRepo(slug), workflowFile: workflow, ref: settings.github.branch || 'dypol-integration',
      inputs: { ...inputs, job_id: job.id },
    });
  } catch (err) {
    const cat = classifyError(err.message);
    job.status = 'failed';
    job.stage = 'workflow_dispatch failed';
    job.error = `GitHub workflow dispatch failed (${cat.category}): ${err.message}`;
    job.errorCategory = cat.category;
    job.errorRetryable = cat.retryable;
    job.updatedAt = nowIso();
    job.logs.push({ ts: new Date().toLocaleTimeString('en-GB'), level: 'error', msg: job.error });
    // Persist a visible failed job rather than losing the record after the
    // database row was created. The request remains an honest 502 response.
    const { updateJob } = await import('../../_lib/db.js');
    await updateJob(db, job.id, job);
    return json(null, 502, {
      error: job.error, code: 'github', category: cat.category, retryable: cat.retryable,
      jobId: job.id,
    });
  }

  const run = {
    id: uid('run'), runId: null, engine, workflow, jobId: job.id,
    startedAt: nowIso(), durationSec: null, status: 'in-progress',
    failureReason: null, errorCategory: null,
    githubUrl: `https://github.com/${slug}/actions`,
    steps: [{ name: 'workflow_dispatch', status: 'done' }],
    logs: job.logs.slice(), artifacts: [],
    demo: false,
  };
  await insertRun(db, run);
  await addActivity(db, { icon: 'run', tone: 'blue', title: 'Run started', sub: `${job.title} · ${engine}` });

  return json(null, 202, {
    ok: true, jobId: job.id, runId: run.id,
    message: `Dispatched ${slug}/${workflow} (${phase} phase). Status will sync from GitHub Actions.`
      + (demoted ? ' Note: “full” was demoted to “draft” — review-required mode blocks single-run uploads.' : ''),
    demoted: demoted || undefined,
  });
}
