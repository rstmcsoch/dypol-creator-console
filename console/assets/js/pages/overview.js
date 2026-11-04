/* Home — what needs you, what is being made, today's uploads, one big
   "Make a new video" button. Technical status stays collapsed at the bottom
   and only speaks up (as a banner) when something is actually wrong. */
import { api } from '../api.js';
import { quotaPanelShell, mountQuotaPanel } from '../quota-panel.js';
import { progressLine, fetchProgress } from '../progress.js';
import {
  icon, esc, statusPill, thumb, fmtAgo, toast, confirmModal, makerName, failureLabel,
  errorToast, UI_PREFS, statusInfo,
} from '../ui.js';

const MAKING = ['dispatched', 'running', 'generating', 'rendering', 'uploading'];
const CHECK = ['needs-review', 'awaiting-review'];

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const openJob = (id) => `#/videos?job=${encodeURIComponent(id)}`;

/** Problems worth a banner (everything healthy → nothing shown). */
function quotaProblems(q) {
  const out = [];
  if (!q || q.demo) return out;
  if (q.token?.state === 'bad') out.push('The cloud connection key has a problem — new videos can’t start.');
  else if (q.token?.state === 'warn') out.push('The cloud connection key expires soon — renew it to keep things running.');
  if (q.storage?.state === 'bad') out.push('Cloud storage for video files is full — old files need clearing.');
  for (const e of q.engines || []) {
    const n = makerName(e.engine);
    if (e.flux?.state === 'bad') out.push(`${n}: the image maker hit today’s limit — videos may use stock clips instead until it resets.`);
    if (e.pixabay?.state === 'bad') out.push(`${n}: the stock-video service hit its limit — try again later.`);
    if (e.wikimedia?.state === 'bad') out.push(`${n}: the free-image library hit its limit — try again later.`);
    if ((e.llmUnavailable7d || 0) >= 3) out.push(`${n}: the AI writer was busy ${e.llmUnavailable7d} times this week — a retry usually works.`);
  }
  return out;
}

function makingCard(j) {
  return `
  <div class="card vcard" data-making="${esc(j.id)}">
    <a class="vcard__top" href="${openJob(j.id)}">
      <div class="vcard__icon vcard__icon--blue">${icon(j.status === 'uploading' ? 'upload' : 'refresh')}</div>
      <div class="vcard__text">
        <div class="vcard__title">${esc(j.title || j.topic || 'Topic picked by the video maker')}</div>
        <div class="vcard__meta">${esc(makerName(j.engine))} · started ${esc(fmtAgo(j.createdAt))}</div>
      </div>
      ${icon('chevronR', 'icon--sm')}
    </a>
    <div class="progress progress--lg"><div class="progress__bar" data-bar style="width:${typeof j.progress === 'number' ? Math.max(4, j.progress) : 8}%"></div></div>
    <div class="vcard__line" data-line>${esc(progressLine(j, null))}</div>
    ${['dispatched', 'running', 'generating', 'rendering'].includes(j.status)
      ? `<div class="vcard__actions"><button class="btn btn--ghost btn--sm" data-stop="${esc(j.id)}">${icon('x', 'icon--sm')} Stop making</button></div>` : ''}
  </div>`;
}

function videoRow(j) {
  return `<a class="vrow" href="${openJob(j.id)}">
    ${thumb(j)}
    <div class="vrow__text">
      <div class="vrow__title">${esc(j.title || j.topic || 'Untitled video')}</div>
      <div class="vrow__meta">${statusPill(j.status)} <span class="muted">${esc(fmtAgo(j.updatedAt))}</span></div>
    </div>
    ${icon('chevronR', 'icon--sm')}
  </a>`;
}

