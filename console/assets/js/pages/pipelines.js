/* Pipelines — per-engine stage management (stages reflect each engine's real implementation) */
import { api } from '../api.js';
import {
  icon, esc, statusPill, progressBar, toast, openModal, closeModal, fmtDateTime,
  fmtDuration, confirmModal, renderLogs,
} from '../ui.js';

const STAGE_HELP = {
  unsupported: 'Not implemented by this engine — the console will never report it as complete.',
  'not-configured': 'Supported but missing credentials/configuration.',
  pending: 'Waiting in the pipeline.',
  running: 'Currently executing.',
  done: 'Completed successfully.',
  failed: 'Failed — inspect logs and retry.',
  blocked: 'Blocked by a safeguard (duplicate, cap, or approval gate).',
};

function stageTrack(stages = []) {
  return `<div class="stage-track">${stages.map((s) => {
    const state = s.state || 'pending';
    const cls = state === 'done' ? 'stage--done' : state === 'running' ? 'stage--running'
      : state === 'failed' ? 'stage--failed' : state === 'blocked' ? 'stage--blocked'
      : state === 'unsupported' || state === 'not-configured' ? 'stage--unsupported' : '';
    const ic = state === 'done' ? 'check' : state === 'running' ? 'refresh' : state === 'failed' ? 'x'
      : state === 'blocked' ? 'lock' : state === 'unsupported' ? 'x' : 'clock';
    return `<div class="stage ${cls}" title="${esc(STAGE_HELP[state] || state)}">
      <div class="stage__line"></div>
      <div class="stage__node">${icon(ic, 'icon--sm')}</div>
      <div class="stage__label">${esc(s.name)}</div>
      <div class="stage__state">${esc(s.label || state)}</div>
    </div>`;
  }).join('')}</div>`;
}

