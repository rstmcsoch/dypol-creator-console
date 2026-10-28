import { json, TZ } from './_lib/util.js';
import { listJobs, getSettings, listRuns } from './_lib/db.js';

/** GET /api/calendar[?month=YYYY-MM] */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const [jobs, settings, runs] = await Promise.all([listJobs(db, {}), getSettings(db), listRuns(db)]);
  const lastRun = runs.find((r) => r.status !== 'queued') || null;
  return json(null, 200, {
    jobs,
    timezone: TZ,
    publishingWindow: `${settings.schedule.windowStart}–${settings.schedule.windowEnd}`,
    windowStart: settings.schedule.windowStart,
    windowEnd: settings.schedule.windowEnd,
    dailyCap: settings.publishing.dailyCap,
    reviewRequired: settings.publishing.reviewRequired,
    automationPaused: settings.schedule.automationPaused,
    nextRunLabel: settings.schedule.automationPaused ? 'Paused' : `Daily ${settings.schedule.windowStart} IST`,
    lastExecutionLabel: lastRun
      ? `${new Date(lastRun.startedAt).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · ${lastRun.status}`
      : 'No runs recorded',
  });
}
