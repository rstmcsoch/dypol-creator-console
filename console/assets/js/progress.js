/* Live run progress — polls GET /api/jobs/:id/progress (or /api/runs/:id/progress)
   every ~7 s while a job is running and renders step-by-step progress
   (step name, status, elapsed) with a link to the GitHub Actions run.
   Data is pushed into D1 by the GitHub webhook; the poll itself is D1-only.
   Polling stops when the job is done, the drawer closes, the panel is
   replaced (another job opened / page changed) or the endpoint is missing. */
import { icon, esc, statusPill, fmtDuration } from './ui.js';

const POLL_MS = 7000;
let activeTimer = null;
let activeToken = 0;

export function stopProgress() {
  if (activeTimer) clearTimeout(activeTimer);
  activeTimer = null;
  activeToken++;
}

function stepIcon(status) {
  return status === 'done' ? 'check' : status === 'failed' ? 'x' : status === 'running' ? 'refresh' : 'clock';
}
function stepClass(status) {
  return status === 'failed' ? 'is-bad' : status === 'running' ? 'is-warn' : ['skipped', 'cancelled', 'pending'].includes(status) ? 'is-off' : '';
}
function liveElapsed(startedAt, completedAt, fallback) {
  if (!startedAt) return fallback ?? null;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
}

