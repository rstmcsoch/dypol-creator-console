/* Content Queue — review, approve, publish with real safeguards.
   AUDIT: full lifecycle status set, niche/date filters, created dates,
   error categories, retry with attempt history, editable metadata that IS
   what gets published, disabled actions always explain themselves. */
import { api } from '../api.js';
import {
  icon, esc, statusPill, enginePill, typePill, thumb, fmtDateTime, fmtAgo, progressBar,
  toast, openDrawer, closeDrawer, renderLogs, emptyState, confirmModal, openModal, closeModal, qcRow,
} from '../ui.js';
import { mountProgress } from '../progress.js';

const STATUS_TABS = [
  ['', 'All'], ['queued', 'Queued'], ['generating,dispatched,running', 'Generating'],
  ['rendering', 'Rendering'], ['needs-review', 'Awaiting Review'], ['approved', 'Approved'],
  ['scheduled', 'Scheduled'], ['uploading', 'Uploading'], ['published', 'Published'], ['failed', 'Failed'],
];

const NICHES = ['general', 'tech', 'science', 'education', 'finance', 'gaming', 'motivation'];

let view = { tab: '', q: '', engine: '', type: '', niche: '', date: '', sort: 'newest', selected: null };

function filterQuery() {
  const p = new URLSearchParams();
  if (view.tab) p.set('status', view.tab);
  if (view.q) p.set('q', view.q);
  if (view.engine) p.set('engine', view.engine);
  if (view.type) p.set('type', view.type);
  if (view.niche) p.set('niche', view.niche);
  if (view.date) p.set('since', view.date);
  p.set('sort', view.sort);
  return `?${p.toString()}`;
}

function jobRow(j) {
  const err = j.status === 'failed' && j.error;
  return `
  <div class="table__row is-clickable ${view.selected === j.id ? 'is-selected' : ''}" role="row" data-job="${esc(j.id)}"
       style="grid-template-columns:28px 76px minmax(0,2.2fr) 1fr .9fr 1.2fr 1.05fr 1.1fr">
    <div class="cell-check"><span class="check ${view.selected === j.id ? 'is-on' : ''}">${view.selected === j.id ? icon('check', 'icon--sm') : ''}</span></div>
    <div class="cell-main">${thumb(j)}</div>
    <div class="cell-main">
      <div class="cell-title truncate">${esc(j.title)}</div>
      <div class="cell-sub truncate">${esc(j.topic || '')}</div>
      <div class="row" style="gap:5px;margin-top:4px;flex-wrap:wrap">
        ${(j.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        ${(j.tags || []).length > 3 ? `<span class="tag">+${j.tags.length - 3}</span>` : ''}
        ${j.attempt > 1 ? `<span class="tag" title="Linked regeneration of an earlier attempt">attempt ${j.attempt}</span>` : ''}
        ${j.demo ? '<span class="pill pill--accent">DEMO</span>' : ''}
      </div>
    </div>
    <div data-col="Engine">${enginePill(j.engine)}<div class="cell-sub" style="margin-top:3px">${typePill(j.format)}</div></div>
    <div data-col="Progress">
      <div style="width:100%">${progressBar(j.progress ?? (j.status === 'published' ? 100 : j.status === 'queued' ? 0 : null), j.status === 'failed' ? 'red' : j.engine === 'verticals' ? 'blue' : '')}</div>
      <div class="cell-sub">${esc(j.stage || '—')}</div>
    </div>
    <div data-col="Status">${statusPill(j.status)}
      ${err ? `<div class="cell-sub" style="color:var(--red)">${esc(j.errorCategory ? `${j.errorCategory}: ` : '')}${esc(String(j.error).slice(0, 48))}</div>` : ''}
    </div>
    <div data-col="Updated"><span class="small muted">${esc(fmtAgo(j.updatedAt))}</span>
      <div class="cell-sub">Created ${esc(fmtDateTime(j.createdAt))}</div>
    </div>
  </div>`;
}

