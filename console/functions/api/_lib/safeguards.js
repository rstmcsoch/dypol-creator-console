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
import { findUploadByKey, recordUpload, capUsage, listJobs, updateJob, addActivity } from './db.js';

/** Returns {key, norm, job, exact} or null. `exclude`: a job id or a list of
 *  ids (a job's lineage) that never count as duplicates of it. */
export async function findDuplicate(db, title, exclude = null) {
  const key = await topicKey(title);
  const norm = normalizeTopic(title);
  const skip = new Set([].concat(exclude || []).filter(Boolean));
  const candidates = await listJobs(db, {});
  for (const j of candidates) {
    if (skip.has(j.id)) continue;
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
  if (pub.reviewRequired && !['approved', 'scheduled', 'publish_failed'].includes(job.status)) {
    return { ok: false, code: 'review-required', error: 'Publishing blocked — review-required mode is on. Approve the video first.' };
  }
  if (pub.dedupe) {
    const dup = await findDuplicate(db, job.title, job.id);
    if (dup) {
      return { ok: false, code: 'duplicate', error: `Publishing blocked — duplicate of “${dup.job.title}” (key ${dup.key}).` };
    }
  }
  const usage = await capUsage(db);
  if (usage.total >= pub.dailyCap) {
    return {
      ok: false, code: 'daily-cap',
      error: `Daily publishing cap reached (${pub.dailyCap}/day, resets 05:30 IST): ${usage.published} published today`
        + (usage.uploading ? `, ${usage.uploading} uploading` : '') + '.',
    };
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
export function buildQuality(job, { oauthConfigured = false, hasArtifact = null, durationKnown = null, engineVerifiedAt = null } = {}) {
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
    // YouTube OAuth lives in the ENGINE repo secrets, not in the console, so
    // the console can only report what a real upload proved.
    oauth: engineVerifiedAt
      ? { state: 'ok', label: `Verified by last successful upload (${String(engineVerifiedAt).slice(0, 10)})` }
      : oauthConfigured
        ? { state: 'warn', label: 'Configured (not tested)' }
        : { state: 'skipped', label: 'Held by the engine — verified when an upload succeeds' },
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
export async function findUploadEvidence(token, gh, job, { runIds = [] } = {}) {
  const { fetchRunResult, listRunArtifacts, downloadArtifact } = await import('./github.js');
  const { extractFirstEntry } = await import('./ziputil.js');
  // Only the job's own PUBLISH runs can carry its upload result. Each is read
  // by exact path (dypol-results/<run_id>.json on dypol-integration) — never a
  // capped directory listing.
  const ids = [...new Set([job.publishRunId, ...runIds].filter(Boolean).map(String))];
  for (const runId of ids) {
    try {
      const res = await fetchRunResult(token, { ...gh, runId });
      if (res && res.job_id === job.id && res.youtube_id) return { ...res, run_id: res.run_id || runId };
    } catch { /* unreadable — try the artifact */ }
    // Artifact backup (covers "upload succeeded but the result commit failed").
    try {
      const artifacts = await listRunArtifacts(token, { ...gh, runId });
      const backup = artifacts.find((a) => a.name === `upload-result-${runId}`);
      if (backup) {
        const zip = await downloadArtifact(token, { ...gh, artifactId: backup.id });
        const entry = await extractFirstEntry(zip, '.json');
        if (entry) {
          const res = JSON.parse(new TextDecoder().decode(entry.bytes));
          if (res && res.job_id === job.id && res.youtube_id) return { ...res, run_id: res.run_id || runId };
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
  const videos = (extra.videos && extra.videos.length ? extra.videos : [{ kind: job.format === 'short' ? 'short' : 'long', youtube_id: youtubeId }])
    .filter((v) => v && v.youtube_id)
    .map((v) => ({ kind: v.kind || 'video', youtube_id: v.youtube_id, youtube_url: v.youtube_url || `https://youtu.be/${v.youtube_id}` }));
  await updateJob(db, job.id, {
    status: 'published', stage: 'Published on YouTube', progress: 100,
    publishedAt: extra.publishedAt || nowIso(), youtubeId, youtubeUrl: extra.url || `https://youtu.be/${youtubeId}`,
    videos, uploadingSince: null, publishBlocked: null,
    error: null, errorCategory: null, errorRetryable: null, errorLog: null,
    ...(extra.publishRunId ? { publishRunId: String(extra.publishRunId) } : {}),
  });
  const extraIds = (extra.videos || []).filter((v) => v.youtube_id && v.youtube_id !== youtubeId);
  await addActivity(db, { icon: 'upload', tone: 'green', title: 'Video uploaded', sub: job.title });
  return extraIds;
}

/* ---------------- Error taxonomy (P2: categories + retryability) ---------------- */
/* Run-failure categories shown to the reviewer (from the failed job's log). */
export const FAILURE_CATEGORIES = {
  setup_failed: 'Setup failed',
  handoff: 'Saving the draft failed',
  llm_unavailable: 'AI model unavailable (temporary)',
  content_gate: 'Blocked by the name check',
  asset: 'Visuals / voice asset problem',
  render: 'Video render failed',
  publish: 'YouTube upload failed',
  unknown: 'Unclassified failure',
};

/** The category an engine logged itself (last DYPOL_FAILURE_CATEGORY=<cat> line), if known. */
export function loggedCategory(text) {
  const all = [...String(text || '').matchAll(/DYPOL_FAILURE_CATEGORY=([a-z_]+)/g)];
  const c = all.length ? all[all.length - 1][1] : null;
  return c && FAILURE_CATEGORIES[c] ? c : null;
}

/**
 * Category + plain label from the failed step's NAME (used when the engine
 * logged no DYPOL_FAILURE_CATEGORY line). Generic steps ("Run DYPOL
 * phase-aware production pipeline", "Generate a draft without uploading")
 * return null so the log text decides.
 */
export function classifyByStep(stepName) {
  const s = String(stepName || '').toLowerCase().replace(/[^a-z0-9 +./_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const r = (category, label) => ({ category, label, retryable: true });
  if (/checkout/.test(s)) return r('setup_failed', 'Setup failed: checkout');
  if (/install|dependenc|requirements|\bpip\b|\bapt\b|fonts?\b/.test(s)) return r('setup_failed', 'Setup failed: dependency install');
  if (/set ?up python|setup-python|virtualenv|whisper model|kokoro model|cache/.test(s)) return r('setup_failed', 'Setup failed: tool setup');
  if (/compile|preflight|validate dypol job id|validate publish handoff|restore youtube oauth/.test(s)) return r('setup_failed', 'Setup failed: preflight checks');
  if (/personal names|name gate|name check|names? in/.test(s)) return r('content_gate', FAILURE_CATEGORIES.content_gate);
  if (/(upload|publish|post).*(youtube|video to)|youtube upload|^publish|uploader/.test(s) && !/artifact|debug|preview/.test(s)) {
    return r('publish', FAILURE_CATEGORIES.publish);
  }
  if (/render|ffmpeg|encode|assembl|preview cop|demo gif/.test(s)) return r('render', FAILURE_CATEGORIES.render);
  if (/artifact|candidate|handoff|commit|save draft|durable/.test(s)) return r('handoff', FAILURE_CATEGORIES.handoff);
  if (/gemini|\bllm\b|lesson|write (the )?script|generate (the )?(script|content|lesson)/.test(s)) return r('llm_unavailable', FAILURE_CATEGORIES.llm_unavailable);
  return null;
}

/** Classify a failed run from its step name + log tail. phase: 'draft'|'publish'. */
export function classifyFailure(text, phase = 'draft') {
  // Repo names/paths contain "gemini" and "youtube" — remove them first.
  const m = String(text || '').toLowerCase()
    .replace(/gemini-youtube-automation|youtube-shorts-pipeline/g, '');
  if (/name gate|personal[- ]name|validate_no_personal_names|name_gate|names? check/.test(m)) {
    return { category: 'content_gate', retryable: true };
  }
  if (phase === 'publish') return { category: 'publish', retryable: true };
  if (/videos\.insert|invalid_grant|quotaexceeded|uploadlimitexceeded|insufficientpermissions|youtube data api|youtube upload/.test(m)) {
    return { category: 'publish', retryable: true };
  }
  if (/\b503\b|unavailable|server disconnected|remoteprotocolerror|overloaded|high demand|resource_exhausted|deadline exceeded|failed to generate|generativelanguage|\b500 internal/.test(m)) {
    return { category: 'llm_unavailable', retryable: true };
  }
  if (/ffmpeg|moviepy|render|encoder|pillow|valueerror: x1|imageio|libx264|composit/.test(m)) {
    return { category: 'render', retryable: true };
  }
  if (/pixabay|flux|workers ai|neurons|kokoro|\btts\b|b-?roll|stock (clip|image|video)|image generation|download(ing)? (clip|image)/.test(m)) {
    return { category: 'asset', retryable: true };
  }
  return { category: 'unknown', retryable: true };
}

export const ERROR_CATEGORIES = {
  github_unavailable: 'GitHub temporarily unavailable',
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
  // Repo names/paths contain "youtube" and "gemini" — never classify on them
  // (a GitHub 500 on .../gemini-youtube-automation/... used to read as "Upload rejected").
  const m = String(message || '').toLowerCase()
    .replace(/[\w.-]*\/?(gemini-youtube-automation|youtube-shorts-pipeline)[\w./-]*/g, ' ');
  if (m.includes('unexpected inputs')) return { category: 'dispatch', retryable: false };
  if (/temporarily unavailable|github api 5\d\d|http 5\d\d|\b50[0-4]\b.*github|server error|network error/.test(m)) {
    return { category: 'github_unavailable', retryable: true };
  }
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