function runModal(engine) {
  openModal({
    title: `Run ${engine.name}`,
    body: `
      <div class="field">
        <label class="field__label" for="p-topic">Topic (optional)</label>
        <input class="input" id="p-topic" placeholder="Leave empty for automatic topic selection" />
      </div>
      ${engine.id === 'verticals' ? `<div class="field">
        <label class="field__label" for="p-context">Context / facts (optional)</label>
        <textarea class="input" id="p-context" rows="3" placeholder="Key facts, date, source names the script should use"></textarea>
      </div>` : ''}
      <div class="field">
        <label class="field__label">Execution phase</label>
        <div class="row row--wrap" id="p-phase" style="gap:8px">
          <button class="chip is-active" data-phase="draft">${icon('doc', 'icon--sm')} Draft + render (no upload)</button>
          <button class="chip" data-phase="publish">${icon('upload', 'icon--sm')} Publish last approved</button>
          <button class="chip" data-phase="full">${icon('run', 'icon--sm')} Full pipeline</button>
        </div>
        <div class="field__hint">Draft phase keeps the review gate intact: videos are produced as drafts and never uploaded before approval.</div>
      </div>
      ${engine.supports?.topic ? '' : `<div class="callout callout--warn">${icon('alert')}<div>This engine picks its own topics — a custom topic is only used when the workflow supports <span class="mono">topic</span> input.</div></div>`}
      <div class="callout">${icon('shield')}<div>Dispatched via GitHub Actions workflow_dispatch. Secrets stay in GitHub Actions Secrets; the console never receives model or YouTube credentials.</div></div>`,
    foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
           <button class="btn btn--primary" id="m-go">${icon('run', 'icon--sm')} Dispatch run</button>`,
  });
  let phase = 'draft';
  document.getElementById('p-phase').addEventListener('click', (e) => {
    const b = e.target.closest('[data-phase]');
    if (!b) return;
    phase = b.dataset.phase;
    document.querySelectorAll('#p-phase .chip').forEach((c) => c.classList.toggle('is-active', c === b));
  });
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-go').onclick = async () => {
    const topic = document.getElementById('p-topic').value.trim();
    const btn = document.getElementById('m-go');
    btn.disabled = true;
    try {
      const ctxEl = document.getElementById('p-context');
      const res = await api.engineRun(engine.id, { topic: topic || undefined, phase, context: ctxEl?.value.trim() || undefined });
      closeModal();
      toast('Workflow dispatched', res.message || 'GitHub Actions run queued.', 'ok');
      await refresh();
    } catch (err) {
      btn.disabled = false;
      toast('Dispatch failed', err.message, 'bad');
    }
  };
}

function enginePanel(e) {
  const schedule = e.schedule || {};
  const connLabel = e.connectionState === 'connected' ? 'Connected'
    : e.connectionState === 'demo-unverified' ? 'Demo · unverified'
    : e.connectionState === 'disabled' ? 'Disabled'
    : e.connectionState === 'error' ? 'GitHub error' : 'Not configured';
  const connColor = e.connectionState === 'connected' ? 'green'
    : e.connectionState === 'error' ? 'red' : e.connectionState === 'demo-unverified' ? 'amber' : 'gray';
  return `
  <div class="card">
    <div class="card__head">
      <div class="engine-icon engine-icon--${e.id === 'gemini' ? 'gemini' : 'verticals'}" style="width:38px;height:38px;border-radius:10px">
        ${icon(e.id === 'gemini' ? 'sparkles' : 'play', 'icon--sm')}
      </div>
      <div>
        <h2 style="display:flex;align-items:center;gap:8px">${esc(e.name)}
          <span class="pill pill--${e.badge === 'PRIMARY' ? 'accent' : 'gray'}">${esc(e.badge)}</span>
          <span class="pill pill--${connColor}" title="${esc(e.connectionDetail || '')}"><span class="dot"></span>${esc(connLabel)}</span>
        </h2>
        <div class="tiny muted">${esc(e.tagline)} · workflow <span class="mono">${esc(e.workflow)}</span> on <span class="mono">${esc(e.repo)}@${esc(e.branch)}</span></div>
      </div>
      <div class="right">
        <button class="btn btn--primary btn--sm" data-action="run" data-id="${esc(e.id)}"
          ${e.connectionState === 'disabled' ? 'disabled title="Enable this engine in Settings first"' : ''}>${icon('run', 'icon--sm')} Start run</button>
        <button class="btn btn--secondary btn--sm" data-action="cancel" data-id="${esc(e.id)}" ${e.running ? '' : 'disabled title="No running job to cancel"'}>${icon('x', 'icon--sm')} Cancel</button>
      </div>
    </div>
    ${e.connectionState === 'error' ? `<div class="card__body" style="padding-top:0"><div class="callout callout--warn">${icon('alert')}<div>${esc(e.connectionDetail || 'GitHub unreachable')}</div></div></div>` : ''}
    <div class="card__body stack" style="gap:16px">
      ${e.latestError ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Latest error.</strong> ${esc(e.latestError)}</div></div>` : ''}
      <div>
        <div class="row" style="margin-bottom:10px">
          <strong class="small">Execution stages</strong>
          <span class="tiny muted">— stages not implemented by this engine are marked “unsupported” and never fabricate success</span>
        </div>
        ${stageTrack(e.stages)}
      </div>
      <div class="grid grid--2" style="gap:14px">
        <div class="card card--pad" style="background:var(--bg-sunken)">
          <div class="tiny muted" style="font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px">Execution</div>
          <dl class="kv">
            <dt>Last run</dt><dd>${e.lastRun ? `${esc(fmtDateTime(e.lastRun.startedAt))} · ${statusPill(e.lastRun.status)}` : '—'}</dd>
            <dt>Duration</dt><dd>${e.lastRun ? esc(fmtDuration(e.lastRun.durationSec)) : '—'}</dd>
            <dt>Last success</dt><dd>${e.lastSuccess ? esc(fmtDateTime(e.lastSuccess)) : '—'}</dd>
            <dt>Run ID</dt><dd class="mono">${e.lastRun ? esc(e.lastRun.runId) : '—'}</dd>
          </dl>
          <div class="row row--wrap" style="margin-top:12px">
            ${e.lastRun?.githubUrl ? `<a class="btn btn--secondary btn--sm" href="${esc(e.lastRun.githubUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} GitHub Actions run</a>` : ''}
            <a class="btn btn--ghost btn--sm" href="#/runs">${icon('doc', 'icon--sm')} Logs</a>
            <button class="btn btn--ghost btn--sm" data-action="retry" data-id="${esc(e.id)}" ${e.lastRun?.status === 'failed' ? '' : 'disabled title="Only a failed run can be retried"'}>${icon('refresh', 'icon--sm')} Retry failed run</button>
          </div>
        </div>
        <div class="card card--pad" style="background:var(--bg-sunken)">
          <div class="tiny muted" style="font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px">Scheduling & publishing</div>
          <div class="switch-row" style="padding:8px 0">
            <div class="switch-row__text">
              <strong>Schedule</strong>
              <span>${schedule.enabled ? esc(schedule.label || 'Enabled') : 'Disabled'} · ${esc(schedule.cron || '')}</span>
            </div>
            <button class="switch ${schedule.enabled ? 'is-on' : ''}" data-action="toggle-schedule" data-id="${e.id}" aria-label="Toggle schedule"></button>
          </div>
          <dl class="kv" style="margin-top:8px">
            <dt>Publishing</dt><dd>${esc(e.publishingMode || 'review-required')}</dd>
            <dt>Draft phase</dt><dd>${e.supports?.draftPhase ? 'Supported' : 'Unsupported'}</dd>
            <dt>Cancellation</dt><dd>${e.supports?.cancellation ? 'Supported (GitHub API)' : 'Not supported mid-run'}</dd>
            <dt>Artifacts</dt><dd>${(e.artifacts || []).length ? e.artifacts.map((a) => esc(a.name)).join(', ') : 'None from last run'}</dd>
          </dl>
        </div>
      </div>
    </div>
  </div>`;
}

async function refresh() {
  const root = document.getElementById('page-root');
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const d = await api.engines();

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Pipelines</h1>
        <div class="sub">Manage the two production engines — stage tracks reflect each engine’s real implementation.</div>
      </div>
      <div class="page-head__actions">
        <a class="btn btn--secondary" href="#/runs">${icon('history', 'icon--sm')} Run history</a>
        <button class="btn btn--primary" id="btn-orchestrate">${icon('zap', 'icon--sm')} Run orchestrated</button>
      </div>
    </div>

    <div class="seg" id="engine-seg" style="margin-bottom:18px">
      ${d.engines.map((e) => `<button class="${(query.get('engine') || d.active) === e.id ? 'is-active' : ''}" data-seg="${e.id}">${esc(e.name)}</button>`).join('')}
      <button class="${query.get('engine') === 'both' ? 'is-active' : ''}" data-seg="both">Both engines</button>
    </div>

    <div class="stack" id="engine-panels">
      ${(query.get('engine') === 'both' ? d.engines : d.engines.filter((e) => e.id === (query.get('engine') || d.active || 'gemini'))).map(enginePanel).join('')}
    </div>

    <div class="callout" style="margin-top:20px">${icon('info')}
      <div><strong>How staging honesty works.</strong> ${esc(d.stagePolicy || 'Each engine reports stage results from its own pipeline state (Engine A: curriculum → content → TTS → visuals → render → upload; Engine B: research → draft → b-roll → voiceover → ASR → captions → music → assemble → thumbnail → upload). A stage shows “done” only when the engine recorded it as completed.')}</div>
    </div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console</span><span>·</span><span>Dual-engine orchestration</span>
    </div>`;

  root.querySelector('#engine-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (!b) return;
    location.hash = `#/pipelines?engine=${b.dataset.seg}`;
  });
  root.querySelector('#btn-orchestrate').onclick = async () => {
    try {
      const res = await api.post('/api/orchestrate/run', {});
      toast('Orchestration started', res.message, 'ok');
      await refresh();
    } catch (err) { toast('Orchestration failed', err.message, 'bad'); }
  };

  root.querySelectorAll('[data-action="run"]').forEach((b) => {
    b.onclick = () => {
      const e = d.engines.find((x) => x.id === b.dataset.id);
      runModal(e);
    };
  });
  root.querySelectorAll('[data-action="cancel"]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmModal('Cancel running job?', 'The workflow will be cancelled at the GitHub Actions level. Partial artifacts are kept.', 'Cancel run', true)) return;
      try {
        const res = await api.engineCancel(b.dataset.id, {});
        toast('Cancellation requested', res.message, 'ok');
        await refresh();
      } catch (err) { toast('Cancel failed', err.message, 'bad'); }
    };
  });
  root.querySelectorAll('[data-action="retry"]').forEach((b) => {
    b.onclick = async () => {
      try {
        const res = await api.post(`/api/engines/${b.dataset.id}/retry`, {});
        toast('Retry dispatched', res.message, 'ok');
        await refresh();
      } catch (err) { toast('Retry failed', err.message, 'bad'); }
    };
  });
  root.querySelectorAll('[data-action="toggle-schedule"]').forEach((b) => {
    b.onclick = async () => {
      const e = d.engines.find((x) => x.id === b.dataset.id);
      try {
        const res = await api.post(`/api/engines/${e.id}/schedule`, { enabled: !e.schedule?.enabled });
        toast('Schedule updated', res.message, 'ok');
        await refresh();
      } catch (err) { toast('Update failed', err.message, 'bad'); }
    };
  });
}

export async function renderPipelines() {
  await refresh();
}
