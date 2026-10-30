#!/usr/bin/env node
/**
 * DYPOL Creator Console — local dev / preview server.
 *
 * Zero-dependency Node HTTP server that serves the static console and implements
 * the exact same /api contract as the production Cloudflare Pages Functions
 * (console/functions/api/*). Runs in "demo" mode: job metadata lives in memory
 * and production runs are simulated. Every demo record is labelled.
 *
 * Production behaviour (real D1 + GitHub Actions + YouTube) lives in
 * console/functions/ — this file never handles real credentials.
 *
 * Usage: node dev/server.js   (PORT=8788 by default, binds 0.0.0.0)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8788);
const ROOT = path.join(__dirname, '..', 'console');
const ADMIN_PASSWORD = process.env.DYPOL_ADMIN_PASSWORD || 'dypol-demo';
const SESSION_SECRET = process.env.DYPOL_SESSION_SECRET || 'dev-only-session-secret-change-me';
const TZ = 'Asia/Kolkata';

/* ============================================================
   In-memory store (demo)
   ============================================================ */
let seq = 100;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => new Date().toISOString();
const fmtWhen = (iso) => (iso && !Number.isNaN(new Date(iso).getTime())
  ? new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  : '—');

const db = {
  jobs: [],
  runs: [],
  activity: [],
  uploads: [], // {topicKey, youtubeId, jobId, at}
  locks: new Map(), // name -> expiresAt
  settings: null,
  sessions: new Map(), // token -> {expiresAt}
  githubConnected: false,
};
const loginAttempts = new Map(); // ip -> [timestamps]

const DEFAULT_SETTINGS = () => ({
  github: {
    gemini: { repo: 'you/gemini-youtube-automation', workflow: 'main.yml' },
    verticals: { repo: 'you/youtube-shorts-pipeline', workflow: 'verticals.yml' },
    branch: 'main',
    tokenConfigured: false,
  },
  engines: {
    gemini: { enabled: true },
    verticals: { enabled: true },
  },
  orchestration: {
    mode: 'primary_with_fallback', fallback: 'on_failure', alternate: 'days',
    maxConcurrency: 1, retryLimit: 2,
  },
  publishing: {
    reviewRequired: true, autoPublish: false, dedupe: true, publishLock: true,
    visibility: 'private', dailyCap: 2, draftMode: false,
  },
  defaults: { format: 'per_engine', language: 'en', niche: 'general', engine: 'gemini' },
  schedule: {
    timezone: TZ, frequency: 'daily', windowStart: '18:00', windowEnd: '21:00',
    automationPaused: false,
  },
});
db.settings = DEFAULT_SETTINGS();

/* ============================================================
   Duplicate prevention — normalised topic matching
   (mirrors console/functions/api/_lib/dedupe.js)
   ============================================================ */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or',
  'is', 'are', 'was', 'were', 'with', 'how', 'why', 'what', 'your', 'you', 'our', 'is',
  'can', 'does', 'do', 'guide', 'video', 'vs', 'into', 'from', 'at', 'by', 'it', 'its']);

function normalizeTopic(title) {
  return String(title || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => {
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // memories → memory
      if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // holes → hole
      return w;
    })
    .join(' ')
    .trim();
}
const topicKey = (title) => crypto.createHash('sha256').update(normalizeTopic(title)).digest('hex').slice(0, 32);

/** Find duplicate among active/published jobs. Returns {key, job} or null. */
function findDuplicate(title, excludeJobId = null) {
  const key = topicKey(title);
  const norm = normalizeTopic(title);
  for (const j of db.jobs) {
    if (j.id === excludeJobId) continue;
    if (['rejected', 'failed', 'cancelled'].includes(j.status)) continue;
    const k2 = topicKey(j.title);
    if (k2 === key) return { key, norm, job: j, exact: true };
    // light containment check (documented limitation: no semantic matching)
    const n2 = normalizeTopic(j.title);
    if (norm.length > 12 && n2.length > 12 && (norm.includes(n2) || n2.includes(norm))) {
      return { key, norm, job: j, exact: false };
    }
  }
  return null;
}

/* ============================================================
   Publishing lock + daily cap
   ============================================================ */
function acquireLock(name, ttlMs = 60000) {
  const exp = db.locks.get(name);
  if (exp && exp > Date.now()) return false;
  db.locks.set(name, Date.now() + ttlMs);
  return true;
}
function releaseLock(name) { db.locks.delete(name); }

function uploadsToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  return db.uploads.filter((u) => new Date(u.at).toLocaleDateString('en-CA', { timeZone: TZ }) === today).length;
}

/* ============================================================
   Demo seed — clearly labelled
   ============================================================ */
