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
  const head = `
    <div class="row row--wrap" style="gap:8px;margin-bottom:8px;align-items:center">
      <strong class="small">Live progress</strong>
      ${run ? statusPill(run.status) : ''}
      ${!p.done ? `<span class="tiny muted">${icon('refresh', 'icon--sm')} updating every ${Math.round((p.pollAfterMs || POLL_MS) / 1000)} s</span>` : ''}
      <span class="spacer" style="flex:1"></span>
      ${run?.htmlUrl ? `<a class="btn btn--ghost btn--sm" href="${esc(run.htmlUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} GitHub run</a>` : ''}
    </div>
    <div class="tiny muted" style="margin-bottom:8px">
      ${typeof p.percent === 'number' ? `<strong>${p.percent}%</strong> · ` : ''}
      ${p.currentStep ? `${p.done ? 'Last step' : 'Current step'}: <strong>${esc(p.currentStep)}</strong> · ` : ''}
      ${p.stepsTotal ? `${p.stepsFinished}/${p.stepsTotal} steps finished · ` : ''}
      ${run?.neverStarted ? 'GitHub never started this run' : run?.startedAt && !(p.done && !run.completedAt)
        ? `elapsed ${esc(fmtDuration(liveElapsed(run.startedAt, run.completedAt, run.elapsedSec)))}` : ''}
    </div>`;
  const failing = p.failingStep || (p.jobStatus === 'failed' && run?.failureReason);
  const fail = failing ? `<div class="callout callout--danger" style="margin-bottom:8px">${icon('alert')}<div><strong>Failed${p.failingStep ? ` at step: ${esc(p.failingStep)}` : ''}.</strong> ${esc(run?.failureReason || p.error || '')}</div></div>` : '';
  const bar = typeof p.percent === 'number' && !p.done
    ? `<div class="progress" style="margin-bottom:8px" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress__bar" style="width:${p.percent}%"></div></div>` : '';
  const list = steps.length ? `<div class="qc">${steps.map((s) => `
      <div class="qc__row ${stepClass(s.status)}">
        ${icon(stepIcon(s.status), 'icon--sm')}
        <span>${multiJob ? `<span class="muted">${esc(s.job)} › </span>` : ''}${esc(s.name)}</span><span class="spacer"></span>
        <span class="tiny" style="margin-right:6px">${s.startedAt ? esc(fmtDuration(liveElapsed(s.startedAt, s.completedAt, s.elapsedSec))) : ''}</span>
        <span class="pill">${esc(s.status)}</span>
      </div>`).join('')}</div>`
    : `<div class="tiny muted">${p.done ? 'No step data was received for this run.' : 'Waiting for the first step update from GitHub… (Sync GitHub runs is the fallback if webhooks are not delivering.)'}</div>`;
  return head + bar + fail + list;
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
