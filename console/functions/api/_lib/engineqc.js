/**
 * The engines' own draft verdict (4 Nov 2026): hard QC failures (off-topic script,
 * resolution, picture static > 3.5 s, true peak above -1 dBTP, …) make a draft
 * "needs_fixes". The draft is still saved and still waits in To check, but the
 * console shows a badge, lists the failed checks on the review sheet, and only
 * lets the reviewer approve after an explicit extra confirm (UI + server).
 *
 * Where the verdict lives:
 *   Long video + Short (gemini):  dypol-results/<draft run id>.json  { needs_fixes, quality: { verdict, hard_failures } }
 *   Short only (verticals):       dypol-drafts/<job id>.json         { needs_fixes, quality: { verdict, hard_failures } }
 *
 * Stored on the job as quality.engine = { state, label, verdict, failures, checkedAt }.
 */
import { fetchRepoFile, splitRepo, integrationRef } from './github.js';

export const NEEDS_FIXES = 'needs_fixes';
const MAX_FAILURES = 12;

/** Normalise an engine result/handoff JSON into { verdict, failures }. */
export function verdictFrom(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const q = doc.quality && typeof doc.quality === 'object' ? doc.quality : {};
  const failures = (Array.isArray(q.hard_failures) ? q.hard_failures : Array.isArray(doc.hard_failures) ? doc.hard_failures : [])
    .map((f) => String(f).slice(0, 300)).filter(Boolean).slice(0, MAX_FAILURES);
  const needs = doc.needs_fixes === true || q.verdict === NEEDS_FIXES || failures.length > 0;
  if (needs) return { verdict: NEEDS_FIXES, failures };
  if (q.verdict === 'ok' || doc.needs_fixes === false) return { verdict: 'ok', failures: [] };
  return null;
}

/** quality.engine entry for a verdict (null = engine did not report one). */
export function engineCheck(v, now = new Date().toISOString()) {
  if (!v) return { state: 'skipped', label: 'Not reported by the video maker', verdict: 'not_checked', failures: [], checkedAt: now };
  if (v.verdict === NEEDS_FIXES) {
    const n = v.failures.length;
    return { state: 'failed', label: `Needs fixes — ${n || 'some'} automatic check${n === 1 ? '' : 's'} failed`, verdict: NEEDS_FIXES, failures: v.failures, checkedAt: now };
  }
  return { state: 'ok', label: 'All automatic checks passed', verdict: 'ok', failures: [], checkedAt: now };
}

export const needsFixes = (job) => job?.quality?.engine?.verdict === NEEDS_FIXES;

/** Read the engine's verdict for a job from its repo. Never throws (null on any problem). */
export async function readEngineVerdict(env, settings, job) {
  try {
    if (!env?.GITHUB_TOKEN || !job) return null;
    const slug = settings?.github?.[job.engine]?.repo;
    if (!slug) return null;
    const gh = splitRepo(slug);
    const ref = integrationRef(settings);
    let path = null;
    if (job.engine === 'verticals') path = `dypol-drafts/${job.id}.json`;
    else if (job.runId && /^\d+$/.test(String(job.runId))) path = `dypol-results/${job.runId}.json`;
    if (!path || !/^[A-Za-z0-9._/-]+$/.test(path)) return null;
    const raw = await fetchRepoFile(env.GITHUB_TOKEN, { ...gh, path, ref });
    if (!raw) return null;
    return verdictFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** quality with quality.engine refreshed from the repo (keeps every other check). */
export async function withEngineCheck(env, settings, job) {
  const v = await readEngineVerdict(env, settings, job);
  return { ...(job.quality || {}), engine: engineCheck(v) };
}

/** True when a waiting draft has no engine verdict stored yet (or only a "not reported" one older than 10 min,
 *  since the result file can land a little after the run finishes). */
export function wantsEngineCheck(job, now = Date.now()) {
  if (!job || !['needs-review', 'awaiting-review'].includes(job.status)) return false;
  const e = job.quality?.engine;
  if (!e) return true;
  if (e.verdict !== 'not_checked') return false;
  const at = Date.parse(e.checkedAt || '') || 0;
  return now - at > 10 * 60e3 && now - (Date.parse(job.updatedAt || '') || 0) < 3 * 24 * 3600e3;
}
