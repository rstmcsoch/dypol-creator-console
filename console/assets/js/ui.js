/* DYPOL Creator Console — shared UI toolkit (icons, formatting, charts, overlays) */

/* ---------------- HTML escaping ---------------- */
export const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/* ---------------- Icons ---------------- */
const PATHS = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10.5V20h12v-9.5"/><path d="M10 20v-5h4v5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M21 20H3"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/><path d="M4 6.5 3 3"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 5 5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  external: '<path d="M14 5h5v5"/><path d="M19 5 11 13"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5z"/><path d="M12 9.5v4.2M12 16.6h.01"/>',
  upload: '<path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M4 20h16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  chevronR: '<path d="m9 6 6 6-6 6"/>',
  chevronL: '<path d="m15 6-6 6 6 6"/>',
  chevronD: '<path d="m6 9 6 6 6-6"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  run: '<path d="M13 3 5 13h5l-1 8 8-10h-5l1-8z"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/>',
  logout: '<path d="M15 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8"/><path d="m17 8 4 4-4 4"/><path d="M21 12h-9"/>',
  github: '<path d="M12 2.7a9.3 9.3 0 0 0-2.9 18.1c.5.1.6-.2.6-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.8.8.1-.6.3-1.1.6-1.3-2.1-.2-4.2-1-4.2-4.6 0-1 .4-1.9 1-2.5-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.6.6.6 1 1.5 1 2.5 0 3.6-2.2 4.4-4.2 4.6.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.3 9.3 0 0 0 12 2.7z"/>',
  youtube: '<rect x="2.7" y="6" width="18.6" height="12.5" rx="3.4"/><path d="m10.4 9.6 4.6 2.7-4.6 2.7z" fill="currentColor" stroke="none"/>',
  sparkles: '<path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 15.9 10.3 11.4 5.8 9.7 10.3 8z"/><path d="M19 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  lock: '<rect x="5.5" y="11" width="13" height="9.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/>',
  doc: '<path d="M7 3.5h7L18.5 8v12.5H7z"/><path d="M14 3.5V8h4.5"/><path d="M10 12.5h5M10 16h5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
  wifiOff: '<path d="M2 2l20 20"/><path d="M5.5 10.7a12 12 0 0 1 4-2.4M2.5 7.7A16 16 0 0 1 8 4.9M12 4.5c3.3 0 6.3 1 8.8 2.8"/><path d="M16 10.2c.9.4 1.8 1 2.5 1.7M8.6 14a6.5 6.5 0 0 1 6.8-1"/><path d="M12 18.7h.01"/>',
  link: '<path d="M10 14.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.6l-1.4 1.4"/><path d="M14 9.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.6l1.4-1.4"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5L13 16l2.6-2.4L19.5 17"/>',
  mic: '<rect x="9.2" y="3.5" width="5.6" height="10.5" rx="2.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/>',
  send: '<path d="M21 3 3 10.5l7 3 3 7L21 3z"/><path d="m10 13.5 4-4"/>',
  inbox: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 13h4.7l1.6 2.6h4.4l1.6-2.6h4.7"/>',
  zap: '<path d="M13 3 5 13h5l-1 8 8-10h-5l1-8z"/>',
  settings2: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.2M12 19v2.2M4.6 7.3l1.9 1.1M17.5 15.6l1.9 1.1M4.6 16.7l1.9-1.1M17.5 8.4l1.9-1.1"/>',
  trendUp: '<path d="m4 16 5.2-5.2 3.5 3.5L20 7"/><path d="M15 7h5v5"/>',
  trendDown: '<path d="m4 8 5.2 5.2 3.5-3.5L20 17"/><path d="M15 17h5v-5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8.2h.01"/>',
  server: '<rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.7 5.3 3.7 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.7-5.3-3.7-8.5S9.6 5.8 12 3.5z"/>',
};

export function icon(name, cls = '') {
  const p = PATHS[name] || PATHS.info;
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

/* ---------------- Formatting ---------------- */
export const fmtNum = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v * 100) / 100);
};

export const TZ = 'Asia/Kolkata';
const dtf = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
});
const dtfFull = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
const tfmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
});

