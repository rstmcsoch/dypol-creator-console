/* Delete video — confirm sheet, progress, result (single and bulk).
   Removes a video from the dashboard and GitHub (runs, logs, saved files,
   files in the code repository). Never deletes anything from YouTube.
   One simple confirm for every video; a video being made is stopped first;
   a video uploading right now can't be deleted until the upload finishes. */
import { api } from './api.js';
import { icon, esc, openModal, closeModal, toast, friendlyError } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const MAX_PASSES = 30;

/** Plain list of what goes, summed over several plans. */
export function summarize(plans) {
  const sum = (k) => plans.reduce((n, p) => n + Number(p.counts?.[k] || 0), 0);
  const attempts = sum('attempts');
  const items = [plans.length > 1 ? plural(plans.length, 'dashboard record', 'dashboard records') : `Dashboard record${attempts > 1 ? ` (${attempts} versions)` : ''}`];
  const runs = sum('githubRuns'), saved = sum('savedFiles'), files = sum('repoFiles');
  if (runs) items.push(`${plural(runs, 'GitHub run', 'GitHub runs')} with ${runs === 1 ? 'its log' : 'their logs'}`);
  if (saved) items.push(plural(saved, 'saved file on GitHub', 'saved files on GitHub'));
  if (files) items.push(plural(files, 'file in the code repository', 'files in the code repository'));
  return {
    items,
    onYouTube: plans.filter((p) => Number(p.youtubeStays || 0) > 0).length,
    beingMade: plans.filter((p) => Number(p.beingMade || 0) > 0).length,
    uploading: plans.filter((p) => p.uploading).length,
    sharedKept: sum('planShared'),
  };
}

export function confirmHtml(videos, plans) {
  const s = summarize(plans);
  const one = videos.length === 1;
  return `
    ${one ? `<div class="confirm-card"><strong>${esc(videos[0].title || 'This video')}</strong>
      <span>${esc(videos[0].statusLabel || '')}</span></div>` : ''}
    <div class="del-what"><div class="small" style="font-weight:700">This removes:</div>
      <ul class="del-list">${s.items.map((t) => `<li>${icon('trash', 'icon--sm')}<span>${esc(t)}</span></li>`).join('')}</ul></div>
    <ul class="confirm-list">
      ${s.onYouTube ? `<li>${icon('youtube', 'icon--sm')}<span><strong>${one ? 'The video stays on YouTube' : `${plural(s.onYouTube, 'video is', 'videos are')} on YouTube and stay there`}</strong> — nothing is deleted from YouTube.</span></li>` : ''}
      ${s.beingMade ? `<li>${icon('x', 'icon--sm')}<span>${one ? 'It’s still being made — it will be stopped first.' : `${plural(s.beingMade, 'video is', 'videos are')} still being made — stopped first.`}</span></li>` : ''}
      ${s.uploading ? `<li>${icon('alert', 'icon--sm')}<span><strong>Uploading right now</strong> — ${one ? 'delete it' : 'those can be deleted'} after the upload finishes.</span></li>` : ''}
      <li>${icon('upload', 'icon--sm')}<span>Deleting doesn’t give back today’s upload slot.</span></li>
      <li>${icon('alert', 'icon--sm')}<span>This can’t be undone.</span></li>
    </ul>`;
}

/** Ask, then delete. videos: [{id, title, statusLabel}]. Resolves true when anything was deleted. */
export async function deleteVideos(videos, { onChange } = {}) {
  if (!videos.length) return false;
  openModal({ title: videos.length > 1 ? `Delete ${videos.length} videos?` : 'Delete this video?', body: `<p class="small muted">${icon('refresh', 'icon--sm')} Checking what will be removed…</p>`, foot: '' });
  const plans = [];
  for (const v of videos) {
    try { plans.push({ id: v.id, ...(await api.get(`/api/jobs/${encodeURIComponent(v.id)}/delete`)) }); } catch (err) {
      if (err.status === 404) continue; // already gone
      closeModal();
      const f = friendlyError(err, 'Couldn’t check this video');
      toast(f.title, f.msg, 'bad', 7000);
      return false;
    }
  }
  if (!plans.length) { closeModal(); onChange?.(); toast('Already deleted', '', 'ok'); return true; }
  const go = plans.filter((p) => !p.uploading);
  const ok = await new Promise((resolve) => {
    openModal({
      title: videos.length > 1 ? `Delete ${videos.length} videos?` : 'Delete this video?',
      body: confirmHtml(videos, plans),
      foot: `<button class="btn btn--secondary" id="del-keep">Keep</button>
             <button class="btn btn--danger-solid" id="del-ok" ${go.length ? '' : 'disabled'}>${icon('trash', 'icon--sm')} ${go.length > 1 ? `Delete ${go.length} videos` : 'Delete video'}</button>`,
    });
    document.getElementById('del-keep').onclick = () => { closeModal(); resolve(false); };
    document.getElementById('del-ok').onclick = () => resolve(true);
  });
  if (!ok) return false;
  return runDeletes(go.map((p) => videos.find((v) => v.id === p.id) || { id: p.id }), plans, { onChange });
}

