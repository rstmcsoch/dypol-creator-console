/**
 * Publishing safeguards: duplicate prevention, publishing lock, daily cap,
 * upload-state verification (anti double-upload), idempotency, and honest
 * quality-check computation.
 *
 * AUDIT FIX (P1): the read path used to call publishGate() from GET handlers,
 * which ACQUIRED the publish lock as a side effect and could block a real
 * publish for the lock TTL. Reads now use checkPublishGate() (lock-free);
 * only POST /publish takes the lock, and the caller releases it explicitly.
 */
import { topicKey, normalizeTopic, nowIso, TZ, uid } from './util.js';
import { findUploadByKey, recordUpload, uploadsOnDate, listJobs, updateJob, addActivity } from './db.js';

/** Returns {key, norm, job, exact} or null. */
export async function findDuplicate(db, title, excludeJobId = null) {
  const key = await topicKey(title);
  const norm = normalizeTopic(title);
  const candidates = await listJobs(db, {});
  for (const j of candidates) {
    if (j.id === excludeJobId) continue;
    if (['rejected', 'failed', 'cancelled', 'superseded'].includes(j.status)) continue;
    const k2 = await topicKey(j.title);
    if (k2 === key) return { key, norm, job: j, exact: true };
    const n2 = normalizeTopic(j.title);
    if (norm.length > 12 && n2.length > 12 && (norm.includes(n2) || n2.includes(norm))) {
      return { key, norm, job: j, exact: false };
    }
  }
  return null;
}

/* ---------------- Publishing lock (atomic D1 INSERT) ---------------- */
export async function acquireLock(db, name, ttlMs = 60000) {
  await db.prepare('DELETE FROM locks WHERE expires_at < ?').bind(Date.now()).run();
  try {
    await db.prepare('INSERT INTO locks (name, expires_at) VALUES (?, ?)')
      .bind(name, Date.now() + ttlMs).run();
    return true;
  } catch {
    return false; // unique violation — lock held
  }
}

export async function releaseLock(db, name) {
  await db.prepare('DELETE FROM locks WHERE name = ?').bind(name).run();
}

export function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

export const uploadIdempotencyKey = (title, jobId) => `${jobId || 'x'}:${(title || '').toLowerCase().slice(0, 80)}`;

/**
 * READ-ONLY publish state for the review panel. Never takes the lock.
 * Returns { code, ok, error?, message?, youtubeId? }.
 */
export async function checkPublishGate(db, job, settings) {
  const pub = settings.publishing;

  const key = await topicKey(job.title);
  const existing = await findUploadByKey(db, key);
  if (existing) {
    return {
      ok: true, code: 'already-uploaded', youtubeId: existing.youtube_id,
      message: `Upload state verified — already on YouTube (id ${existing.youtube_id}). No duplicate upload performed.`,
    };
  }
  if (job.status === 'published') {
    return { ok: true, code: 'already-published', message: 'Already published — no further action taken.' };
  }
  if (pub.draftMode) {
    return { ok: false, code: 'draft-mode', error: 'Draft-only mode is on — generation results are saved but nothing uploads.' };
  }
  if (pub.reviewRequired && !['approved', 'scheduled'].includes(job.status)) {
    return { ok: false, code: 'review-required', error: 'Publishing blocked — review-required mode is on. Approve the video first.' };
  }
  if (pub.dedupe) {
    const dup = await findDuplicate(db, job.title, job.id);
    if (dup) {
      return { ok: false, code: 'duplicate', error: `Publishing blocked — duplicate of “${dup.job.title}” (key ${dup.key}).` };
    }
  }
  const n = await uploadsOnDate(db, todayStr());
  const inflight = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'uploading'").first();
  if (n + Number(inflight?.n || 0) >= pub.dailyCap) {
    return { ok: false, code: 'daily-cap', error: `Daily publishing cap reached (${pub.dailyCap}/day, IST).` };
  }
  return { ok: true, code: 'cleared', key };
}

/**
 * FULL publish gate — acquires the publishing lock. The CALLER must release it
 * (finally { await releaseLock(db, 'publish') }). Used only by POST /publish.
 */
export async function publishGate(db, job, settings) {
  const pub = settings.publishing;
  let lockHeld = false;
  if (pub.publishLock) {
    lockHeld = await acquireLock(db, 'publish', 45000);
    if (!lockHeld) {
      return { ok: false, code: 'locked', error: 'Another publish is in progress (publishing lock held). Try again shortly.' };
    }
  }
  const state = await checkPublishGate(db, job, settings);
  return { ...state, lockHeld };
}

/**
 * Honest quality checks. Only checks the system can genuinely verify are
 * marked ok; everything else is 'skipped' (labelled for human review) or
 * 'pending'. Copyright / factual accuracy are NEVER auto-passed.
 */
export function buildQuality(job, { oauthConfigured = false, hasArtifact = null, durationKnown = null } = {}) {
  const titleLen = String(job.title || '').length;
  const hasMeta = !!(job.description || '').trim() || (job.tags || []).length > 0;
  return {
    title: { state: titleLen > 0 && titleLen <= 100 ? 'ok' : 'failed', label: `${titleLen}/100 chars` },
    metadata: { state: hasMeta ? 'ok' : 'warn', label: hasMeta ? 'Present' : 'Missing description/tags' },
    artifact: hasArtifact === null ? { state: 'skipped', label: 'Not verified yet' }
      : hasArtifact ? { state: 'ok', label: 'Output file present' }
      : { state: 'failed', label: 'No output artifact' },
    duration: durationKnown === null ? { state: 'skipped', label: 'Unknown — check after render' }
      : durationKnown ? { state: 'ok', label: 'Duration > 0' }
      : { state: 'failed', label: 'Zero/unknown duration' },
    duplicate: { state: 'skipped', label: 'Checked at publish time' },
    oauth: oauthConfigured
      ? { state: 'warn', label: 'Configured (not tested)' }
      : { state: 'failed', label: 'Not configured' },
    review: ['approved', 'scheduled', 'published'].includes(job.status)
      ? { state: 'ok', label: 'Approved' }
      : { state: 'pending', label: 'Awaiting review' },
    rights: { state: 'skipped', label: 'Human review required' },
  };
}