export const fmtDate = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? dtf.format(new Date(iso)) : '—');
export const fmtDateTime = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? dtfFull.format(new Date(iso)) + ' IST' : '—');
export const fmtTime = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? tfmt.format(new Date(iso)) : '—');

export function fmtAgo(iso) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export const fmtSecs = (sec) => {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function statusPill(status) {
  const map = {
    published: ['green', 'Published'], uploaded: ['green', 'Uploaded'], completed: ['green', 'Completed'],
    approved: ['teal', 'Approved'], ok: ['green', 'OK'], passed: ['green', 'Passed'],
    generating: ['blue', 'Generating'], rendering: ['blue', 'Rendering'], 'in-progress': ['blue', 'In Progress'],
    running: ['blue', 'In production'], dispatched: ['blue', 'Starting'], uploading: ['violet', 'Uploading'],
    processing: ['blue', 'Processing'],
    scheduled: ['gray', 'Scheduled'], queued: ['gray', 'Queued'], draft: ['gray', 'Draft'],
    'needs-review': ['amber', 'Needs review'], 'awaiting-review': ['amber', 'Awaiting review'],
    blocked: ['amber', 'Blocked'], duplicate: ['amber', 'Duplicate'], superseded: ['gray', 'Superseded'],
    failed: ['red', 'Failed'], error: ['red', 'Error'], cancelled: ['gray', 'Cancelled'],
    rejected: ['gray', 'Rejected'], publish_failed: ['red', 'Upload failed'],
    'verified-by-upload': ['green', 'Verified by last upload'], 'held-by-engine': ['gray', 'Held by engine'],
    'not-configured': ['gray', 'Not configured'], unsupported: ['gray', 'Unsupported'],
    paused: ['amber', 'Paused'], connected: ['green', 'Connected'], disconnected: ['red', 'Disconnected'],
    'demo-unverified': ['amber', 'Demo · unverified'], disabled: ['gray', 'Disabled'],
    'missing-credentials': ['amber', 'Credentials missing'],
    'configured-untested': ['amber', 'Configured · untested'],
  };
  const [color, label] = map[status] || ['gray', String(status || 'Unknown').replaceAll('-', ' ')];
  return `<span class="pill pill--${color}"><span class="dot"></span>${esc(label)}</span>`;
}

export const engineLabel = (engine) =>
  engine === 'gemini' ? 'Gemini Automation'
  : engine === 'verticals' ? 'Verticals v3'
  : esc(engine || '—');

export const enginePill = (engine) =>
  engine === 'gemini'
    ? '<span class="pill pill--accent">Gemini</span>'
    : engine === 'verticals'
      ? '<span class="pill pill--violet">Verticals v3</span>'
      : `<span class="pill pill--gray">${esc(engine || '—')}</span>`;

export const typePill = (type) =>
  type === 'long-form' || type === 'long'
    ? '<span class="tag">Long-form 16:9</span>'
    : type === 'short'
      ? '<span class="tag">Short 9:16</span>'
      : `<span class="tag">${esc(type || '—')}</span>`;

/* ---------------- Charts (hand-rolled SVG) ---------------- */
export function lineChart(series, { height = 190, labels = [], valueFmt = fmtNum, yMax: forcedMax } = {}) {
  const W = 640, H = height, padL = 38, padR = 12, padT = 14, padB = 26;
  const data = series.map((d) => Number(d) || 0);
  if (!data.length) return '';
  const max = forcedMax ?? Math.max(1, ...data) * 1.15;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => padT + ih - (v / max) * ih;

  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(data.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(0).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  let grid = '', yLabels = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (ih / 3) * g;
    const val = max * (1 - g / 3);
    grid += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
    yLabels += `<text class="axis-text" x="${padL - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${esc(valueFmt(val))}</text>`;
  }
  let xLabels = '';
  const every = Math.ceil(data.length / 8);
  labels.forEach((l, i) => {
    if (i % every === 0 || i === labels.length - 1) {
      xLabels += `<text class="axis-text" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`;
    }
  });
  const dots = data.map((v, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.4"/>`).join('');

  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
    ${grid}${yLabels}${xLabels}
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    ${dots}
  </svg></div>`;
}

export function barChart(values, { height = 190, labels = [], valueFmt = fmtNum, alt = false } = {}) {
  const W = 640, H = height, padL = 38, padR = 12, padT = 14, padB = 26;
  const data = values.map((v) => Number(v) || 0);
  if (!data.length) return '';
  const max = Math.max(1, ...data) * 1.15;
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = Math.min(46, (iw / data.length) * 0.55);
  const x = (i) => padL + (i + 0.5) * (iw / data.length) - bw / 2;
  const y = (v) => padT + ih - (v / max) * ih;

  let grid = '', yLabels = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (ih / 3) * g;
    const val = max * (1 - g / 3);
    grid += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
    yLabels += `<text class="axis-text" x="${padL - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${esc(valueFmt(val))}</text>`;
  }
  const bars = data.map((v, i) =>
    `<rect class="bar${alt ? ' bar--alt' : ''}" x="${x(i).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, padT + ih - y(v)).toFixed(1)}"/>`
  ).join('');
  const every = Math.ceil(data.length / 8);
  const xLabels = labels.map((l, i) =>
    (i % every === 0 || i === labels.length - 1)
      ? `<text class="axis-text" x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : ''
  ).join('');

  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
    ${grid}${yLabels}${bars}${xLabels}
  </svg></div>`;
}

/* ---------------- Overlays ---------------- */
export function toast(title, message = '', kind = '', ms = 4200) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  el.innerHTML = `<span>${icon(kind === 'bad' ? 'alert' : kind === 'ok' ? 'check' : 'info')}</span>
    <div><strong>${esc(title)}</strong>${message ? `<div>${esc(message)}</div>` : ''}</div>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 500);
}

export function openDrawer({ title, body, foot = '' }) {
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer-body').innerHTML = body;
  document.getElementById('drawer-foot').innerHTML = foot;
  document.getElementById('drawer').classList.add('is-open');
  document.getElementById('drawer').setAttribute('aria-hidden', 'false');
  document.getElementById('drawer-scrim').classList.add('is-open');
}

export function closeDrawer() {
  document.getElementById('drawer').classList.remove('is-open');
  document.getElementById('drawer').setAttribute('aria-hidden', 'true');
  document.getElementById('drawer-scrim').classList.remove('is-open');
}

export function openModal({ title, body, foot }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-foot').innerHTML = foot;
  const wrap = document.getElementById('modal-wrap');
  wrap.classList.add('is-open');
  wrap.setAttribute('aria-hidden', 'false');
}

export function closeModal() {
  const wrap = document.getElementById('modal-wrap');
  wrap.classList.remove('is-open');
  wrap.setAttribute('aria-hidden', 'true');
}

export function confirmModal(title, bodyHtml, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    openModal({
      title, body: bodyHtml,
      foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
             <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="m-ok">${esc(confirmLabel)}</button>`,
    });
    const done = (v) => { closeModal(); resolve(v); };
    document.getElementById('m-cancel').onclick = () => done(false);
    document.getElementById('m-ok').onclick = () => done(true);
    document.getElementById('modal-wrap').addEventListener('click', (e) => {
      if (e.target.id === 'modal-wrap') done(false);
    }, { once: true });
  });
}

