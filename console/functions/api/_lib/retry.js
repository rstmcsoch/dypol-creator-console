/**
 * retryJob — the ONE retry path for every Retry button:
 *   POST /api/jobs/:id/retry, POST /api/runs/:id/retry, POST /api/engines/:engine/retry
 *
 * A retry is a FRESH workflow_dispatch on dypol-integration (never
 * "re-run failed jobs", which replays the old commit so fixes never apply).
 * The new GitHub run is linked to the SAME job (dispatchForJob writes the run
 * row first and stores the run id), the same inputs are resent (stored on the
 * previous run row, incl. reviewer_feedback; policy fields — privacy,
 * review_required, auto_publish — always come from current settings), and
 * each job may be retried at most MAX_RETRIES times (jobs.retry_count).
 *
 * Guards (read-only; no publish lock is taken on this path):
 *   · upload guard — the job's topic already on YouTube: from this job →
 *     recorded as published, no dispatch; from an earlier attempt in the same
 *     lineage (parent chain) → nothing to retry; from an unrelated job → blocked.
 *   · duplicate guard — another active/finished job with the same topic blocks,
 *     except jobs in this job's own lineage (the job itself and its parents).
 * A failed UPLOAD (publish_failed) is retried only from the video drawer
 * (allowPublish), through the normal publish path with its own safeguards.
 */
import { nowIso, topicKey } from './util.js';
import {
  getJob, updateJob, appendLog, addActivity, runsForJob, findUploadByKey,
} from './db.js';
import { findDuplicate, recordPublished, classifyError } from './safeguards.js';
import { dispatchForJob, buildDraftInputs } from './jobflow.js';

export const MAX_RETRIES = 2;
const RETRYABLE = ['failed', 'cancelled'];
const ts = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
const out = (status, body) => ({ status, body });

/** The job's id plus every parent id (Redo chain), newest first. */
export async function lineageIds(db, job) {
  const ids = [job.id];
  let cur = job;
  for (let i = 0; i < 10 && cur?.parentJobId; i++) {
    if (ids.includes(cur.parentJobId)) break;
    ids.push(cur.parentJobId);
    cur = await getJob(db, cur.parentJobId);
  }
  return ids;
}

/** Feedback text saved on a Redo child ("Feedback from previous attempt: …"). */
function feedbackFromNote(note) {
  const m = /^Feedback from previous attempt:\s*([\s\S]+)$/.exec(String(note || ''));
  return m ? m[1].trim() : '';
}

/** Inputs for the retry: the last draft dispatch's stored inputs, else rebuilt from the job. */
export async function retryInputs(db, settings, job) {
  const rows = await runsForJob(db, job.id, 'draft');
  const prev = rows.find((r) => r.inputs && typeof r.inputs === 'object' && Object.keys(r.inputs).length);
  const policy = buildDraftInputs(settings, job.engine, {});
  if (prev) {
    const { phase: _p, job_id: _j, draft_run_id: _d, ...rest } = prev.inputs;
    return {
      inputs: {
        ...rest,
        privacy: policy.privacy, review_required: policy.review_required, auto_publish: policy.auto_publish,
      },
      from: 'stored',
    };
  }
  return {
    inputs: buildDraftInputs(settings, job.engine, {
      topic: job.topic || job.title, niche: job.niche,
      reviewerFeedback: feedbackFromNote(job.reviewNote),
    }),
    from: 'rebuilt',
  };
}

