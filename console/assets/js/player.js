/* DYPOL review player — a small custom player for checking drafts (no library).
   - Plays the compressed review copy from R2 (HTTP Range, preload=metadata: the
     file is never downloaded first); "Full quality" switches to the original
     render at the same moment; Download saves the original.
   - Big play/pause, tap left/right third to skip ±5 s, draggable scrubber with a
     thumbnail strip, speed 0.5/1/1.5/2×, frame-step, mute, fullscreen, captions,
     chapter marks (long video), QC warning marks with "Next warning", and
     timestamped review notes that pre-fill the Reject / Redo reason.
   - Keyboard: Space/K play · ←/→ 5 s · J/L 10 s · ,/. frame · </> speed ·
     M mute · F fullscreen · C captions · N note · Q next warning · 0–9 jump. */

export const SPEEDS = [0.5, 1, 1.5, 2];
export const SKIP = 5;

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Sprite tile (background offsets) for time t. */
export function spriteTile(sprite, t) {
  if (!sprite || !sprite.count) return null;
  const i = Math.min(sprite.count - 1, Math.max(0, Math.floor((Number(t) || 0) / (sprite.interval || 1))));
  return { x: (i % sprite.cols) * sprite.tw, y: Math.floor(i / sprite.cols) * sprite.th, w: sprite.tw, h: sprite.th, i };
}

/** First marker strictly after t (+0.25 s so repeated taps advance); wraps to the first. */
export function nextMarker(markers, t) {
  const list = (markers || []).slice().sort((a, b) => a.t - b.t);
  if (!list.length) return null;
  return list.find((m) => m.t > (Number(t) || 0) + 0.25) || list[0];
}

export function nextSpeed(cur, dir = 1) {
  const i = SPEEDS.indexOf(cur);
  const j = i < 0 ? 1 : Math.min(SPEEDS.length - 1, Math.max(0, i + dir));
  return SPEEDS[j];
}

/** Map a key to a player action name (null = not ours). */
export function keyAction(key) {
  const k = String(key || '');
  const map = {
    ' ': 'toggle', k: 'toggle', K: 'toggle', ArrowLeft: 'back', ArrowRight: 'fwd', j: 'back10', J: 'back10', l: 'fwd10', L: 'fwd10',
    ',': 'frameBack', '.': 'frameFwd', '<': 'slower', '>': 'faster', m: 'mute', M: 'mute', f: 'fullscreen', F: 'fullscreen',
    c: 'captions', C: 'captions', n: 'note', N: 'note', q: 'nextQc', Q: 'nextQc',
  };
  if (map[k]) return map[k];
  if (/^[0-9]$/.test(k)) return `pct${k}`;
  return null;
}