/* ---------------- Small components ---------------- */
export const progressBar = (pct, variant = '') => {
  // AUDIT FIX: unknown progress renders as an indeterminate bar — the console
  // never fabricates a percentage it cannot establish.
  if (pct === null || pct === undefined) {
    return `<div class="progress-row">
      <div class="progress"><div class="progress__bar ${variant ? `progress__bar--${variant}` : ''}" style="width:35%;opacity:.45"></div></div>
      <div class="pct">—</div>
    </div>`;
  }
  return `
  <div class="progress-row">
    <div class="progress"><div class="progress__bar ${variant ? `progress__bar--${variant}` : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
    <div class="pct">${Math.round(pct)}%</div>
  </div>`;
};

export const statCard = ({ iconName, tone = 'orange', label, value, delta = '', deltaDir = '' }) => `
  <div class="stat">
    <div class="stat__icon stat__icon--${tone}">${icon(iconName)}</div>
    <div style="min-width:0">
      <div class="stat__label">${esc(label)}</div>
      <div class="stat__value">${value}</div>
      ${delta ? `<div class="stat__delta ${deltaDir}">${deltaDir === 'up' ? icon('trendUp', 'icon--sm') : deltaDir === 'down' ? icon('trendDown', 'icon--sm') : ''}${delta}</div>` : ''}
    </div>
  </div>`;