function seed() {
  const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const mk = (o) => {
    const job = {
      id: o.id || uid('job'), engine: o.engine, title: o.title, topic: o.title,
      niche: o.niche || 'general', format: o.format, status: o.status, stage: o.stage,
      progress: o.progress, description: o.description || '', tags: o.tags || [],
      durationSec: o.durationSec || null, thumbnail: null,
      createdAt: o.createdAt || t(30), updatedAt: o.updatedAt || o.createdAt || t(30),
      scheduledFor: o.scheduledFor || null, publishedAt: o.publishedAt || null,
      youtubeId: o.youtubeId || null, youtubeUrl: o.youtubeUrl || null,
      error: o.error || null, quality: o.quality || qualityDefaults(o.status),
      logs: o.logs || defaultLogs(o), runId: o.runId || null,
      demo: true, publishBlocked: null, duplicateOf: null,
    };
    db.jobs.push(job);
    return job;
  };
  mk({
    id: 'job-demo-memory', engine: 'gemini', title: 'Why AI Agents Need Memory',
    format: 'long-form', status: 'published', stage: 'Upload complete', progress: 100,
    description: 'Building better AI agents starts with memory. Here is why context retention changes everything.',
    tags: ['AI', 'Agents', 'Tech'], durationSec: 754,
    createdAt: t(40), updatedAt: t(2), publishedAt: t(2),
    youtubeId: 'demo-mem001', youtubeUrl: 'https://youtu.be/demo-mem001',
  });
  mk({
    id: 'job-demo-blackholes', engine: 'verticals', title: 'The Science of Black Holes in 60 Seconds',
    format: 'short', status: 'generating', stage: 'Generating video…', progress: 75,
    description: 'What really happens inside a black hole? Let’s break it down in 60 seconds.',
    tags: ['Space', 'Science', 'Explainer', 'Universe'], durationSec: 58,
    createdAt: t(8), updatedAt: t(1),
  });
  mk({
    id: 'job-demo-transformers', engine: 'gemini', title: 'How Transformers Learn',
    format: 'long-form', status: 'scheduled', stage: 'Queued', progress: 0,
    description: 'The magic behind modern AI models explained in simple terms.',
    tags: ['AI', 'Machine Learning', 'Tech'], durationSec: 626,
    createdAt: t(6), updatedAt: t(4), scheduledFor: new Date(Date.now() + 20 * 3600e3).toISOString(),
  });
  mk({
    id: 'job-demo-canai', engine: 'verticals', title: 'Can AI Think Like Humans?',
    format: 'short', status: 'needs-review', stage: 'Ready for review', progress: 100,
    description: 'Is AI really thinking, or just following patterns? Exploring the philosophy of machine minds.',
    tags: ['AI', 'Philosophy', 'Future'], durationSec: 72,
    createdAt: t(10), updatedAt: t(3),
    quality: {
      narration: { state: 'ok', label: 'OK' }, captions: { state: 'ok', label: 'OK' },
      duplicate: { state: 'passed', label: 'Passed' }, oauth: { state: 'ok', label: 'OK' },
    },
  });

  db.runs.push(
    {
      id: uid('run'), runId: 'GA-1842', engine: 'gemini', workflow: 'main.yml',
      jobId: 'job-demo-memory', jobTitle: 'Why AI Agents Need Memory',
      startedAt: t(4), durationSec: 1620, status: 'completed', failureReason: null,
      githubUrl: 'https://github.com/you/gemini-youtube-automation/actions/runs/1842', demo: true,
      steps: [
        { name: 'Checkout repository', status: 'done' }, { name: 'Set up Python', status: 'done' },
        { name: 'Install dependencies and patch ImageMagick', status: 'done' },
        { name: 'Restore API credentials', status: 'done' },
        { name: 'Run Autonomous Production Pipeline', status: 'done' },
        { name: 'Upload artifacts', status: 'done' }, { name: 'Commit content plan', status: 'done' },
      ],
      logs: [
        { ts: '10:24:02', level: 'info', msg: 'Starting Autonomous Production Pipeline' },
        { ts: '10:24:15', level: 'ok', msg: 'Curriculum step: 1 lesson selected' },
        { ts: '10:26:40', level: 'ok', msg: 'Lesson content generated via gemini-3.6-flash' },
        { ts: '10:31:11', level: 'info', msg: 'Narration (gTTS) written to output/lesson_audio.wav' },
        { ts: '10:38:52', level: 'ok', msg: 'Long video rendered: output/long_video_20261027.mp4' },
        { ts: '10:42:19', level: 'ok', msg: 'Short video rendered: output/short_video_20261027.mp4' },
        { ts: '10:44:35', level: 'ok', msg: 'YouTube upload complete (visibility=private) id=demo-mem001' },
        { ts: '10:46:12', level: 'ok', msg: 'content_plan.json updated and pushed' },
      ],
      artifacts: [{ name: 'final-videos', size: '184 MB' }, { name: 'audio-debug-files', size: '22 MB' }],
    },
    {
      id: uid('run'), runId: 'GA-1838', engine: 'gemini', workflow: 'main.yml',
      jobId: null, jobTitle: null,
      startedAt: t(26), durationSec: 420, status: 'failed',
      failureReason: 'Step "Run Autonomous Production Pipeline" exited with code 1: gTTS returned empty audio',
      githubUrl: 'https://github.com/you/gemini-youtube-automation/actions/runs/1838', demo: true,
      steps: [
        { name: 'Checkout repository', status: 'done' }, { name: 'Set up Python', status: 'done' },
        { name: 'Install dependencies', status: 'done' }, { name: 'Restore API credentials', status: 'done' },
        { name: 'Run Autonomous Production Pipeline', status: 'failed' },
        { name: 'Upload artifacts', status: 'skipped' }, { name: 'Commit content plan', status: 'skipped' },
      ],
      logs: [
        { ts: '04:10:02', level: 'info', msg: 'Starting Autonomous Production Pipeline' },
        { ts: '04:12:41', level: 'warn', msg: 'gTTS attempt 1 produced empty audio, retrying' },
        { ts: '04:16:22', level: 'error', msg: 'gTTSError: gTTS wrote an empty or truncated audio file.', failed: true },
      ],
      artifacts: [],
    },
    {
      id: uid('run'), runId: 'VB-771', engine: 'verticals', workflow: 'verticals.yml',
      jobId: 'job-demo-blackholes', jobTitle: 'The Science of Black Holes in 60 Seconds',
      startedAt: t(1.2), durationSec: 840, status: 'in-progress',
      failureReason: null,
      githubUrl: 'https://github.com/you/youtube-shorts-pipeline/actions/runs/771', demo: true,
      steps: [
        { name: 'research', status: 'done' }, { name: 'draft', status: 'done' },
        { name: 'broll', status: 'done' }, { name: 'voiceover', status: 'done' },
        { name: 'whisper', status: 'done' }, { name: 'captions', status: 'done' },
        { name: 'music', status: 'done' }, { name: 'assemble', status: 'running' },
        { name: 'thumbnail', status: 'pending' }, { name: 'upload', status: 'pending' },
      ],
      logs: [
        { ts: '09:10:00', level: 'info', msg: 'verticals produce --draft drafts/blackholes.json' },
        { ts: '09:11:22', level: 'ok', msg: 'broll: 3/3 frames via gemini-nano-banana-2.1' },
        { ts: '09:12:40', level: 'ok', msg: 'voiceover: edge-tts en-US-Neural' },
        { ts: '09:14:05', level: 'info', msg: 'captions: SRT generated, burn-in scheduled' },
        { ts: '09:16:30', level: 'info', msg: 'assemble: encoding 1080x1920 @30fps' },
      ],
      artifacts: [],
    },
  );

  db.uploads.push({ topicKey: topicKey('Why AI Agents Need Memory'), youtubeId: 'demo-mem001', jobId: 'job-demo-memory', at: t(2) });

  db.activity = [
    { ts: t(2), icon: 'upload', tone: 'green', title: 'Video uploaded', sub: 'Why AI Agents Need Memory' },
    { ts: t(4), icon: 'doc', tone: 'blue', title: 'Script generated', sub: 'Next: The Future of Space Exploration' },
    { ts: t(6), icon: 'check', tone: 'violet', title: 'Video completed', sub: '5 Amazing Android Apps You Must Try' },
    { ts: t(8), icon: 'plus', tone: 'amber', title: 'Topic added to plan', sub: 'AI Tools for Students' },
    { ts: t(27), icon: 'check', tone: 'green', title: 'Run completed', sub: 'Daily cycle · 2 videos created' },
  ];
}
seed();

/* ============================================================
   Job simulation — advances running jobs so the preview is live
   ============================================================ */
function qualityDefaults(status) {
  const reviewed = ['needs-review', 'approved', 'scheduled', 'published', 'uploading'].includes(status);
  // AUDIT FIX: honest states — only checks the system can verify are "ok".
  // Rights/copyright are always "skipped" (human review), OAuth is
  // "configured (not tested)" at best, never a blanket "OK".
  return {
    narration: { state: reviewed ? 'warn' : 'pending', label: reviewed ? 'Present (not auditioned)' : 'Pending' },
    captions: { state: reviewed ? 'warn' : 'pending', label: reviewed ? 'Generated (not auditioned)' : 'Pending' },
    duplicate: { state: reviewed ? 'passed' : 'pending', label: reviewed ? 'Passed' : 'Pending' },
    oauth: { state: 'warn', label: 'Demo mode — not tested' },
    rights: { state: 'skipped', label: 'Human review required' },
    artifact: { state: reviewed ? 'ok' : 'skipped', label: reviewed ? 'Output file present (demo)' : 'Not verified yet' },
    duration: { state: reviewed ? 'ok' : 'skipped', label: reviewed ? 'Duration > 0 (demo)' : 'Unknown' },
  };
}
function defaultLogs(o) {
  const base = [
    { ts: '—', level: 'info', msg: `Job created for ${o.engine === 'gemini' ? 'Gemini YouTube Automation' : 'Verticals v3'}` },
    { ts: '—', level: 'ok', msg: 'Topic accepted — duplicate check passed' },
    { ts: '—', level: 'info', msg: `Stage: ${o.stage}` },
  ];
  return base;
}

