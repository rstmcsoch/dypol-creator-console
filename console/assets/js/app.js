/* DYPOL Creator Console — app shell, router, session */
import { api } from './api.js';
import { icon, toast, closeDrawer, closeModal, esc } from './ui.js';
import { renderOverview } from './pages/overview.js';
import { renderPipelines } from './pages/pipelines.js';
import { renderQueue } from './pages/queue.js';
import { renderCalendar } from './pages/calendar.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderRuns } from './pages/runs.js';
import { renderSettings } from './pages/settings.js';

const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'home', render: renderOverview },
  { id: 'pipelines', label: 'Pipelines', icon: 'layers', render: renderPipelines },
  { id: 'queue', label: 'Content Queue', icon: 'inbox', render: renderQueue },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', render: renderCalendar },
  { id: 'analytics', label: 'Analytics', icon: 'chart', render: renderAnalytics },
  { id: 'runs', label: 'Run History', icon: 'history', render: renderRuns },
  { id: 'settings', label: 'Settings', icon: 'gear', render: renderSettings },
];

const state = {
  session: null,
  route: 'overview',
  loading: false,
};

/* ---------------- Shell rendering ---------------- */
function renderNav() {
  const nav = document.getElementById('sidebar-nav');
  const badge = (id) => {
    const q = state.session?.pendingReview;
    if (id === 'queue' && q) return `<span class="nav-badge">${q}</span>`;
    return '';
  };
  nav.innerHTML = `
    ${ROUTES.map((r) => `
      <a class="nav-item ${state.route === r.id ? 'is-active' : ''}" href="#/${r.id}" data-nav="${r.id}">
        ${icon(r.icon)}<span>${r.label}</span>${badge(r.id)}
      </a>`).join('')}
    <div class="nav-section">Engines</div>
    <a class="engine-item" href="#/pipelines?engine=gemini" data-nav="pipelines">
      <span class="engine-dot dot-green"></span>
      <div><div>Gemini YouTube Automation</div><small>Long-form + Shorts</small></div>
    </a>
    <a class="engine-item" href="#/pipelines?engine=verticals" data-nav="pipelines">
      <span class="engine-dot dot-green"></span>
      <div><div>Verticals v3 (Shorts)</div><small>Research-driven verticals</small></div>
    </a>`;
}

function renderTopbarStatus() {
  const el = document.getElementById('topbar-status');
  const s = state.session;
  if (!s) { el.innerHTML = ''; return; }
  const demo = s.mode === 'demo'
    ? `<span class="status-pill status-pill--demo">${icon('info', 'icon--sm')}<span>Demo data</span></span>`
    : `<span class="status-pill">${icon('shield', 'icon--sm')}<span class="hide-xs">Live backend</span></span>`;
  el.innerHTML = `<div class="row" style="gap:8px">${demo}</div>`;
}

function routeInfo() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [id, query = ''] = hash.split('?');
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
  closeDrawer();
  closeModal();
  document.getElementById('sidebar').classList.remove('is-open');
  document.getElementById('sidebar-scrim').classList.remove('is-open');
  const root = document.getElementById('page-root');
  root.innerHTML = `
    <div class="stack">
      <div class="skeleton skeleton--line" style="width:220px;height:22px"></div>
      <div class="grid grid--stats">
        ${'<div class="skeleton skeleton--block"></div>'.repeat(4)}
      </div>
      <div class="skeleton" style="height:280px"></div>
    </div>`;
  try {
    await route.render(root, { query, state, refresh });
  } catch (err) {
    root.innerHTML = `
      <div class="card"><div class="empty">
        <div class="empty__icon">${icon('alert')}</div>
        <h3>Could not load this page</h3>
        <p>${esc(err.message || 'Unexpected error. Try refreshing the console.')}</p>
        <button class="btn btn--secondary" onclick="location.reload()">Reload console</button>
      </div></div>`;
  }
}

export async function refresh() {
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
      hint.innerHTML = `<strong>Local demo mode.</strong> Use password <code>dypol-demo</code>. Data is simulated and clearly labelled.`;
    } else {
      hint.textContent = 'Use the admin password configured for this deployment.';
    }
  }).catch(() => {});
}

function showApp() {
  document.getElementById('login-root').hidden = true;
  document.getElementById('app-root').hidden = false;
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
    errBox.innerHTML = `${icon('alert')}<div><strong>Sign-in failed.</strong> ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener('hashchange', navigate);
window.addEventListener('dypol:unauthorized', () => {
  state.session = null;
  showLogin();
});

// Touch-friendly explanations: a tap on anything aria-disabled shows WHY
// (hover-only tooltips are invisible on phones/tablets).
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[aria-disabled="true"]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const why = el.dataset.why || el.getAttribute('title') || 'Not available right now.';
  toast('Not available', why, 'warn');
}, true);

document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('is-open');
  document.getElementById('sidebar-scrim').classList.add('is-open');
});
document.getElementById('sidebar-scrim').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('is-open');
  document.getElementById('sidebar-scrim').classList.remove('is-open');
});
document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('btn-refresh').addEventListener('click', () => {
  refresh();
  toast('Refreshed', 'Console data reloaded.', 'ok');
});
document.getElementById('btn-bell').addEventListener('click', () => {
  toast('Notifications', 'Recent activity is shown on the Overview page.');
});
document.getElementById('btn-avatar').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* ignore */ }
  state.session = null;
  showLogin();
  toast('Signed out', 'Your console session has ended.');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); closeModal(); }
});

boot();