/* ---------------- Upload-evidence verification (anti blind-retry) ---------------- */

/**
 * Look for a VERIFIED upload result for a job when the console has no record:
 *   1. dypol-results/*.json committed in the engine fork (primary),
 *   2. upload-result-<run>.zip workflow artifact (backup when the commit failed).
 * Returns the result object {job_id, youtube_id, videos[], ...} or null.
 * Never uploads anything; read-only against GitHub.
 */
export async function findUploadEvidence(token, gh, job) {
  const { listRepoDir, fetchRepoFile, listRunArtifacts, downloadArtifact } = await import('./github.js');
  const { extractFirstEntry } = await import('./ziputil.js');

  // 1. Committed result files.
  try {
    const files = await listRepoDir(token, { ...gh, path: 'dypol-results' });
    for (const f of files.slice(0, 30)) {
      if (!f.name.endsWith('.json')) continue;
      const raw = await fetchRepoFile(token, { ...gh, path: f.path });
      if (!raw) continue;
      try {
        const res = JSON.parse(raw);
        if (res && res.job_id === job.id && res.youtube_id) return res;
      } catch { /* skip malformed */ }
    }
  } catch { /* repo unreadable — fall through to artifacts */ }

  // 2. Artifact backup (covers "upload succeeded but the result commit failed").
  if (job.runId) {
    try {
      const artifacts = await listRunArtifacts(token, { ...gh, runId: job.runId });
      const backup = artifacts.find((a) => a.name === `upload-result-${job.runId}`);
      if (backup) {
        const zip = await downloadArtifact(token, { ...gh, artifactId: backup.id });
        const entry = await extractFirstEntry(zip, '.json');
        if (entry) {
          const res = JSON.parse(new TextDecoder().decode(entry.bytes));
          if (res && (res.job_id === job.id || !res.job_id) && res.youtube_id) return res;
        }
      }
    } catch { /* artifact expired or unreachable */ }
  }
  return null;
}

/** Called after a verified upload result (from the engine's upload_result file). */
export async function recordPublished(db, job, youtubeId, extra = {}) {
  const key = await topicKey(job.title);
  await recordUpload(db, {
    topicKey: key, youtubeId, jobId: job.id,
    idempotencyKey: uploadIdempotencyKey(job.title, job.id),
  });
  // Multi-video (Engine A long + Short): record EVERY video separately so the
  // second upload never overwrites the first. Each gets its own uploads row.
  for (const v of extra.videos || []) {
    if (!v.youtube_id || v.youtube_id === youtubeId) continue;
    await recordUpload(db, {
      topicKey: `${key}:${v.kind || v.youtube_id}`,
      youtubeId: v.youtube_id, jobId: job.id,
      idempotencyKey: `${uploadIdempotencyKey(job.title, job.id)}:${v.kind || v.youtube_id}`,
    }).catch(() => {});
  }
  await updateJob(db, job.id, {
    status: 'published', stage: 'Upload complete', progress: 100,
    publishedAt: nowIso(), youtubeId, youtubeUrl: extra.url || `https://youtu.be/${youtubeId}`,
  });
  const extraIds = (extra.videos || []).filter((v) => v.youtube_id && v.youtube_id !== youtubeId);
  await addActivity(db, { icon: 'upload', tone: 'green', title: 'Video uploaded', sub: job.title });
  return extraIds;
}

/* ---------------- Error taxonomy (P2: categories + retryability) ---------------- */
export const ERROR_CATEGORIES = {
  dispatch: 'Dispatch failure',
  config: 'Missing configuration',
  permission: 'Permission denied',
  quota: 'Provider quota exceeded',
  provider: 'AI provider error',
  timeout: 'Timeout',
  render: 'Rendering failure',
  dependency: 'Dependency installation failure',
  oauth: 'YouTube authorisation failure',
  upload: 'Upload rejection',
  db: 'Persistence error',
  unknown: 'Unclassified',
};

export function classifyError(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('workflow_dispatch') || m.includes('dispatch failed') || m.includes('404') && m.includes('workflow')) return { category: 'dispatch', retryable: true };
  if (m.includes('not configured') || m.includes('missing')) return { category: 'config', retryable: false };
  if (m.includes('403') || m.includes('permission') || m.includes('bad credentials')) return { category: 'permission', retryable: false };
  if (m.includes('429') || m.includes('quota') || m.includes('rate limit')) return { category: 'quota', retryable: true };
  if (m.includes('oauth') || m.includes('refresh token') || m.includes('unauthorized') || m.includes('401')) return { category: 'oauth', retryable: false };
  if (m.includes('ffmpeg') || m.includes('render') || m.includes('moviepy')) return { category: 'render', retryable: true };
  if (m.includes('pip install') || m.includes('dependency')) return { category: 'dependency', retryable: true };
  if (m.includes('upload') || m.includes('youtube')) return { category: 'upload', retryable: true };
  if (m.includes('timeout') || m.includes('timed out')) return { category: 'timeout', retryable: true };
  if (m.includes('gemini') || m.includes('model')) return { category: 'provider', retryable: true };
  return { category: 'unknown', retryable: true };
}