export function renderProgress(p) {
  if (!p) return '';
  const run = p.run;
  const steps = (p.jobs || []).flatMap((j) => (j.steps || []).map((s) => ({ ...s, job: j.name })));
  const multiJob = (p.jobs || []).length > 1;
  const done = p.done;
  const failed = p.jobStatus === 'failed' || !!p.failingStep;
  const left = minutesLeft(p);
  const head = `
    <div class="prog">
      <div class="prog__line">
        <strong>${done ? (failed ? 'Stopped' : 'Finished') : (p.stepsTotal ? `Step ${Math.min((p.stepsFinished || 0) + 1, p.stepsTotal)} of ${p.stepsTotal}` : 'Being made')}</strong>
        ${!done && p.currentStep ? `<span>· ${esc(plainStep(p.currentStep))}</span>` : ''}
        ${!done ? `<span class="muted">· ${left ? `about ${left} min left` : 'usually about 15 min in total'}</span>` : ''}
        ${run?.neverStarted ? '<span class="muted">· the cloud never started it</span>' : run?.startedAt && !(done && !run.completedAt)
          ? `<span class="muted">· ${done ? 'took' : 'running for'} ${esc(fmtDuration(liveElapsed(run.startedAt, run.completedAt, run.elapsedSec)))}</span>` : ''}
      </div>
      ${typeof p.percent === 'number' && !done
        ? `<div class="progress progress--lg" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress__bar" style="width:${p.percent}%"></div></div>` : ''}
      ${!done ? `<div class="tiny muted">${icon('refresh', 'icon--sm')} Updates by itself every ${Math.round((p.pollAfterMs || POLL_MS) / 1000)} seconds.</div>` : ''}
    </div>`;
  const fail = failed ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Stopped${p.failingStep ? ` while “${esc(plainStep(p.failingStep))}”` : ''}.</strong> ${esc(run?.failureReason || p.error || '')}</div></div>` : '';
  const list = steps.length ? `<details class="mini-details"><summary>All steps (${steps.length})${run?.htmlUrl ? '' : ''}</summary>
      <div class="qc" style="margin-top:8px">${steps.map((s) => `
      <div class="qc__row ${stepClass(s.status)}">
        ${icon(stepIcon(s.status), 'icon--sm')}
        <span>${multiJob ? `<span class="muted">${esc(s.job)} › </span>` : ''}${esc(s.name)}</span><span class="spacer"></span>
        <span class="tiny" style="margin-right:6px">${s.startedAt ? esc(fmtDuration(liveElapsed(s.startedAt, s.completedAt, s.elapsedSec))) : ''}</span>
        <span class="pill">${esc(s.status)}</span>
      </div>`).join('')}</div>
      ${run?.htmlUrl ? `<a class="btn btn--ghost btn--sm" style="margin-top:8px" href="${esc(run.htmlUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} Open this run in GitHub</a>` : ''}
    </details>`
    : `<div class="tiny muted">${done ? 'No step details were received for this video.' : 'Waiting for the first update from the cloud… (Settings → Advanced → Technical history → Refresh from the cloud, if this takes long.)'}</div>`;
  return head + fail + list;
}

/**
 * Mount a polling progress panel into `el`.
 *  url: progress endpoint; onDone(progress): called once when the job finishes
 *  (e.g. to refresh the list); initial: when false, a non-running job renders
 *  nothing and does not poll.
 */
export function mountProgress(el, url, { onDone, showWhenDone = true } = {}) {
  stopProgress();
  if (!el) return;
  const token = activeToken;
  let wasRunning = false;
  const drawerOpen = () => document.getElementById('drawer')?.classList.contains('is-open');

  const tick = async () => {
    if (token !== activeToken || !el.isConnected || !drawerOpen()) { if (token === activeToken) stopProgress(); return; }
    let p = null;
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) { // endpoint missing (dev server) or job gone — stop quietly
        if (!wasRunning) el.innerHTML = '';
        stopProgress();
        return;
      }
      p = (await res.json())?.progress;
    } catch {
      // transient network error: retry on the next tick
    }
    if (token !== activeToken || !el.isConnected) return;
    if (p) {
      if (!p.done) wasRunning = true;
      el.innerHTML = (!p.done || showWhenDone) && (p.run || !p.done) ? renderProgress(p) : '';
      if (p.done) {
        stopProgress();
        if (wasRunning && onDone) onDone(p);
        return;
      }
    }
    activeTimer = setTimeout(tick, (p && p.pollAfterMs) || POLL_MS);
  };
  tick();
}

/* ---------------- Plain progress line (Home + Videos cards) ---------------- */
const STEP_WORDS = [
  [/checkout|set up|setup|install|restore|credential|cache|python|node|patch/i, 'Getting ready'],
  [/research|curriculum|topic|plan/i, 'Choosing the topic'],
  [/draft|script|lesson|content|writ/i, 'Writing the script'],
  [/tts|voice|narrat|audio|whisper|asr/i, 'Recording the voice'],
  [/caption|subtit|srt/i, 'Adding captions'],
  [/broll|b-roll|visual|image|pixabay|flux|frame|judge/i, 'Making the visuals'],
  [/music/i, 'Adding music'],
  [/render|assemble|moviepy|ffmpeg|produce|production|pipeline/i, 'Putting the video together'],
  [/thumb/i, 'Making the thumbnail'],
  [/upload|artifact|preview|report|commit|result/i, 'Saving the video'],
];
/** "Making the visuals" etc. for a raw step name. */
export function plainStep(name) {
  const n = String(name || '');
  for (const [re, w] of STEP_WORDS) if (re.test(n)) return w;
  return n ? 'Working' : '';
}
/** Rough minutes left from elapsed time and percent; null when unknown. */
export function minutesLeft(p) {
  const pct = typeof p?.percent === 'number' ? p.percent : null;
  const started = p?.run?.startedAt ? Date.parse(p.run.startedAt) : null;
  if (!pct || pct < 10 || pct >= 100 || !started) return null;
  const elapsed = (Date.now() - started) / 60000;
  const left = (elapsed * (100 - pct)) / pct;
  return Math.max(1, Math.round(left));
}
/** One plain line, e.g. "Step 3 of 6 · Making the visuals · about 5 min left". */
export function progressLine(job, p) {
  if (job?.status === 'queued') return 'In line — it starts on its own.';
  if (job?.status === 'dispatched') return 'Starting… usually within a minute.';
  if (job?.status === 'uploading') return 'Uploading to YouTube — about a minute.';
  const parts = [];
  if (p?.stepsTotal) parts.push(`Step ${Math.min((p.stepsFinished || 0) + 1, p.stepsTotal)} of ${p.stepsTotal}`);
  const w = plainStep(p?.currentStep);
  if (w) parts.push(w);
  const m = minutesLeft(p);
  if (m) parts.push(`about ${m} min left`);
  else if (!parts.length && typeof job?.progress === 'number') parts.push(`${Math.round(job.progress)}% done`);
  if (!m) parts.push('usually about 15 min in total');
  return parts.join(' · ');
}
export async function fetchProgress(jobId) {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/progress`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json())?.progress || null;
  } catch { return null; }
}
