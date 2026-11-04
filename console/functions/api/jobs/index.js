import { json, readBody, uid, nowIso, topicKey } from '../_lib/util.js';
import { listJobs, insertJob, addActivity, getSettings, capUsage, updateJob } from '../_lib/db.js';
import { findDuplicate } from '../_lib/safeguards.js';
import { backgroundReconcile } from '../_lib/jobflow.js';
import { pendingDeletions } from '../_lib/deletejob.js';
import { wantsEngineCheck, withEngineCheck } from '../_lib/engineqc.js';

/** GET /api/jobs — searchable, filterable queue. */
export const ALL_STATUSES = ['queued', 'dispatched', 'running', 'generating', 'rendering', 'needs-review',
  'awaiting-review', 'approved', 'scheduled', 'uploading', 'published', 'failed', 'publish_failed', 'cancelled',
  'rejected', 'superseded'];

export async function onRequestGet(context) {
  const db = context.env.DB;
  const q = new URL(context.request.url).searchParams;
  backgroundReconcile(context); // throttled stale-job check (never blocks the list)
  const jobs = await listJobs(db, {
    status: q.get('status') || undefined,
    engine: q.get('engine') || undefined,
    type: q.get('type') || undefined,
    niche: q.get('niche') || undefined,
    since: q.get('since') || undefined,
    q: q.get('q') || undefined,
    sort: q.get('sort') || 'newest',
  });
  const all = await listJobs(db, {});
  const counts = { all: all.length };
  for (const s of ALL_STATUSES) counts[s] = all.filter((j) => j.status === s).length;
  // Any comma-joined chip key the UI asks for is the sum of its statuses.
  counts.byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, counts[s]]));
  counts['needs-review'] = all.filter((j) => ['needs-review', 'awaiting-review'].includes(j.status)).length;
  counts['generating,dispatched,running'] = all.filter((j) => ['generating', 'dispatched', 'running'].includes(j.status)).length;
  counts['generating,rendering,uploading,queued'] = all.filter((j) => ['generating', 'rendering', 'uploading', 'queued', 'dispatched', 'running'].includes(j.status)).length;
  const settings = await getSettings(db);
  // Engine verdicts for waiting drafts that don't have one yet (a few per load, in parallel).
  const todo = jobs.filter((j) => wantsEngineCheck(j)).slice(0, 6);
  if (todo.length) {
    await Promise.all(todo.map(async (j) => {
      const quality = await withEngineCheck(context.env, settings, j);
      j.quality = quality;
      await updateJob(db, j.id, { quality }).catch(() => {});
    }));
  }
  const usage = await capUsage(db);
  const deleting = await pendingDeletions(db);
  for (const j of jobs) if (deleting.has(j.id)) j.deletion = deleting.get(j.id);
  return json(null, 200, {
    jobs, counts,
    cap: { used: usage.total, published: usage.published, deletedToday: usage.deletedToday || 0, uploading: usage.uploading, limit: settings.publishing.dailyCap, resets: '05:30 IST (00:00 UTC)' },
    policyNote: 'All videos require approval before publishing while review-required mode is on. The publish action re-checks duplicates, the daily cap and the upload state server-side.',
  });
}

/** POST /api/jobs — add a topic (duplicate-checked). */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const body = await readBody(context.request);
  const title = String(body.topic || body.title || '').trim();
  if (!title) return json(null, 400, { error: 'Topic is required.', code: 'validation' });

  const settings = await getSettings(db);
  if (settings.publishing.dedupe) {
    const dup = await findDuplicate(db, title);
    if (dup) {
      return json(null, 409, {
        error: `Duplicate topic blocked — normalised match with “${dup.job.title}” (${dup.exact ? 'exact' : 'containment'} match, key ${dup.key}).`,
        code: 'duplicate', duplicateOf: { id: dup.job.id, title: dup.job.title, key: dup.key },
      });
    }
  }

  let engine = body.engine;
  if (!engine || engine === 'auto') {
    engine = settings.orchestration.mode === 'alternate' ? ((new Date().getDate() % 2) ? 'gemini' : 'verticals') : 'gemini';
  }
  const job = {
    id: uid('job'), engine, title, topic: title,
    niche: body.niche || 'general',
    format: engine === 'gemini' ? 'long-form' : 'short',
    status: 'queued', stage: 'Queued', progress: 0,
    description: '', tags: ['New'], durationSec: null, thumbnail: null,
    createdAt: nowIso(), updatedAt: nowIso(), scheduledFor: null, publishedAt: null,
    youtubeId: null, youtubeUrl: null, error: null,
    quality: {
      narration: { state: 'pending', label: 'Pending' }, captions: { state: 'pending', label: 'Pending' },
      duplicate: { state: 'pending', label: 'Pending' }, oauth: { state: 'pending', label: 'Pending' },
    },
    logs: [{ ts: new Date().toLocaleTimeString('en-GB'), level: 'ok', msg: `Topic queued (key ${await topicKey(title)}) — duplicate check passed` }],
    runId: null, publishBlocked: null, duplicateOf: null, demo: false,
  };
  await insertJob(db, job);
  await addActivity(db, { icon: 'plus', tone: 'amber', title: 'Topic added to plan', sub: title, jobId: job.id });
  return json(null, 201, { ok: true, jobId: job.id, message: `“${title}” added to the queue.` });
}
