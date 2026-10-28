import { json, readBody, uid, nowIso } from '../../_lib/util.js';
import { getJob, updateJob, appendLog, insertJob, addActivity, getSettings } from '../../_lib/db.js';
import { findDuplicate, classifyError, buildQuality } from '../../_lib/safeguards.js';
import { splitRepo, dispatchWorkflow } from '../../_lib/github.js';

/**
 * POST /api/jobs/:id/regenerate — dispatch a NEW generation job linked to the
 * original (parent_job_id + attempt), preserving full attempt history instead
 * of wiping the original's state (audit defect: the old code overwrote status,
 * error and logs in place).
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const original = await getJob(db, context.params.id);
  if (!original) return json(null, 404, { error: 'Job not found.', code: 'not-found' });

  const settings = await getSettings(db);
  if (settings.schedule.automationPaused) {
    return json(null, 409, { error: 'Automation is paused. Resume scheduling before regenerating.', code: 'paused' });
  }
  const slug = settings.github[original.engine]?.repo;
  const workflow = settings.github[original.engine]?.workflow;
  if (!context.env.GITHUB_TOKEN || !slug) {
    return json(null, 409, { error: 'Engine not configured for dispatch.', code: 'not-configured' });
  }

  // A regeneration is an INTENTIONAL re-attempt of the same topic — dedupe
  // must not block it, but the active sibling attempt is superseded first.
  const child = {
    id: uid('job'), engine: original.engine,
    title: original.title, topic: original.topic || original.title,
    niche: original.niche, format: original.format,
    status: 'dispatched', stage: 'Regeneration dispatched', progress: null,
    description: original.description, tags: [...(original.tags || [])],
    durationSec: null, thumbnail: null,
    createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
    youtubeId: null, youtubeUrl: null, error: null,
    errorCategory: null, errorRetryable: null,
    quality: buildQuality(original, { oauthConfigured: false }),
    logs: [{
      ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
      msg: `Regeneration attempt ${(original.attempt || 1) + 1} — parent job ${original.id}`,
    }],
    runId: null, parentJobId: original.id, attempt: (original.attempt || 1) + 1,
    publishBlocked: null, duplicateOf: null, demo: false,
  };

  try {
    await dispatchWorkflow(context.env.GITHUB_TOKEN, {
      ...splitRepo(slug), workflowFile: workflow, ref: settings.github.branch || 'dypol-integration',
      inputs: {
        phase: 'draft', topic: child.topic, job_id: child.id,
        privacy: settings.publishing.visibility,
        title_override: child.title,
        description_override: (child.description || '').slice(0, 480),
      },
    });
  } catch (err) {
    const cat = classifyError(err.message);
    return json(null, 502, { error: `Regenerate dispatch failed (${cat.category}): ${err.message}`, code: 'github' });
  }

  await insertJob(db, child);
  if (!['published', 'rejected'].includes(original.status)) {
    await updateJob(db, original.id, { status: 'superseded', stage: `Superseded by attempt ${child.attempt}` });
  }
  await appendLog(db, original, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
    msg: `Regenerated as new attempt ${child.attempt} (job ${child.id}) — history preserved`,
  });
  await addActivity(db, { icon: 'refresh', tone: 'blue', title: 'Regeneration dispatched', sub: `${original.title} · attempt ${child.attempt}` });

  return json(null, 202, {
    ok: true, jobId: child.id, attempt: child.attempt,
    message: `Regeneration dispatched as attempt ${child.attempt}. The earlier attempt remains in history.`,
  });
}
