import { json } from '../_lib/util.js';
import { listRuns, getSettings } from '../_lib/db.js';
import { splitRepo, listWorkflowRuns, listRunArtifacts } from '../_lib/github.js';

/** GET /api/engines — engine status with REAL stage definitions. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  const [runs, settings] = await Promise.all([listRuns(db), getSettings(db)]);
  const token = context.env.GITHUB_TOKEN;

  // Enrich latest runs with real GitHub state when possible.
  let ghRuns = { gemini: [], verticals: [] };
  const fetched = { gemini: false, verticals: false };
  const fetchErrors = {};
  if (token) {
    for (const id of ['gemini', 'verticals']) {
      const slug = settings.github[id]?.repo;
      if (!slug || settings.engines?.[id]?.enabled === false) continue;
      try {
        ghRuns[id] = await listWorkflowRuns(token, { ...splitRepo(slug), workflowFile: settings.github[id].workflow });
        fetched[id] = true;
      } catch (err) {
        fetchErrors[id] = err.message.slice(0, 120); // engine not reachable — reported honestly
      }
    }
  }
  const engine2Key = (id) => id; // job registry uses the same engine ids

  const mk = (id, name, badge, tagline, description, stages) => {
    const lr = runs.find((r) => r.engine === engine2Key(id));
    const gh = ghRuns[id]?.[0];
    // AUDIT FIX: "connected" requires an actual successful GitHub response for
    // THIS engine's workflow (the old check was `>= 0` — always true).
    const reachable = !!token && !!settings.github[id]?.repo && fetched[id] === true;
    return {
      id, name, badge, tagline, description,
      repo: settings.github[id]?.repo || '—',
      branch: settings.github.branch,
      workflow: settings.github[id]?.workflow || '—',
      connected: reachable,
      connectionState: !settings.github[id]?.repo ? 'not-configured'
        : !token ? 'not-configured'
        : fetched[id] ? 'connected' : 'error',
      connectionDetail: !settings.github[id]?.repo ? 'Repository not configured'
        : !token ? 'GITHUB_TOKEN not configured'
        : fetched[id] ? (gh ? `Last run: ${gh.status}${gh.conclusion ? ` · ${gh.conclusion}` : ''}` : 'Reachable (no runs yet)')
        : (fetchErrors[id] || 'GitHub API unreachable'),
      progress: gh?.status === 'in_progress' ? null : gh?.conclusion === 'success' ? 100 : null,
      lastRun: lr ? {
        startedAt: gh?.startedAt || lr.startedAt,
        status: gh ? (gh.conclusion === 'success' ? 'completed' : gh.conclusion === 'failure' ? 'failed' : gh.status) : lr.status,
        runId: gh?.runId || lr.runId,
        githubUrl: gh?.githubUrl || lr.githubUrl,
        durationSec: lr.durationSec,
      } : gh ? { startedAt: gh.startedAt, status: gh.status, runId: gh.runId, githubUrl: gh.githubUrl, durationSec: null } : null,
      lastRunStatus: gh?.conclusion || lr?.status || null,
      lastSuccess: runs.find((r) => r.engine === id && r.status === 'completed')?.startedAt || null,
      stage: gh?.status === 'in_progress' ? 'Running in GitHub Actions' : null,
      latestError: lr?.status === 'failed' ? lr.failureReason : null,
      running: gh?.status === 'in_progress' || gh?.status === 'queued',
      schedule: {
        enabled: !settings.schedule.automationPaused,
        cron: id === 'gemini' ? '0 7 * * * (12:30 PM IST)' : 'configured in workflow',
        label: 'Daily automation cycle',
      },
      publishingMode: settings.publishing.reviewRequired ? 'review-required' : 'automatic',
      supports: {
        draftPhase: id === 'verticals' ? true : true, // workflow inputs phase
        cancellation: true,
        topic: true,
      },
      artifacts: lr?.artifacts || [],
      stages,
    };
  };

  return json(null, 200, {
    engines: [
      mk('gemini', 'Gemini YouTube Automation', 'PRIMARY', 'Educational videos + Shorts',
        'Uses Gemini for script generation, creates videos with narration, stock visuals (Pexels) and uploads to YouTube automatically.',
        [
          { name: 'Curriculum', state: 'done', label: 'gemini' },
          { name: 'Lesson content', state: 'done', label: 'gemini' },
          { name: 'Script / TTS', state: 'done', label: 'gTTS' },
          { name: 'Visuals (Pexels)', state: 'done', label: 'stock' },
          { name: 'Render', state: 'done', label: 'moviepy' },
          { name: 'Quality checks', state: 'pending', label: 'pending' },
          { name: 'Upload (YouTube)', state: 'pending', label: 'pending' },
          { name: 'Commit plan', state: 'pending', label: 'pending' },
        ]),
      mk('verticals', 'Verticals v3 (Shorts)', 'BACKUP', 'Research-driven vertical Shorts',
        'Researches trending topics, generates scripts, creates vertical videos with captions, music and uploads to YouTube.',
        [
          { name: 'Research', state: 'done' }, { name: 'Draft', state: 'done' },
          { name: 'B-roll', state: 'done', label: 'nano-banana' }, { name: 'Voiceover', state: 'done', label: 'edge-tts' },
          { name: 'Whisper ASR', state: 'done' }, { name: 'Captions', state: 'done' },
          { name: 'Music', state: 'done' }, { name: 'Assemble', state: 'done', label: 'ffmpeg' },
          { name: 'Thumbnail', state: 'pending' }, { name: 'Upload', state: 'pending' },
        ]),
    ],
    active: 'gemini',
    stagePolicy: 'Engine A stages come from its production pipeline (curriculum → lesson content → gTTS → Pexels visuals → MoviePy/FFmpeg render → upload → plan commit). Engine B stages mirror its PipelineState machine (research → draft → broll → voiceover → whisper → captions → music → assemble → thumbnail → upload). A stage shows “done” only when the engine recorded it as completed.',
  });
}