function detailDrawer(j) {
  const canApprove = ['needs-review', 'awaiting-review'].includes(j.status);
  const canPublish = j.status === 'approved' || (j.status === 'scheduled');
  const canRetry = j.status === 'failed';
  const blocked = j.publishBlocked;
  const why = {
    reject: j.status === 'published' ? 'Published videos cannot be rejected.' : '',
    approve: canApprove ? '' : 'Only videos awaiting review can be approved.',
    publish: blocked ? blocked : canPublish ? '' : 'Approve (or schedule) the video before publishing.',
    retry: canRetry ? '' : 'Only failed jobs can be retried.',
    regenerate: j.status === 'published' ? 'Published videos cannot be regenerated — create a new topic instead.' : '',
    edit: j.status === 'published' ? 'Published videos cannot be edited.' : '',
  };
  const hasRun = !!j.runId && !j.demo;
  const body = `
    ${hasRun ? `<div class="media-review">
      <video controls preload="metadata" playsinline style="width:100%;max-height:60vh;border-radius:12px;background:#000"
        src="/api/jobs/${encodeURIComponent(j.id)}/media?kind=video"></video>
      <div class="row row--wrap" style="gap:8px;margin-top:8px">
        <a class="btn btn--ghost btn--sm" href="/api/jobs/${encodeURIComponent(j.id)}/media?kind=video" target="_blank" rel="noopener">${icon('external', 'icon--sm')} Open video</a>
        ${j.engine === 'gemini' ? `<a class="btn btn--ghost btn--sm" href="/api/jobs/${encodeURIComponent(j.id)}/media?kind=short" target="_blank" rel="noopener">${icon('external', 'icon--sm')} Open Short</a>` : ''}
        <a class="btn btn--ghost btn--sm" href="/api/jobs/${encodeURIComponent(j.id)}/media?kind=thumb" target="_blank" rel="noopener">${icon('external', 'icon--sm')} Thumbnail</a>
      </div>
      <div id="visual-credits" class="small muted" style="margin-top:8px">Loading visual sources…</div>
    </div>` : thumb(j, true)}
    <div class="row row--wrap" style="gap:7px">
      <span class="pill pill--outline">${esc(j.format === 'short' ? 'Short · 9:16' : 'Long-form · 16:9')}</span>
      ${enginePill(j.engine)}
      ${statusPill(j.status)}
      ${j.attempt > 1 ? `<span class="pill pill--outline">Attempt ${j.attempt}</span>` : ''}
      ${j.demo ? '<span class="pill pill--accent">Demo record</span>' : ''}
    </div>
    ${j.demo ? '' : '<div id="job-progress" aria-live="polite"></div>'}

    <div>
      <div class="row" style="margin-bottom:6px">
        <strong class="small">Metadata (this is what will be sent to YouTube)</strong>
        <button class="btn btn--ghost btn--sm" id="btn-edit-meta" ${why.edit ? `disabled title="${esc(why.edit)}"` : ''}>${icon('doc', 'icon--sm')} Edit</button>
      </div>
      <h3 style="font-size:16px;font-weight:750;letter-spacing:-.2px">${esc(j.title)}</h3>
      <p class="small muted" style="margin-top:6px;line-height:1.65">${esc(j.description || 'No description generated yet.')}</p>
    </div>
    <div class="row row--wrap" style="gap:6px">${(j.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <dl class="kv">
      <dt>Topic</dt><dd>${esc(j.topic || '—')}</dd>
      <dt>Niche</dt><dd>${esc(j.niche || 'general')}</dd>
      <dt>Created</dt><dd>${esc(fmtDateTime(j.createdAt))}</dd>
      <dt>Scheduled</dt><dd>${j.scheduledFor ? esc(fmtDateTime(j.scheduledFor)) : '—'}</dd>
      <dt>Published</dt><dd>${j.publishedAt ? esc(fmtDateTime(j.publishedAt)) : '—'}</dd>
      ${j.parentJobId ? `<dt>Regenerated from</dt><dd class="mono"><a href="#/queue?job=${encodeURIComponent(j.parentJobId)}">${esc(j.parentJobId)}</a></dd>` : ''}
      ${j.youtubeId ? `<dt>YouTube ID</dt><dd class="mono">${esc(j.youtubeId)}</dd>` : ''}
      ${j.youtubeUrl ? `<dt>YouTube URL</dt><dd><a href="${esc(j.youtubeUrl)}" target="_blank" rel="noopener">${esc(j.youtubeUrl)}</a></dd>` : ''}
      <dt>Job ID</dt><dd class="mono">${esc(j.id)}</dd>
    </dl>
    ${j.error ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Failure${j.errorCategory ? ` (${esc(j.errorCategory)})` : ''}.</strong> ${esc(j.error)}
      ${j.errorRetryable === false ? '<br>This failure is classified as non-retryable — fix the configuration before retrying.' : ''}</div></div>` : ''}
    ${blocked ? `<div class="callout callout--warn">${icon('lock')}<div><strong>Publishing blocked.</strong> ${esc(blocked)}</div></div>` : ''}
    ${j.duplicateOf ? `<div class="callout callout--warn">${icon('copy')}<div><strong>Possible duplicate.</strong> Matches existing topic${j.duplicateOf.url ? ` — <a href="${esc(j.duplicateOf.url)}" target="_blank" rel="noopener">existing video</a>` : ''}. Normalised topic key: <span class="mono">${esc(j.duplicateOf.key || '')}</span></div></div>` : ''}
    <div>
      <div class="row" style="margin-bottom:8px"><strong class="small">Quality checks</strong>
        <span class="tiny muted">— only verifiable checks pass; the rest are labelled</span></div>
      <div class="qc">
        ${qcRow('Title length (≤100)', j.quality?.title)}
        ${qcRow('Metadata present', j.quality?.metadata)}
        ${qcRow('Output artifact', j.quality?.artifact)}
        ${qcRow('Duration > 0', j.quality?.duration)}
        ${qcRow('Narration', j.quality?.narration)}
        ${qcRow('Captions', j.quality?.captions)}
        ${qcRow('Duplicate check', j.quality?.duplicate)}
        ${qcRow('OAuth credentials', j.quality?.oauth)}
        ${qcRow('Review decision', j.quality?.review)}
        ${qcRow('Copyright / rights', j.quality?.rights)}
      </div>
    </div>
    <div>
      <div class="row" style="margin-bottom:8px"><strong class="small">Generation logs</strong>
        ${j.runId ? `<a class="tiny" href="#/runs?run=${encodeURIComponent(j.runId)}">Open run history</a>` : ''}</div>
      ${renderLogs(j.logs || [])}
    </div>`;

  const btn = (action, label, ic, cls = 'btn--secondary') =>
    `<button class="${cls} btn--sm" data-jact="${action}" ${why[action] ? `disabled title="${esc(why[action])}"` : ''}>${icon(ic, 'icon--sm')} ${label}</button>`;

  const foot = `
    ${btn('reject', 'Reject', 'x', 'btn--danger')}
    ${btn('regenerate', 'Regenerate', 'refresh')}
    ${btn('retry', 'Retry', 'run')}
    ${btn('schedule', 'Schedule', 'calendar')}
    ${btn('approve', 'Approve & Schedule', 'check', 'btn--primary')}
    ${btn('publish', 'Publish', 'upload', 'btn--primary')}
    ${j.youtubeUrl ? `<a class="btn btn--ghost btn--sm" href="${esc(j.youtubeUrl)}" target="_blank" rel="noopener">${icon('external', 'icon--sm')} Open YouTube</a>` : ''}`;

  openDrawer({ title: 'Video Details', body, foot });
  // Live step-by-step progress while the job runs (stops when done/closed).
  mountProgress(document.getElementById('job-progress'), `/api/jobs/${encodeURIComponent(j.id)}/progress`, {
    onDone: (p) => {
      toast(p.jobStatus === 'failed' ? 'Run failed' : 'Run finished',
        p.jobStatus === 'failed' ? (p.failingStep ? `Failed at step: ${p.failingStep}` : (p.error || '')) : `Status: ${p.jobStatus}`,
        p.jobStatus === 'failed' ? 'bad' : 'ok');
      refresh().catch(() => {});
    },
  });
  const credits = document.getElementById('visual-credits');
  if (credits) {
    fetch(`/api/jobs/${encodeURIComponent(j.id)}/media?kind=manifest`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const rows = [];
        for (const m of (d?.manifests || [])) {
          const items = Array.isArray(m.data) ? m.data : (m.data?.segments || m.data?.assets || m.data?.items || []);
          for (const it of items) {
            const a = it.asset || it;
            rows.push(`<li>${esc(String(it.segment ?? ''))} · ${esc(a.provider || 'unknown')} · ${esc(a.license || '—')}${it.review_required ? ' · <strong>review</strong>' : ''}${a.source_url && !/api\.cloudflare/.test(a.source_url) ? ` · <a href="${esc(a.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`);
          }
        }
        credits.innerHTML = rows.length ? `<strong>Visual sources</strong><ul style="margin:4px 0 0 16px">${rows.slice(0, 40).join('')}</ul>` : 'No visual manifest in this run.';
      })
      .catch(() => { credits.textContent = 'Visual sources unavailable.'; });
  }

  document.getElementById('btn-edit-meta')?.addEventListener('click', () => {
    openModal({
      title: 'Edit metadata',
      body: `
        <div class="field"><label class="field__label" for="m-title">Title (≤100 chars)</label>
          <input class="input" id="m-title" maxlength="100" value="${esc(j.title)}"></div>
        <div class="field"><label class="field__label" for="m-desc">Description</label>
          <textarea class="textarea" id="m-desc">${esc(j.description || '')}</textarea></div>
        <div class="field"><label class="field__label" for="m-tags">Tags (comma separated)</label>
          <input class="input" id="m-tags" value="${esc((j.tags || []).join(', '))}"></div>
        <div class="callout">${icon('info')}<div>These edits are persisted and are the metadata sent to YouTube when this job publishes.</div></div>`,
      foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
             <button class="btn btn--primary" id="m-save">Save metadata</button>`,
    });
    document.getElementById('m-cancel').onclick = closeModal;
    document.getElementById('m-save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const res = await api.patch(`/api/jobs/${j.id}`, {
          title: document.getElementById('m-title').value,
          description: document.getElementById('m-desc').value,
          tags: document.getElementById('m-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        });
        closeModal(); closeDrawer();
        toast('Metadata saved', res.message, 'ok');
        await refresh();
      } catch (err) {
        e.target.disabled = false;
        toast('Save failed', err.message, 'bad');
      }
    };
  });

  document.getElementById('drawer-foot').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-jact]');
    if (!b || b.disabled) return;
    const action = b.dataset.jact;
    if (action === 'reject') {
      if (!await confirmModal('Reject this video?', 'The job is marked rejected and will not publish. Generated artifacts are kept.', 'Reject', true)) return;
    }
    if (action === 'schedule') {
      openModal({
        title: 'Schedule publishing',
        body: `<div class="field"><label class="field__label" for="sch-when">Publish at (IST)</label>
               <input class="input" type="datetime-local" id="sch-when">
               <div class="field__hint">The console enforces the daily upload cap and duplicate check again at publish time.</div></div>`,
        foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
               <button class="btn btn--primary" id="m-save">Save schedule</button>`,
      });
      document.getElementById('m-cancel').onclick = closeModal;
      document.getElementById('m-save').onclick = async () => {
        const when = document.getElementById('sch-when').value;
        if (!when) { toast('Pick a time', 'Choose when this video should publish.', 'warn'); return; }
        try {
          const res = await api.jobAction(j.id, 'schedule', { when: new Date(when).toISOString() });
          closeModal(); closeDrawer();
          toast('Scheduled', res.message, 'ok');
          await refresh();
        } catch (err) { toast('Schedule failed', err.message, 'bad'); }
      };
      return;
    }
    b.disabled = true; // double-submission guard
    try {
      const res = action === 'retry'
        ? await api.jobRetry(j.id)
        : await api.jobAction(j.id, action, {});
      closeDrawer();
      toast('Done', res.message || 'Action completed.', 'ok');
      await refresh();
    } catch (err) {
      b.disabled = false;
      toast('Action failed', err.message, 'bad');
    }
  });
}