/* ---------- review notes (kept in this browser, per video) ---------- */
const NOTES_KEY = (jobId) => `dypol-review-notes:${jobId}`;
export function getNotes(jobId, store = globalThis.localStorage) {
  try { const v = JSON.parse(store?.getItem(NOTES_KEY(jobId)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveNotes(jobId, notes, store = globalThis.localStorage) {
  try { store?.setItem(NOTES_KEY(jobId), JSON.stringify(notes.slice(0, 100))); } catch { /* private mode */ }
}
/** Notes → reason text: "0:12 (Short) — text" lines, in time order. */
export function notesToReason(notes) {
  return (notes || []).slice().sort((a, b) => (a.video === b.video ? a.t - b.t : a.video === 'short' ? 1 : -1))
    .map((n) => `${fmtTime(n.t)}${n.video === 'short' ? ' (Short)' : ''} — ${String(n.text || '').trim()}`)
    .filter((l) => !/—\s*$/.test(l)).join('\n');
}

/* ---------- DOM ---------- */
const SVG = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  back: '<path d="M11 18V6l-8.5 6zM13 12l8.5 6V6z" transform="scale(-1,1) translate(-24,0)"/>',
  fwd: '<path d="M4 18l8.5-6L4 6zm9-12v12l8.5-6z"/>',
  fprev: '<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>',
  fnext: '<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>',
  vol: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/>',
  mute: '<path d="M3 9v6h4l5 5V4L7 9H3zm18.7 1.3-1.4-1.4L18 11.2l-2.3-2.3-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3z"/>',
  full: '<path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/>',
  cc: '<path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z"/>',
  note: '<path d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/>',
  warn: '<path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/>',
  dl: '<path d="M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z"/>',
};
const ic = (n) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">${SVG[n]}</svg>`;
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Mount the review player.
 *   el      container element
 *   jobId   job id (notes key)
 *   media   (kind, extra) => URL of /api/jobs/:id/media
 *   info    kind=info response ({source, main, videos:{long,short}}) or null
 *   engine  'gemini' | 'verticals'
 */
export function mountPlayer(el, { jobId, media, info, engine }) {
  const videos = info?.videos || {};
  const main = info?.main || (engine === 'verticals' ? 'short' : 'long');
  const hasShort = engine === 'gemini';
  const st = { which: main, full: false, notes: getNotes(jobId), dragging: false, raf: 0, lastFast: 0 };
  const meta = () => videos[st.which] || {};
  const srcFor = () => media(st.which === main ? 'video' : 'short', st.full ? '&quality=full' : '');

  el.innerHTML = `
  <div class="rp ${main === 'short' ? 'rp--short' : ''}" tabindex="0" aria-label="Review player">
    ${hasShort ? `<div class="rp__tabs" role="tablist">
      <button type="button" role="tab" class="rp__tab is-on" data-which="long">Long video</button>
      <button type="button" role="tab" class="rp__tab" data-which="short">Short</button></div>` : ''}
    <div class="rp__stage">
      <video class="rp__video" preload="metadata" playsinline webkit-playsinline></video>
      <div class="rp__tap" aria-hidden="true"><span data-zone="l"></span><span data-zone="c"></span><span data-zone="r"></span></div>
      <button type="button" class="rp__big" aria-label="Play">${ic('play')}</button>
      <div class="rp__flash" aria-hidden="true"></div>
      <div class="rp__spin" aria-hidden="true"></div>
      <div class="rp__err" hidden></div>
    </div>
    <div class="rp__bar">
      <div class="rp__track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
        <div class="rp__buf"></div><div class="rp__played"></div><div class="rp__marks"></div><div class="rp__knob"></div>
        <div class="rp__thumb" hidden><div class="rp__thumb-img"></div><span class="rp__thumb-t">0:00</span></div>
      </div>
    </div>
    <div class="rp__ctl">
      <button type="button" class="rp__btn" data-act="toggle" aria-label="Play or pause (Space)">${ic('play')}</button>
      <button type="button" class="rp__btn" data-act="back" aria-label="Back 5 seconds (Left arrow)">−5</button>
      <button type="button" class="rp__btn" data-act="fwd" aria-label="Forward 5 seconds (Right arrow)">+5</button>
      <button type="button" class="rp__btn rp__opt" data-act="frameBack" aria-label="Previous frame (,)">${ic('fprev')}</button>
      <button type="button" class="rp__btn rp__opt" data-act="frameFwd" aria-label="Next frame (.)">${ic('fnext')}</button>
      <span class="rp__time"><span class="rp__cur">0:00</span> / <span class="rp__dur">0:00</span></span>
      <span class="rp__sp"></span>
      <button type="button" class="rp__btn rp__speed" data-act="speed" aria-label="Speed">1×</button>
      <button type="button" class="rp__btn" data-act="captions" aria-label="Captions (C)" aria-pressed="false">${ic('cc')}</button>
      <button type="button" class="rp__btn" data-act="mute" aria-label="Mute (M)">${ic('vol')}</button>
      <button type="button" class="rp__btn" data-act="fullscreen" aria-label="Full screen (F)">${ic('full')}</button>
    </div>
    <div class="rp__row">
      <button type="button" class="rp__chip" data-act="quality" aria-pressed="false">Full quality</button>
      <a class="rp__chip" data-role="download" rel="noopener">${ic('dl')} Download original</a>
      <button type="button" class="rp__chip rp__chip--warn" data-act="nextQc" hidden>${ic('warn')} <span>Next warning</span></button>
      <button type="button" class="rp__chip" data-act="note">${ic('note')} <span>Note at 0:00</span></button>
    </div>
    <div class="rp__chapters" hidden></div>
    <form class="rp__noteform" hidden><input class="input" maxlength="300" placeholder="What should change here?" aria-label="Note text"><button class="btn btn--primary btn--sm" type="submit">Add</button><button class="btn btn--ghost btn--sm" type="button" data-act="noteCancel">Cancel</button></form>
    <ul class="rp__notes"></ul>
    <div class="rp__hint tiny muted"></div>
  </div>`;

  const $ = (s) => el.querySelector(s);
  const root = $('.rp'), v = $('.rp__video'), track = $('.rp__track'), thumb = $('.rp__thumb'), thumbImg = $('.rp__thumb-img');
  const big = $('.rp__big'), flash = $('.rp__flash'), err = $('.rp__err');
  let trackEl = null;

  const dur = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Number(meta().duration) || 0);
  const fps = () => Number(meta().fps) || 30;

  function hint() {
    const m = meta();
    const src = info?.source === 'r2' ? (st.full ? `Original ${m.w || ''}×${m.h || ''}` : `Review copy ${m.preview?.w || ''}×${m.preview?.h || ''}`) : (st.full ? 'Full-quality file' : 'Small preview');
    const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    $('.rp__hint').textContent = touch
      ? `${src} · tap the left / right side of the picture to skip 5 s`
      : `${src} · keys: Space play · ←/→ 5 s · J/L 10 s · comma/period one frame · C captions · M mute · F full screen · N note · Q next warning`;
  }

  function load(keepTime) {
    const t = keepTime ? v.currentTime : 0;
    const wasPlaying = keepTime && !v.paused;
    err.hidden = true;
    root.classList.add('is-loading');
    if (trackEl) { trackEl.remove(); trackEl = null; }
    v.src = srcFor();
    if (meta().captions) {
      trackEl = document.createElement('track');
      Object.assign(trackEl, { kind: 'captions', label: 'English', srclang: 'en', src: media('captions', `&video=${st.which}`) });
      v.appendChild(trackEl);
      const on = $('[data-act="captions"]').getAttribute('aria-pressed') === 'true';
      setTimeout(() => { if (v.textTracks[0]) v.textTracks[0].mode = on ? 'showing' : 'hidden'; }, 0);
    }
    $('[data-act="captions"]').disabled = !meta().captions;
    $('[data-act="captions"]').title = meta().captions ? 'Captions' : 'No caption file stored for this video';
    const dl = $('[data-role="download"]');
    dl.href = media(st.which === main ? 'video' : 'short', '&quality=full&download=1');
    root.classList.toggle('rp--short', st.which === 'short');
    if (keepTime && t > 0) {
      // Resume at the same moment; retry once the file can play (some sources report seekable late).
      const resume = () => {
        try { v.currentTime = Math.min(t, (dur() || t) - 0.05); } catch { /* not seekable yet */ }
        if (wasPlaying) v.play().catch(() => {});
        paint();
      };
      v.addEventListener('loadedmetadata', resume, { once: true });
      v.addEventListener('canplay', () => { if (Math.abs(v.currentTime - t) > 1) resume(); }, { once: true });
    }
    v.load();
    marks(); chapters(); hint();
  }

  function marks() {
    const m = meta(), d = Number(m.duration) || dur();
    const box = $('.rp__marks');
    if (!d) { box.innerHTML = ''; return; }
    const pos = (t) => `${Math.min(100, Math.max(0, (t / d) * 100)).toFixed(3)}%`;
    box.innerHTML = [
      ...(m.chapters || []).filter((c) => c.t > 0.5).map((c) => `<i class="rp__mk rp__mk--ch" style="left:${pos(c.t)}" title="${escH(c.title)}"></i>`),
      ...(m.markers || []).map((q) => `<i class="rp__mk rp__mk--qc" style="left:${pos(q.t)}" title="${escH(q.label)}"></i>`),
      ...st.notes.filter((n) => n.video === st.which).map((n) => `<i class="rp__mk rp__mk--note" style="left:${pos(n.t)}" title="${escH(n.text)}"></i>`),
    ].join('');
    const q = $('[data-act="nextQc"]');
    q.hidden = !(m.markers || []).length;
    q.querySelector('span').textContent = `Next warning (${(m.markers || []).length})`;
  }

  function chapters() {
    const box = $('.rp__chapters'), list = meta().chapters || [];
    box.hidden = list.length < 2;
    box.innerHTML = list.map((c) => `<button type="button" class="rp__chap" data-t="${c.t}">${fmtTime(c.t)} ${escH(c.title)}</button>`).join('');
  }

  function notes() {
    $('.rp__notes').innerHTML = st.notes.slice().sort((a, b) => a.t - b.t).map((n, i) => `
      <li class="rp__note"><button type="button" class="rp__note-t" data-t="${n.t}" data-w="${n.video}">${fmtTime(n.t)}${hasShort ? ` · ${n.video === 'short' ? 'Short' : 'Long'}` : ''}</button>
        <span>${escH(n.text)}</span><button type="button" class="rp__note-x" data-del="${i}" aria-label="Remove note">×</button></li>`).join('');
    marks();
  }

  function paint() {
    const d = dur(), t = st.dragging ? st.dragT : v.currentTime;
    const p = d ? (t / d) * 100 : 0;
    $('.rp__played').style.width = `${p}%`;
    $('.rp__knob').style.left = `${p}%`;
    $('.rp__cur').textContent = fmtTime(t);
    $('.rp__dur').textContent = fmtTime(d);
    $('[data-act="note"] span').textContent = `Note at ${fmtTime(v.currentTime)}`;
    track.setAttribute('aria-valuemax', String(Math.round(d)));
    track.setAttribute('aria-valuenow', String(Math.round(t)));
    try {
      const b = v.buffered;
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5) end = Math.max(end, b.end(i));
      $('.rp__buf').style.width = `${d ? (end / d) * 100 : 0}%`;
    } catch { /* no buffered ranges yet */ }
  }
  const loop = () => { paint(); st.raf = v.paused ? 0 : requestAnimationFrame(loop); };
  const playIcon = () => {
    const playing = !v.paused;
    $('[data-act="toggle"]').innerHTML = ic(playing ? 'pause' : 'play');
    big.hidden = playing;
    root.classList.toggle('is-playing', playing);
  };

  function seek(t) {
    const d = dur();
    v.currentTime = Math.max(0, Math.min(d ? d - 0.05 : t, t));
    paint();
  }
  function flashMsg(txt, side) {
    flash.textContent = txt;
    flash.className = `rp__flash is-on ${side ? `rp__flash--${side}` : ''}`;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { flash.className = 'rp__flash'; }, 550);
  }
  const frame = (dir) => { v.pause(); seek(v.currentTime + dir / fps()); };

  function openNote() {
    v.pause();
    const f = $('.rp__noteform');
    f.hidden = false;
    f.dataset.t = String(v.currentTime);
    f.querySelector('input').value = '';
    f.querySelector('input').placeholder = `What should change at ${fmtTime(v.currentTime)}?`;
    f.querySelector('input').focus();
  }

  const actions = {
    toggle: () => (v.paused ? v.play().catch(() => {}) : v.pause()),
    back: () => { seek(v.currentTime - SKIP); flashMsg('−5 s', 'l'); },
    fwd: () => { seek(v.currentTime + SKIP); flashMsg('+5 s', 'r'); },
    back10: () => { seek(v.currentTime - 10); flashMsg('−10 s', 'l'); },
    fwd10: () => { seek(v.currentTime + 10); flashMsg('+10 s', 'r'); },
    frameBack: () => frame(-1),
    frameFwd: () => frame(1),
    slower: () => setSpeed(nextSpeed(v.playbackRate, -1)),
    faster: () => setSpeed(nextSpeed(v.playbackRate, 1)),
    speed: () => setSpeed(SPEEDS[(SPEEDS.indexOf(v.playbackRate) + 1) % SPEEDS.length] || 1),
    mute: () => { v.muted = !v.muted; $('[data-act="mute"]').innerHTML = ic(v.muted ? 'mute' : 'vol'); },
    captions: () => {
      const b = $('[data-act="captions"]');
      if (b.disabled) return;
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      if (v.textTracks[0]) v.textTracks[0].mode = on ? 'showing' : 'hidden';
      flashMsg(on ? 'Captions on' : 'Captions off');
    },
    fullscreen: () => {
      if (document.fullscreenElement) return document.exitFullscreen?.();
      if (root.requestFullscreen) return root.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
      return v.webkitEnterFullscreen?.();
    },
    quality: () => {
      st.full = !st.full;
      const b = $('[data-act="quality"]');
      b.setAttribute('aria-pressed', String(st.full));
      b.textContent = st.full ? 'Full quality ✓' : 'Full quality';
      load(true);
    },
    nextQc: () => {
      const m = nextMarker(meta().markers, v.currentTime);
      if (m) { v.pause(); seek(Math.max(0, m.t - 0.5)); flashMsg(m.label || 'QC warning'); }
    },
    note: openNote,
    noteCancel: () => { $('.rp__noteform').hidden = true; root.focus(); },
  };
  function setSpeed(s) { v.playbackRate = s; $('.rp__speed').textContent = `${s}×`; flashMsg(`${s}×`); }
  for (let i = 0; i <= 9; i++) actions[`pct${i}`] = () => seek(dur() * i / 10);

  // Buttons
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && actions[b.dataset.act]) { e.preventDefault(); actions[b.dataset.act](); return; }
    const tab = e.target.closest('.rp__tab');
    if (tab && tab.dataset.which !== st.which) {
      st.which = tab.dataset.which;
      el.querySelectorAll('.rp__tab').forEach((x) => x.classList.toggle('is-on', x === tab));
      v.pause(); load(false); return;
    }
    const ch = e.target.closest('[data-t]');
    if (ch && !ch.closest('.rp__track')) {
      if (ch.dataset.w && ch.dataset.w !== st.which && hasShort) {
        el.querySelector(`.rp__tab[data-which="${ch.dataset.w}"]`)?.click();
        v.addEventListener('loadedmetadata', () => seek(Number(ch.dataset.t)), { once: true });
      } else seek(Number(ch.dataset.t));
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const sorted = st.notes.slice().sort((a, b) => a.t - b.t);
      const gone = sorted[Number(del.dataset.del)];
      st.notes = st.notes.filter((n) => n !== gone);
      saveNotes(jobId, st.notes); notes();
    }
  });
  $('.rp__noteform').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget, text = f.querySelector('input').value.trim();
    if (text) {
      st.notes.push({ t: Math.round(Number(f.dataset.t) * 10) / 10, video: st.which, text });
      saveNotes(jobId, st.notes); notes();
    }
    f.hidden = true; root.focus();
  });

  // Tap zones: left third −5 s, right third +5 s, middle play/pause.
  $('.rp__tap').addEventListener('click', (e) => {
    const z = e.target.dataset.zone;
    if (z === 'l') actions.back(); else if (z === 'r') actions.fwd(); else actions.toggle();
  });
  big.addEventListener('click', () => actions.toggle());

  // Scrubber: pointer drag; seek on release (fastSeek while dragging where supported).
  const tAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * dur();
  };
  const showThumb = (clientX, t) => {
    const sp = meta().sprite;
    const r = track.getBoundingClientRect();
    thumb.hidden = false;
    $('.rp__thumb-t').textContent = fmtTime(t);
    const tile = info?.source === 'r2' ? spriteTile(sp, t) : null;
    if (tile) {
      thumbImg.hidden = false;
      thumbImg.style.cssText = `width:${tile.w}px;height:${tile.h}px;background-image:url("${media('sprite', `&video=${st.which}`)}");background-position:-${tile.x}px -${tile.y}px`;
    } else thumbImg.hidden = true;
    const w = thumb.offsetWidth || 100;
    thumb.style.left = `${Math.max(0, Math.min(r.width - w, clientX - r.left - w / 2))}px`;
  };
  track.addEventListener('pointerdown', (e) => {
    if (!dur()) return;
    st.dragging = true; st.wasPlaying = !v.paused;
    track.setPointerCapture(e.pointerId);
    st.dragT = tAt(e.clientX); showThumb(e.clientX, st.dragT); paint();
  });
  track.addEventListener('pointermove', (e) => {
    if (!dur()) return;
    const t = tAt(e.clientX);
    if (st.dragging) {
      st.dragT = t; paint();
      const now = performance.now();
      if (typeof v.fastSeek === 'function' && now - st.lastFast > 180) { st.lastFast = now; v.fastSeek(t); }
    }
    if (st.dragging || e.pointerType === 'mouse') showThumb(e.clientX, t);
  });
  const endDrag = (e) => {
    if (!st.dragging) return;
    st.dragging = false;
    seek(tAt(e.clientX));
    clearTimeout(thumb._t);
    thumb._t = setTimeout(() => { if (!st.dragging) thumb.hidden = true; }, 700); // let a finger see where it landed
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', () => { st.dragging = false; thumb.hidden = true; });
  track.addEventListener('pointerleave', (e) => { if (!st.dragging && e.pointerType === 'mouse') thumb.hidden = true; });

  // Keyboard (while the player has focus, or the drawer is open and no field is focused).
  const onKey = (e) => {
    if (!document.body.contains(root)) { window.removeEventListener('keydown', onKey); return; }
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
    if (document.getElementById('modal-wrap')?.classList.contains('is-open')) return;
    const drawer = root.closest('#drawer');
    if (drawer && !drawer.classList.contains('is-open')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const act = keyAction(e.key);
    if (!act || !actions[act]) return;
    e.preventDefault();
    actions[act]();
  };
  window.addEventListener('keydown', onKey);

  // Video events
  v.addEventListener('play', () => { playIcon(); if (!st.raf) st.raf = requestAnimationFrame(loop); });
  v.addEventListener('pause', () => { playIcon(); paint(); });
  v.addEventListener('ended', playIcon);
  v.addEventListener('loadedmetadata', () => { root.classList.remove('is-loading'); marks(); paint(); });
  v.addEventListener('waiting', () => root.classList.add('is-loading'));
  v.addEventListener('playing', () => root.classList.remove('is-loading'));
  v.addEventListener('canplay', () => root.classList.remove('is-loading'));
  v.addEventListener('seeked', paint);
  v.addEventListener('progress', () => { if (v.paused) paint(); });
  v.addEventListener('error', () => {
    root.classList.remove('is-loading');
    err.hidden = false;
    err.textContent = st.full ? 'The full-quality file couldn’t be played here. Try Download original.' : 'The preview couldn’t be loaded yet. It appears when the video is ready.';
  });

  // Closing the sheet pauses the video (the drawer is hidden, not removed).
  const drawer = root.closest('#drawer');
  if (drawer && typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (!document.body.contains(root)) { mo.disconnect(); return; }
      if (!drawer.classList.contains('is-open')) v.pause();
    });
    mo.observe(drawer, { attributes: true, attributeFilter: ['class'] });
  }

  load(false);
  notes();
  return {
    el: root, video: v,
    notes: () => st.notes.slice(),
    destroy: () => { window.removeEventListener('keydown', onKey); v.removeAttribute('src'); v.load(); },
  };
}
