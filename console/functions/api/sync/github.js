import { json, nowIso } from '../_lib/util.js';
import {
  listRuns, updateRun, getJob, updateJob, getSettings, listJobs,
  insertRun, appendLog, addActivity,
} from '../_lib/db.js';
import {
  splitRepo, listWorkflowRuns, listRunArtifacts,
  listRepoDir, fetchRepoFile,
} from '../_lib/github.js';
import {
  recordPublished, classifyError, buildQuality,
} from '../_lib/safeguards.js';
import { maybeDispatchFallback } from '../_lib/fallback.js';
import { findLocalRun, ensureProgressSchema, mapRunStatus } from '../_lib/webhook.js';

/**
 * POST /api/sync/github — pull real GitHub Actions state into the job registry.
 *
 * Source-of-truth synchroniser:
 *  · maps workflow runs to jobs (statuses: dispatched / running / needs-review /
 *    failed — never fabricating intermediate progress),
 *  · INGESTS dypol-results/<run_id>.json files written by the engine workflows
 *    after a verified YouTube upload → records the REAL video ID
 *    (audit fix: the previous version never called recordPublished, so a
 *    successful publish run never became "published"),
 *  · implements Mode-1 fallback: only when the primary run genuinely failed,
 *    nothing was uploaded, and the fallback policy allows it,
 *  · records error categories and retryability on failures.
 */
const STALE_MS = 90 * 60 * 1000;

