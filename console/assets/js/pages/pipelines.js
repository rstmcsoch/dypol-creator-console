/* Video makers (Advanced) — per-maker steps, last run, schedule. Same functions as the old
   Pipelines page, in plain words. Starting a video normally happens on the Make page. */
import { api } from '../api.js';
import {
  icon, esc, statusPill, friendlyStage, progressBar, toast, openModal, closeModal, fmtDateTime,
  fmtDuration, confirmModal, renderLogs, makerName, errorToast, failureLabel,
} from '../ui.js';

const STAGE_HELP = {
  unsupported: 'This video maker doesn’t do this step.',
  'not-configured': 'This step needs setting up first.',
  pending: 'Not started yet.',
  running: 'Working on it now.',
  done: 'Finished.',
  failed: 'Stopped here — see Technical history.',
  blocked: 'Held by a safety rule (repeat topic, daily limit, or your check).',
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
      <div class="stage__label">${esc(friendlyStage(s.name))}</div>
      <div class="stage__state">${esc(friendlyStage(s.label || state))}</div>
    </div>`;
  }).join('')}</div>`;
}

function runModal(engine) {
  openModal({
    title: `Make a ${makerName(engine.id)}`,
    body: `
      <div class="field">
        <label class="field__label" for="p-topic">Topic (optional)</label>
        <input class="input" id="p-topic" placeholder="Leave empty and the maker picks one" />
      </div>
      ${engine.id === 'verticals' ? `<div class="field">
        <label class="field__label" for="p-context">Facts to include (optional)</label>
        <textarea class="input" id="p-context" rows="3" placeholder="Key facts, date, source names the script should use"></textarea>
      </div>` : ''}
      <div class="field">
        <label class="field__label">What to run</label>
        <div class="row row--wrap" id="p-phase" style="gap:8px">
          <button class="chip is-active" data-phase="draft">${icon('doc', 'icon--sm')} Make a video (waits for your check)</button>
          <button class="chip" data-phase="publish">${icon('upload', 'icon--sm')} Upload the last approved video</button>
          <button class="chip" data-phase="full">${icon('run', 'icon--sm')} Make, then upload what I approved</button>
        </div>
        <div class="field__hint">Nothing goes on YouTube before you approve it, whichever you pick.</div>
      </div>
      ${engine.supports?.topic ? '' : `<div class="callout callout--warn">${icon('alert')}<div>This video maker usually picks its own topics, so your topic may be ignored.</div></div>`}
      <div class="callout">${icon('shield')}<div>Made in the cloud. Your passwords and keys stay there and are never shown here.</div></div>`,
    foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
           <button class="btn btn--primary" id="m-go">${icon('play', 'icon--sm')} Start making</button>`,
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
      toast('Started!', 'Follow it on Home — about 15 minutes.', 'ok');
      await refresh();
    } catch (err) {
      btn.disabled = false;
      errorToast(err, 'Couldn’t start');
    }
  };
}

function enginePanel(e) {
  const schedule = e.schedule || {};
  const connLabel = e.connectionState === 'connected' ? 'Connected'
    : e.connectionState === 'demo-unverified' ? 'Demo'
    : e.connectionState === 'disabled' ? 'Switched off'
    : e.connectionState === 'error' ? 'Can’t reach it' : 'Not set up';
  const connColor = e.connectionState === 'connected' ? 'green'
    : e.connectionState === 'error' ? 'red' : e.connectionState === 'demo-unverified' ? 'amber' : 'gray';
  return `
  <div class="card">
    <div class="card__head card__head--stack">
      <div class="row" style="gap:12px;min-width:0">
        <div class="engine-icon engine-icon--${e.id === 'gemini' ? 'gemini' : 'verticals'}" style="width:40px;height:40px;border-radius:11px">
          ${icon(e.id === 'gemini' ? 'video' : 'play', 'icon--sm')}
        </div>
        <div style="min-width:0">
          <h2>${esc(makerName(e.id))}</h2>
          <div class="row row--wrap" style="gap:6px;margin-top:4px">
            <span class="pill pill--${e.badge === 'PRIMARY' ? 'accent' : 'gray'}">${e.badge === 'PRIMARY' ? 'Main maker' : 'Backup maker'}</span>
            <span class="pill pill--${connColor}"><span class="dot"></span>${esc(connLabel)}</span>
          </div>
        </div>
      </div>
      <div class="row row--wrap" style="gap:8px">
        <button class="btn btn--primary" data-action="run" data-id="${esc(e.id)}"
          ${e.connectionState === 'disabled' ? 'aria-disabled="true" data-why="This maker is switched off. Turn it on in Settings → Advanced → Video makers."' : ''}>${icon('play', 'icon--sm')} Make a video</button>
        <button class="btn btn--secondary" data-action="cancel" data-id="${esc(e.id)}" ${e.running ? '' : 'aria-disabled="true" data-why="Nothing is being made by this maker right now."'}>${icon('x', 'icon--sm')} Stop current video</button>
      </div>
    </div>
    ${e.connectionState === 'error' ? `<div class="card__body" style="padding-top:0"><div class="callout callout--warn">${icon('alert')}<div>Can’t reach this video maker right now. ${esc(e.connectionDetail || '')}</div></div></div>` : ''}
    <div class="card__body stack" style="gap:16px">
      ${e.latestError ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Last problem:</strong> ${esc(e.latestError)}</div></div>` : ''}
      <div>
        <div class="row" style="margin-bottom:10px">
          <strong class="small">Steps</strong>
          <span class="tiny muted">— a step shows “done” only when the maker really finished it</span>
        </div>
        ${stageTrack(e.stages)}
      </div>
      <div class="grid grid--2" style="gap:14px">
        <div class="card card--pad" style="background:var(--bg-sunken)">
          <div class="tiny muted" style="font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px">Last time</div>
          <dl class="kv">
            <dt>Started</dt><dd>${e.lastRun ? `${esc(fmtDateTime(e.lastRun.startedAt))} · ${statusPill(e.lastRun.status)}` : '—'}</dd>
            <dt>Took</dt><dd>${e.lastRun ? esc(fmtDuration(e.lastRun.durationSec)) : '—'}</dd>
            <dt>Last success</dt><dd>${e.lastSuccess ? esc(fmtDateTime(e.lastSuccess)) : '—'}</dd>
            <dt>Reference</dt><dd class="mono">${e.lastRun ? esc(e.lastRun.runId) : '—'}</dd>
          </dl>
          <div class="row row--wrap" style="margin-top:12px">
            ${e.lastRun?.githubUrl ? `<a class="btn btn--secondary btn--sm" href="${esc(e.lastRun.githubUrl)}" target="_blank" rel="noopener">${icon('github', 'icon--sm')} Open in GitHub</a>` : ''}
            <a class="btn btn--ghost btn--sm" href="#/runs">${icon('doc', 'icon--sm')} Technical history</a>
            <button class="btn btn--ghost btn--sm" data-action="retry" data-id="${esc(e.id)}" ${e.lastRun?.status === 'failed' ? '' : 'aria-disabled="true" data-why="Only a run that didn’t finish can be tried again."'}>${icon('refresh', 'icon--sm')} Try the last run again</button>
          </div>
        </div>
        <div class="card card--pad" style="background:var(--bg-sunken)">
          <div class="tiny muted" style="font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px">Automatic schedule</div>
          <div class="switch-row" style="padding:8px 0">
            <div class="switch-row__text">
              <strong>Start videos automatically</strong>
              <span>${schedule.enabled ? esc(schedule.label || 'On') : 'Off'}${schedule.cron ? ` · <span class="mono">${esc(schedule.cron)}</span>` : ''}. You still check every video.</span>
            </div>
            <button class="switch ${schedule.enabled ? 'is-on' : ''}" data-action="toggle-schedule" data-id="${e.id}" aria-label="Start videos automatically"></button>
          </div>
          <dl class="kv" style="margin-top:8px">
            <dt>Publishing</dt><dd>${e.publishingMode === 'review-required' || !e.publishingMode ? 'You check every video first' : esc(e.publishingMode)}</dd>
            <dt>Make without uploading</dt><dd>${e.supports?.draftPhase ? 'Yes' : 'No'}</dd>
            <dt>Can be stopped</dt><dd>${e.supports?.cancellation ? 'Yes' : 'Not while running'}</dd>
            <dt>Files</dt><dd>${(e.artifacts || []).length ? e.artifacts.map((a) => esc(a.name)).join(', ') : 'Listed in Technical history'}</dd>
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
    <a class="back-link" href="#/settings">${icon('chevronL', 'icon--sm')} Settings</a>
    <div class="page-head">
      <div>
        <h1>Video makers</h1>
        <div class="sub">The two cloud tools that make your videos. Most days you only need <a href="#/make">Make a video</a>.</div>
      </div>
      <div class="page-head__actions">
        <a class="btn btn--secondary" href="#/runs">${icon('history', 'icon--sm')} Technical history</a>
        <button class="btn btn--secondary" id="btn-orchestrate">${icon('zap', 'icon--sm')} Let the system choose</button>
      </div>
    </div>

    <div class="seg seg--wide" id="engine-seg" style="margin-bottom:18px">
      ${d.engines.map((e) => `<button class="${(query.get('engine') || d.active) === e.id ? 'is-active' : ''}" data-seg="${e.id}">${esc(makerName(e.id))}</button>`).join('')}
      <button class="${query.get('engine') === 'both' ? 'is-active' : ''}" data-seg="both">Both</button>
    </div>

    <div class="stack" id="engine-panels">
      ${(query.get('engine') === 'both' ? d.engines : d.engines.filter((e) => e.id === (query.get('engine') || d.active || 'gemini'))).map(enginePanel).join('')}
    </div>

    <details class="mini-details" style="margin-top:18px">
      <summary>${icon('info', 'icon--sm')} How the steps are shown</summary>
      <p class="small muted" style="margin-top:8px">${esc(d.stagePolicy || 'Each maker reports its own steps. Long video + Short: topic → script → voice → visuals → put together → upload. Short only: research → script → visuals → voice → captions → music → put together → thumbnail → upload. A step shows “done” only when the maker really finished it.')}</p>
    </details>`;

  root.querySelector('#engine-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (!b) return;
    location.hash = `#/makers?engine=${b.dataset.seg}`;
  });
  root.querySelector('#btn-orchestrate').onclick = async (ev) => {
    if (!await confirmModal('Let the system choose?', '<p>The system starts the main video maker (backup if it breaks), following your video maker plan in Settings → Advanced. You still check the video before it goes up.</p>', 'Start', false, 'Not now')) return;
    ev.target.disabled = true;
    try {
      await api.post('/api/orchestrate/run', {});
      toast('Started!', 'Follow it on Home — about 15 minutes.', 'ok');
      await refresh();
    } catch (err) { ev.target.disabled = false; errorToast(err, 'Couldn’t start'); }
  };

  root.querySelectorAll('[data-action="run"]').forEach((b) => {
    b.onclick = () => {
      const e = d.engines.find((x) => x.id === b.dataset.id);
      runModal(e);
    };
  });
  root.querySelectorAll('[data-action="cancel"]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmModal('Stop the current video?', '<p>The video maker stops and the video being made is thrown away. Nothing is published.</p>', 'Stop it', true, 'Keep going')) return;
      try {
        const res = await api.engineCancel(b.dataset.id, {});
        toast('Stopping', 'Nothing was published.', 'ok');
        await refresh();
      } catch (err) { errorToast(err, 'Couldn’t stop it'); }
    };
  });
  root.querySelectorAll('[data-action="retry"]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmModal('Try the last run again?', '<p>Makes the last video that didn’t finish again, with the latest version of the maker. You still check it before it goes up.</p>', 'Try again', false, 'Not now')) return;
      try {
        await api.post(`/api/engines/${b.dataset.id}/retry`, {});
        toast('Trying again', 'Follow it on Home.', 'ok');
        await refresh();
      } catch (err) { errorToast(err, 'Couldn’t try again'); }
    };
  });
  root.querySelectorAll('[data-action="toggle-schedule"]').forEach((b) => {
    b.onclick = async () => {
      const e = d.engines.find((x) => x.id === b.dataset.id);
      try {
        const res = await api.post(`/api/engines/${e.id}/schedule`, { enabled: !e.schedule?.enabled });
        toast(e.schedule?.enabled ? 'Automatic videos off' : 'Automatic videos on', res.message || '', 'ok');
        await refresh();
      } catch (err) { errorToast(err, 'Couldn’t change it'); }
    };
  });
}

export async function renderPipelines() {
  await refresh();
}
