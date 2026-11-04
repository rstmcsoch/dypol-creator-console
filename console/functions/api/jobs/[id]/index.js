import { json, readBody, nowIso } from '../../_lib/util.js';
import { getJob, getSettings, updateJob, appendLog, addActivity } from '../../_lib/db.js';
import { findDuplicate, checkPublishGate, buildQuality } from '../../_lib/safeguards.js';
import { pendingDeletions } from '../../_lib/deletejob.js';
import { wantsEngineCheck, withEngineCheck } from '../../_lib/engineqc.js';

/**
 * GET /api/jobs/:id — full review-panel payload.
 * AUDIT FIX: uses the READ-ONLY checkPublishGate (the old code acquired the
 * publish lock from a GET handler and could block real publishes).
 */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });

  const settings = await getSettings(db);
  if (wantsEngineCheck(job)) {
    // Drafts made before the console read engine verdicts: look once, then keep it.
    const quality = await withEngineCheck(context.env, settings, job);
    await updateJob(db, job.id, { quality }).catch(() => {});
    job.quality = quality;
  }
  if (settings.publishing.dedupe) {
    const dup = await findDuplicate(db, job.title, job.id);
    job.duplicateOf = dup ? { key: dup.key, id: dup.job.id, title: dup.job.title, url: dup.job.youtubeUrl } : null;
  }
  const gate = await checkPublishGate(db, job, settings);
  job.publishBlocked = gate.ok ? null : gate.error;

  // Honest quality checks (computed, not hardcoded).
  const lastUp = await db.prepare("SELECT published_at FROM jobs WHERE engine = ? AND status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1")
    .bind(job.engine).first().catch(() => null);
  job.quality = {
    ...buildQuality(job, {
      engineVerifiedAt: lastUp?.published_at || null,
      hasArtifact: job.status === 'published' ? true : null,
      durationKnown: job.durationSec ? true : null,
    }),
    ...(job.quality?.duplicate?.state === 'failed' ? { duplicate: job.quality.duplicate } : {}),
    ...(job.quality?.narration && job.quality.narration.source ? { narration: job.quality.narration } : {}),
    ...(job.quality?.engine ? { engine: job.quality.engine } : {}),
  };

  const deleting = await pendingDeletions(db);
  if (deleting.has(job.id)) job.deletion = deleting.get(job.id);
  return json(null, 200, { job, mode: 'live' });
}

/**
 * PATCH /api/jobs/:id — metadata edits from the review panel.
 * Edits are persisted and ARE the metadata sent to YouTube on publish
 * (publish dispatch passes title/description/tags as workflow inputs).
 */
export async function onRequestPatch(context) {
  const db = context.env.DB;
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  if (job.status === 'published') {
    return json(null, 409, { error: 'Published videos cannot be edited.', code: 'state' });
  }
  const body = await readBody(context.request);
  const patch = {};
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 100) return json(null, 400, { error: 'Title must be 1–100 characters (YouTube limit).', code: 'validation' });
    patch.title = t;
  }
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 5000);
  if (Array.isArray(body.tags)) patch.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);

  await updateJob(db, job.id, patch);
  await appendLog(db, job, {
    ts: new Date().toLocaleTimeString('en-GB'), level: 'info',
    msg: 'Metadata edited in review panel — will be used for publishing',
  });
  await addActivity(db, { icon: 'doc', tone: 'blue', title: 'Metadata updated', sub: patch.title || job.title, jobId: job.id });
  return json(null, 200, { ok: true, job: await getJob(db, job.id), message: 'Metadata saved and will be used when publishing.' });
}