export async function onRequestPost(context) {
  const db = context.env.DB;
  const token = context.env.GITHUB_TOKEN;
  if (!token) {
    return json(null, 409, { ok: false, message: 'GITHUB_TOKEN not configured — cannot sync from GitHub.' });
  }
  await ensureProgressSchema(db);
  const settings = await getSettings(db);
  const runs = await listRuns(db);
  let updated = 0, fallbackDispatched = 0, uploadsRecorded = 0;
  const messages = [];

  for (const engine of ['gemini', 'verticals']) {
    const slug = settings.github[engine]?.repo;
    const workflow = settings.github[engine]?.workflow;
    if (!slug || !workflow) continue;
    const gh = splitRepo(slug);

    /* ---- 0. Stuck 'uploading' jobs: verify against GitHub evidence ---- */
    try {
      const { listJobs } = await import('../_lib/db.js');
      const { findUploadEvidence } = await import('../_lib/safeguards.js');
      const stuck = (await listJobs(db, {})).filter((j) => j.engine === engine && j.status === 'uploading');
      for (const job of stuck) {
        const ev = await findUploadEvidence(token, gh, job);
        if (ev?.youtube_id) {
          await recordPublished(db, job, ev.youtube_id, { url: ev.youtube_url, videos: ev.videos });
          await appendLog(db, job, {
            ts: new Date().toLocaleTimeString('en-GB'), level: 'ok',
            msg: `Recovered upload record from engine evidence (${ev.youtube_id}${ev.videos?.length > 1 ? `, ${ev.videos.length} videos` : ''}) — job is published.`,
          });
          uploadsRecorded++;
          messages.push(`upload recovered: ${ev.youtube_id} (${job.title})`);
        }
      }
    } catch (err) {
      messages.push(`${engine}: evidence check failed — ${err.message}`);
    }

    /* ---- 1. Verified upload results (dypol-results/*.json) ---- */
    try {
      const files = await listRepoDir(token, { ...gh, path: 'dypol-results' });
      for (const f of files.slice(0, 25)) {
        if (!f.name.endsWith('.json')) continue;
        const raw = await fetchRepoFile(token, { ...gh, path: f.path });
        if (!raw) continue;
        let res;
        try { res = JSON.parse(raw); } catch { continue; }
        if (!res || !res.youtube_id || !res.job_id) continue;
        const job = await getJob(db, res.job_id);
        if (!job || job.status === 'published') continue;
        await recordPublished(db, job, res.youtube_id, { url: res.youtube_url, videos: res.videos || [] });
        await appendLog(db, job, {
          ts: new Date().toLocaleTimeString('en-GB'), level: 'ok',
          msg: `Upload verified from engine result file ${f.name} — YouTube ID ${res.youtube_id}`
            + ((res.videos || []).length > 1 ? ` (+${res.videos.length - 1} more video(s): ${res.videos.slice(1).map((v) => v.youtube_id).join(', ')})` : ''),
        });
        uploadsRecorded++;
        messages.push(`upload recorded: ${res.youtube_id} (${job.title})`);
      }
    } catch (err) {
      messages.push(`${engine}: results read failed — ${err.message}`);
    }

    /* ---- 2. Workflow run states ---- */
    let ghRuns = [];
    try {
      ghRuns = await listWorkflowRuns(token, { ...gh, workflowFile: workflow, perPage: 15 });
    } catch (err) {
      messages.push(`${engine}: ${err.message}`);
      continue;
    }

    for (const ghr of ghRuns) {
      const status = mapRunStatus(ghr.status, ghr.conclusion);
      // Link console-dispatched runs (dispatch API returns no run id): match by
      // run id, else job_id in the run-name, else by dispatch time (within 5 min).
      // Shared with the GitHub webhook (see _lib/webhook.js#findLocalRun).
      const match = findLocalRun(runs, engine, ghr);
      let local = match.run;
      let linked = false;
      if (local && match.by !== 'run_id') {
        local.runId = ghr.runId; linked = true;
        await updateRun(db, local.id, { runId: ghr.runId, githubUrl: ghr.githubUrl });
        await updateJob(db, local.jobId, { runId: ghr.runId });
      }
      let jobNeedsSync = false;
      if (local && local.jobId && ['completed', 'failed', 'cancelled'].includes(status)) {
        const j = await getJob(db, local.jobId);
        jobNeedsSync = !!j && ['dispatched', 'running', 'generating', 'rendering'].includes(j.status);
      }

      if (!local) {
        local = {
          id: `run-gh-${ghr.runId}`, runId: ghr.runId, engine,
          workflow, jobId: null, startedAt: ghr.startedAt,
          durationSec: null, status, failureReason: null, githubUrl: ghr.githubUrl,
          steps: [], logs: [{ ts: '—', level: 'info', msg: `Discovered from GitHub: ${ghr.displayTitle || ghr.name}` }],
          artifacts: [],
        };
        await insertRun(db, local);
        runs.push(local);
        updated++;
      } else if (local.status !== status || linked || jobNeedsSync) {
        const prev = local.status;
        // Keep a step-level reason already recorded by the webhook.
        const failureReason = status === 'failed'
          ? (/^(Step|Job) “/.test(local.failureReason || '') ? local.failureReason
            : `GitHub Actions run concluded with failure (${ghr.displayTitle || ghr.name})`) : null;
        await updateRun(db, local.id, {
          status, githubUrl: ghr.githubUrl, startedAt: ghr.startedAt, failureReason,
        });
        updated++;
        messages.push(`run ${ghr.runId}: ${prev} → ${status}`);

        if (local.jobId) {
          const job = await getJob(db, local.jobId);
          // Never demote an 'uploading'/'published' job — its upload may be
          // in flight or already verified elsewhere.
          if (job && !['published', 'superseded', 'rejected', 'uploading'].includes(job.status)) {
            if (status === 'in-progress' || status === 'queued') {
              await updateJob(db, job.id, {
                status: status === 'queued' ? 'dispatched' : 'running',
                stage: status === 'queued' ? 'Queued in GitHub Actions' : 'Running in GitHub Actions',
                progress: null, // honest: no fabricated percentage
              });
            } else if (status === 'completed') {
              await updateJob(db, job.id, {
                status: 'needs-review', stage: 'Ready for review',
                progress: 100,
                quality: buildQuality(job, {
                  oauthConfigured: !!(context.env.YOUTUBE_CLIENT_SECRET_B64 && context.env.YOUTUBE_TOKEN_B64),
                  hasArtifact: (local.artifacts || []).length > 0,
                  durationKnown: job.durationSec ? true : null,
                }),
              });
              await addActivity(db, { icon: 'check', tone: 'violet', title: 'Video ready for review', sub: job.title });
            } else if (status === 'failed') {
              const cat = classifyError(failureReason);
              await updateJob(db, job.id, {
                status: 'failed', stage: 'Failed', error: failureReason,
                errorCategory: cat.category, errorRetryable: cat.retryable,
              });
              await addActivity(db, { icon: 'alert', tone: 'red', title: 'Run failed', sub: `${job.title} — ${cat.category}` });
            } else if (status === 'cancelled') {
              await updateJob(db, job.id, { status: 'cancelled', stage: 'Cancelled', error: 'Run cancelled' });
            }
          }
        }

        // Mode-1 fallback: primary GENUINELY failed (never on slowness), the
        // job has no upload anywhere (registry + evidence), and policy allows it.
        if (status === 'failed') {
          const fb = await maybeDispatchFallback({
            db, token, settings, engine, local, displayTitle: ghr.displayTitle,
          });
          if (fb) {
            if (fb.dispatched) fallbackDispatched++;
            messages.push(fb.message);
          }
        }
      }

      // Enrich artifacts for completed runs.
      if (status === 'completed' && (!local.artifacts || !local.artifacts.length) && local.runId) {
        try {
          const artifacts = await listRunArtifacts(token, { ...gh, runId: local.runId });
          if (artifacts.length) {
            await updateRun(db, local.id, { artifacts });
            updated++;
          }
        } catch { /* non-fatal */ }
      }
    }
  }

  /* ---- 3. Stale cleanup: active jobs/runs with no GitHub run after 90 min ---- */
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const r of await listRuns(db)) {
      if (!r.runId && ['in-progress', 'queued'].includes(r.status) && (Date.parse(r.startedAt) || 0) < cutoff) {
        await updateRun(db, r.id, { status: 'failed', failureReason: 'Stale: no matching GitHub Actions run found' });
        updated++;
      }
    }
    for (const j of await listJobs(db, {})) {
      if (['dispatched', 'running', 'generating', 'rendering'].includes(j.status)
        && (Date.parse(j.updatedAt || j.createdAt) || 0) < cutoff) {
        await updateJob(db, j.id, {
          status: 'failed', stage: 'Stale', error: 'Stale: no GitHub Actions progress for 90+ minutes',
          errorCategory: 'stale', errorRetryable: true,
        });
        messages.push(`stale job closed: ${j.title}`);
        updated++;
      }
    }
  } catch (err) { messages.push(`stale cleanup failed — ${err.message}`); }

  return json(null, 200, {
    ok: true,
    message: `Sync complete — ${updated} run record(s) updated, ${uploadsRecorded} verified upload(s) recorded.`
      + (fallbackDispatched ? ` ${fallbackDispatched} fallback dispatch(es).` : '')
      + (messages.length ? ` ${messages.slice(0, 4).join(' · ')}` : ''),
  });
}
