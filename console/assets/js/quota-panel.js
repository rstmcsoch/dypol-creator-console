/**
 * Quota & health panel (Overview + Settings). Phone-first: one column of
 * status rows, shared limits first, then one block per engine.
 * Data: GET /api/quota (cached server-side, refreshed at most every 30 min).
 */
import { api } from './api.js';
import { esc, icon, fmtAgo, fmtDateTime } from './ui.js';

const MB = 1024 * 1024;
const fmtMB = (b) => (b === null || b === undefined ? '—' : `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`);
const ENGINE_NAMES = { gemini: 'Engine A · Gemini long + Short', verticals: 'Engine B · Verticals Shorts' };

const dot = (state) => {
  const cls = state === 'ok' ? '' : state === 'warn' ? 'check-dot--warn' : state === 'bad' ? 'check-dot--bad' : 'check-dot--off';
  const ic = state === 'ok' ? 'check' : state === 'bad' || state === 'warn' ? 'alert' : 'info';
  return `<span class="check-dot ${cls}" aria-label="${esc(state)}">${icon(ic, 'icon--sm')}</span>`;
};
const row = (label, value, state, sub = '') => `
  <div class="qrow">
    ${dot(state)}
    <div class="qrow__main"><div class="qrow__label">${esc(label)}</div>${sub ? `<div class="qrow__sub">${esc(sub)}</div>` : ''}</div>
    <div class="qrow__value">${esc(value)}</div>
  </div>`;

function engineBlock(e) {
  if (!e.configured) {
    return `<div class="qeng"><div class="qeng__title">${esc(ENGINE_NAMES[e.engine] || e.engine)}</div>
      ${row('Status', 'Not configured', 'off', (e.notes || []).join(' · '))}</div>`;
  }
  const st = e.storage || {};
  return `<div class="qeng">
    <div class="qeng__title">${esc(ENGINE_NAMES[e.engine] || e.engine)}${e.enabled ? '' : ' <span class="pill">disabled</span>'}</div>
    ${row('YouTube uploads today', `${e.uploadsToday.videos} video${e.uploadsToday.videos === 1 ? '' : 's'}`, 'ok', `${e.uploadsToday.jobs} job${e.uploadsToday.jobs === 1 ? '' : 's'} published`)}
    ${row('Last successful upload', e.lastUpload ? fmtAgo(e.lastUpload.at) : 'None yet', e.oauth.state, e.lastUpload ? `${fmtDateTime(e.lastUpload.at)} · ${e.oauth.detail}` : e.oauth.detail)}
    ${row('Cloudflare FLUX quota', e.flux.state === 'bad' ? 'Hit today' : e.flux.state === 'ok' ? 'OK' : '—', e.flux.state, e.flux.detail)}
    ${row('Pixabay limit', e.pixabay.state === 'bad' ? 'Hit today' : e.pixabay.state === 'ok' ? 'OK' : '—', e.pixabay.state, e.pixabay.detail)}
    ${row('NVIDIA visual judge', e.judge.calls === null || e.judge.calls === undefined ? '—' : `${e.judge.calls} call${e.judge.calls === 1 ? '' : 's'}`, e.judge.state, e.judge.detail)}
    ${row('Gemini unavailable (7 days)', String(e.llmUnavailable7d), e.llmUnavailable7d >= 3 ? 'bad' : e.llmUnavailable7d ? 'warn' : 'ok', 'Jobs that failed with llm_unavailable')}
    ${row('Actions storage', fmtMB((st.cacheBytes || 0) + (st.artifactBytes || 0)), 'ok', `Artifacts ${fmtMB(st.artifactBytes)} (${st.artifactCount ?? '—'}) · cache ${fmtMB(st.cacheBytes)}`)}
    ${(e.notes || []).length ? `<div class="qrow__sub" style="padding:4px 0 0 30px">${esc(e.notes.join(' · '))}</div>` : ''}
  </div>`;
}

export function quotaPanelShell(id = 'quota-panel') {
  return `<div class="card quota" id="${esc(id)}">
    <div class="card__head">${icon('shield')}<h2>Quota &amp; health</h2>
      <div class="right"><span class="tiny muted" data-q-age></span></div></div>
    <div class="card__body" data-q-body><div class="small muted">Checking quotas…</div></div>
  </div>`;
}

export function renderQuota(d) {
  const yt = d.youtube || {};
  const sto = d.storage || {};
  const capState = yt.usedJobs >= yt.capJobs ? 'warn' : 'ok';
  const unitState = yt.estUnits >= yt.dailyUnits ? 'bad' : yt.estUnits >= yt.dailyUnits * 0.7 ? 'warn' : 'ok';
  return `
    ${d.demo ? `<div class="callout callout--warn" style="margin-bottom:10px">${icon('info')}<div>Demo data — connect GitHub to see real quotas.</div></div>` : ''}
    ${d.stale ? `<div class="callout callout--warn" style="margin-bottom:10px">${icon('alert')}<div>Showing the last saved check; the refresh failed.</div></div>` : ''}
    <div class="qeng">
      ${row('GitHub token', d.token?.state === 'ok' ? 'Valid' : d.token?.state === 'warn' ? 'Expiring' : d.token?.state === 'bad' ? 'Problem' : '—', d.token?.state || 'off', d.token?.detail || '')}
      ${row('YouTube uploads today (console cap)', `${yt.usedJobs ?? 0} / ${yt.capJobs ?? 2}`, capState, `${yt.videosToday ?? 0} videos · ~${(yt.estUnits ?? 0).toLocaleString('en-IN')} of ${(yt.dailyUnits ?? 10000).toLocaleString('en-IN')} API units (est.) · UTC day`)}
      <div class="qrow">
        ${dot(sto.state || 'off')}
        <div class="qrow__main"><div class="qrow__label">GitHub Actions storage (both repos)</div>
          <div class="qbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, sto.pct || 0)}"><span style="width:${Math.min(100, sto.pct || 0)}%"></span></div>
          <div class="qrow__sub">Artifacts + caches vs 500 MB free</div></div>
        <div class="qrow__value">${esc(fmtMB(sto.usedBytes))}</div>
      </div>
    </div>
    ${(d.engines || []).map(engineBlock).join('')}
    <div class="tiny muted" style="margin-top:8px">Checked ${esc(fmtAgo(d.generatedAt))} · refreshes at most every 30 min${d.subrequests?.skipped?.length ? ` · skipped: ${esc(d.subrequests.skipped.join(', '))}` : ''}</div>`;
}

export async function mountQuotaPanel(root, id = 'quota-panel') {
  const el = root.querySelector(`#${id}`);
  if (!el) return;
  const body = el.querySelector('[data-q-body]');
  try {
    const d = await api.quota();
    body.innerHTML = renderQuota(d);
    const age = el.querySelector('[data-q-age]');
    if (age) age.textContent = d.cached ? `cached ${Math.round((d.ageSec || 0) / 60)} min` : 'just now';
  } catch (err) {
    body.innerHTML = `<div class="callout callout--warn">${icon('alert')}<div>Quota check unavailable: ${esc(err.message)}</div></div>`;
  }
}