export const emptyState = (iconName, title, message, actionHtml = '') => `
  <div class="empty">
    <div class="empty__icon">${icon(iconName)}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(message)}</p>
    ${actionHtml}
  </div>`;

export const thumb = (job, big = false) => {
  const dur = job.durationSec ? fmtSecs(job.durationSec) : '';
  const inner = job.thumbnail
    ? `<img src="${esc(job.thumbnail)}" alt="" loading="lazy">`
    : `<div class="thumb__ph">${icon('image', 'icon--sm')}</div>`;
  return `<div class="thumb ${big ? 'thumb--lg' : ''}">${inner}${dur ? `<span class="thumb__dur">${esc(dur)}</span>` : ''}</div>`;
};

export const qcRow = (name, res) => {
  const state = res?.state || 'skipped';
  const cls = state === 'ok' || state === 'passed' ? '' : state === 'warn' || state === 'pending' ? 'is-warn' : state === 'failed' ? 'is-bad' : 'is-off';
  return `<div class="qc__row ${cls}">
    ${icon(state === 'ok' || state === 'passed' ? 'check' : state === 'failed' ? 'x' : state === 'warn' || state === 'pending' ? 'alert' : 'info', 'icon--sm')}
    <span>${esc(name)}</span><span class="spacer"></span>
    <span class="pill">${esc(res?.label || state)}</span>
  </div>`;
};

export const renderLogs = (logs = []) => {
  if (!logs.length) return `<div class="empty" style="padding:24px"><p class="muted small">No log entries recorded for this job yet.</p></div>`;
  return `<div class="logs">${logs.map((l) => {
    const cls = l.level === 'error' ? 'log-err' : l.level === 'warn' ? 'log-warn' : l.level === 'ok' ? 'log-ok' : 'log-info';
    return `<div class="log-line ${l.failed ? 'log-fail' : ''}"><span class="log-ts">${esc(l.ts || '')}</span> <span class="${cls}">${esc(l.msg)}</span></div>`;
  }).join('')}</div>`;
};


/* ---------------- Plain-language helpers (no raw infra strings) ---------------- */
export const FAILURE_LABELS = {
  llm_unavailable: 'AI model unavailable (temporary)', content_gate: 'Blocked by the name check',
  asset: 'Visuals / voice asset problem', render: 'Video render failed', publish: 'YouTube upload failed',
  unknown: 'Unclassified failure', dispatch: 'Engine refused the request', stale: 'Stopped responding',
  config: 'Missing configuration', permission: 'Permission denied', quota: 'Quota exceeded',
  provider: 'AI provider error', timeout: 'Timed out', upload: 'Upload rejected', oauth: 'YouTube sign-in problem',
};
export const failureLabel = (c) => FAILURE_LABELS[c] || (c ? String(c).replaceAll('_', ' ') : '');

const STAGE_TEXT = [
  [/^workflow_dispatch sent$/i, 'Sent to engine'],
  [/^Running in GitHub Actions$/i, 'Working on it'],
  [/^Queued in GitHub Actions$/i, 'Waiting to start'],
  [/^Running: (.+)$/i, 'Working — $1'],
  [/^workflow_dispatch failed$/i, 'Could not start'],
  [/^Approved — awaiting publish window$/i, 'Approved'],
  [/^Failed: (.+)$/i, 'Failed at “$1”'],
  [/B-roll nano-banana/gi, 'Visuals'],
  [/workflow_dispatch/gi, 'start request'],
];
/** Human-friendly stage text for a raw stage string. */
export function friendlyStage(stage) {
  let s = String(stage || '');
  for (const [re, to] of STAGE_TEXT) s = s.replace(re, to);
  return s;
}

/**
 * Touch-friendly disabled state: elements render with aria-disabled + a
 * data-why reason (instead of a hover-only title). A tap shows the reason.
 */
export const disabledAttr = (why) => (why ? `aria-disabled="true" data-why="${esc(why)}"` : '');
