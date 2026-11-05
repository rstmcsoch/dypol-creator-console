/* DYPOL Creator Console — app shell, router, session.
   v2 (31 Oct 2026): one main path — Make a video → Check it → Publish.
   Phone: bottom tab bar (Home · Videos · Make · Settings). Desktop: slim sidebar.
   Technical pages (video makers, technical history, calendar, channel stats)
   live under "Advanced" and keep every original function. */
import { api } from './api.js';
import { icon, toast, closeDrawer, closeModal, esc, openModal, UI_PREFS } from './ui.js';
import { renderOverview } from './pages/overview.js';
import { renderMake } from './pages/make.js';
import { renderPipelines } from './pages/pipelines.js';
import { renderQueue } from './pages/queue.js';
import { renderCalendar } from './pages/calendar.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderRuns } from './pages/runs.js';
import { renderSettings } from './pages/settings.js';
import { initMotion, pageEnter } from './motion.js';
import { escapeTarget } from './layers.js';

// Main routes (tab bar + sidebar) and Advanced routes (sidebar section + Settings → More tools).
const ROUTES = [
  { id: 'home', label: 'Home', icon: 'home', render: renderOverview, main: true },
  { id: 'make', label: 'Make a video', tab: 'Make', icon: 'plus', render: renderMake, main: true },
  { id: 'videos', label: 'Videos', icon: 'inbox', render: renderQueue, main: true },
  { id: 'settings', label: 'Settings', icon: 'gear', render: renderSettings, main: true },
  { id: 'makers', label: 'Video makers', icon: 'layers', render: renderPipelines },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', render: renderCalendar },
  { id: 'runs', label: 'Technical history', icon: 'history', render: renderRuns },
  { id: 'analytics', label: 'Channel stats', icon: 'chart', render: renderAnalytics },
];
// Old links keep working.
const ALIASES = { overview: 'home', queue: 'videos', pipelines: 'makers' };

const state = { session: null, route: 'home' };

/* ---------------- Shell rendering ---------------- */
function pendingBadge() {
  const q = state.session?.pendingReview;
  return q ? `<span class="nav-badge" aria-label="${q} waiting for your check">${q}</span>` : '';
}

function renderNav() {
  const nav = document.getElementById('sidebar-nav');
  const item = (r) => `
      <a class="nav-item ${state.route === r.id ? 'is-active' : ''}" href="#/${r.id}" data-nav="${r.id}">
        ${icon(r.icon)}<span>${esc(r.label)}</span>${r.id === 'videos' ? pendingBadge() : ''}
      </a>`;
  nav.innerHTML = `
    <a class="btn btn--primary btn--block nav-make" href="#/make">${icon('plus', 'icon--sm')} Make a new video</a>
    ${ROUTES.filter((r) => r.main && r.id !== 'make').map(item).join('')}
    <div class="nav-section">Advanced</div>
    ${ROUTES.filter((r) => !r.main).map(item).join('')}`;

  const tabs = document.getElementById('tabbar');
  const t = (id, label, ic, extra = '') => `
    <a class="tab ${state.route === id ? 'is-active' : ''}" href="#/${id}" data-nav="${id}" ${state.route === id ? 'aria-current="page"' : ''}>
      <span class="tab__icon">${icon(ic)}${extra}</span><span class="tab__label">${label}</span>
    </a>`;
  const q = state.session?.pendingReview;
  const advActive = ROUTES.find((r) => r.id === state.route && !r.main);
  tabs.innerHTML = `
    ${t('home', 'Home', 'home')}
    ${t('videos', 'Videos', 'inbox', q ? `<span class="tab__badge">${q}</span>` : '')}
    <a class="tab tab--make ${state.route === 'make' ? 'is-active' : ''}" href="#/make" data-nav="make" aria-label="Make a new video">
      <span class="tab__fab">${icon('plus')}</span><span class="tab__label">Make</span>
    </a>
    ${t('settings', 'Settings', 'gear').replace('tab ', `tab ${advActive ? 'is-active ' : ''}`)}`;
}

function renderTopbarStatus() {
  const el = document.getElementById('topbar-status');
  const s = state.session;
  el.innerHTML = s && s.mode === 'demo'
    ? `<span class="status-pill status-pill--demo">${icon('info', 'icon--sm')}<span>Demo</span></span>` : '';
}

function routeInfo() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [rawId, query = ''] = hash.split('?');
  const id = ALIASES[rawId] || rawId;
  const route = ROUTES.find((r) => r.id === id) || ROUTES[0];
  return { route, query: new URLSearchParams(query) };
}

async function navigate() {
  const { route, query } = routeInfo();
  state.route = route.id;
  renderNav();
  renderTopbarStatus();
  document.getElementById('topbar-title').textContent = route.label;
  document.title = `${route.label} · DYPOL Creator Console`;
  document.body.dataset.route = route.id;
  closeDrawer();
  closeModal();
  const root = document.getElementById('page-root');
  root.innerHTML = `
    <div class="stack">
      <div class="skeleton skeleton--line" style="width:200px;height:24px"></div>
      <div class="skeleton" style="height:120px"></div>
      <div class="skeleton" style="height:56px"></div>
      <div class="skeleton" style="height:180px"></div>
    </div>`;
  window.scrollTo(0, 0);
  root.scrollTop = 0; // desktop: the page scrolls inside the main panel
  try {
    await route.render(root, { query, state, refresh });
    pageEnter(root);
  } catch (err) {
    root.innerHTML = `
      <div class="card"><div class="empty">
        <div class="empty__icon">${icon('alert')}</div>
        <h3>This page didn’t load</h3>
        <p>${esc(err.status === 0 ? 'No connection. Check your internet, then tap Try again.' : (err.message || 'Something unexpected went wrong.'))}</p>
        <button class="btn btn--primary btn--lg" onclick="location.reload()">Try again</button>
      </div></div>`;
  }
}

