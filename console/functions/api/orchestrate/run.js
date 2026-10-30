import { json, readBody, uid, nowIso } from '../_lib/util.js';
import { getSettings, insertJob, addActivity, listJobs } from '../_lib/db.js';
import { findDuplicate, classifyError, buildQuality } from '../_lib/safeguards.js';
import { dispatchForJob } from '../_lib/jobflow.js';

/**
 * POST /api/orchestrate/run { topic?, forceMode? } — mode-aware dual-engine dispatch.
 *
 * Mode 1 primary_with_fallback: dispatch Engine A only. The fallback (Engine B)
 *   is dispatched by the sync step if — and only if — the primary run genuinely
 *   failed AND no upload happened AND the fallback policy allows it.
 * Mode 2 alternate: pick the engine for today (odd/even days or run index).
 * Mode 3 draft_both: dispatch BOTH engines in draft phase. Nothing auto-publishes;
 *   candidates compete in the Content Queue and only an explicit approval wins.
 *
 * forceMode: 'draft_both' lets the Overview "Run Both" control request
 * candidates regardless of the configured mode (still draft-only, still
 * duplicate- and concurrency-guarded).
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const body = await readBody(context.request);
  const settings = await getSettings(db);
  const mode = body.forceMode === 'draft_both' ? 'draft_both' : settings.orchestration.mode;
  const title = String(body.topic || '').trim();

  if (settings.schedule.automationPaused && body.force !== true) {
    return json(null, 409, { error: 'Automation is paused. Resume scheduling before starting runs.', code: 'paused' });
  }
  if (!context.env.GITHUB_TOKEN) {
    return json(null, 409, { error: 'GITHUB_TOKEN not configured.', code: 'not-configured' });
  }
  if (title && settings.publishing.dedupe) {
    const dup = await findDuplicate(db, title);
    if (dup) return json(null, 409, { error: `Duplicate topic blocked — matches “${dup.job.title}”.`, code: 'duplicate' });
  }

  // Concurrency gate (counts across both engines).
  const maxConcurrent = settings.orchestration.maxConcurrency ?? 1;
  const active = (await listJobs(db, {})).filter((j) =>
    ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status)
    // Records with no update for 90+ min are stale (lost dispatch) — never block on them.
    && (Date.now() - (Date.parse(j.updatedAt || j.createdAt) || 0)) < 90 * 60 * 1000);
  const wanted = mode === 'draft_both' ? 2 : 1;
  if (active.length + wanted > Math.max(maxConcurrent, wanted)) {
    return json(null, 409, {
      error: `Concurrency limit reached (${maxConcurrent} active job(s) configured).`,
      code: 'concurrency-limit',
    });
  }

  const dispatch = async (engine, phase) => {
    if (settings.engines?.[engine]?.enabled === false) {
      throw Object.assign(new Error(`${engine} is disabled in Settings`), { code: 'engine-disabled' });
    }
    const slug = settings.github[engine]?.repo;
    const workflow = settings.github[engine]?.workflow;
    if (!slug || !workflow) throw Object.assign(new Error(`${engine} repository/workflow is not configured`), { code: 'not-configured' });
    const job = {
      id: uid('job'), engine, title: title || `${engine} orchestrated run`,
      topic: title || null, niche: body.niche || settings.defaults.niche || 'general',
      format: engine === 'gemini' ? 'long-form' : 'short',
      status: 'dispatched', stage: `Orchestrated (${mode})`, progress: null,
      description: `Dispatched by orchestrator (mode: ${mode}, phase: ${phase}).`,
      tags: mode === 'draft_both' ? ['Candidate'] : [], durationSec: null, thumbnail: null,
      createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
      youtubeId: null, youtubeUrl: null, error: null, errorCategory: null, errorRetryable: null,
      quality: buildQuality({ title: title || `${engine} run`, description: '', tags: [] }, {}),
      logs: [{ ts: new Date().toLocaleTimeString('en-GB'), level: 'info', msg: `orchestrate → ${engine} (mode=${mode}, phase=${phase})` }],
      runId: null, parentJobId: null, attempt: 1,
      publishBlocked: mode === 'draft_both' ? 'Draft mode — compare candidates before publishing.' : null,
      duplicateOf: null, demo: false,
    };
    await insertJob(db, job);
    try {
      await dispatchForJob({
        db, env: context.env, settings, job, phase,
        inputs: {
          ...(title ? { topic: title } : {}),
          privacy: settings.publishing.visibility,
          language: settings.defaults?.language || 'en',
          review_required: settings.publishing.reviewRequired ? '1' : '0',
          auto_publish: settings.publishing.autoPublish ? '1' : '0',
          title_override: title || '',
          ...(engine === 'verticals' ? { niche: String(body.niche || settings.defaults.niche || 'tech') } : {}),
        },
      });
    } catch (err) {
      const cat = classifyError(err.message);
      const { updateJob } = await import('../_lib/db.js');
      await updateJob(db, job.id, {
        status: 'failed', stage: 'Could not start',
        error: `GitHub workflow dispatch failed (${cat.category}): ${err.message}`,
        errorCategory: cat.category, errorRetryable: cat.retryable,
      });
      throw err;
    }
    return job;
  };

  try {
    if (mode === 'draft_both') {
      await dispatch('gemini', 'draft');
      await dispatch('verticals', 'draft');
      await addActivity(db, { icon: 'zap', tone: 'violet', title: 'Draft candidates dispatched', sub: 'Both engines — nothing auto-publishes' });
      return json(null, 202, {
        ok: true,
        message: 'Draft candidates dispatched to both engines. Nothing will auto-publish — pick a winner in the Content Queue.',
      });
    }
    // 'full' (generate+upload in one run) is only for automatic-publish mode;
    // under review-required the orchestrator runs draft-only production and the
    // console's publish gate handles uploads after approval.
    const autoAllowed = settings.publishing.autoPublish === true && settings.publishing.reviewRequired === false;
    const phase = autoAllowed ? 'full' : 'draft';
    if (mode === 'alternate') {
      const engine = settings.engines?.verticals?.enabled === true && new Date().getDate() % 2 === 0 ? 'verticals' : 'gemini';
      await dispatch(engine, phase);
      return json(null, 202, {
        ok: true,
        message: `Mode 2: dispatched ${engine} for today's alternating slot (${phase} phase).`,
      });
    }
    await dispatch('gemini', phase);
    return json(null, 202, {
      ok: true,
      message: `Mode 1: primary (Gemini Automation) dispatched (${phase} phase). Verticals v3 runs only if this attempt genuinely fails — never on slowness, and never after an upload.`,
    });
  } catch (err) {
    const cat = classifyError(err.message);
    return json(null, err.code === 'engine-disabled' ? 409 : 502, {
      error: `Orchestrated dispatch failed (${cat.category}): ${err.message}`,
      code: err.code || 'github',
    });
  }
}