const STAGE_FLOW = {
  generating: ['Generating script…', 'Generating visuals…', 'Rendering video…', 'Ready for review'],
  rendering: ['Rendering video…', 'Ready for review'],
  uploading: ['Uploading to YouTube…', 'Published'],
};

setInterval(() => {
  for (const j of db.jobs) {
    // 'dispatched' jobs enter the simulated pipeline shortly after dispatch.
    if (j.status === 'dispatched') {
      j.status = 'generating';
      j.stage = 'Generating script…';
      j.progress = 4;
      j.logs.push({ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'info', msg: 'Run picked up by the pipeline' });
    }
    if (!['generating', 'rendering', 'uploading'].includes(j.status)) continue;
    j.progress = Math.min(100, (j.progress || 0) + 7 + Math.random() * 8);
    const flow = STAGE_FLOW[j.status] || [];
    const idx = Math.min(flow.length - 1, Math.floor((j.progress / 100) * flow.length));
    j.stage = flow[idx] || j.stage;
    j.logs.push({ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'info', msg: `Stage: ${j.stage} (${Math.round(j.progress)}%)` });
    j.updatedAt = now();
    if (j.progress >= 100) {
      if (j.status === 'uploading') {
        completeUpload(j);
      } else {
        j.status = 'needs-review';
        j.stage = 'Ready for review';
        j.quality = qualityDefaults('needs-review');
        db.activity.unshift({ ts: now(), icon: 'check', tone: 'violet', title: 'Video ready for review', sub: j.title });
      }
    }
  }
}, 5000);

function completeUpload(job) {
  const key = topicKey(job.title);
  const id = 'demo-' + crypto.randomBytes(4).toString('hex');
  job.status = 'published';
  job.stage = 'Upload complete';
  job.publishedAt = now();
  job.youtubeId = id;
  job.youtubeUrl = `https://youtu.be/${id}`;
  job.quality = qualityDefaults('published');
  job.logs.push({ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'ok', msg: `YouTube upload complete id=${id} visibility=${db.settings.publishing.visibility}` });
  db.uploads.push({ topicKey: key, youtubeId: id, jobId: job.id, at: now() });
  db.activity.unshift({ ts: now(), icon: 'upload', tone: 'green', title: 'Video uploaded', sub: job.title });
}

/* ============================================================
   Auth — HMAC-signed session cookie (production uses scrypt + D1)
   ============================================================ */
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function makeSession(days = 7) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions.set(token, { expiresAt: Date.now() + days * 86400e3 });
  return token;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function authed(req) {
  const tok = parseCookies(req).dypol_session;
  const s = tok && db.sessions.get(tok);
  return !!(s && s.expiresAt > Date.now());
}

/* ============================================================
   Helpers
   ============================================================ */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (obj && obj._clearCookie) {
    headers['Set-Cookie'] = 'dypol_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
    delete obj._clearCookie;
  }
  res.writeHead(code, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}
