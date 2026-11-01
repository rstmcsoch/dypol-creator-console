/* Videos — "To check" first, then "Being made" and "All".
   Tapping a video opens the check screen: player on top, what will go to
   YouTube, and a sticky action bar (Approve & publish / Redo / Reject).
   Every technical detail of the old Content Queue (logs, steps, quality
   checks, IDs, visual sources, full-quality files) is kept under "Details".
   Safeguards unchanged: approve = one confirm then approve+publish; reject
   needs a reason; retries max 2; the server re-checks cap/duplicates/lock. */
import { api } from '../api.js';
import {
  icon, esc, statusPill, thumb, fmtDateTime, fmtAgo, toast, openDrawer, closeDrawer, renderLogs,
  emptyState, confirmModal, openModal, closeModal, qcRow, friendlyStage, failureLabel, failureNext,
  disabledAttr, makerName, statusInfo, errorToast, UI_PREFS, visWord,
} from '../ui.js';
import { mountProgress, progressLine, fetchProgress } from '../progress.js';
import { deleteVideos, runDeletes } from '../delete.js';

// Every job state belongs to exactly one chip, so the chips add up to "All".
const STATUS_TABS = [
  ['', 'All'], ['queued', 'Saved ideas'], ['dispatched,running,generating,rendering', 'Being made'],
  ['needs-review', 'Waiting for your check'], ['approved,scheduled', 'Approved'], ['uploading', 'Uploading'],
  ['published', 'On YouTube'], ['failed', 'Didn’t finish'], ['publish_failed', 'Upload didn’t finish'],
  ['rejected', 'Rejected'], ['superseded', 'Replaced by a redo'], ['cancelled', 'Stopped'],
];
const SEGMENTS = {
  check: 'needs-review',
  making: 'dispatched,running,generating,rendering,uploading,approved,scheduled',
  all: '',
};
const REJECTABLE = ['needs-review', 'awaiting-review', 'approved', 'scheduled', 'failed', 'publish_failed', 'queued'];
const REASONS = ['Boring or wrong topic', 'Visuals look bad', 'Voice or sound problem', 'Wrong facts', 'Title or description problem', 'Too slow or too long'];

function chipCount(counts, key) {
  if (key === '') return counts.all ?? 0;
  const by = counts.byStatus || counts;
  return key.split(',').reduce((n, s) => n + Number(by[s] || 0) + (s === 'needs-review' ? Number(by['awaiting-review'] || 0) : 0), 0);
}

