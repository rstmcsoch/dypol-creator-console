/* Technical history (Advanced) — every cloud run with steps, logs, files and IDs.
   Same data and actions as the old Run History, in plain words, no sideways scrolling. */
import { api } from '../api.js';
import {
  icon, esc, statusPill, enginePill, fmtDateTime, fmtDuration, toast, openDrawer,
  renderLogs, emptyState, confirmModal, errorToast, makerName,
} from '../ui.js';
import { mountProgress } from '../progress.js';

function runDrawer(r) {
  const failedStep = (r.steps || []).find((s) => s.status === 'failed');
  const body = `
    <div class="row row--wrap" style="gap:8px">
      ${enginePill(r.engine)}
      ${statusPill(r.status === 'queued' ? 'dispatched' : r.status)}
      ${r.demo ? '<span class="pill pill--accent">Demo record</span>' : ''}
    </div>
    <dl class="kv">
      <dt>Reference</dt><dd class="mono">${esc(r.runId)}</dd>
      <dt>Cloud file</dt><dd class="mono">${esc(r.workflow)}</dd>
      <dt>Video</dt><dd>${r.jobId ? `<a href="#/videos?job=${encodeURIComponent(r.jobId)}">${esc(r.jobTitle || r.jobId)}</a>` : '—'}</dd>
      <dt>Started</dt><dd>${esc(fmtDateTime(r.startedAt))}</dd>
      <dt>Took</dt><dd>${esc(fmtDuration(r.durationSec))}</dd>
      <dt>Result</dt><dd>${statusPill(r.status === 'queued' ? 'dispatched' : r.status)}</dd>
      ${r.failureReason ? `<dt>What went wrong</dt><dd style="color:var(--red)">${esc(r.failureReason)}</dd>` : ''}
    </dl>
    ${r.demo ? '' : '<div id="run-progress" aria-live="polite"></div>'}
    ${failedStep ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Stopped at: ${esc(failedStep.name)}.</strong> ${esc(failedStep.note || 'See the log below.')}</div></div>` : ''}
    <div>
      <strong class="small">Steps</strong>
      ${(r.steps || []).length ? '' : '<div class="tiny muted" style="margin-top:6px">No step details were recorded for this run.</div>'}
      <div class="qc" style="margin-top:8px">
        ${(r.steps || []).map((s) => `
          <div class="qc__row ${s.status === 'failed' ? 'is-bad' : s.status === 'running' ? 'is-warn' : s.status === 'skipped' ? 'is-off' : ''}">
            ${icon(s.status === 'done' ? 'check' : s.status === 'failed' ? 'x' : s.status === 'running' ? 'refresh' : 'clock', 'icon--sm')}
            <span>${esc(s.name)}</span><span class="spacer"></span>
            <span class="pill">${esc(s.status)}</span>
          </div>`).join('')}
      </div>
    </div>
    <div>
      <strong class="small">Log</strong>
      <div style="margin-top:8px">${renderLogs(r.logs || [])}</div>
    </div>
    ${(r.artifacts || []).length ? `
      <div>
        <strong class="small">Files</strong>
        <div class="row row--wrap" style="margin-top:8px">
          ${r.artifacts.map((a) => `<span class="pill pill--outline">${icon('doc', 'icon--sm')} ${esc(a.name)} (${esc(a.size || '?')})</span>`).join('')}
        </div>
      </div>` : ''}`;
  const foot = `
    ${r.githubUrl ? `<a class="btn btn--secondary btn--sm" href="${esc(r.githubUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} Open in GitHub</a>` : ''}
    <button class="btn btn--primary btn--sm" data-ract="retry" ${r.status === 'failed' ? '' : 'aria-disabled="true" data-why="Only a run that didn’t finish can be tried again."'}>${icon('refresh', 'icon--sm')} Try again</button>`;
  openDrawer({ title: 'Run details', body, foot });
  document.getElementById('drawer').dataset.kind = '';
  // Poll live progress only while the run is active; refresh the table when it ends.
  if (['in-progress', 'queued'].includes(r.status)) {
    mountProgress(document.getElementById('run-progress'), `/api/runs/${encodeURIComponent(r.id)}/progress`, {
      onDone: () => { refresh().catch(() => {}); },
    });
  }
  document.getElementById('drawer-foot').onclick = async (e) => {
    const b = e.target.closest('[data-ract="retry"]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    if (!await confirmModal('Try this run again?', '<p>Starts it again with the latest version of the video maker. Nothing goes on YouTube until you approve it.</p>', 'Try again', false, 'Not now')) return;
    try {
      await api.retryRun(r.id);
      toast('Trying again', 'Follow it on Home.', 'ok');
      await refresh();
    } catch (err) { errorToast(err, 'Couldn’t try again'); }
  };
}

async function refresh() {
  const root = document.getElementById('page-root');
  const data = await api.runs();
  const runs = data.runs || [];

  root.innerHTML = `
    <a class="back-link" href="#/settings">${icon('chevronL', 'icon--sm')} Settings</a>
    <div class="page-head">
      <div>
        <h1>Technical history</h1>
        <div class="sub">Every time a video maker ran in the cloud, with steps and logs. Useful when something didn’t finish.</div>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--secondary" id="btn-sync">${icon('refresh', 'icon--sm')} Refresh from the cloud</button>
      </div>
    </div>
    <div class="tiny muted" style="margin:-8px 0 14px">${runs.length} run${runs.length === 1 ? '' : 's'} recorded</div>

    ${runs.length ? `<div class="vlist-big">
      ${runs.map((r) => `
        <div class="run-item" data-run="${esc(r.id)}" role="button" tabindex="0">
          <div class="run-item__top">
            ${enginePill(r.engine)} ${statusPill(r.status === 'queued' ? 'dispatched' : r.status)}
            <span class="spacer"></span>
            <span class="tiny muted">${esc(fmtDateTime(r.startedAt))}</span>
          </div>
          <div class="run-item__sub">Took ${esc(fmtDuration(r.durationSec))} · ref <span class="mono">${esc(r.runId)}</span></div>
          ${r.failureReason ? `<div class="run-item__err">${esc(r.failureReason)}</div>` : ''}
          <div class="run-item__actions">
            <span class="btn btn--ghost btn--sm">Details ${icon('chevronR', 'icon--sm')}</span>
            ${r.githubUrl ? `<a class="btn btn--ghost btn--sm" href="${esc(r.githubUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${icon('github', 'icon--sm')} GitHub</a>` : ''}
            ${r.status === 'failed' ? `<button class="btn btn--ghost btn--sm" data-retry="${esc(r.id)}" onclick="event.stopPropagation()">${icon('refresh', 'icon--sm')} Try again</button>` : ''}
            ${r.jobId && ['in-progress', 'queued'].includes(r.status) ? `<button class="btn btn--ghost btn--sm" data-cancel-job="${esc(r.jobId)}" onclick="event.stopPropagation()">${icon('x', 'icon--sm')} Stop</button>` : ''}
          </div>
        </div>`).join('')}
    </div>` : `<div class="card">${emptyState('history', 'No runs yet', 'Runs appear here after you make a video or an automatic video starts.')}</div>`}

    <div class="callout" style="margin-top:16px">${icon('info')}<div>Trying a run again first checks what already reached YouTube, so a video can never be uploaded twice.</div></div>`;

  root.querySelectorAll('[data-run]').forEach((row) => {
    row.onclick = async () => {
      try {
        const full = await api.run(row.dataset.run);
        runDrawer(full.run);
      } catch (err) { toast('Could not load run', err.message, 'bad'); }
    };
  });
  root.querySelectorAll('[data-cancel-job]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!await confirmModal('Stop this video?', '<p>The video maker stops and this video is thrown away. Nothing is published.</p>', 'Stop it', true, 'Keep going')) return;
      try {
        const res = await api.jobAction(b.dataset.cancelJob, 'cancel');
        toast('Stopped', 'Nothing was published.', 'ok');
        location.reload();
      } catch (err) { errorToast(err, 'Couldn’t stop it'); }
    });
  });
  root.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmModal('Try this run again?', '<p>Starts it again with the latest version of the video maker. Nothing goes on YouTube until you approve it.</p>', 'Try again', false, 'Not now')) return;
      try {
        await api.retryRun(b.dataset.retry);
        toast('Trying again', 'Follow it on Home.', 'ok');
        await refresh();
      } catch (err) { errorToast(err, 'Couldn’t try again'); }
    };
  });
  root.querySelector('#btn-sync').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = 'Refreshing…';
    try {
      const res = await api.syncGithub();
      await refresh();
      toast('Up to date', res.message, 'ok', 8000);
    } catch (err) {
      b.disabled = false;
      errorToast(err, 'Couldn’t refresh');
    }
  };
}

export async function renderRuns() {
  await refresh();
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('run');
  if (want) {
    try { const full = await api.run(want); runDrawer(full.run); } catch { /* run not found: list stays */ }
  }
}