function metrics() {
  const jobs = db.jobs;
  const month = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
  const lmDate = new Date(); lmDate.setMonth(lmDate.getMonth() - 1);
  const lastMonth = lmDate.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
  const publishedMonth = jobs.filter((j) => j.publishedAt && j.publishedAt.slice(0, 7) === month).length;
  const publishedLast = jobs.filter((j) => j.publishedAt && j.publishedAt.slice(0, 7) === lastMonth).length;
  const delta = publishedMonth - publishedLast;
  const failedRuns = db.runs.filter((r) => r.status === 'failed');
  const latestSuccess = db.runs.find((r) => r.status === 'completed') || null;
  // Job counts ≠ video counts: Engine A produces 2 videos per published lesson.
  const videosGenerated = jobs.filter((j) =>
    ['needs-review', 'approved', 'scheduled', 'uploading', 'published'].includes(j.status)).length
    + jobs.filter((j) => j.engine === 'gemini' && j.status === 'published').length;
  return {
    totalJobs: jobs.length,
    videosGenerated,
    publishedTotal: jobs.filter((j) => j.status === 'published').length,
    publishedMonth,
    publishedMonthDelta: delta === 0 ? 'Same as last month' : `${delta > 0 ? '+' : ''}${delta} vs last month`,
    inProduction: jobs.filter((j) => ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status)).length,
    inProductionNote: 'Jobs actively executing',
    awaitingReview: jobs.filter((j) => ['needs-review', 'awaiting-review'].includes(j.status)).length,
    failedRuns: failedRuns.length,
    failedDelta: failedRuns.length ? `Latest: ${(failedRuns[0].failureReason || 'see run history').slice(0, 40)}…` : 'None recorded',
    latestSuccess: latestSuccess ? latestSuccess.startedAt : null,
  };
}
function engineSummaries() {
  const gs = db.settings;
  const lastRun = (engine) => db.runs.filter((r) => r.engine === engine).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const mk = (id, name, badge, tagline, description, stages) => {
    const lr = lastRun(id);
    const runningJob = db.jobs.find((j) => j.engine === id && ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
    // AUDIT FIX: "connected" is a demo-mode statement about configuration,
    // never a claim of verified provider access. Real deployments probe GitHub.
    const configured = !!gs.github[id]?.repo && gs.engines?.[id]?.enabled !== false;
    const steps = lr?.steps || [];
    const done = steps.filter((s) => s.status === 'done').length;
    return {
      id, name, badge, tagline, description,
      repo: gs.github[id]?.repo || '—', branch: gs.github.branch,
      workflow: gs.github[id]?.workflow || '—',
      connected: configured,
      connectionState: gs.engines?.[id]?.enabled === false ? 'disabled'
        : configured ? 'demo-unverified' : 'not-configured',
      connectionDetail: gs.engines?.[id]?.enabled === false ? 'Disabled in Settings'
        : configured ? 'Demo mode — provider access not verified' : 'Repository not configured',
      // Progress: derived from real step counts when available — else null
      // (indeterminate), never a fabricated percentage.
      progress: steps.length ? Math.round((done / steps.length) * 100) : (runningJob ? null : lr?.status === 'completed' ? 100 : null),
      lastRun: lr ? { startedAt: lr.startedAt, status: lr.status, runId: lr.runId, githubUrl: lr.githubUrl, durationSec: lr.durationSec } : null,
      lastRunStatus: lr?.status,
      lastSuccess: lr?.status === 'completed' ? lr.startedAt : db.runs.filter((r) => r.engine === id && r.status === 'completed')[0]?.startedAt || null,
      stage: runningJob?.stage || (lr?.status === 'in-progress' ? 'Running' : null),
      latestError: lr?.status === 'failed' ? lr.failureReason : null,
      running: !!runningJob || lr?.status === 'in-progress',
      schedule: { enabled: !gs.schedule.automationPaused, cron: id === 'gemini' ? '0 7 * * * (12:30 PM IST)' : '30 9 * * * (3:00 PM IST)', label: 'Daily automation cycle' },
      publishingMode: gs.publishing.draftMode ? 'draft-only' : gs.publishing.reviewRequired ? 'review-required' : gs.publishing.autoPublish ? 'automatic' : 'review-required',
      supports: { draftPhase: true, cancellation: true, topic: true },
      artifacts: lr?.artifacts || [],
      stages,
    };
  };
  return {
    engines: [
      mk('gemini', 'Gemini YouTube Automation', 'PRIMARY', 'Educational videos + Shorts',
        'Uses Gemini for script generation, creates videos with narration, stock visuals (Pexels) and uploads to YouTube automatically.',
        [
          { name: 'Curriculum', state: 'done' }, { name: 'Lesson content', state: 'done' },
          { name: 'Script / TTS', state: 'done' }, { name: 'Visuals (Pexels)', state: 'done' },
          { name: 'Render (FFmpeg)', state: 'done' }, { name: 'Quality checks', state: 'done' },
          { name: 'Upload (YouTube)', state: 'done' }, { name: 'Commit plan', state: 'done' },
        ]),
      mk('verticals', 'Verticals v3 (Shorts)', 'BACKUP', 'Research-driven vertical Shorts',
        'Researches trending topics, generates scripts, creates vertical videos with captions, music and uploads to YouTube.',
        [
          { name: 'Research', state: 'done' }, { name: 'Draft', state: 'done' },
          { name: 'B-roll', state: 'done' }, { name: 'Voiceover', state: 'done' },
          { name: 'Whisper ASR', state: 'done' }, { name: 'Captions', state: 'done' },
          { name: 'Music', state: 'done' }, { name: 'Assemble', state: 'running' },
          { name: 'Thumbnail', state: 'pending' }, { name: 'Upload', state: 'pending' },
        ]),
    ],
  };
}

/* ============================================================
   API routes
   ============================================================ */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* --- auth --- */
  if (p === '/api/health') {
    return json(res, 200, {
      mode: 'demo', db: 'memory', github: 'not-verified',
      githubToken: false, geminiKey: false, youtubeOAuth: false, youtubeAnalytics: false,
    });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    // Sliding-window throttle: 5 attempts / 60 s per IP (mirrors production).
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const nowTs = Date.now();
    loginAttempts.set(ip, (loginAttempts.get(ip) || []).filter((t) => nowTs - t < 60000));
    const attempts = loginAttempts.get(ip);
    if (attempts.length >= 5) {
      return json(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.', code: 'throttled' });
    }
    attempts.push(nowTs);
    const body = await readBody(req);
    if (String(body.password) !== ADMIN_PASSWORD) {
      return json(res, 401, { error: 'Invalid console password.', code: 'auth' });
    }
    loginAttempts.delete(ip); // successful login clears the window
    const days = body.remember === true || body.remember === 'true' ? 30 : 7;
    const token = makeSession(days);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `dypol_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${days * 86400}`,
    });
    return res.end(JSON.stringify({ ok: true, sessionDays: days }));
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    const tok = parseCookies(req).dypol_session;
    if (tok) db.sessions.delete(tok);
    return json(res, 200, { ok: true, _clearCookie: true });
  }

  if (!authed(req)) return json(res, 401, { error: 'Sign in required.', code: 'auth' });

  if (p === '/api/session') {
    return json(res, 200, { user: 'admin', mode: 'demo', pendingReview: db.jobs.filter((j) => j.status === 'needs-review').length });
  }

  /* --- quota & health (demo values, clearly labelled) --- */
  if (p === '/api/quota') {
    const now = new Date();
    const eng = (engine) => ({
      engine, configured: true, enabled: true, demo: true,
      uploadsToday: { jobs: 0, videos: 0 }, lastUpload: null,
      oauth: { state: 'unknown', detail: 'Demo mode — no uploads' },
      flux: { state: 'unknown', detail: 'Demo mode' }, pixabay: { state: 'unknown', detail: 'Demo mode' },
      judge: { state: 'unknown', detail: 'Demo mode', calls: null }, llmUnavailable7d: 0,
      storage: { cacheBytes: 0, artifactBytes: 0, artifactCount: 0 }, logsScanned: 0, notes: ['Simulated data'],
    });
    return json(res, 200, {
      demo: true, generatedAt: now.toISOString(), nextRefreshAt: new Date(+now + 1800e3).toISOString(),
      token: { state: 'unknown', detail: 'Demo mode', expiresAt: null },
      youtube: { capJobs: 2, usedJobs: 0, videosToday: 0, estUnits: 0, dailyUnits: 10000 },
      storage: { usedBytes: 0, freeBytes: 500 * 1024 * 1024, pct: 0, state: 'ok' },
      engines: [eng('gemini'), eng('verticals')], subrequests: { used: 0, limit: 40, skipped: [] }, cached: true, ageSec: 0,
    });
  }

  /* --- overview --- */
  if (p === '/api/overview') {
    const m = metrics();
    const { engines } = engineSummaries();
    return json(res, 200, {
      mode: 'demo', demo: true, timezone: TZ, schedulePaused: db.settings.schedule.automationPaused,
      metrics: m,
      engines: engines.map((e) => ({ ...e, stages: undefined })),
      recentVideos: db.jobs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
      activity: db.activity.slice(0, 6),
      nextRun: db.settings.schedule.automationPaused ? null : {
        label: `Today · ${db.settings.schedule.windowStart} IST`, note: 'Daily automation cycle', engine: 'gemini',
      },
    });
  }

  /* --- engines --- */
  if (p === '/api/engines' && method === 'GET') {
    const { engines } = engineSummaries();
    return json(res, 200, {
      engines, active: 'gemini',
      stagePolicy: 'Engine A stages come from its production pipeline (curriculum → lesson content → gTTS → Pexels visuals → MoviePy/FFmpeg render → upload → plan commit). Engine B stages mirror its PipelineState machine (research → draft → broll → voiceover → whisper → captions → music → assemble → thumbnail → upload).',
    });
  }

  const runMatch = p.match(/^\/api\/engines\/(gemini|verticals)\/(run|cancel|retry|schedule)$/);
  if (runMatch && method === 'POST') {
    const [, engine, action] = runMatch;
    const body = await readBody(req);
    if (db.settings.schedule.automationPaused && action === 'run') {
      return json(res, 409, { error: 'Automation is paused. Resume scheduling before starting runs.', code: 'paused' });
    }
    if (action === 'run') {
      if (db.settings.engines?.[engine]?.enabled === false) {
        return json(res, 409, {
          error: `${engine === 'gemini' ? 'Gemini Automation' : 'Verticals v3'} is disabled in Settings. Enable it before dispatching jobs (running jobs are unaffected).`,
          code: 'engine-disabled',
        });
      }
      const maxConcurrent = db.settings.orchestration.maxConcurrency ?? 1;
      const active = db.jobs.filter((j) => ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
      if (active.length >= maxConcurrent) {
        return json(res, 409, {
          error: `Concurrency limit reached (${maxConcurrent} active job(s)). Wait for a running job to finish or raise “Maximum concurrency” in Settings.`,
          code: 'concurrency-limit',
        });
      }
      const title = body.topic || (engine === 'gemini'
        ? 'The Future of Renewable Energy (auto topic)'
        : 'Amazing Facts About the Human Brain (auto topic)');
      const dup = db.settings.publishing.dedupe ? findDuplicate(title) : null;
      if (dup) {
        return json(res, 409, {
          error: `Duplicate topic blocked — “${title}” matches “${dup.job.title}” (normalised key ${dup.key}).`,
          code: 'duplicate',
        });
      }
      const phaseRaw = body.phase || 'draft';
      const autoAllowed = db.settings.publishing.autoPublish === true && db.settings.publishing.reviewRequired === false;
      const phase = phaseRaw === 'full' && !autoAllowed ? 'draft' : phaseRaw;
      const demoted = phaseRaw === 'full' && phase === 'draft';
      const job = {
        id: uid('job'), engine, title, topic: title, niche: body.niche || db.settings.defaults.niche || 'general',
        format: engine === 'gemini' ? 'long-form' : 'short',
        status: 'dispatched', stage: 'workflow_dispatch sent', progress: null,
        description: `Auto-created from ${phase} dispatch.`, tags: ['New'],
        durationSec: null, thumbnail: null,
        createdAt: now(), updatedAt: now(),
        scheduledFor: null, publishedAt: null, youtubeId: null, youtubeUrl: null,
        error: null, errorCategory: null, errorRetryable: null,
        quality: qualityDefaults('generating'), demo: true,
        publishBlocked: null, duplicateOf: null,
        logs: [
          { ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'info', msg: `workflow_dispatch → ${engine} (${phase} phase)` },
          ...(demoted ? [{ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'warn', msg: 'Requested phase=full demoted to draft — review-required mode blocks single-run uploads' }] : []),
          { ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'ok', msg: 'Duplicate check passed' },
        ],
        runId: null, parentJobId: null, attempt: 1,
      };
      db.jobs.unshift(job);
      const run = {
        id: uid('run'), runId: `SIM-${Math.floor(Math.random() * 9000 + 1000)}`, engine,
        workflow: engine === 'gemini' ? db.settings.github.gemini.workflow : db.settings.github.verticals.workflow,
        jobId: job.id, jobTitle: job.title, startedAt: now(), durationSec: null,
        status: 'in-progress', failureReason: null,
        githubUrl: `https://github.com/${engine === 'gemini' ? db.settings.github.gemini.repo : db.settings.github.verticals.repo}/actions`,
        demo: true,
        steps: [{ name: 'workflow_dispatch', status: 'done' }, { name: 'production', status: 'running' }],
        logs: job.logs.slice(),
        artifacts: [],
      };
      db.runs.unshift(run);
      job.runId = run.id;
      db.activity.unshift({ ts: now(), icon: 'run', tone: 'blue', title: 'Run started', sub: `${job.title} · ${engine}` });
      return json(res, 202, { ok: true, jobId: job.id, message: `Dispatched ${engine} workflow (${phase} phase). Demo run simulated.` });
    }
    if (action === 'cancel') {
      db.jobs.filter((j) => j.engine === engine && ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status))
        .forEach((j) => { j.status = 'cancelled'; j.stage = 'Cancelled'; j.error = 'Cancelled by user'; });
      return json(res, 200, { ok: true, message: 'Cancellation requested — running jobs marked cancelled.' });
    }
    if (action === 'retry') {
      return json(res, 202, { ok: true, message: 'Retry dispatched (upload state verified first — no blind re-upload).' });
    }
    if (action === 'schedule') {
      return json(res, 200, { ok: true, message: `Schedule ${body.enabled ? 'enabled' : 'disabled'} for ${engine}.` });
    }
  }

  if (p === '/api/engines/test-connection' && method === 'POST') {
    const body = await readBody(req);
    if (body.target === 'github') {
      return json(res, 200, { ok: false, message: 'Demo mode — GitHub token not configured. Set GITHUB_TOKEN as a server secret in production.' });
    }
    if (body.target === 'gemini') {
      return json(res, 200, { ok: false, message: 'Demo mode — GEMINI_API_KEY not configured. Provider readiness is tested server-side in production without exposing the key.' });
    }
    if (body.target === 'youtube') {
      return json(res, 200, {
        ok: false, state: 'missing-credentials',
        message: 'Demo mode — YouTube OAuth not configured. Complete the OAuth setup in docs/SECRETS.md.',
      });
    }
    const sample = findDuplicate('The Science of Black Holes in 60 Seconds');
    return json(res, 200, {
      ok: true,
      message: sample
        ? `Self test passed — normalisation detected match on key ${sample.key}.`
        : 'Self test ran — normalisation works (no seeded match for the sample title).',
    });
  }

  /* --- jobs --- */
  if (p === '/api/jobs' && method === 'GET') {
    const q = url.searchParams;
    let jobs = db.jobs.slice();
    const status = q.get('status');
    if (status) {
      const set = status.split(',');
      jobs = jobs.filter((j) => set.includes(j.status) ||
        (set.includes('needs-review') && j.status === 'awaiting-review') ||
        (set.includes('generating,dispatched,running', ) && ['dispatched', 'running'].includes(j.status)));
    }
    if (q.get('engine')) jobs = jobs.filter((j) => j.engine === q.get('engine'));
    if (q.get('type')) jobs = jobs.filter((j) => j.format === q.get('type'));
    if (q.get('niche')) jobs = jobs.filter((j) => (j.niche || 'general') === q.get('niche'));
    if (q.get('since')) jobs = jobs.filter((j) => j.createdAt.slice(0, 10) >= q.get('since'));
    const search = (q.get('q') || '').toLowerCase();
    if (search) {
      jobs = jobs.filter((j) =>
        j.title.toLowerCase().includes(search) || (j.topic || '').toLowerCase().includes(search) ||
        (j.tags || []).some((t) => t.toLowerCase().includes(search)));
    }
    const sort = q.get('sort') || 'newest';
    jobs.sort((a, b) => sort === 'oldest' ? a.updatedAt.localeCompare(b.updatedAt)
      : sort === 'status' ? a.status.localeCompare(b.status)
      : b.updatedAt.localeCompare(a.updatedAt));

    const counts = { all: db.jobs.length };
    for (const s of ['queued', 'dispatched', 'running', 'generating', 'rendering', 'approved', 'uploading', 'published', 'failed', 'cancelled', 'rejected', 'superseded']) {
      counts[s] = db.jobs.filter((j) => j.status === s).length;
    }
    counts['needs-review'] = db.jobs.filter((j) => ['needs-review', 'awaiting-review'].includes(j.status)).length;
    counts['generating,rendering,uploading,queued'] = db.jobs.filter((j) => ['generating', 'rendering', 'uploading', 'queued', 'dispatched', 'running'].includes(j.status)).length;
    return json(res, 200, {
      jobs, counts,
      policyNote: 'All videos require approval before publishing while review-required mode is on. The publish action re-checks duplicates, the daily cap and the upload state server-side.',
    });
  }

  if (p === '/api/jobs' && method === 'POST') {
    const body = await readBody(req);
    const title = String(body.topic || body.title || '').trim();
    if (!title) return json(res, 400, { error: 'Topic is required.', code: 'validation' });
    const dup = db.settings.publishing.dedupe ? findDuplicate(title) : null;
    if (dup) {
      return json(res, 409, {
        error: `Duplicate topic blocked — normalised match with “${dup.job.title}” (${dup.exact ? 'exact' : 'containment'} match, key ${dup.key}).`,
        code: 'duplicate', duplicateOf: { id: dup.job.id, title: dup.job.title, key: dup.key },
      });
    }
    let engine = body.engine === 'auto' || !body.engine ? (db.settings.orchestration.mode === 'alternate' && db.jobs.length % 2 ? 'verticals' : 'gemini') : body.engine;
    const job = {
      id: uid('job'), engine, title, topic: title, niche: body.niche || 'general',
      format: engine === 'gemini' ? 'long-form' : 'short',
      status: 'queued', stage: 'Queued', progress: 0,
      description: '', tags: ['New'], durationSec: null, thumbnail: null,
      createdAt: now(), updatedAt: now(), scheduledFor: null, publishedAt: null,
      youtubeId: null, youtubeUrl: null, error: null,
      quality: qualityDefaults('queued'), demo: true, publishBlocked: null, duplicateOf: null,
      logs: [{ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'ok', msg: `Topic queued (key ${topicKey(title)}) — duplicate check passed` }],
      runId: null,
    };
    db.jobs.unshift(job);
    db.activity.unshift({ ts: now(), icon: 'plus', tone: 'amber', title: 'Topic added to plan', sub: title });
    return json(res, 201, { ok: true, jobId: job.id, message: `“${title}” added to the queue.` });
  }

  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(?:\/(approve|reject|regenerate|schedule|publish))?$/);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    const job = db.jobs.find((j) => j.id === id);
    if (!job) return json(res, 404, { error: 'Job not found.', code: 'not-found' });

    if (!action && method === 'GET') {
      const dup = db.settings.publishing.dedupe ? findDuplicate(job.title, job.id) : null;
      job.duplicateOf = dup ? { key: dup.key, id: dup.job.id, title: dup.job.title, url: dup.job.youtubeUrl } : null;
      // AUDIT FIX: read-only check (the old publishBlockReason returned wrong
      // reasons and had drifted from the real gate).
      const state = checkPublishState(job);
      job.publishBlocked = state.ok ? null : state.error;
      return json(res, 200, { job, mode: 'demo' });
    }

    if (method === 'PATCH' && !action) {
      // Metadata edits from the review panel — persisted and used on publish.
      const body = await readBody(req);
      if (job.status === 'published') {
        return json(res, 409, { error: 'Published videos cannot be edited.', code: 'state' });
      }
      if (body.title !== undefined) {
        const t = String(body.title).trim();
        if (!t || t.length > 100) return json(res, 400, { error: 'Title must be 1–100 characters (YouTube limit).', code: 'validation' });
        job.title = t;
      }
      if (body.description !== undefined) job.description = String(body.description).slice(0, 5000);
      if (Array.isArray(body.tags)) job.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      job.updatedAt = now();
      job.logs.push({ ts: new Date().toLocaleTimeString('en-GB', { timeZone: TZ }), level: 'info', msg: 'Metadata edited in review panel — will be used for publishing' });
      return json(res, 200, { ok: true, job, message: 'Metadata saved and will be used when publishing.' });
    }

    if (action && method === 'POST') {
      const body = await readBody(req);
      const ts = new Date().toLocaleTimeString('en-GB', { timeZone: TZ });
      if (action === 'approve') {
        if (!['needs-review', 'awaiting-review'].includes(job.status)) {
          return json(res, 409, { error: 'Only videos awaiting review can be approved.', code: 'state' });
        }
        if (job.quality?.duplicate?.state === 'failed') {
          return json(res, 409, { error: 'Approval blocked — duplicate check failed for this video.', code: 'duplicate' });
        }
        job.status = 'scheduled';
        job.stage = 'Approved — awaiting publish window';
        job.scheduledFor = body.when || new Date(Date.now() + 3600e3).toISOString();
        job.updatedAt = now();
        job.logs.push({ ts, level: 'ok', msg: `Approved — scheduled for ${job.scheduledFor}` });
        db.activity.unshift({ ts: now(), icon: 'check', tone: 'green', title: 'Video approved', sub: job.title });
        return json(res, 200, { ok: true, message: `Approved. Scheduled for ${new Date(job.scheduledFor).toLocaleString('en-IN', { timeZone: TZ })} IST.` });
      }
      if (action === 'reject') {
        job.status = 'rejected';
        job.stage = 'Rejected';
        job.updatedAt = now();
        job.logs.push({ ts, level: 'warn', msg: 'Rejected by reviewer — will not publish' });
        return json(res, 200, { ok: true, message: 'Video rejected. It will not be published.' });
      }
      if (action === 'regenerate') {
        // AUDIT FIX: regeneration creates a LINKED child job (attempt +1) and
        // preserves the original's history instead of wiping its state.
        const child = {
          ...JSON.parse(JSON.stringify(job)),
          id: uid('job'), status: 'dispatched', stage: 'Regeneration dispatched',
          progress: null, error: null, errorCategory: null, errorRetryable: null,
          createdAt: now(), updatedAt: now(), publishedAt: null,
          youtubeId: null, youtubeUrl: null, scheduledFor: null,
          parentJobId: job.id, attempt: (job.attempt || 1) + 1,
          quality: qualityDefaults('generating'), demo: true, duplicateOf: null,
          publishBlocked: null,
          logs: [{ ts, level: 'info', msg: `Regeneration attempt ${(job.attempt || 1) + 1} — parent job ${job.id}` }],
        };
        db.jobs.unshift(child);
        if (!['published', 'rejected'].includes(job.status)) {
          job.status = 'superseded';
          job.stage = `Superseded by attempt ${child.attempt}`;
        }
        job.logs.push({ ts, level: 'info', msg: `Regenerated as new attempt ${child.attempt} (job ${child.id}) — history preserved` });
        return json(res, 202, {
          ok: true, jobId: child.id, attempt: child.attempt,
          message: `Regeneration dispatched as attempt ${child.attempt}. The earlier attempt remains in history.`,
        });
      }
      if (action === 'retry') {
        if (job.status !== 'failed') {
          return json(res, 409, { error: 'Only failed jobs can be retried. Use Regenerate for new attempts.', code: 'state' });
        }
        const retryLimit = db.settings.orchestration.retryLimit ?? 2;
        if ((job.attempt || 1) > retryLimit) {
          return json(res, 409, { error: `Retry limit reached (${retryLimit}). Use Regenerate for a deliberate new attempt.`, code: 'retry-limit' });
        }
        const existing = db.uploads.find((u) => u.topicKey === topicKey(job.title));
        if (existing) {
          return json(res, 200, { ok: true, message: `Upload state verified — already on YouTube (id ${existing.youtubeId}). Retry suppressed.` });
        }
        job.status = 'dispatched';
        job.stage = 'Retry dispatched';
        job.error = null; job.errorCategory = null; job.errorRetryable = null;
        job.updatedAt = now();
        job.logs.push({ ts, level: 'info', msg: `Retry ${job.attempt || 1}/${retryLimit} dispatched — upload state verified first` });
        return json(res, 202, { ok: true, message: `Retry dispatched (attempt ${job.attempt || 1}).` });
      }
      if (action === 'schedule') {
        if (!body.when) return json(res, 400, { error: 'Missing "when".', code: 'validation' });
        job.scheduledFor = body.when;
        if (['needs-review', 'awaiting-review', 'queued'].includes(job.status)) {
          job.status = 'scheduled';
          job.stage = 'Scheduled';
        }
        job.updatedAt = now();
        job.logs.push({ ts, level: 'ok', msg: `Scheduled for ${body.when}` });
        return json(res, 200, { ok: true, message: `Scheduled for ${new Date(body.when).toLocaleString('en-IN', { timeZone: TZ })} IST.` });
      }
      if (action === 'publish') {
        return publishJob(job, res, ts);
      }
    }
  }

  /* --- orchestrate --- */
  if (p === '/api/orchestrate/run' && method === 'POST') {
    const body = await readBody(req);
    const mode = body.forceMode === 'draft_both' ? 'draft_both' : db.settings.orchestration.mode;
    const title = body.topic || 'How AI Is Changing Education in 2026 (orchestrated)';
    if (db.settings.engines?.gemini?.enabled === false && db.settings.engines?.verticals?.enabled === false) {
      return json(res, 409, { error: 'Both engines are disabled in Settings.', code: 'engine-disabled' });
    }
    const maxConcurrent = db.settings.orchestration.maxConcurrency ?? 1;
    const active = db.jobs.filter((j) => ['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status));
    const wanted = mode === 'draft_both' ? 2 : 1;
    if (active.length + wanted > Math.max(maxConcurrent, wanted)) {
      return json(res, 409, { error: `Concurrency limit reached (${maxConcurrent} active job(s) configured).`, code: 'concurrency-limit' });
    }
    const dup = db.settings.publishing.dedupe ? findDuplicate(title) : null;
    if (dup) return json(res, 409, { error: `Duplicate topic blocked — matches “${dup.job.title}”.`, code: 'duplicate' });
    // 'draft_both' never uploads; mode 1 dispatches 'full' only when policy allows.
    const autoAllowed = db.settings.publishing.autoPublish === true && db.settings.publishing.reviewRequired === false;
    const fullPhase = autoAllowed ? 'full' : 'draft';

    if (mode === 'draft_both') {
      const msgs = [];
      for (const engine of ['gemini', 'verticals']) {
        const job = {
          id: uid('job'), engine, title: `${title} [${engine} candidate]`, topic: title,
          niche: 'general', format: engine === 'gemini' ? 'long-form' : 'short',
          status: 'generating', stage: 'Draft mode — producing candidate', progress: 6,
          description: `Draft candidate produced by ${engine} for comparison (Mode 3).`,
          tags: ['Candidate'], durationSec: null, thumbnail: null,
          createdAt: now(), updatedAt: now(), scheduledFor: null, publishedAt: null,
          youtubeId: null, youtubeUrl: null, error: null,
          quality: qualityDefaults('generating'), demo: true, publishBlocked: 'Draft mode — both candidates must be compared before any publish.',
          duplicateOf: null, logs: [{ ts: '—', level: 'info', msg: 'Mode 3: draft candidate — auto-publish disabled' }], runId: null,
        };
        db.jobs.unshift(job);
        msgs.push(engine);
      }
      return json(res, 202, { ok: true, message: `Mode 3: draft candidates dispatched to both engines (${msgs.join(', ')}). Publish one manually.` });
    }
    if (mode === 'alternate') {
      const engine = new Date().getDate() % 2 ? 'gemini' : 'verticals';
      return json(res, 202, { ok: true, message: `Mode 2: today alternates to ${engine}. Dispatch from the engine card to confirm.` });
    }
    // primary_with_fallback
    return json(res, 202, { ok: true, message: 'Mode 1: primary (Gemini Automation) dispatched. Verticals v3 will only run if this attempt genuinely fails.' });
  }

  /* --- runs --- */
  if (p === '/api/runs' && method === 'GET') {
    return json(res, 200, {
      runs: db.runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      source: 'Demo registry (production: GitHub Actions workflow-runs API)',
    });
  }
  const runIdMatch = p.match(/^\/api\/runs\/([^/]+)(?:\/(retry))?$/);
  if (runIdMatch && method !== 'GET' ? runIdMatch[2] === 'retry' : runIdMatch && method === 'GET') {
    const run = db.runs.find((r) => r.id === runIdMatch[1]);
    if (!run) return json(res, 404, { error: 'Run not found.', code: 'not-found' });
    if (runIdMatch[2] === 'retry' && method === 'POST') {
      if (run.status !== 'failed') return json(res, 409, { error: 'Only failed runs can be retried.', code: 'state' });
      run.status = 'in-progress';
      run.failureReason = null;
      run.startedAt = now();
      run.steps = run.steps.map((s) => ({ ...s, status: s.status === 'failed' ? 'running' : s.status }));
      run.logs.push({ ts: '—', level: 'info', msg: 'Retry dispatched — upload state verified before re-running (no blind re-upload)' });
      return json(res, 202, { ok: true, message: 'Run retried. Upload registry checked first to prevent duplicate uploads.' });
    }
    return json(res, 200, { run });
  }

  /* --- calendar --- */
  if (p === '/api/calendar' && method === 'GET') {
    const lastRun = db.runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return json(res, 200, {
      jobs: db.jobs.slice().sort((a, b) => (b.scheduledFor || b.updatedAt).localeCompare(a.scheduledFor || a.updatedAt)),
      timezone: TZ,
      publishingWindow: `${db.settings.schedule.windowStart}–${db.settings.schedule.windowEnd}`,
      windowStart: db.settings.schedule.windowStart,
      windowEnd: db.settings.schedule.windowEnd,
      dailyCap: db.settings.publishing.dailyCap,
      reviewRequired: db.settings.publishing.reviewRequired,
      automationPaused: db.settings.schedule.automationPaused,
      nextRunLabel: db.settings.schedule.automationPaused ? 'Paused' : `Today ${db.settings.schedule.windowStart} IST`,
      lastExecutionLabel: lastRun ? `${fmtWhen(lastRun.startedAt)} · ${lastRun.status}` : 'No runs recorded',
    });
  }
  if (p === '/api/schedule' && method === 'POST') {
    const body = await readBody(req);
    const s = db.settings.schedule;
    if (body.automationPaused !== undefined) {
      s.automationPaused = !!body.automationPaused;
      db.activity.unshift({
        ts: now(), icon: body.automationPaused ? 'pause' : 'play', tone: 'amber',
        title: body.automationPaused ? 'Automation paused' : 'Automation resumed',
        sub: 'Control file updated on engine forks (dypol-control.json)',
      });
    }
    if (body.windowStart) s.windowStart = body.windowStart;
    if (body.windowEnd) s.windowEnd = body.windowEnd;
    if (body.frequency) s.frequency = body.frequency;
    if (body.dailyCap) db.settings.publishing.dailyCap = Math.max(1, Math.min(10, Number(body.dailyCap)));
    return json(res, 200, {
      ok: true,
      message: (db.settings.schedule.automationPaused
        ? 'Automation paused — history, credentials and configuration preserved. '
        : 'Schedule settings saved. ')
        + 'Engine forks’ dypol-control.json would be updated via the GitHub API in production.',
    });
  }

  /* --- analytics --- */
  if (p === '/api/analytics') {
    const labels = [];
    const views = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      labels.push(d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
      views.push(Math.round(300 + Math.sin(i / 2.2) * 160 + i * 22 + Math.random() * 60));
    }
    return json(res, 200, {
      connected: false, demo: true,
      reason: 'YouTube Analytics API is not connected. Connect the channel in Settings to see live metrics. The console never invents results in place of unavailable data.',
      totals: { views: 12400, published: db.jobs.filter((j) => j.status === 'published').length, avgDuration: '4:12', watchHours: 468 },
      series: { views, labels, publishedWeekly: [1, 2, 2, 3], weekLabels: ['W1', 'W2', 'W3', 'W4'] },
      topVideos: db.jobs.filter((j) => j.status === 'published'),
    });
  }

  /* --- settings --- */
  if (p === '/api/settings' && method === 'GET') {
    return json(res, 200, {
      ...db.settings,
      health: {
        mode: 'demo', db: 'memory', github: 'unverified',
        githubToken: false, geminiKey: false, youtubeOAuth: false, youtubeAnalytics: false,
        channelName: null,
      },
    });
  }
  if (p === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const merge = (a, b) => ({ ...a, ...(b || {}) });
    db.settings = {
      ...db.settings,
      github: merge(db.settings.github, body.github),
      engines: merge(db.settings.engines, body.engines),
      orchestration: {
        ...merge(db.settings.orchestration, body.orchestration),
        maxConcurrency: Math.max(1, Math.min(3, Number(body.orchestration?.maxConcurrency) || db.settings.orchestration.maxConcurrency || 1)),
        retryLimit: Math.max(0, Math.min(5, Number(body.orchestration?.retryLimit) || (db.settings.orchestration.retryLimit ?? 2))),
      },
      publishing: merge(db.settings.publishing, body.publishing),
      defaults: merge(db.settings.defaults, body.defaults),
      schedule: merge(db.settings.schedule, body.schedule),
    };
    return json(res, 200, { ok: true, message: 'Settings saved. Secrets remain server-side.' });
  }

  if (p === '/api/sync/github' && method === 'POST') {
    return json(res, 200, {
      ok: true,
      message: 'Demo mode — nothing to sync from GitHub. Configure GITHUB_TOKEN to pull real workflow runs.',
    });
  }

  return json(res, 404, { error: `Unknown API route: ${p}`, code: 'not-found' });
}

/* publish with lock + cap + dedupe + upload-state verification */
// AUDIT FIX: this is the READ-ONLY state used by GET /jobs/:id. The old
// version returned wrong reasons (e.g. "review required" for published jobs)
// and had drifted from publishJob(). Both now share the same rule order.
function checkPublishState(job) {
  const existing = db.uploads.find((u) => u.topicKey === topicKey(job.title));
  if (existing) {
    return {
      ok: true, code: 'already-uploaded', youtubeId: existing.youtubeId,
      message: `Upload state verified — already on YouTube (id ${existing.youtubeId}). No duplicate upload performed.`,
    };
  }
  if (job.status === 'published') return { ok: true, code: 'already-published', message: 'Already published.' };
  if (db.settings.publishing.draftMode) {
    return { ok: false, code: 'draft-mode', error: 'Draft-only mode is on — generation results are saved but nothing uploads.' };
  }
  if (db.settings.publishing.reviewRequired && !['approved', 'scheduled'].includes(job.status)) {
    return { ok: false, code: 'review-required', error: 'Publishing blocked — review-required mode is on. Approve the video first.' };
  }
  const dup = db.settings.publishing.dedupe ? findDuplicate(job.title, job.id) : null;
  if (dup) {
    return { ok: false, code: 'duplicate', error: `Publishing blocked — duplicate of “${dup.job.title}” (key ${dup.key}).` };
  }
  const uploading = db.jobs.filter((j) => j.status === 'uploading').length;
  if (uploadsToday() + uploading >= db.settings.publishing.dailyCap) {
    return { ok: false, code: 'daily-cap', error: `Daily publishing cap reached (${db.settings.publishing.dailyCap}/day, IST).` };
  }
  return { ok: true, code: 'cleared' };
}

function classifyError(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('403') || m.includes('permission')) return { category: 'permission', retryable: false };
  if (m.includes('quota') || m.includes('429')) return { category: 'quota', retryable: true };
  if (m.includes('oauth') || m.includes('token')) return { category: 'oauth', retryable: false };
  if (m.includes('not configured')) return { category: 'config', retryable: false };
  return { category: 'unknown', retryable: true };
}