async function refresh() {
  const root = document.getElementById('page-root');
  const [d, list] = await Promise.all([api.overview(), api.jobs('?sort=newest').catch(() => ({ jobs: [], counts: {} }))]);
  const jobs = list.jobs || [];
  const toCheck = jobs.filter((j) => CHECK.includes(j.status));
  const making = jobs.filter((j) => MAKING.includes(j.status));
  const recentCut = Date.now() - 48 * 3600e3;
  const seenTitle = new Set();
  const failed = jobs.filter((j) => ['failed', 'publish_failed'].includes(j.status) && Date.parse(j.updatedAt) > recentCut)
    .filter((j) => { const k = (j.title || j.topic || j.id).toLowerCase(); if (seenTitle.has(k)) return false; seenTitle.add(k); return true; });
  const approved = jobs.filter((j) => j.status === 'approved');
  const seenRecent = new Set();
  const recent = jobs.filter((j) => !MAKING.includes(j.status) && !CHECK.includes(j.status) && j.status !== 'queued')
    .filter((j) => { const k = (j.title || j.topic || j.id).toLowerCase(); if (seenRecent.has(k)) return false; seenRecent.add(k); return true; })
    .slice(0, 4);
  const cap = list.cap || null;
  const capLimit = cap?.limit ?? UI_PREFS.dailyCap ?? 2;
  const capUsed = cap?.used ?? 0;
  const capLeft = Math.max(0, capLimit - capUsed);
  const reviewCount = (list.counts?.['needs-review'] ?? toCheck.length) || 0;

  const attention = [];
  if (reviewCount) {
    attention.push(`
      <a class="attn attn--amber" href="${reviewCount === 1 && toCheck[0] ? openJob(toCheck[0].id) : '#/videos?tab=check'}">
        <div class="attn__icon">${icon('eye')}</div>
        <div class="attn__text"><strong>${reviewCount === 1 ? '1 video is waiting for your check' : `${reviewCount} videos are waiting for your check`}</strong>
          <span>Watch, then approve, redo or reject. Nothing goes on YouTube until you approve.${toCheck.some((j) => j?.quality?.engine?.verdict === 'needs_fixes') ? ` <strong>${toCheck.filter((j) => j?.quality?.engine?.verdict === 'needs_fixes').length} need${toCheck.filter((j) => j?.quality?.engine?.verdict === 'needs_fixes').length === 1 ? 's' : ''} fixes.</strong>` : ''}</span></div>
        <span class="btn btn--primary btn--sm">Check now</span>
      </a>`);
  }
  for (const j of approved.slice(0, 2)) {
    attention.push(`
      <a class="attn attn--amber" href="${openJob(j.id)}">
        <div class="attn__icon">${icon('upload')}</div>
        <div class="attn__text"><strong>Approved but not on YouTube yet</strong><span>“${esc(j.title)}” — open it and tap Publish now.</span></div>
        ${icon('chevronR', 'icon--sm')}
      </a>`);
  }
  for (const j of failed.slice(0, 2)) {
    attention.push(`
      <a class="attn attn--red" href="${openJob(j.id)}">
        <div class="attn__icon">${icon('alert')}</div>
        <div class="attn__text"><strong>${esc(statusInfo(j.status).label)}: “${esc(j.title || j.topic || 'video')}”</strong>
          <span>${esc(failureLabel(j.errorCategory) || 'Something went wrong')}. Open it to see what to do.</span></div>
        ${icon('chevronR', 'icon--sm')}
      </a>`);
  }
  if (failed.length > 2) attention.push(`<a class="link-row" href="#/videos?tab=all&status=failed">See ${failed.length - 2} more that didn’t finish ${icon('chevronR', 'icon--sm')}</a>`);

  const now = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  root.innerHTML = `
    <div class="hello">
      <h1>${greeting()}</h1>
      <div class="sub">${esc(now)}</div>
    </div>

    ${d.demo ? `<div class="callout callout--warn">${icon('info')}<div><strong>Demo mode.</strong> Everything here is pretend data, so you can try things safely.</div></div>` : ''}
    ${d.schedulePaused ? `<div class="callout callout--warn">${icon('pause')}<div><strong>Automatic videos are paused.</strong> New videos only start when you tap Make. <a href="#/settings">Change in Settings</a></div></div>` : ''}
    ${(d.engines || []).some((e) => e.connectionState === 'error') ? `<div class="callout callout--danger">${icon('alert')}<div><strong>A video maker can’t be reached right now.</strong> New videos may not start. Details: Settings → Advanced → System status.</div></div>` : ''}
    <div id="home-problems"></div>

    <section class="home-sec">
      <div class="sec-title">Needs you</div>
      ${attention.length ? `<div class="stack-sm">${attention.join('')}</div>`
        : `<div class="attn attn--ok"><div class="attn__icon">${icon('check')}</div><div class="attn__text"><strong>You’re all caught up</strong><span>Nothing needs you right now.</span></div></div>`}
    </section>

    <a class="btn btn--primary btn--xl btn--block home-make" href="#/make">${icon('plus')} Make a new video</a>

    <section class="card uploads">
      <div class="uploads__row">
        <div>
          <div class="uploads__label">Uploads today</div>
          <div class="uploads__value">${capUsed} of ${capLimit} used · <strong>${capLeft} left</strong></div>
        </div>
        <div class="uploads__dots" aria-hidden="true">${Array.from({ length: capLimit }, (_, i) => `<span class="${i < capUsed ? 'is-used' : ''}"></span>`).join('')}</div>
      </div>
      <div class="field__hint">You can publish up to ${capLimit} a day. The count resets at 5:30 AM. Videos go up as ${esc((UI_PREFS.visibility || 'unlisted').replace(/^./, (c) => c.toUpperCase()))}.</div>
    </section>

    <section class="home-sec">
      <div class="sec-title">Being made ${making.length ? `<span class="count">${making.length}</span>` : ''}</div>
      ${making.length ? `<div class="stack-sm">${making.map(makingCard).join('')}</div>`
        : `<div class="empty-mini">${icon('video')}<span>Nothing is being made right now. Tap <strong>Make a new video</strong> to start one.</span></div>`}
    </section>

    <section class="home-sec">
      <div class="sec-title">Recent videos <a class="sec-link" href="#/videos?tab=all">See all</a></div>
      ${recent.length ? `<div class="card vlist">${recent.map(videoRow).join('')}</div>`
        : `<div class="empty-mini">${icon('inbox')}<span>Your finished videos will show up here.</span></div>`}
    </section>

    <a class="card next-auto" href="#/calendar">
      <div class="vcard__icon">${icon('calendar')}</div>
      <div class="vcard__text">
        <div class="vcard__title">${d.nextRun ? `Next automatic video: ${esc(d.nextRun.label)}` : 'No automatic videos planned'}</div>
        <div class="vcard__meta">${d.nextRun ? 'Starts by itself. You still check it before it goes up.' : 'Automatic videos are paused or not set up. You can still tap Make.'}</div>
      </div>
      ${icon('chevronR', 'icon--sm')}
    </a>

    <details class="card adv" id="home-status">
      <summary>${icon('shield', 'icon--sm')} System status <span class="muted small">limits, storage, connections</span></summary>
      <div class="adv__body">${quotaPanelShell('quota-panel')}</div>
    </details>`;

  // Live "step x of y" for each video being made.
  for (const j of making.slice(0, 4)) {
    fetchProgress(j.id).then((p) => {
      const card = root.querySelector(`[data-making="${CSS.escape(j.id)}"]`);
      if (!card || !p) return;
      card.querySelector('[data-line]').textContent = progressLine(j, p);
      if (typeof p.percent === 'number') card.querySelector('[data-bar]').style.width = `${Math.max(4, p.percent)}%`;
    });
  }
  root.querySelectorAll('[data-stop]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmModal('Stop making this video?', '<p>The video maker stops and this video is thrown away. Nothing is published. You can make it again later.</p>', 'Stop making', true, 'Keep making')) return;
      b.disabled = true;
      try {
        const res = await api.jobAction(b.dataset.stop, 'cancel');
        toast('Stopped', res.message || 'The video was stopped.', 'ok');
        await refresh();
      } catch (err) { b.disabled = false; errorToast(err, 'Couldn’t stop it'); }
    };
  });
  const details = root.querySelector('#home-status');
  details.addEventListener('toggle', () => { if (details.open) mountQuotaPanel(root, 'quota-panel'); }, { once: true });

  // Quiet unless something is wrong.
  api.quota().then((q) => {
    const probs = quotaProblems(q);
    const el = root.querySelector('#home-problems');
    if (el && probs.length) {
      el.innerHTML = `<div class="callout callout--warn">${icon('alert')}<div><strong>Heads up.</strong> ${probs.map(esc).join(' ')} <a href="#/settings?open=status">See system status</a></div></div>`;
    }
  }).catch(() => {});
}

export async function renderOverview() {
  await refresh();
}
