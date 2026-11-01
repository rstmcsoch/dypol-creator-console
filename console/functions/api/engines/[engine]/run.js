import { json, readBody, uid, nowIso } from '../../_lib/util.js';
import { getSettings, insertJob, addActivity, listJobs, getJob } from '../../_lib/db.js';
import { findDuplicate, classifyError, buildQuality, ERROR_CATEGORIES } from '../../_lib/safeguards.js';
import { dispatchForJob, buildDraftInputs } from '../../_lib/jobflow.js';

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
    ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status)
    // Records with no update for 90+ min are stale (lost dispatch) — never block on them.
    && (Date.now() - (Date.parse(j.updatedAt || j.createdAt) || 0)) < 90 * 60 * 1000);
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
    ...buildDraftInputs(settings, engine, {
      topic: title, niche: body.niche, context: body.context,
      titleOverride: body.titleOverride, descriptionOverride: body.descriptionOverride,
    }),
  };

  const job = {
    id: uid('job'), engine,
    title: title || `${engine === 'gemini' ? 'Gemini Automation' : 'Verticals v3'} run ${new Date().toLocaleString('en-IN')}`,
    topic: title || null, niche: body.niche || settings.defaults.niche || 'general',
    format: engine === 'gemini' ? 'long-form' : 'short',
    status: 'dispatched', stage: 'Sent to engine', progress: null,
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

  let dispatched;
  try {
    dispatched = await dispatchForJob({ db, env: context.env, settings, job, phase, inputs });
  } catch (err) {
    const cat = classifyError(err.message);
    job.status = 'failed';
    job.stage = 'Could not start';
    job.error = `GitHub workflow dispatch failed (${cat.category}): ${err.message}`;
    job.errorCategory = cat.category;
    job.errorRetryable = cat.retryable;
    job.updatedAt = nowIso();
    job.logs.push({ ts: new Date().toLocaleTimeString('en-GB'), level: 'error', msg: job.error });
    const { updateJob } = await import('../../_lib/db.js');
    const { runId: _ignored, ...rest } = job;
    await updateJob(db, job.id, rest);
    return json(null, 502, {
      error: job.error, code: 'github', category: cat.category, retryable: cat.retryable,
      jobId: job.id,
    });
  }
  const run = { id: dispatched.runRowId };
  await addActivity(db, { icon: 'run', tone: 'blue', title: 'Run started', sub: `${job.title} · ${engine}`, jobId: job.id });

  return json(null, 202, {
    ok: true, jobId: job.id, runId: run.id, ghRunId: dispatched.ghRunId || null,
    message: `Dispatched ${slug}/${workflow} (${phase} phase). Status will sync from GitHub Actions.`
      + (demoted ? ' Note: “full” was demoted to “draft” — review-required mode blocks single-run uploads.' : ''),
    demoted: demoted || undefined,
  });
}
