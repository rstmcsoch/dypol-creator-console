/* Overview dashboard — truthful operational summary.
   AUDIT: job counts ≠ video counts; engine readiness is probed and can be
   partial; no fabricated percentages; Run A / Run B / Run Both / History /
   Configure / Refresh all wired to real backend actions. */
import { api } from '../api.js';
import { quotaPanelShell, mountQuotaPanel } from '../quota-panel.js';
import {
  icon, esc, statCard, friendlyStage, statusPill, enginePill, typePill, thumb, fmtDateTime,
  fmtAgo, fmtNum, progressBar, toast, openModal, closeModal, emptyState,
} from '../ui.js';

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  if (h < 12) return 'Good morning, Creator';
  if (h < 17) return 'Good afternoon, Creator';
  return 'Good evening, Creator';
}

const CONN_BADGE = {
  connected: ['green', 'Connected'], error: ['red', 'GitHub error'],
  'not-configured': ['gray', 'Not configured'], disabled: ['gray', 'Disabled'],
  'demo-unverified': ['amber', 'Demo · unverified'],
};

function engineCard(e) {
  const [connColor, connLabel] = CONN_BADGE[e.connectionState] || ['gray', 'Unknown'];
  return `
  <div class="card engine-card">
    <div class="engine-card__head">
      <div class="engine-icon engine-icon--${e.id === 'gemini' ? 'gemini' : 'verticals'}">
        ${icon(e.id === 'gemini' ? 'sparkles' : 'play')}
      </div>
      <div style="flex:1;min-width:0">
        <div class="row row--wrap" style="gap:8px">
          <h3>${esc(e.name)}</h3>
          <span class="pill pill--${e.badge === 'PRIMARY' ? 'accent' : 'gray'}">${esc(e.badge)}</span>
          <span class="pill pill--${connColor}" title="${esc(e.connectionDetail || '')}"><span class="dot"></span>${esc(connLabel)}</span>
        </div>
        <div class="muted small" style="margin-top:3px">${esc(e.tagline)}</div>
      </div>
    </div>
    <p class="desc">${esc(e.description)}</p>
    ${e.connectionState === 'error' ? `<div class="callout callout--warn" style="padding:8px 12px">${icon('alert')}<div>${esc(e.connectionDetail || 'Provider unreachable')}</div></div>` : ''}
    <div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <span class="tiny muted" style="font-weight:650">Pipeline progress</span>
      </div>
      ${progressBar(e.progress, e.id === 'gemini' ? '' : 'blue')}
    </div>
    <div class="kv">
      <dt>Repository</dt><dd class="mono">${esc(e.repo)}</dd>
      <dt>Workflow</dt><dd class="mono">${esc(e.workflow)}</dd>
      <dt>Last run</dt><dd>${e.lastRun ? `${esc(fmtDateTime(e.lastRun.startedAt || e.lastRun))} · ${statusPill(e.lastRunStatus || 'completed')}` : '<span class="muted">No runs yet</span>'}</dd>
      <dt>Last success</dt><dd>${e.lastSuccess ? esc(fmtDateTime(e.lastSuccess)) : '<span class="muted">—</span>'}</dd>
      <dt>Current stage</dt><dd>${e.stage ? esc(friendlyStage(e.stage)) : '<span class="muted">Idle</span>'}</dd>
      ${e.latestError ? `<dt>Latest error</dt><dd style="color:var(--red)">${esc(e.latestError)}</dd>` : ''}
    </div>
    <div class="row row--wrap" style="margin-top:auto">
      <button class="btn btn--primary btn--sm" data-action="run-engine" data-engine="${esc(e.id)}"
        ${e.connectionState === 'disabled' ? 'aria-disabled="true" data-why="Enable this engine in Settings first"' : ''}>${icon('run', 'icon--sm')} Run now</button>
      <a class="btn btn--secondary btn--sm" href="#/runs">${icon('history', 'icon--sm')} Run history</a>
      <a class="btn btn--ghost btn--sm" href="#/pipelines?engine=${esc(e.id)}">${icon('gear', 'icon--sm')} Configure</a>
    </div>
  </div>`;
}