export async function refresh() {
  try { state.session = await api.session(); } catch { /* 401 handled globally */ }
  await navigate();
}

/* ---------------- Session + login ---------------- */
function showLogin() {
  document.getElementById('app-root').hidden = true;
  const login = document.getElementById('login-root');
  login.hidden = false;
  api.health().then((h) => {
    const hint = document.getElementById('login-hint');
    if (h?.mode === 'demo') {
      hint.innerHTML = `<strong>Demo mode.</strong> Use password <code>dypol-demo</code>. Everything here is pretend data.`;
    } else {
      hint.textContent = 'The password set up for this console.';
    }
  }).catch(() => {});
}

async function loadPrefs() {
  try {
    const s = await api.settings();
    UI_PREFS.visibility = s.publishing?.visibility || 'unlisted';
    UI_PREFS.dailyCap = s.publishing?.dailyCap ?? 2;
    UI_PREFS.defaultEngine = s.defaults?.engine || 'gemini';
    UI_PREFS.defaultNiche = s.defaults?.niche || 'general';
    UI_PREFS.engines = s.engines || {};
    UI_PREFS.reviewRequired = !!s.publishing?.reviewRequired;
    UI_PREFS.paused = !!s.schedule?.automationPaused;
    UI_PREFS.windowStart = s.schedule?.windowStart || '';
    UI_PREFS.windowEnd = s.schedule?.windowEnd || '';
    UI_PREFS.defaultVoice = s.defaults?.voice || 'am_michael';
    UI_PREFS.defaultPattern = s.defaults?.designPattern || 'elements';
    UI_PREFS.customVoices = Array.isArray(s.customVoices) ? s.customVoices : [];
  } catch { /* keep defaults */ }
}

async function showApp() {
  document.getElementById('login-root').hidden = true;
  document.getElementById('app-root').hidden = false;
  await loadPrefs();
  navigate();
}

async function boot() {
  try {
    state.session = await api.session();
    showApp();
  } catch {
    showLogin();
  }
}

/* ---------------- Global wiring ---------------- */
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-submit');
  const errBox = document.getElementById('login-error');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errBox.hidden = true;
  try {
    const password = document.getElementById('login-password').value;
    const remember = !!document.getElementById('login-remember')?.checked;
    await api.login(password, remember);
    state.session = await api.session();
    document.getElementById('login-password').value = '';
    showApp();
  } catch (err) {
    errBox.hidden = false;
    errBox.className = 'callout callout--danger';
    const msg = err.status === 0 ? 'No connection. Check your internet and try again.'
      : err.status === 429 || err.code === 'throttled' ? 'Too many tries. Wait a minute, then try again.'
      : 'That password didn’t work. Check it and try again.';
    errBox.innerHTML = `${icon('alert')}<div><strong>Couldn’t sign in.</strong> ${esc(msg)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

window.addEventListener('hashchange', navigate);
window.addEventListener('dypol:unauthorized', () => {
  state.session = null;
  showLogin();
});

// Touch-friendly explanations: a tap on anything aria-disabled shows WHY.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[aria-disabled="true"]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const why = el.dataset.why || el.getAttribute('title') || 'Not available right now.';
  toast('Not available right now', why, 'warn');
}, true);

document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-back').addEventListener('click', closeDrawer);
document.getElementById('btn-refresh').addEventListener('click', async () => {
  await refresh();
  toast('Up to date', 'Latest status loaded.', 'ok', 2200);
});
// Account: a menu, never an instant sign-out.
document.getElementById('btn-avatar').addEventListener('click', () => {
  openModal({
    title: 'Account',
    body: `<div class="acct">
        <div class="avatar avatar--lg">D</div>
        <div><strong>Signed in as ${esc(state.session?.user || 'admin')}</strong>
          <div class="small muted">${state.session?.mode === 'demo' ? 'Demo mode — pretend data' : 'Your console session'}</div></div>
      </div>
      <p class="small muted">Signing out ends this session on this device. You’ll need the password to come back.</p>`,
    foot: `<button class="btn btn--secondary" id="acct-close">Close</button>
           <button class="btn btn--danger-solid" id="acct-out">${icon('logout', 'icon--sm')} Sign out</button>`,
  });
  document.getElementById('acct-close').onclick = closeModal;
  document.getElementById('acct-out').onclick = async () => {
    closeModal();
    try { await api.logout(); } catch { /* ignore */ }
    state.session = null;
    showLogin();
    toast('Signed out', 'See you soon.');
  };
});
// Esc closes only the top layer: the confirm first, then the review popup/drawer.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const target = escapeTarget({
    modalOpen: document.getElementById('modal-wrap').classList.contains('is-open'),
    drawerOpen: document.getElementById('drawer').classList.contains('is-open'),
  });
  if (target === 'modal') closeModal();
  else if (target === 'drawer') closeDrawer();
});
document.getElementById('modal-wrap').addEventListener('click', (e) => {
  if (e.target.id === 'modal-wrap' && !document.getElementById('m-ok')) closeModal();
});

initMotion();
boot();