function videoLinks(j, big = false) {
  const vids = (j.videos && j.videos.length) ? j.videos
    : (j.youtubeUrl ? [{ kind: j.format === 'short' ? 'short' : 'long', youtube_url: j.youtubeUrl, youtube_id: j.youtubeId }] : []);
  const label = (k) => (k === 'short' ? 'Watch the Short on YouTube' : k === 'long' ? 'Watch the video on YouTube' : 'Watch on YouTube');
  return vids.map((v) => `<a class="btn ${big ? 'btn--primary btn--lg' : 'btn--secondary btn--sm'}" href="${esc(v.youtube_url || `https://youtu.be/${v.youtube_id}`)}" target="_blank" rel="noopener">${icon('youtube', 'icon--sm')} ${esc(label(v.kind))}</a>`).join('');
}

const NICHES = ['general', 'tech', 'science', 'education', 'finance', 'gaming', 'motivation'];

let view = { seg: null, tab: '', q: '', engine: '', type: '', niche: '', date: '', sort: 'newest', selected: null, picking: false, picked: new Set() };
const asVideo = (j) => ({ id: j.id, title: j.title || j.topic || 'Video', statusLabel: statusInfo(j.status).label });
const deletionLine = (j) => (j.deletion ? (j.deletion.running ? 'Being deleted…' : 'Deletion not finished — open it and tap Retry delete') : '');

function filterQuery() {
  const p = new URLSearchParams();
  const status = view.tab || SEGMENTS[view.seg] || '';
  if (status) p.set('status', status);
  if (view.q) p.set('q', view.q);
  if (view.engine) p.set('engine', view.engine);
  if (view.type) p.set('type', view.type);
  if (view.niche) p.set('niche', view.niche);
  if (view.date) p.set('since', view.date);
  p.set('sort', view.sort);
  return `?${p.toString()}`;
}

/** Bottom sheet with reason chips + text. Resolves to text, '' (optional) or null (cancel). */
function reasonSheet({ title, intro, okLabel, danger = false, optional = false, prefill = '' }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="small">${esc(intro)}</p>
        <div class="chips-wrap" id="rs-chips">${REASONS.map((r) => `<button type="button" class="chip chip--lg" data-r="${esc(r)}">${esc(r)}</button>`).join('')}
          <button type="button" class="chip chip--lg" data-r="other">Other</button></div>
        <div class="field"><label class="field__label" for="rs-text">${optional ? 'What should change? (optional)' : 'Anything to add? (optional if you picked a reason)'}</label>
          <textarea class="textarea" id="rs-text" maxlength="2000" rows="3" placeholder="e.g. Fewer crowd clips; make the intro faster">${esc(prefill)}</textarea></div>`,
      foot: `<button class="btn btn--secondary" id="rs-cancel">Cancel</button>
             <button class="btn ${danger ? 'btn--danger-solid' : 'btn--primary'}" id="rs-ok">${esc(okLabel)}</button>`,
    });
    const picked = new Set();
    document.getElementById('rs-chips').onclick = (e) => {
      const c = e.target.closest('[data-r]');
      if (!c) return;
      const r = c.dataset.r;
      if (picked.has(r)) picked.delete(r); else picked.add(r);
      c.classList.toggle('is-active', picked.has(r));
      if (r === 'other' && picked.has(r)) document.getElementById('rs-text').focus();
    };
    document.getElementById('rs-cancel').onclick = () => { closeModal(); resolve(null); };
    document.getElementById('rs-ok').onclick = () => {
      const text = document.getElementById('rs-text').value.trim();
      const chips = [...picked].filter((r) => r !== 'other');
      const v = [chips.join('; '), text].filter(Boolean).join(' — ');
      if (!optional && v.length < 3) { toast('Pick a reason', 'Tap one of the reasons or type a few words.', 'warn'); return; }
      closeModal(); resolve(v);
    };
  });
}

function card(j) {
  const info = statusInfo(j.status);
  const err = ['failed', 'publish_failed'].includes(j.status);
  const picking = view.picking && view.seg === 'all';
  const picked = view.picked.has(j.id);
  return `
  <div class="vwrap ${picked ? 'is-picked' : ''}">
  ${picking ? `<label class="vpick" aria-label="Select ${esc(j.title || 'video')}"><input type="checkbox" data-pick="${esc(j.id)}" ${picked ? 'checked' : ''} ${j.status === 'uploading' ? 'disabled' : ''}></label>` : ''}
  <button class="vitem" data-job="${esc(j.id)}">
    ${thumb(j)}
    <span class="vitem__text">
      <span class="vitem__title">${esc(j.title || j.topic || 'Topic picked by the video maker')}</span>
      <span class="vitem__meta">${statusPill(j.status)}</span>
      <span class="vitem__sub">${esc(makerName(j.engine))} · ${esc(fmtAgo(j.updatedAt))}${j.attempt > 1 ? ` · version ${j.attempt}` : ''}${j.demo ? ' · demo' : ''}</span>
      ${err ? `<span class="vitem__err">${esc(failureLabel(j.errorCategory) || 'Something went wrong')}</span>` : ''}
      ${['dispatched', 'running', 'generating', 'rendering', 'uploading'].includes(j.status) ? `<span class="vitem__sub" data-pl="${esc(j.id)}">${esc(progressLine(j, null))}</span>` : ''}
      ${info.tone === 'amber' && ['needs-review', 'awaiting-review'].includes(j.status) ? '<span class="vitem__cta">Tap to check it</span>' : ''}
      ${j.deletion ? `<span class="vitem__err">${esc(deletionLine(j))}</span>` : ''}
    </span>
    ${icon('chevronR', 'icon--sm')}
  </button>
  ${picking ? '' : `<button class="vdel" data-del="${esc(j.id)}" aria-label="Delete ${esc(j.title || 'video')}" title="Delete">${icon('trash', 'icon--sm')}</button>`}
  </div>`;
}

function stateBanner(j, retriesLeft) {
  const i = statusInfo(j.status);
  let next = i.help;
  if (j.status === 'failed') next = `${failureLabel(j.errorCategory) || 'Something went wrong'}. ${j.errorRetryable === false ? 'This needs a setup fix first — check Settings → Advanced → System status.' : failureNext(j.errorCategory, retriesLeft)}`;
  if (j.status === 'publish_failed') next = 'The video is fine, but the YouTube upload stopped. Tap Try upload again — it won’t upload twice.';
  if (j.status === 'approved' && j.publishBlocked) next = `Approved, but not uploaded yet: ${j.publishBlocked}`;
  const ic = { amber: 'eye', red: 'alert', green: 'check', blue: 'refresh', violet: 'upload', gray: 'info', teal: 'check' }[i.tone] || 'info';
  return `<div class="state state--${i.tone}">${icon(ic)}<div><strong>${esc(i.label)}</strong><span>${esc(next)}</span></div></div>`;
}

function detailDrawer(j) {
  const canApprove = ['needs-review', 'awaiting-review'].includes(j.status);
  const canPublish = ['approved', 'scheduled'].includes(j.status);
  const canRetry = ['failed', 'cancelled', 'publish_failed'].includes(j.status);
  const canStop = ['dispatched', 'running', 'generating', 'rendering'].includes(j.status);
  const isIdea = j.status === 'queued';
  const retriesLeft = Math.max(0, 2 - Number(j.retryCount || 0));
  const blocked = canPublish || canApprove ? j.publishBlocked : null;
  // A video that is simply waiting for review is not "blocked" — only show real blockers.
  const realBlock = blocked && !/review|approve the video/i.test(blocked) ? blocked : null;
  const why = {
    reject: REJECTABLE.includes(j.status) ? '' : j.status === 'uploading' ? 'It is uploading right now.' : `A video that is “${statusInfo(j.status).label}” can’t be rejected.`,
    approve: canApprove ? '' : 'Only videos waiting for your check can be approved.',
    publish: canPublish ? (realBlock || '') : 'Approve the video first.',
    retry: !canRetry ? 'Only videos that didn’t finish can be tried again.'
      : j.status !== 'publish_failed' && !retriesLeft ? 'Both tries are used — tap Redo for a fresh version.' : '',
    regenerate: ['published', 'uploading'].includes(j.status) ? 'Videos on YouTube or uploading can’t be redone — make a new video instead.' : isIdea ? 'Not made yet.' : '',
    edit: j.status === 'published' ? 'Videos already on YouTube can’t be edited here — edit them in YouTube Studio.' : '',
  };
  const hasRun = !!j.runId && !j.demo;
  const media = (kind, extra = '') => `/api/jobs/${encodeURIComponent(j.id)}/media?kind=${kind}${extra}`;
  const qc = j.quality || {};
  const qcIssues = j.status === 'published' ? [] : Object.entries(qc).filter(([, r]) => r?.state === 'failed');
  const QC_NAMES = { title: 'Title length', metadata: 'Title & description', artifact: 'Video file', duration: 'Video length', narration: 'Voice', captions: 'Captions', duplicate: 'Repeat-topic check', oauth: 'YouTube sign-in', review: 'Your check', rights: 'Image & music rights' };

  const body = `
    ${j.deletion ? `<div class="state state--red">${icon('alert')}<div><strong>${j.deletion.running ? 'Being deleted…' : 'Deletion not finished'}</strong>
      <span>Some parts couldn’t be removed yet${j.deletion.remaining?.githubRuns ? ` (${j.deletion.remaining.githubRuns} GitHub run${j.deletion.remaining.githubRuns === 1 ? '' : 's'} left)` : ''}. Nothing was touched on YouTube.</span>
      <button class="btn btn--danger-solid btn--sm" id="btn-retry-delete" style="margin-top:8px;align-self:flex-start">${icon('refresh', 'icon--sm')} Retry delete</button></div></div>` : stateBanner(j, retriesLeft)}
    ${hasRun ? `<div class="media-review">
      <video controls preload="metadata" playsinline class="player ${j.format === 'short' ? 'player--short' : ''}" src="${media('video')}"></video>
      <div class="row row--wrap" style="gap:8px;margin-top:8px">
        ${j.engine === 'gemini' ? `<a class="btn btn--secondary btn--sm" href="${media('short')}" target="_blank" rel="noopener">${icon('play', 'icon--sm')} Watch the Short</a>` : ''}
        <a class="btn btn--ghost btn--sm" href="${media('video', '&quality=full&download=1')}" rel="noopener">${icon('external', 'icon--sm')} Full-quality file</a>
      </div>
      <div class="tiny muted" style="margin-top:4px">This player shows a small preview. Open the full-quality file if detail matters.</div>
    </div>` : `<div class="player-ph">${thumb(j, true)}<div class="tiny muted">${j.demo ? 'Demo video — no real preview.' : 'The preview appears here when the video is ready.'}</div></div>`}
    ${j.demo ? '' : '<div id="job-progress" aria-live="polite"></div>'}

    <section class="sheet-sec">
      <div class="sheet-sec__head"><strong>What goes to YouTube</strong>
        <button class="btn btn--ghost btn--sm" id="btn-edit-meta" ${disabledAttr(why.edit)}>${icon('doc', 'icon--sm')} Edit</button></div>
      <div class="meta-title">${esc(j.title || 'No title yet')}</div>
      <p class="meta-desc">${esc(j.description || 'No description yet.')}</p>
      ${(j.tags || []).length ? `<div class="row row--wrap" style="gap:6px">${j.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="tiny muted" style="margin-top:8px">${esc(makerName(j.engine))} · ${j.status === 'published' ? 'on YouTube' : `goes up as ${esc(visWord())}`}</div>
    </section>

    ${(j.videos || []).length || j.youtubeUrl ? `<section class="sheet-sec"><strong>On YouTube</strong><div class="yt-links" style="margin-top:8px">${videoLinks(j)}</div></section>` : ''}
    ${j.reviewNote ? `<div class="callout">${icon('doc')}<div><strong>Your note:</strong> ${esc(j.reviewNote)}</div></div>` : ''}
    ${realBlock ? `<div class="callout callout--warn">${icon('lock')}<div><strong>Can’t publish yet.</strong> ${esc(realBlock)}</div></div>` : ''}
    ${j.duplicateOf ? `<div class="callout callout--warn">${icon('copy')}<div><strong>This looks like a topic you already made.</strong> ${j.duplicateOf.url ? `<a href="${esc(j.duplicateOf.url)}" target="_blank" rel="noopener">See the earlier video</a>. ` : ''}Publishing will be blocked to avoid a repeat.</div></div>` : ''}
    ${qcIssues.length ? `<div class="callout callout--warn">${icon('alert')}<div><strong>Check this before approving:</strong> ${qcIssues.map(([k, r]) => `${esc(QC_NAMES[k] || k)} (${esc(r.label || r.state)})`).join(', ')}</div></div>` : ''}

    <details class="mini-details tech">
      <summary>${icon('info', 'icon--sm')} Details <span class="muted small">checks, files, steps, logs, IDs</span></summary>
      <div class="stack" style="margin-top:10px">
        <dl class="kv">
          <dt>Topic</dt><dd>${esc(j.topic || '—')}</dd>
          <dt>Category</dt><dd>${esc(j.niche || 'general')}</dd>
          <dt>Video maker</dt><dd>${esc(makerName(j.engine))}</dd>
          ${j.attempt > 1 ? `<dt>Version</dt><dd>${esc(String(j.attempt))}</dd>` : ''}
          <dt>Created</dt><dd>${esc(fmtDateTime(j.createdAt))}</dd>
          <dt>Planned for</dt><dd>${j.scheduledFor ? esc(fmtDateTime(j.scheduledFor)) : '—'}</dd>
          <dt>Published</dt><dd>${j.publishedAt ? esc(fmtDateTime(j.publishedAt)) : '—'}</dd>
          ${j.parentJobId ? `<dt>Redo of</dt><dd class="mono"><a href="#/videos?job=${encodeURIComponent(j.parentJobId)}">${esc(j.parentJobId)}</a></dd>` : ''}
          ${(j.videos || []).map((v) => `<dt>${v.kind === 'short' ? 'YouTube Short' : v.kind === 'long' ? 'Long video' : 'YouTube'}</dt><dd><a href="${esc(v.youtube_url)}" target="_blank" rel="noopener">${esc(v.youtube_url)}</a></dd>`).join('')}
          ${!(j.videos || []).length && j.youtubeUrl ? `<dt>YouTube</dt><dd><a href="${esc(j.youtubeUrl)}" target="_blank" rel="noopener">${esc(j.youtubeUrl)}</a></dd>` : ''}
          <dt>Reference</dt><dd class="mono">${esc(j.id)}</dd>
          ${j.stage ? `<dt>Last step</dt><dd>${esc(friendlyStage(j.stage))}</dd>` : ''}
        </dl>
        ${j.error && ['failed', 'publish_failed', 'cancelled'].includes(j.status) ? `<div class="callout callout--danger">${icon('alert')}<div><strong>${esc(failureLabel(j.errorCategory) || 'Error')}.</strong> ${esc(j.error)}
          ${j.errorLog ? `<details style="margin-top:6px"><summary class="small">Last lines of the log</summary><pre class="log-tail">${esc(j.errorLog)}</pre></details>` : ''}</div></div>` : ''}
        ${j.duplicateOf?.key ? `<div class="tiny muted">Repeat-topic key: <span class="mono">${esc(j.duplicateOf.key)}</span></div>` : ''}
        ${hasRun ? `<div class="row row--wrap" style="gap:8px">
          <a class="btn btn--ghost btn--sm" href="${media('video')}" target="_blank" rel="noopener">${icon('external', 'icon--sm')} Open preview</a>
          <a class="btn btn--ghost btn--sm" href="${media('thumb')}" target="_blank" rel="noopener">${icon('image', 'icon--sm')} Thumbnail</a>
          ${j.engine === 'gemini' ? `<a class="btn btn--ghost btn--sm" href="${media('short', '&quality=full&download=1')}" rel="noopener">${icon('external', 'icon--sm')} Full-quality Short</a>` : ''}
        </div>
        <div id="visual-credits" class="small muted">Loading picture sources…</div>` : ''}
        <div>
          <div class="small" style="font-weight:700;margin-bottom:6px">All checks</div>
          <div class="qc">
            ${qcRow('Title length (100 characters max)', qc.title)}
            ${qcRow('Title & description present', qc.metadata)}
            ${qcRow('Video file made', qc.artifact)}
            ${qcRow('Video has a length', qc.duration)}
            ${qcRow('Voice', qc.narration)}
            ${qcRow('Captions', qc.captions)}
            ${qcRow('Repeat-topic check', qc.duplicate)}
            ${qcRow('YouTube sign-in', qc.oauth)}
            ${qcRow('Your check', qc.review)}
            ${qcRow('Image & music rights', qc.rights)}
          </div>
        </div>
        <div>
          <div class="row" style="margin-bottom:6px"><span class="small" style="font-weight:700">Log</span>
            ${j.runId ? `<a class="tiny" href="#/runs?run=${encodeURIComponent(j.runId)}">Open in technical history</a>` : ''}</div>
          ${renderLogs(j.logs || [])}
        </div>
      </div>
    </details>

    <section class="danger-zone">
      <div><strong>Delete video</strong>
        <span>Removes it from the dashboard and GitHub (runs, logs, saved files).${j.status === 'published' || (j.videos || []).length ? ' The video stays on YouTube.' : ''}${['dispatched', 'running', 'generating', 'rendering'].includes(j.status) ? ' It is stopped first.' : ''}</span></div>
      <button class="btn btn--danger btn--sm" id="btn-delete" ${j.status === 'uploading' ? disabledAttr('It is uploading right now — delete it after the upload finishes.') : ''}>${icon('trash', 'icon--sm')} Delete</button>
    </section>`;

  const btn = (action, label, ic, cls = 'btn--secondary') =>
    `<button class="btn ${cls}" data-jact="${action}" ${disabledAttr(why[action])}>${icon(ic, 'icon--sm')} ${label}</button>`;

  let primary = '';
  if (canApprove) primary = btn('approve', 'Approve & publish', 'check', 'btn--primary btn--xl');
  else if (canPublish) primary = btn('publish', 'Publish now', 'upload', 'btn--primary btn--xl');
  else if (canRetry) primary = btn('retry', j.status === 'publish_failed' ? 'Try upload again' : `Try again (${retriesLeft} left)`, 'refresh', 'btn--primary btn--xl');
  else if (canStop) primary = `<button class="btn btn--secondary btn--xl" data-jact="cancel">${icon('x', 'icon--sm')} Stop making</button>`;
  else if (isIdea) primary = `<a class="btn btn--primary btn--xl" href="#/make?topic=${encodeURIComponent(j.topic || j.title || '')}&kind=${encodeURIComponent(j.engine || '')}">${icon('play', 'icon--sm')} Make this video now</a>`;
  const secondary = [
    why.regenerate ? '' : btn('regenerate', 'Redo', 'refresh'),
    isIdea ? `<button class="btn btn--danger" data-jact="cancel">${icon('x', 'icon--sm')} Remove idea</button>` : REJECTABLE.includes(j.status) ? btn('reject', 'Reject', 'x', 'btn--danger') : '',
  ].filter(Boolean).join('');
  const foot = j.status === 'published'
    ? `<div class="foot-stack">${videoLinks(j, true) || '<span class="small muted">On YouTube.</span>'}</div>`
    : `<div class="foot-stack">${primary}${secondary ? `<div class="foot-row">${secondary}</div>` : ''}</div>`;

  openDrawer({ title: canApprove ? 'Check this video' : 'Video', body, foot });
  document.getElementById('drawer').dataset.kind = 'review';
  mountProgress(document.getElementById('job-progress'), `/api/jobs/${encodeURIComponent(j.id)}/progress`, {
    showWhenDone: false,
    onDone: (p) => {
      toast(p.jobStatus === 'failed' ? 'It didn’t finish' : 'Ready!',
        p.jobStatus === 'failed' ? 'Open it to see what to do next.' : `${statusInfo(p.jobStatus).label}.`,
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
            rows.push(`<li>${esc(String(it.segment ?? ''))} · ${esc(a.provider || 'unknown')} · ${esc(a.license || '—')}${it.review_required ? ' · <strong>check</strong>' : ''}${a.source_url && !/api\.cloudflare/.test(a.source_url) ? ` · <a href="${esc(a.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`);
          }
        }
        credits.innerHTML = rows.length ? `<details><summary><strong>Where the pictures came from (${rows.length})</strong></summary><ul style="margin:4px 0 0 16px">${rows.slice(0, 40).join('')}</ul></details>` : 'No picture-source list in this video.';
      })
      .catch(() => { credits.textContent = 'Picture sources unavailable.'; });
  }

  const afterDelete = () => { closeDrawer(); refresh().catch(() => {}); };
  document.getElementById('btn-delete')?.addEventListener('click', async (ev) => {
    if (ev.currentTarget.getAttribute('aria-disabled') === 'true') { toast('Can’t delete yet', ev.currentTarget.dataset.why || '', 'warn'); return; }
    await deleteVideos([asVideo(j)], { onChange: afterDelete });
  });
  document.getElementById('btn-retry-delete')?.addEventListener('click', () => runDeletes([asVideo(j)], [], { onChange: afterDelete }));

  document.getElementById('btn-edit-meta')?.addEventListener('click', (ev) => {
    if (ev.currentTarget.getAttribute('aria-disabled') === 'true') return;
    openModal({
      title: 'Edit what goes to YouTube',
      body: `
        <div class="field"><label class="field__label" for="m-title">Title</label>
          <input class="input input--lg" id="m-title" maxlength="100" value="${esc(j.title)}">
          <div class="field__hint"><span id="m-count">${(j.title || '').length}</span>/100 characters. No personal names.</div></div>
        <div class="field"><label class="field__label" for="m-desc">Description</label>
          <textarea class="textarea" id="m-desc" rows="5">${esc(j.description || '')}</textarea>
          <div class="field__hint">Shown under the video on YouTube.</div></div>
        <div class="field"><label class="field__label" for="m-tags">Tags</label>
          <input class="input input--lg" id="m-tags" value="${esc((j.tags || []).join(', '))}">
          <div class="field__hint">Separate with commas, e.g. space, science, explainer.</div></div>`,
      foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
             <button class="btn btn--primary" id="m-save">Save</button>`,
    });
    document.getElementById('m-title').oninput = (e) => { document.getElementById('m-count').textContent = e.target.value.length; };
    document.getElementById('m-cancel').onclick = closeModal;
    document.getElementById('m-save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api.patch(`/api/jobs/${j.id}`, {
          title: document.getElementById('m-title').value,
          description: document.getElementById('m-desc').value,
          tags: document.getElementById('m-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        });
        closeModal();
        toast('Saved', 'This is what will be sent to YouTube.', 'ok');
        const full = await api.job(j.id);
        detailDrawer(full.job);
        refresh().catch(() => {});
      } catch (err) {
        e.target.disabled = false;
        errorToast(err, 'Couldn’t save');
      }
    };
  });

  document.getElementById('drawer-foot').onclick = async (e) => {
    const b = e.target.closest('[data-jact]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
    const action = b.dataset.jact;
    let payload = {};
    if (action === 'reject') {
      const reason = await reasonSheet({ title: 'Reject this video?', intro: 'It will not be published. Your reason is saved and used as feedback if you tap Redo later.', okLabel: 'Reject video', danger: true });
      if (reason === null) return;
      payload = { reason };
    }
    if (action === 'approve') {
      let capText = '';
      try {
        const l = await api.jobs('?status=published&sort=newest');
        if (l.cap) capText = `This will be upload ${Math.min(l.cap.used + 1, l.cap.limit)} of ${l.cap.limit} today.`;
      } catch { /* optional */ }
      if (!await confirmModal('Publish to YouTube?', `
          <div class="confirm-card"><strong>${esc(j.title || 'This video')}</strong>
            <span>${esc(makerName(j.engine))}${j.engine === 'gemini' ? ' — the video and its Short both go up' : ''}</span></div>
          <ul class="confirm-list">
            <li>${icon('eye', 'icon--sm')}<span>Goes up as <strong>${esc(visWord())}</strong>${UI_PREFS.visibility === 'unlisted' ? ' — only people with the link can see it' : ''}.</span></li>
            ${capText ? `<li>${icon('upload', 'icon--sm')}<span>${esc(capText)}</span></li>` : ''}
            <li>${icon('shield', 'icon--sm')}<span>The daily limit and repeat-topic check still apply.</span></li>
          </ul>`, 'Approve & publish', false, 'Not yet')) return;
    }
    if (action === 'publish' || (action === 'retry' && j.status === 'publish_failed')) {
      if (!await confirmModal(action === 'publish' ? 'Publish now?' : 'Try the upload again?', `<p>It goes up as <strong>${esc(visWord())}</strong>. The console first checks that nothing from this video is already on YouTube, so it can’t upload twice.</p>`, action === 'publish' ? 'Publish now' : 'Try upload again', false, 'Not yet')) return;
    }
    if (action === 'retry' && j.status !== 'publish_failed') {
      if (!await confirmModal('Try again?', `<p>Makes this video again with the latest version of the video maker (about 15 minutes). ${retriesLeft} ${retriesLeft === 1 ? 'try' : 'tries'} left.</p>`, 'Try again', false, 'Not now')) return;
    }
    if (action === 'cancel') {
      if (isIdea ? !await confirmModal('Remove this idea?', '<p>The saved topic is removed from your list. Nothing was made or published.</p>', 'Remove idea', true, 'Keep it')
        : !await confirmModal('Stop making this video?', '<p>The video maker stops and this video is thrown away. Nothing is published.</p>', 'Stop making', true, 'Keep making')) return;
    }
    if (action === 'regenerate') {
      const fb = await reasonSheet({ title: 'Make a new version?', intro: 'A fresh version is made (about 15 minutes) and replaces this one. Tell the maker what to change — optional.', okLabel: 'Start new version', optional: true, prefill: j.reviewNote || '' });
      if (fb === null) return;
      payload = fb ? { feedback: fb } : {};
    }
    b.disabled = true; // double-submission guard
    try {
      const res = action === 'retry'
        ? await api.jobRetry(j.id)
        : await api.jobAction(j.id, action, payload);
      closeDrawer();
      const done = {
        approve: res.published === false ? ['Approved — not uploaded yet', res.message || 'Open it later and tap Publish now.', 'warn'] : ['Approved!', `It’s going up on YouTube as ${visWord()}.`, 'ok'],
        publish: ['Publishing…', `It’s going up on YouTube as ${visWord()}.`, 'ok'],
        reject: ['Rejected', 'It won’t be published. Your reason was saved.', 'ok'],
        regenerate: ['New version started', 'Follow it on Home — about 15 minutes.', 'ok'],
        retry: ['Trying again', 'Follow it on Home.', 'ok'],
        cancel: isIdea ? ['Idea removed', '', 'ok'] : ['Stopped', 'Nothing was published.', 'ok'],
      }[action] || ['Done', res.message || '', 'ok'];
      toast(done[0], done[1], done[2], 6000);
      await refresh();
    } catch (err) {
      b.disabled = false;
      errorToast(err, 'That didn’t work');
    }
  };
}

async function openJob(id) {
  try {
    const full = await api.job(id);
    view.selected = id;
    detailDrawer(full.job);
  } catch (err) { errorToast(err, 'Couldn’t open the video'); }
}

async function refresh() {
  const root = document.getElementById('page-root');
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  if (hashParams.get('tab') && SEGMENTS[hashParams.get('tab')] !== undefined) { view.seg = hashParams.get('tab'); view.tab = ''; }
  if (hashParams.get('status')) view.tab = hashParams.get('status');
  const requestedJob = hashParams.get('job');
  if (hashParams.get('tab') || hashParams.get('status') || requestedJob) history.replaceState(null, '', '#/videos');

  // First visit: open "To check" when something is waiting, otherwise "All".
  if (view.seg === null) {
    const probe = await api.jobs('?sort=newest');
    view.seg = (probe.counts?.['needs-review'] || 0) > 0 ? 'check' : 'all';
  }
  const data = await api.jobs(filterQuery());
  const counts = data.counts || {};
  const jobs = data.jobs || [];
  const nCheck = chipCount(counts, 'needs-review');
  const nMaking = chipCount(counts, SEGMENTS.making);
  const filtersOn = !!(view.tab || view.q || view.engine || view.type || view.niche || view.date || view.sort !== 'newest');

  const empty = {
    check: ['eye', 'Nothing to check right now', 'When a video is ready, it shows up here for you to watch and approve.'],
    making: ['video', 'Nothing is being made', 'Start a video and you can follow it here and on Home.'],
    all: ['inbox', filtersOn ? 'No videos match these filters' : 'No videos yet', filtersOn ? 'Clear the filters to see everything.' : 'Make your first video — it takes about 15 minutes.'],
  }[view.seg] || ['inbox', 'No videos', ''];

  root.innerHTML = `
    <div class="page-head page-head--simple">
      <div><h1>Videos</h1>
        <div class="sub">Check new videos, follow the ones being made, and find old ones.</div></div>
    </div>

    <div class="segbar" role="tablist">
      <button role="tab" class="${view.seg === 'check' ? 'is-active' : ''}" data-seg="check">To check${nCheck ? ` <span class="segbar__n segbar__n--amber">${nCheck}</span>` : ''}</button>
      <button role="tab" class="${view.seg === 'making' ? 'is-active' : ''}" data-seg="making">Being made${nMaking ? ` <span class="segbar__n">${nMaking}</span>` : ''}</button>
      <button role="tab" class="${view.seg === 'all' ? 'is-active' : ''}" data-seg="all">All <span class="segbar__n">${counts.all ?? 0}</span></button>
    </div>
    ${data.cap ? `<div class="tiny muted" style="margin:-4px 2px 12px">Uploads today: ${esc(String(data.cap.used))} of ${esc(String(data.cap.limit))} used · resets 5:30 AM</div>` : ''}

    <details class="filters" ${filtersOn ? 'open' : ''}>
      <summary>${icon('filter', 'icon--sm')} Search &amp; filters${filtersOn ? ' <span class="pill pill--accent">on</span>' : ''}</summary>
      <div class="filters__body">
        <div class="search">${icon('search')}<input class="input" id="q-search" placeholder="Search titles or tags…" value="${esc(view.q)}" /></div>
        <div class="field__label" style="margin-top:4px">Status</div>
        <div class="row row--wrap filter-chips">
          ${STATUS_TABS.map(([key, label]) => `
            <button class="chip ${view.tab === key && (key || filtersOn) ? 'is-active' : ''}" data-tab="${key}">${esc(label)} <span class="chip__count">${chipCount(counts, key)}</span></button>`).join('')}
        </div>
        <div class="filters__grid">
          <label class="field"><span class="field__label">Kind</span><select class="select" id="q-engine">
            <option value="">Any kind</option>
            <option value="gemini" ${view.engine === 'gemini' ? 'selected' : ''}>Long video + Short</option>
            <option value="verticals" ${view.engine === 'verticals' ? 'selected' : ''}>Short only</option></select></label>
          <label class="field"><span class="field__label">Shape</span><select class="select" id="q-type">
            <option value="">Any shape</option>
            <option value="long-form" ${view.type === 'long-form' ? 'selected' : ''}>Long video 16:9</option>
            <option value="short" ${view.type === 'short' ? 'selected' : ''}>Short 9:16</option></select></label>
          <label class="field"><span class="field__label">Category</span><select class="select" id="q-niche">
            <option value="">Any category</option>
            ${NICHES.map((n) => `<option value="${n}" ${view.niche === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field"><span class="field__label">Made on or after</span><input class="input" type="date" id="q-date" value="${esc(view.date)}"></label>
          <label class="field"><span class="field__label">Order</span><select class="select" id="q-sort">
            <option value="newest" ${view.sort === 'newest' ? 'selected' : ''}>Newest first</option>
            <option value="oldest" ${view.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
            <option value="status" ${view.sort === 'status' ? 'selected' : ''}>By status</option></select></label>
        </div>
        ${filtersOn ? '<button class="btn btn--ghost btn--sm" id="q-clear">Clear filters</button>' : ''}
      </div>
    </details>

    ${view.seg === 'all' && jobs.length ? `<div class="row pick-head">
      ${view.picking ? `<label class="small"><input type="checkbox" id="pick-all" ${jobs.every((j) => view.picked.has(j.id) || j.status === 'uploading') ? 'checked' : ''}> Select all shown</label>
        <button class="btn btn--ghost btn--sm" id="pick-cancel">Cancel</button>`
      : `<button class="btn btn--ghost btn--sm" id="pick-start">${icon('check', 'icon--sm')} Select videos to delete</button>`}
    </div>` : ''}
    ${jobs.length ? `<div class="vlist-big">${jobs.map(card).join('')}</div>
      <div class="tiny muted" style="margin:10px 2px">Showing ${jobs.length} of ${counts.all ?? jobs.length} videos</div>`
      : `<div class="card">${emptyState(empty[0], empty[1], empty[2], `<a class="btn btn--primary btn--lg" href="#/make">${icon('plus', 'icon--sm')} Make a new video</a>`)}</div>`}

    ${view.picking && view.seg === 'all' ? `<div class="bulkbar"><span><strong>${view.picked.size}</strong> selected</span>
      <button class="btn btn--danger-solid" id="bulk-delete" ${view.picked.size ? '' : 'disabled'}>${icon('trash', 'icon--sm')} Delete ${view.picked.size || ''}</button></div>` : ''}
    <div class="callout" style="margin-top:14px">${icon('shield')}<div>You check every video before it goes up. Approve sends it to YouTube as ${esc(visWord())}; the daily limit and repeat-topic check are always applied.</div></div>`;

  root.querySelectorAll('[data-seg]').forEach((b) => {
    b.onclick = () => { view.seg = b.dataset.seg; view.tab = ''; refresh(); };
  });
  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { view.tab = b.dataset.tab; if (!b.dataset.tab) view.seg = 'all'; refresh(); };
  });
  const searchEl = root.querySelector('#q-search');
  if (searchEl && view._refocus) {
    searchEl.focus();
    const v = searchEl.value; searchEl.value = ''; searchEl.value = v;
    view._refocus = false;
  }
  let t = null;
  searchEl?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { view.q = searchEl.value.trim(); view._refocus = true; refresh(); }, 320);
  });
  root.querySelector('#q-engine').onchange = (e) => { view.engine = e.target.value; refresh(); };
  root.querySelector('#q-type').onchange = (e) => { view.type = e.target.value; refresh(); };
  root.querySelector('#q-niche').onchange = (e) => { view.niche = e.target.value; refresh(); };
  root.querySelector('#q-date').onchange = (e) => { view.date = e.target.value; refresh(); };
  root.querySelector('#q-sort').onchange = (e) => { view.sort = e.target.value; refresh(); };
  const clear = root.querySelector('#q-clear');
  if (clear) clear.onclick = () => { Object.assign(view, { tab: '', q: '', engine: '', type: '', niche: '', date: '', sort: 'newest' }); refresh(); };

  root.querySelectorAll('[data-job]').forEach((row) => {
    row.onclick = () => {
      if (view.picking && view.seg === 'all') {
        const j = jobs.find((x) => x.id === row.dataset.job);
        if (j && j.status !== 'uploading') { if (view.picked.has(j.id)) view.picked.delete(j.id); else view.picked.add(j.id); refresh(); }
        return;
      }
      openJob(row.dataset.job);
    };
  });
  root.querySelectorAll('[data-pick]').forEach((cb) => {
    cb.onchange = () => { if (cb.checked) view.picked.add(cb.dataset.pick); else view.picked.delete(cb.dataset.pick); refresh(); };
  });
  root.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const j = jobs.find((x) => x.id === b.dataset.del);
      if (!j) return;
      if (j.status === 'uploading') { toast('Can’t delete yet', 'It is uploading right now — delete it after the upload finishes.', 'warn'); return; }
      await deleteVideos([asVideo(j)], { onChange: () => refresh().catch(() => {}) });
    };
  });
  const pickStart = root.querySelector('#pick-start');
  if (pickStart) pickStart.onclick = () => { view.picking = true; view.picked = new Set(); refresh(); };
  const pickCancel = root.querySelector('#pick-cancel');
  if (pickCancel) pickCancel.onclick = () => { view.picking = false; view.picked = new Set(); refresh(); };
  const pickAll = root.querySelector('#pick-all');
  if (pickAll) pickAll.onchange = () => { for (const j of jobs) if (j.status !== 'uploading') { if (pickAll.checked) view.picked.add(j.id); else view.picked.delete(j.id); } refresh(); };
  const bulk = root.querySelector('#bulk-delete');
  if (bulk) bulk.onclick = async () => {
    const chosen = jobs.filter((j) => view.picked.has(j.id)).map(asVideo);
    // selections from other filters/pages that are not on screen are kept by id
    for (const id of view.picked) if (!chosen.some((c) => c.id === id)) chosen.push({ id, title: id });
    const ok = await deleteVideos(chosen, { onChange: () => { view.picking = false; view.picked = new Set(); refresh().catch(() => {}); } });
    if (!ok) refresh().catch(() => {});
  };
  for (const j of jobs.filter((x) => ['dispatched', 'running', 'generating', 'rendering'].includes(x.status)).slice(0, 4)) {
    fetchProgress(j.id).then((p) => {
      const el = root.querySelector(`[data-pl="${CSS.escape(j.id)}"]`);
      if (el && p) el.textContent = progressLine(j, p);
    });
  }

  if (requestedJob) await openJob(requestedJob);
}

export async function renderQueue() {
  await refresh();
}