async function refresh() {
  const root = document.getElementById('page-root');
  const data = await api.jobs(filterQuery());
  const counts = data.counts || {};
  const jobs = data.jobs || [];

  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  const requestedJob = hashParams.get('job');
  if (requestedJob && jobs.some((j) => j.id === requestedJob)) view.selected = requestedJob;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Content Queue</h1>
        <div class="sub">Review, approve, and publish safely.</div>
      </div>
      <div class="page-head__actions">
        <span class="badge-soft">${icon('shield', 'icon--sm')} Human approval enabled</span>
        <span class="badge-soft badge-soft--neutral">${icon('copy', 'icon--sm')} Duplicate topics blocked</span>
        <button class="btn btn--primary" id="btn-add-topic">${icon('plus', 'icon--sm')} Add new topic</button>
      </div>
    </div>

    <div class="row row--wrap filter-bar" style="margin-bottom:10px">
      ${STATUS_TABS.map(([key, label]) => `
        <button class="chip ${view.tab === key ? 'is-active' : ''}" data-tab="${key}">
          ${esc(label)} <span class="chip__count">${counts[key === '' ? 'all' : key] ?? 0}</span>
        </button>`).join('')}
    </div>
    <div class="row row--wrap filter-bar" style="margin-bottom:14px">
      <div class="search">
        ${icon('search')}
        <input class="input" id="q-search" placeholder="Search titles, tags, or keywords…" value="${esc(view.q)}" />
      </div>
      <select class="select" id="q-engine" style="width:auto" title="Filter by engine">
        <option value="">All Engines</option>
        <option value="gemini" ${view.engine === 'gemini' ? 'selected' : ''}>Gemini Automation</option>
        <option value="verticals" ${view.engine === 'verticals' ? 'selected' : ''}>Verticals v3</option>
      </select>
      <select class="select" id="q-type" style="width:auto" title="Filter by format">
        <option value="">All Types</option>
        <option value="long-form" ${view.type === 'long-form' ? 'selected' : ''}>Long-form 16:9</option>
        <option value="short" ${view.type === 'short' ? 'selected' : ''}>Short 9:16</option>
      </select>
      <select class="select" id="q-niche" style="width:auto" title="Filter by niche">
        <option value="">All Niches</option>
        ${NICHES.map((n) => `<option value="${n}" ${view.niche === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <input class="input" type="date" id="q-date" style="width:auto" title="Created on or after" value="${esc(view.date)}">
      <select class="select" id="q-sort" style="width:auto">
        <option value="newest" ${view.sort === 'newest' ? 'selected' : ''}>Newest First</option>
        <option value="oldest" ${view.sort === 'oldest' ? 'selected' : ''}>Oldest First</option>
        <option value="status" ${view.sort === 'status' ? 'selected' : ''}>By status</option>
      </select>
    </div>

    <div class="card">
      ${jobs.length ? `
      <div class="table" role="table">
        <div class="table__head" role="row" style="grid-template-columns:28px 76px minmax(0,2.2fr) 1fr .9fr 1.2fr 1.05fr 1.1fr">
          <div><span class="check"></span></div><div>Video</div><div>Title</div>
          <div>Engine / Type</div><div>Progress</div><div>Status</div><div>Updated</div><div></div>
        </div>
        ${jobs.map((j) => jobRow(j)).join('')}
      </div>
      <div class="card__foot" style="justify-content:space-between">
        <span class="tiny muted">Showing ${jobs.length} of ${counts.all ?? jobs.length} jobs</span>
        <span class="tiny muted">Click a row to open the review panel</span>
      </div>`
      : emptyState('inbox', 'No videos match these filters', 'Adjust filters or add a new topic to start production.', `<button class="btn btn--primary btn--sm" id="empty-add">Add new topic</button>`)}
    </div>

    ${data.policyNote ? `<div class="callout" style="margin-top:16px">${icon('lock')}<div><strong>Human approval enabled.</strong> ${esc(data.policyNote)}</div></div>` : ''}

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console</span><span>·</span><span>Content Queue</span>
    </div>`;

  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { view.tab = b.dataset.tab; refresh(); };
  });

  // Preserve search focus/caret across re-renders (UX fix).
  const searchEl = root.querySelector('#q-search');
  if (searchEl.dataset.refocus === '1') {
    searchEl.focus();
    const v = searchEl.value; searchEl.value = ''; searchEl.value = v;
  }
  let t = null;
  searchEl.addEventListener('input', () => {
    searchEl.dataset.refocus = '1';
    clearTimeout(t);
    t = setTimeout(() => { view.q = searchEl.value.trim(); refresh(); }, 320);
  });
  root.querySelector('#q-engine').onchange = (e) => { view.engine = e.target.value; refresh(); };
  root.querySelector('#q-type').onchange = (e) => { view.type = e.target.value; refresh(); };
  root.querySelector('#q-niche').onchange = (e) => { view.niche = e.target.value; refresh(); };
  root.querySelector('#q-date').onchange = (e) => { view.date = e.target.value; refresh(); };
  root.querySelector('#q-sort').onchange = (e) => { view.sort = e.target.value; refresh(); };

  root.querySelectorAll('[data-job]').forEach((row) => {
    row.onclick = async () => {
      view.selected = row.dataset.job;
      try {
        const full = await api.job(row.dataset.job);
        detailDrawer(full.job);
        refresh();
      } catch (err) { toast('Could not load video', err.message, 'bad'); }
    };
  });

  const addTopic = async () => {
    openModal({
      title: 'Add new topic',
      body: `
        <div class="field"><label class="field__label" for="t-topic">Topic or keyword</label>
          <input class="input" id="t-topic" placeholder="e.g. The science of black holes" /></div>
        <div class="field"><label class="field__label" for="t-engine">Engine</label>
          <select class="select" id="t-engine">
            <option value="gemini">Gemini Automation (long-form + short)</option>
            <option value="verticals">Verticals v3 (vertical short)</option>
            <option value="auto">Orchestrator decides (per execution mode)</option>
          </select></div>
        <div class="field"><label class="field__label" for="t-niche">Niche</label>
          <select class="select" id="t-niche">${NICHES.map((n) => `<option>${n}</option>`).join('')}</select></div>
        <div class="callout">${icon('shield')}<div>The duplicate check runs before this topic is dispatched. A normalised match with an existing active or published video is blocked.</div></div>`,
      foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
             <button class="btn btn--primary" id="m-add">${icon('plus', 'icon--sm')} Add to queue</button>`,
    });
    document.getElementById('m-cancel').onclick = closeModal;
    document.getElementById('m-add').onclick = async (e) => {
      const topic = document.getElementById('t-topic').value.trim();
      if (!topic) { toast('Topic required', 'Enter a topic to add.', 'warn'); return; }
      e.target.disabled = true;
      const engine = document.getElementById('t-engine').value;
      const niche = document.getElementById('t-niche').value;
      try {
        const res = await api.createJob({ topic, engine, niche });
        closeModal();
        toast('Topic added', res.message, 'ok');
        await refresh();
      } catch (err) {
        e.target.disabled = false;
        toast('Blocked', err.message, 'bad');
      }
    };
  };
  root.querySelector('#btn-add-topic').onclick = addTopic;
  const ea = root.querySelector('#empty-add');
  if (ea) ea.onclick = addTopic;

  if (requestedJob && jobs.some((j) => j.id === requestedJob)) {
    const full = await api.job(requestedJob);
    detailDrawer(full.job);
    history.replaceState(null, '', '#/queue');
  }
}

export async function renderQueue() {
  await refresh();
}