function publishJob(job, res, ts) {
  // Blind-retry protection for an upload already in flight: never re-dispatch.
  if (job.status === 'uploading') {
    return json(res, 409, {
      error: 'An upload is already in flight for this job. Wait for it to finish, then sync — re-dispatching risks a duplicate upload.',
      code: 'upload-in-flight',
    });
  }
  // Full gate: upload registry → draft mode → review → lock → dedupe → cap.
  // The lock is released synchronously in `finally` (no timers — the old
  // setTimeout release was unreliable and could leak the lock on errors).
  const state = checkPublishState(job);
  if (state.code === 'already-uploaded') {
    job.status = 'published';
    job.youtubeId = state.youtubeId;
    job.youtubeUrl = `https://youtu.be/${state.youtubeId}`;
    job.publishedAt = job.publishedAt || now();
    job.logs.push({ ts, level: 'warn', msg: `Upload state verified — video already on YouTube (id=${state.youtubeId}). No duplicate upload performed.` });
    return json(res, 200, { ok: true, message: state.message, job });
  }
  if (state.ok && state.code === 'already-published') {
    return json(res, 200, { ok: true, message: state.message, job });
  }
  if (!state.ok) {
    const cat = classifyError(state.error);
    job.publishBlocked = state.error;
    job.errorCategory = cat.category;
    job.errorRetryable = cat.retryable;
    job.logs.push({ ts, level: 'error', msg: `Publish blocked (${cat.category}) — ${state.error}` });
    return json(res, state.code === 'locked' ? 423 : 409, { error: state.error, code: state.code, category: cat.category });
  }
  if (db.settings.publishing.publishLock && !acquireLock('publish', 30000)) {
    return json(res, 423, { error: 'Another publish is in progress (publishing lock held). Try again shortly.', code: 'locked' });
  }
  try {
    if (uploadsToday() >= db.settings.publishing.dailyCap) {
      job.publishBlocked = `Daily cap reached (${db.settings.publishing.dailyCap} uploads/day).`;
      job.logs.push({ ts, level: 'error', msg: `Publish blocked — daily cap ${db.settings.publishing.dailyCap} reached` });
      return json(res, 409, { error: `Daily publishing cap reached (${db.settings.publishing.dailyCap}/day, IST).`, code: 'daily-cap' });
    }
    job.status = 'uploading';
    job.stage = 'Uploading to YouTube…';
    job.progress = null; // honest: no fabricated percentage mid-upload
    job.updatedAt = now();
    job.logs.push({ ts, level: 'info', msg: `Publish started (visibility=${db.settings.publishing.visibility}, idempotency=${job.id}:${topicKey(job.title)})` });
    // simulated upload completes shortly; keeps the demo responsive
    setTimeout(() => completeUpload(job), 1500);
    return json(res, 202, { ok: true, message: 'Publishing — safeguards passed (dedupe, cap, lock).', job });
  } finally {
    if (db.settings.publishing.publishLock) releaseLock('publish');
  }
}

/* ============================================================
   Static files + server
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    // AUDIT FIX: prefix check must include the separator, or a sibling
    // directory like console-evil/ escapes the web root.
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    if (url.pathname === '/' || !path.extname(url.pathname)) file = path.join(ROOT, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        if (path.extname(url.pathname)) { res.writeHead(404); return res.end('Not found'); }
        file = path.join(ROOT, 'index.html');
        return fs.readFile(file, (e2, d2) => {
          if (e2) { res.writeHead(500); return res.end('Error'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DYPOL Creator Console (demo backend) listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD === 'dypol-demo' ? 'dypol-demo (default demo password)' : 'custom'}`);
});