export async function retryJob({ db, env, settings, job, source = 'job', allowPublish = false }) {
  if (!job) return out(404, { error: 'Job not found.', code: 'not-found' });

  if (job.status === 'publish_failed') {
    if (!allowPublish) {
      return out(409, {
        error: 'This was a failed upload. Retry it from the video’s drawer — it confirms first and checks YouTube so nothing uploads twice.',
        code: 'publish-retry-from-drawer',
      });
    }
    const { publishJob } = await import('./publish.js');
    return publishJob(db, env, settings, job);
  }
  if (!RETRYABLE.includes(job.status)) {
    return out(409, { error: 'Only failed or cancelled runs can be retried. Use Redo for a new attempt.', code: 'state' });
  }
  const used = Number(job.retryCount || 0);
  if (used >= MAX_RETRIES) {
    return out(409, {
      error: `Retry limit reached (${MAX_RETRIES} retries for this video). Use Redo for a deliberate new attempt.`,
      code: 'retry-limit', retryCount: used,
    });
  }
  if (settings.engines?.[job.engine]?.enabled === false) {
    return out(409, { error: 'This engine is disabled in Settings. Enable it before retrying.', code: 'engine-disabled' });
  }
  if (settings.schedule?.automationPaused) {
    return out(409, { error: 'Automation is paused. Resume scheduling before retrying.', code: 'paused' });
  }

  // ---- Upload guard (lineage-aware, read-only) ----
  const lineage = await lineageIds(db, job);
  const uploaded = await findUploadByKey(db, await topicKey(job.title));
  if (uploaded) {
    if (uploaded.job_id === job.id) {
      await recordPublished(db, job, uploaded.youtube_id);
      await appendLog(db, await getJob(db, job.id), {
        ts: ts(), level: 'warn', msg: `Retry not sent — this video is already on YouTube (${uploaded.youtube_id}).`,
      });
      return out(200, { ok: true, message: `Already on YouTube (id ${uploaded.youtube_id}) — recorded, nothing re-run.` });
    }
    return out(409, lineage.includes(uploaded.job_id)
      ? { error: `An earlier attempt of this video (job ${uploaded.job_id}) is already on YouTube — nothing to retry.`, code: 'already-uploaded' }
      : { error: `Blocked — this topic is already on YouTube from another video (job ${uploaded.job_id}).`, code: 'duplicate' });
  }
  // ---- Duplicate guard (same job / parent chain exempt) ----
  if (settings.publishing?.dedupe !== false) {
    const dup = await findDuplicate(db, job.title, lineage);
    if (dup) {
      return out(409, {
        error: `Duplicate topic — “${job.title}” matches “${dup.job.title}” (${dup.job.status}).`,
        code: 'duplicate', duplicateOf: { id: dup.job.id, title: dup.job.title },
      });
    }
  }

  const { inputs, from } = await retryInputs(db, settings, job);
  const previousRunId = job.runId || null;
  await updateJob(db, job.id, {
    status: 'dispatched', stage: `Retry ${used + 1}/${MAX_RETRIES} sent to engine`, progress: null,
    error: null, errorCategory: null, errorRetryable: null, errorLog: null, retryCount: used + 1,
  });

  let res;
  try {
    res = await dispatchForJob({ db, env, settings, job: await getJob(db, job.id), phase: 'draft', inputs });
  } catch (err) {
    const cat = classifyError(err.message);
    // A refused dispatch does not consume a retry.
    await updateJob(db, job.id, {
      status: 'failed', stage: 'Could not start', retryCount: used,
      error: `Retry could not start (${cat.category}): ${err.message}`, errorCategory: cat.category, errorRetryable: cat.retryable,
    });
    await appendLog(db, await getJob(db, job.id), { ts: ts(), level: 'error', msg: `Retry dispatch failed: ${err.message}` });
    return out(502, { error: `Retry could not start: ${err.message}`, code: 'github', category: cat.category, retryable: cat.retryable });
  }
  if (!res.ghRunId) await updateJob(db, job.id, { runId: null }); // linked by webhook/reconcile
  const sentFeedback = !!res.sent?.reviewer_feedback;
  await appendLog(db, await getJob(db, job.id), {
    ts: ts(), level: 'info',
    msg: `Retry ${used + 1}/${MAX_RETRIES} (${source}): fresh workflow_dispatch on dypol-integration`
      + `${res.ghRunId ? ` → GitHub run ${res.ghRunId}` : ''}${previousRunId ? ` (previous run ${previousRunId})` : ''}`
      + ` · inputs ${from}${sentFeedback ? ' incl. reviewer feedback' : ''}`
      + (res.stripped?.length ? ` · not declared, not sent: ${res.stripped.join(', ')}` : ''),
  });
  await addActivity(db, { icon: 'refresh', tone: 'blue', title: 'Retry started', sub: `${job.title} · retry ${used + 1}/${MAX_RETRIES}` });
  return out(202, {
    ok: true, jobId: job.id, runId: res.runRowId, ghRunId: res.ghRunId || null, retryCount: used + 1,
    message: `Retry ${used + 1}/${MAX_RETRIES} started as a fresh run on the latest code${res.ghRunId ? ` (GitHub run ${res.ghRunId})` : ''}.`,
    at: nowIso(),
  });
}
