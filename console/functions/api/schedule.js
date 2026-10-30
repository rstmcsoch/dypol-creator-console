import { json, readBody, TZ } from './_lib/util.js';
import { getSettings, saveSettings, addActivity } from './_lib/db.js';
import { splitRepo, updateRepoFile, integrationRef } from './_lib/github.js';

/**
 * POST /api/schedule — publishing window, daily cap, pause/resume, frequency.
 *
 * AUDIT: "pause" now ENFORCES behaviour instead of only changing a badge:
 * a dypol-control.json file is written to BOTH engine forks on dypol-integration (never main) (via the GitHub
 * contents API). The engine workflows read it as their first step and exit
 * early when schedule_enabled=false on scheduled runs. Manual dashboard runs
 * remain possible (force), matching the documented semantics:
 * "prevent future SCHEDULED runs without deleting jobs/drafts/records/creds".
 */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const body = await readBody(context.request);
  const settings = await getSettings(db);
  const patch = { schedule: { ...settings.schedule }, publishing: { ...settings.publishing } };

  if (body.automationPaused !== undefined) {
    patch.schedule.automationPaused = !!body.automationPaused;
    await addActivity(db, {
      icon: body.automationPaused ? 'pause' : 'play', tone: 'amber',
      title: body.automationPaused ? 'Automation paused' : 'Automation resumed',
      sub: 'Schedule state changed — control file updated on engine forks',
    });
  }
  if (body.windowStart) patch.schedule.windowStart = body.windowStart;
  if (body.windowEnd) patch.schedule.windowEnd = body.windowEnd;
  if (body.frequency) patch.schedule.frequency = body.frequency;
  if (body.dailyCap) patch.publishing.dailyCap = Math.max(1, Math.min(10, Number(body.dailyCap)));

  await saveSettings(db, patch);

  // Push the schedule gate to both engine forks (best effort — if the token or
  // repos are missing the dashboard state still saves and reports honestly).
  const control = JSON.stringify({
    schedule_enabled: !patch.schedule.automationPaused,
    publishing_window: `${patch.schedule.windowStart}-${patch.schedule.windowEnd} IST`,
    daily_cap: patch.publishing.dailyCap,
    review_required: patch.publishing.reviewRequired,
    updated_at: new Date().toISOString(),
    updated_by: 'dypol-creator-console',
  }, null, 2);
  const results = [];
  if (context.env.GITHUB_TOKEN) {
    for (const id of ['gemini', 'verticals']) {
      const slug = settings.github[id]?.repo;
      if (!slug) continue;
      try {
        await updateRepoFile(context.env.GITHUB_TOKEN, {
          ...splitRepo(slug), path: 'dypol-control.json', content: control, branch: integrationRef(settings),
          message: `DYPOL: ${patch.schedule.automationPaused ? 'pause' : 'resume'} scheduled automation`,
        });
        results.push(`${id}: control file updated`);
      } catch (err) {
        results.push(`${id}: control file FAILED (${err.message})`);
      }
    }
  } else {
    results.push('GITHUB_TOKEN not configured — fork control file not updated');
  }

  return json(null, 200, {
    ok: true,
    message: (patch.schedule.automationPaused
      ? 'Automation paused — history, credentials and configuration preserved. '
      : 'Schedule settings saved. ')
      + (results.length ? results.join(' · ') : ''),
  });
}
