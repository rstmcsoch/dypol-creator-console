/* Run History — execution history with structured logs */
import { api } from '../api.js';
import {
  icon, esc, statusPill, enginePill, fmtDateTime, fmtDuration, toast, openDrawer,
  renderLogs, emptyState,
} from '../ui.js';

function runDrawer(r) {
  const failedStep = (r.steps || []).find((s) => s.status === 'failed');
  const body = `
    <div class="row row--wrap" style="gap:8px">
      ${enginePill(r.engine)}
      ${statusPill(r.status)}
      ${r.demo ? '<span class="pill pill--accent">Demo record</span>' : ''}
    </div>
    <dl class="kv">
      <dt>Run ID</dt><dd class="mono">${esc(r.runId)}</dd>
      <dt>Workflow</dt><dd class="mono">${esc(r.workflow)}</dd>
      <dt>Job</dt><dd>${r.jobId ? `<a href="#/queue?job=${encodeURIComponent(r.jobId)}">${esc(r.jobTitle || r.jobId)}</a>` : '—'}</dd>
      <dt>Started</dt><dd>${esc(fmtDateTime(r.startedAt))}</dd>
      <dt>Duration</dt><dd>${esc(fmtDuration(r.durationSec))}</dd>
      <dt>Conclusion</dt><dd>${esc(r.status)}</dd>
      ${r.failureReason ? `<dt>Failure reason</dt><dd style="color:var(--red)">${esc(r.failureReason)}</dd>` : ''}
    </dl>
    ${failedStep ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Failed step: ${esc(failedStep.name)}.</strong> ${esc(failedStep.note || 'See logs below.')}</div></div>` : ''}
    <div>
      <strong class="small">Steps</strong>
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
      <strong class="small">Structured logs</strong>
      <div style="margin-top:8px">${renderLogs(r.logs || [])}</div>
    </div>
    ${(r.artifacts || []).length ? `
      <div>
        <strong class="small">Artifacts</strong>
        <div class="row row--wrap" style="margin-top:8px">
          ${r.artifacts.map((a) => `<span class="pill pill--outline">${icon('doc', 'icon--sm')} ${esc(a.name)} (${esc(a.size || '?')})</span>`).join('')}
        </div>
      </div>` : ''}`;
  const foot = `
    ${r.githubUrl ? `<a class="btn btn--secondary btn--sm" href="${esc(r.githubUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} GitHub Actions run</a>` : ''}
    <button class="btn btn--primary btn--sm" data-ract="retry" ${r.status === 'failed' ? '' : 'disabled'}>${icon('refresh', 'icon--sm')} Retry failed run</button>`;
  openDrawer({ title: 'Run detail', body, foot });
  document.getElementById('drawer-foot').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-ract="retry"]')) return;
    try {
      const res = await api.retryRun(r.id);
      toast('Retry dispatched', res.message, 'ok');
      await refresh();
    } catch (err) { toast('Retry failed', err.message, 'bad'); }
  });
}

async function refresh() {
  const root = document.getElementById('page-root');
  const data = await api.runs();
  const runs = data.runs || [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Run History</h1>
        <div class="sub">Execution history from GitHub Actions workflow runs — statuses and logs come from real backend data.</div>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--secondary" id="btn-sync">${icon('refresh', 'icon--sm')} Sync GitHub runs</button>
      </div>
    </div>

    <div class="row row--wrap" style="gap:14px;margin-bottom:16px">
      <span class="badge-soft badge-soft--neutral">${icon('server', 'icon--sm')} ${esc(data.source || 'backend')}</span>
      <span class="badge-soft badge-soft--accent">${icon('history', 'icon--sm')} ${runs.length} run(s) recorded</span>
    </div>

    <div class="card">
      ${runs.length ? `<div class="table">
        <div class="table__head" style="grid-template-columns:minmax(0,1.5fr) 1.2fr .9fr 1.1fr .8fr 1.1fr 1.3fr">
          <div>Engine / Workflow</div><div>Run ID</div><div>Started</div><div>Duration</div><div>Status</div><div>Failure reason</div><div>Actions</div>
        </div>
        ${runs.map((r) => `
          <div class="table__row is-clickable" data-run="${esc(r.id)}" style="grid-template-columns:minmax(0,1.5fr) 1.2fr .9fr 1.1fr .8fr 1.1fr 1.3fr">
            <div class="cell-main">
              <div class="cell-title truncate">${enginePill(r.engine)}</div>
              <div class="cell-sub mono truncate">${esc(r.workflow)}</div>
            </div>
            <div data-col="Run ID"><span class="mono small">${esc(r.runId)}</span></div>
            <div data-col="Started"><span class="small muted">${esc(fmtDateTime(r.startedAt))}</span></div>
            <div data-col="Duration"><span class="small">${esc(fmtDuration(r.durationSec))}</span></div>
            <div data-col="Status">${statusPill(r.status)}</div>
            <div data-col="Failure"><span class="small truncate" style="color:${r.failureReason ? 'var(--red)' : 'var(--ink-3)'}">${esc(r.failureReason || '—')}</span></div>
            <div data-col="Actions">
              <div class="row">
                ${r.githubUrl ? `<a class="btn btn--ghost btn--sm" href="${esc(r.githubUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${icon('github', 'icon--sm')}</a>` : ''}
                <button class="btn btn--ghost btn--sm" data-retry="${esc(r.id)}" ${r.status === 'failed' ? '' : 'disabled'} onclick="event.stopPropagation()">${icon('refresh', 'icon--sm')} Retry</button>
              </div>
            </div>
          </div>`).join('')}
      </div>` : emptyState('history', 'No runs recorded yet', 'Runs appear here after you dispatch an engine from the Pipelines page or a schedule fires.')}
    </div>

    <div class="callout" style="margin-top:16px">${icon('info')}<div>Each row links to the corresponding GitHub Actions run. Retrying a failed run re-dispatches the workflow with the same inputs after the publishing safeguards re-verify the upload state — blind retries cannot double-upload.</div></div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console</span><span>·</span><span>Run History</span>
    </div>`;

  root.querySelectorAll('[data-run]').forEach((row) => {
    row.onclick = async () => {
      try {
        const full = await api.run(row.dataset.run);
        runDrawer(full.run);
      } catch (err) { toast('Could not load run', err.message, 'bad'); }
    };
  });
  root.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      try {
        const res = await api.retryRun(b.dataset.retry);
        toast('Retry dispatched', res.message, 'ok');
        await refresh();
      } catch (err) { toast('Retry failed', err.message, 'bad'); }
    };
  });
  root.querySelector('#btn-sync').onclick = async () => {
    try {
      const res = await api.syncGithub();
      toast('Sync complete', res.message, 'ok');
      await refresh();
    } catch (err) { toast('Sync failed', err.message, 'bad'); }
  };
}

export async function renderRuns() {
  await refresh();
}
