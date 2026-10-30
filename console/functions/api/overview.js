import { json, TZ } from './_lib/util.js';
import { listJobs, listRuns, listActivity, getSettings } from './_lib/db.js';
import { splitRepo, listWorkflowRuns } from './_lib/github.js';
import { backgroundReconcile } from './_lib/jobflow.js';

/**
 * GET /api/overview — truthful operational summary.
 * AUDIT: metrics are computed from persisted records; job counts and video
 * counts are distinguished; engine readiness is probed (never assumed);
 * workflow success is NOT treated as upload success.
 */
export async function onRequestGet(context) {
  backgroundReconcile(context);
  const db = context.env.DB;
  const [jobs, runs, activity, settings] = await Promise.all([
    listJobs(db, {}), listRuns(db), listActivity(db, 8), getSettings(db),
  ]);

  const month = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
  const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = lastMonthDate.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
  const publishedThisMonth = jobs.filter((j) => j.publishedAt && j.publishedAt.slice(0, 7) === month).length;
  const publishedLastMonth = jobs.filter((j) => j.publishedAt && j.publishedAt.slice(0, 7) === lastMonth).length;
  const delta = publishedThisMonth - publishedLastMonth;

  // Job counts vs video counts: one Engine A job produces 2 videos (long+short),
  // one Engine B job produces 1. "Videos generated" counts completed outputs.
  const videosGenerated = jobs.filter((j) =>
    ['needs-review', 'approved', 'scheduled', 'uploading', 'published'].includes(j.status)).length
    + jobs.filter((j) => j.engine === 'gemini' && j.status === 'published').length; // +1 short per published lesson

  const failedRuns = runs.filter((r) => r.status === 'failed');
  const latestSuccess = runs.find((r) => r.status === 'completed') || null;

  // Engine readiness: probe GitHub per engine (cheap, 2 calls) — a badge is
  // earned, not assumed. Falls back to "unverified" on errors.
  const probe = async (engine) => {
    const token = context.env.GITHUB_TOKEN;
    const slug = settings.github[engine]?.repo;
    const wf = settings.github[engine]?.workflow;
    if (!token || !slug || !wf) return { state: 'not-configured', detail: !slug ? 'Repository not set' : 'GITHUB_TOKEN missing' };
    if (settings.engines?.[engine]?.enabled === false) return { state: 'disabled', detail: 'Disabled in Settings' };
    try {
      const [gh] = await listWorkflowRuns(token, {
        ...splitRepo(slug), workflowFile: wf, perPage: 1,
      });
      return gh === undefined
        ? { state: 'connected', detail: 'Reachable (no runs yet)' }
        : { state: 'connected', detail: `Last run ${gh.status}${gh.conclusion ? ` · ${gh.conclusion}` : ''}` };
    } catch (err) {
      return { state: 'error', detail: err.message.slice(0, 120) };
    }
  };
  const [probeA, probeB] = await Promise.all([probe('gemini'), probe('verticals')]);

  const lastRunFor = (engine) => runs.find((r) => r.engine === engine) || null;
  const engineCard = (id, name, badge, tagline, description, probeResult) => {
    const lr = lastRunFor(id);
    const runningJob = jobs.find((j) => j.engine === id && ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
    // Progress: derived from real run steps when available, else indeterminate.
    const steps = lr?.steps || [];
    const done = steps.filter((s) => s.status === 'done').length;
    return {
      id, name, badge, tagline, description,
      repo: settings.github[id]?.repo || '—',
      branch: settings.github.branch,
      workflow: settings.github[id]?.workflow || '—',
      connected: probeResult.state === 'connected',
      connectionState: probeResult.state,
      connectionDetail: probeResult.detail,
      progress: steps.length ? Math.round((done / steps.length) * 100) : null,
      lastRun: lr ? { startedAt: lr.startedAt, status: lr.status, runId: lr.runId, githubUrl: lr.githubUrl, durationSec: lr.durationSec } : null,
      lastRunStatus: lr?.status,
      lastSuccess: runs.find((r) => r.engine === id && r.status === 'completed')?.startedAt || null,
      stage: runningJob?.stage || null,
      latestError: lr?.status === 'failed' ? lr.failureReason : null,
      running: !!runningJob || lr?.status === 'in-progress',
    };
  };

  const engines = [
    engineCard('gemini', 'Gemini YouTube Automation', 'PRIMARY', 'Educational videos + Shorts',
      'Uses Gemini for script generation, creates videos with narration, stock visuals (Pexels) and uploads to YouTube automatically.', probeA),
    engineCard('verticals', 'Verticals v3 (Shorts)', 'BACKUP', 'Research-driven vertical Shorts',
      'Researches trending topics, generates scripts, creates vertical videos with captions, music and uploads to YouTube.', probeB),
  ];

  const operational = engines.every((e) => e.connectionState === 'connected')
    ? 'operational'
    : engines.some((e) => e.connectionState === 'connected') ? 'partial' : 'degraded';

  return json(null, 200, {
    mode: 'live', demo: false, timezone: TZ,
    operational,
    schedulePaused: settings.schedule.automationPaused,
    metrics: {
      totalJobs: jobs.length,
      videosGenerated,
      publishedTotal: jobs.filter((j) => j.status === 'published').length,
      publishedMonth: publishedThisMonth,
      publishedMonthDelta: delta === 0 ? 'Same as last month'
        : `${delta > 0 ? '+' : ''}${delta} vs last month`,
      inProduction: jobs.filter((j) => ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status)).length,
      inProductionNote: 'Jobs actively executing',
      awaitingReview: jobs.filter((j) => ['needs-review', 'awaiting-review'].includes(j.status)).length,
      failedRuns: failedRuns.length,
      failedDelta: failedRuns.length ? `Latest: ${failedRuns[0].failureReason?.slice(0, 40) || 'see run history'}…` : 'None recorded',
      latestSuccess: latestSuccess ? latestSuccess.startedAt : null,
    },
    engines,
    recentVideos: jobs.slice(0, 5),
    recentErrors: [
      ...failedRuns.slice(0, 3).map((r) => ({
        ts: r.startedAt, title: `Run failed · ${r.engine}`,
        sub: r.failureReason || 'Unknown failure',
      })),
      ...jobs.filter((j) => j.error).slice(0, 3).map((j) => ({
        ts: j.updatedAt, title: `Job failed · ${j.title}`,
        sub: j.errorCategory ? `${j.errorCategory}: ${j.error}` : j.error,
      })),
    ].slice(0, 5),
    activity: activity.map((a) => ({ ts: a.ts, icon: a.icon, tone: a.tone, title: a.title, sub: a.sub })),
    nextRun: settings.schedule.automationPaused ? null : {
      label: `Daily · ${settings.schedule.windowStart} IST`,
      note: `GitHub cron schedule (${settings.schedule.frequency})`, engine: 'gemini',
    },
  });
}