function runPipelineModal() {
  openModal({
    title: 'Run pipeline',
    body: `
      <div class="field">
        <label class="field__label" for="run-topic">Topic (optional — engine discovers one if empty)</label>
        <input class="input" id="run-topic" placeholder="e.g. How transformers learn" />
      </div>
      <div class="field">
        <label class="field__label">Engine</label>
        <div class="row row--wrap" style="gap:8px" id="run-engine-pick">
          <button class="chip is-active" data-engine="gemini">${icon('sparkles', 'icon--sm')} Engine A · Gemini</button>
          <button class="chip" data-engine="verticals">${icon('play', 'icon--sm')} Engine B · Verticals</button>
          <button class="chip" data-engine="orchestrated">${icon('zap', 'icon--sm')} Orchestrated (per mode)</button>
          <button class="chip" data-engine="both">${icon('copy', 'icon--sm')} Run Both (draft candidates)</button>
        </div>
      </div>
      <div class="callout">${icon('shield')}<div>Runs are dispatched to GitHub Actions with the publishing safeguards: duplicate check, daily cap, concurrency limit, and review-required approval by default. “Run Both” produces labelled draft candidates — nothing auto-publishes.</div></div>`,
    foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
           <button class="btn btn--primary" id="m-run">${icon('run', 'icon--sm')} Start run</button>`,
  });
  let engine = 'gemini';
  document.getElementById('run-engine-pick').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-engine]');
    if (!btn) return;
    engine = btn.dataset.engine;
    document.querySelectorAll('#run-engine-pick .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  });
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-run').onclick = async (ev) => {
    const topic = document.getElementById('run-topic').value.trim();
    const btn = ev.currentTarget;
    btn.disabled = true; // double-submission guard
    try {
      const res = engine === 'orchestrated'
        ? await api.post('/api/orchestrate/run', { topic })
        : engine === 'both'
          ? await api.post('/api/orchestrate/run', { topic, forceMode: 'draft_both' })
          : await api.engineRun(engine, { topic });
      closeModal();
      toast('Pipeline started', res.message || 'Job dispatched to GitHub Actions.', 'ok');
      await refresh();
    } catch (err) {
      btn.disabled = false;
      toast('Could not start run', err.message, 'bad');
    }
  };
}

async function refresh() {
  const root = document.getElementById('page-root');
  const d = await api.overview();
  const m = d.metrics;
  const healthPill = d.demo
    ? `<span class="status-pill status-pill--demo">${icon('info', 'icon--sm')}<span class="hide-xs">Demo · engines unverified</span></span>`
    : d.operational === 'operational'
      ? `<span class="status-pill">${icon('shield', 'icon--sm')}<span class="hide-xs">All engines reachable</span></span>`
      : d.operational === 'partial'
        ? `<span class="status-pill status-pill--warn">${icon('alert', 'icon--sm')}<span class="hide-xs">Partial availability</span></span>`
        : `<span class="status-pill status-pill--bad">${icon('alert', 'icon--sm')}<span class="hide-xs">Engines unavailable</span></span>`;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${greeting()}</h1>
        <div class="sub">Your YouTube production at a glance · ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} (IST)</div>
      </div>
      <div class="page-head__actions">
        ${healthPill}
        <button class="btn btn--primary" id="btn-run-pipeline">${icon('run', 'icon--sm')} Run pipeline ${icon('chevronD', 'icon--sm')}</button>
        <a class="btn btn--secondary" href="#/runs">${icon('history', 'icon--sm')} View history</a>
      </div>
    </div>

    ${d.demo ? `<div class="callout callout--warn" style="margin-bottom:18px">${icon('info')}<div><strong>Demonstration data.</strong> This console is in local demo mode — metrics, videos and runs below are simulated until you connect GitHub, D1 and YouTube (see Settings → System health). Every demo record is labelled.</div></div>` : ''}
    ${d.schedulePaused ? `<div class="callout callout--warn" style="margin-bottom:18px">${icon('pause')}<div><strong>Automation is paused.</strong> Scheduled runs are on hold. Existing videos, records and credentials are preserved. Resume from Settings or Calendar.</div></div>` : ''}

    <div class="grid grid--stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      ${statCard({ iconName: 'layers', tone: 'orange', label: 'Total jobs', value: fmtNum(m.totalJobs), delta: 'Job records (all attempts)' })}
      ${statCard({ iconName: 'video', tone: 'violet', label: 'Videos generated', value: fmtNum(m.videosGenerated), delta: 'Outputs from completed jobs' })}
      ${statCard({ iconName: 'youtube', tone: 'green', label: 'Videos published', value: fmtNum(m.publishedTotal), delta: m.publishedMonthDelta })}
      ${statCard({ iconName: 'refresh', tone: 'blue', label: 'Jobs running now', value: fmtNum(m.inProduction), delta: m.inProductionNote })}
      ${statCard({ iconName: 'clock', tone: 'amber', label: 'Awaiting review', value: fmtNum(m.awaitingReview), delta: 'Needs your approval' })}
      ${statCard({ iconName: 'alert', tone: m.failedRuns > 0 ? 'red' : 'green', label: 'Failed jobs', value: fmtNum(m.failedRuns), delta: m.failedDelta, deltaDir: m.failedRuns > 0 ? 'down' : '' })}
    </div>

    <div class="section-head"><h2>Production engines</h2>
      <div class="right">
        <button class="btn btn--secondary btn--sm" id="btn-run-both">${icon('copy', 'icon--sm')} Run Both (draft)</button>
        <span class="badge-soft badge-soft--neutral">${icon('shield', 'icon--sm')} Duplicate protection active</span>
      </div>
    </div>
    <div class="grid grid--2">${d.engines.map(engineCard).join('')}</div>

    <div style="margin-top:18px">${quotaPanelShell('quota-panel')}</div>

    <div class="rail-grid" style="margin-top:26px">
      <div class="stack">
        <div class="card">
          <div class="card__head">
            ${icon('video')}<h2>Recent uploads &amp; jobs</h2>
            <div class="right"><a class="btn btn--ghost btn--sm" href="#/queue">View all ${icon('chevronR', 'icon--sm')}</a></div>
          </div>
          ${d.recentVideos.length ? `
          <div class="table" role="table">
            <div class="table__head" role="row" style="grid-template-columns:76px minmax(0,2.4fr) 1fr 1fr 1.1fr 40px">
              <div>Thumb</div><div>Title</div><div>Engine</div><div>Stage</div><div>Status</div><div></div>
            </div>
            ${d.recentVideos.map((v) => `
              <div class="table__row is-clickable" role="row" data-open-job="${esc(v.id)}"
                   style="grid-template-columns:76px minmax(0,2.4fr) 1fr 1fr 1.1fr 40px">
                <div class="cell-main">${thumb(v)}</div>
                <div class="cell-main">
                  <div class="cell-title truncate">${esc(v.title)}</div>
                  <div class="cell-sub">${typePill(v.format)} · ${esc(fmtDateTime(v.updatedAt))}${v.demo ? ' · <span class="pill pill--accent">DEMO</span>' : ''}</div>
                </div>
                <div data-col="Engine">${enginePill(v.engine)}</div>
                <div data-col="Stage"><span class="small muted truncate">${esc(friendlyStage(v.stage) || '—')}</span></div>
                <div data-col="Status">${statusPill(v.status)}</div>
                <div class="row" style="justify-content:flex-end">
                  <button class="icon-btn icon-btn--bare" aria-label="Open details">${icon('chevronR', 'icon--sm')}</button>
                </div>
              </div>`).join('')}
          </div>` : emptyState('video', 'No videos yet', 'Start your first pipeline run and produced videos will appear here.', `<button class="btn btn--primary btn--sm" id="empty-run">Run pipeline</button>`)}
        </div>

        ${(d.recentErrors || []).length ? `
        <div class="card">
          <div class="card__head">${icon('alert')}<h2>Recent errors</h2>
            <div class="right"><a class="btn btn--ghost btn--sm" href="#/runs">Run history ${icon('chevronR', 'icon--sm')}</a></div></div>
          <div class="card__body" style="padding:8px 20px">
            <div class="timeline">
              ${d.recentErrors.map((a) => `
                <div class="timeline__item">
                  <div class="timeline__icon stat__icon--red">${icon('alert', 'icon--sm')}</div>
                  <div class="timeline__body">
                    <div class="timeline__title">${esc(a.title)}</div>
                    <div class="timeline__sub">${esc(a.sub)}</div>
                  </div>
                  <div class="timeline__time">${esc(fmtAgo(a.ts))}</div>
                </div>`).join('')}
            </div>
          </div>
        </div>` : ''}
      </div>

      <div class="stack rail">
        <div class="card">
          <div class="card__head">${icon('calendar')}<h2>Next scheduled run</h2></div>
          <div class="card__body">
            ${d.nextRun ? `
              <div class="card" style="border-color:var(--accent-border);background:var(--accent-soft)">
                <div class="card__body" style="padding:15px">
                  <div style="font-size:16px;font-weight:800;color:var(--accent-700)">${esc(d.nextRun.label)}</div>
                  <div class="small" style="margin-top:3px;color:var(--accent-ink)">${esc(d.nextRun.note || 'Daily automation cycle')}</div>
                  <button class="btn btn--primary btn--block" style="margin-top:12px" id="btn-run-now">${icon('play', 'icon--sm')} Run Now</button>
                </div>
              </div>`
            : `<div class="muted small">No runs scheduled — automation is paused or no cadence configured.</div>`}
            ${m.latestSuccess ? `<div class="tiny muted" style="margin-top:10px">${icon('check', 'icon--sm')} Latest successful run: <strong>${esc(fmtDateTime(m.latestSuccess))}</strong></div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('zap')}<h2>Quick actions</h2></div>
          <div class="card__body" style="padding:8px 12px">
            ${[
              ['plus', 'Add new topic', 'Generate from an idea or keyword', '#/queue'],
              ['inbox', 'View content plan', 'Manage your upcoming videos', '#/calendar'],
              ['chart', 'Check analytics', 'Performance & insights', '#/analytics'],
            ].map(([ic, t, s, href]) => `
              <a class="row" href="${href}" style="padding:11px 10px;border-radius:10px;color:inherit;text-decoration:none">
                <div class="stat__icon stat__icon--orange" style="width:34px;height:34px;border-radius:9px">${icon(ic, 'icon--sm')}</div>
                <div style="min-width:0"><div class="small" style="font-weight:650">${t}</div><div class="tiny muted truncate">${s}</div></div>
                <div class="spacer"></div>${icon('chevronR', 'icon--sm')}
              </a>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('zap')}<h2>Recent activity</h2></div>
          <div class="card__body" style="padding:8px 20px">
            <div class="timeline">
              ${d.activity.length ? d.activity.map((a) => `
                <div class="timeline__item">
                  <div class="timeline__icon stat__icon--${a.tone || 'blue'}">${icon(a.icon || 'check', 'icon--sm')}</div>
                  <div class="timeline__body">
                    <div class="timeline__title">${esc(a.title)}</div>
                    <div class="timeline__sub">${esc(a.sub)}</div>
                  </div>
                  <div class="timeline__time">${esc(fmtAgo(a.ts))}</div>
                </div>`).join('') : `<div class="muted small" style="padding:14px 0">No activity recorded yet.</div>`}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console v1.0.0</span><span>·</span>
      <span>Build · Automate · Create</span>
      <span class="spacer"></span>
      <span class="mono">Timezone ${esc(d.timezone || 'Asia/Kolkata')}</span>
    </div>`;

  root.querySelector('#btn-run-pipeline').onclick = runPipelineModal;
  root.querySelectorAll('[data-action="run-engine"]').forEach((b) => {
    b.onclick = () => runEngineDirect(b.dataset.engine);
  });
  const runBoth = root.querySelector('#btn-run-both');
  if (runBoth) runBoth.onclick = async () => {
    try {
      const res = await api.post('/api/orchestrate/run', { forceMode: 'draft_both' });
      toast('Draft candidates dispatched', res.message, 'ok');
      await refresh();
    } catch (err) { toast('Could not start', err.message, 'bad'); }
  };
  const runNow = root.querySelector('#btn-run-now');
  if (runNow) runNow.onclick = runPipelineModal;
  const emptyRun = root.querySelector('#empty-run');
  if (emptyRun) emptyRun.onclick = runPipelineModal;
  mountQuotaPanel(root, 'quota-panel');
  root.querySelectorAll('[data-open-job]').forEach((row) => {
    row.onclick = () => { location.hash = `#/queue?job=${encodeURIComponent(row.dataset.openJob)}`; };
  });
}

async function runEngineDirect(engine) {
  try {
    const res = await api.engineRun(engine, {});
    toast('Run started', res.message || `Dispatched to ${engine}.`, 'ok');
    await refresh();
  } catch (err) {
    toast('Could not start run', err.message, 'bad');
  }
}

export async function renderOverview() {
  await refresh();
}