/** Progress + result. Also used by "Retry delete". */
export async function runDeletes(videos, plans = [], { onChange } = {}) {
  const rows = videos.map((v) => ({ ...v, state: 'waiting', note: 'Waiting…' }));
  const paint = (final = false) => {
    const doneN = rows.filter((r) => r.state === 'done').length;
    const bad = rows.filter((r) => ['partial', 'refused'].includes(r.state));
    const ytStays = rows.filter((r) => r.youtubeStays).length;
    openModal({
      title: !final ? 'Deleting…' : bad.length ? (doneN ? 'Partly done' : 'Not finished') : 'Deleted',
      body: `<ul class="del-progress">${rows.map((r) => `<li class="del-progress__row del-progress__row--${r.state}">
          <span class="del-progress__icon">${icon(r.state === 'done' ? 'check' : ['partial', 'refused'].includes(r.state) ? 'alert' : 'refresh', 'icon--sm')}</span>
          <span><strong>${esc(r.title || 'Video')}</strong><span class="tiny muted">${esc(r.note)}</span></span></li>`).join('')}</ul>
        ${final && !bad.length ? `<p class="small">Removed from the dashboard and GitHub.${ytStays ? ' The YouTube video stays online.' : ''}</p>` : ''}
        ${final && bad.length ? `<div class="callout callout--warn">${icon('alert')}<div>Some things couldn’t be removed (a connection or GitHub hiccup). Nothing was touched on YouTube. The video stays in your list marked “Deletion not finished” until you tap Retry delete.</div></div>` : ''}`,
      foot: final
        ? `${bad.length ? `<button class="btn btn--secondary" id="del-later">Later</button><button class="btn btn--danger-solid" id="del-retry">${icon('refresh', 'icon--sm')} Retry delete</button>` : '<button class="btn btn--primary" id="del-close">Done</button>'}`
        : '<span class="small muted">Please keep this open — it takes a few seconds per video.</span>',
    });
    if (final) {
      document.getElementById('del-close')?.addEventListener('click', closeModal);
      document.getElementById('del-later')?.addEventListener('click', closeModal);
      document.getElementById('del-retry')?.addEventListener('click', () => runDeletes(bad.map(({ id, title }) => ({ id, title })), plans, { onChange }));
    }
  };
  paint();
  for (const r of rows) {
    r.state = 'working'; r.note = 'Removing…'; paint();
    let out = null;
    for (let i = 0; i < MAX_PASSES; i++) {
      try {
        out = await api.post(`/api/jobs/${encodeURIComponent(r.id)}/delete`, {});
      } catch (err) {
        out = { state: err.code === 'uploading' ? 'refused' : 'partial', error: err.code === 'uploading' ? err.message : (friendlyError(err, 'Couldn’t delete').msg || err.message) };
        break;
      }
      if (out.state === 'waiting') { r.note = 'Stopping the video maker first…'; paint(); }
      else if (out.state === 'continue' || out.state === 'busy') { r.note = 'Removing…'; paint(); }
      else break;
      await sleep(Math.min(Math.max(Number(out.retryAfterMs) || 1500, 500), 8000));
    }
    if (out?.state === 'done') {
      r.state = 'done'; r.note = out.youtubeStays ? 'Deleted · still on YouTube' : 'Deleted';
      r.youtubeStays = !!out.youtubeStays;
    } else if (out?.state === 'refused') {
      r.state = 'refused'; r.note = out.error || 'Can’t delete right now';
    } else {
      r.state = 'partial';
      const rem = out?.remaining;
      const left = rem ? [rem.githubRuns ? plural(rem.githubRuns, 'GitHub run', 'GitHub runs') : '', rem.repoCommits ? 'files in the code repository' : ''].filter(Boolean).join(', ') : '';
      r.note = `Not finished${left ? ` — still there: ${left}` : ''}${out?.state === 'waiting' ? ' (still stopping)' : ''}`;
    }
    paint();
  }
  paint(true);
  onChange?.();
  return rows.some((r) => r.state === 'done');
}
