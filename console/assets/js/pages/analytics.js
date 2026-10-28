/* Analytics — honest about what is connected vs unavailable */
import { api } from '../api.js';
import {
  icon, esc, fmtNum, fmtDateTime, lineChart, barChart, statCard, thumb, emptyState,
} from '../ui.js';

async function refresh() {
  const root = document.getElementById('page-root');
  const d = await api.analytics();

  const notConnected = `
    <div class="card">
      <div class="empty">
        <div class="empty__icon">${icon('wifiOff')}</div>
        <h3>YouTube Analytics is not connected</h3>
        <p>${esc(d.reason || 'Live channel metrics require a connected YouTube channel with YouTube Analytics API access. The console will not display invented numbers in place of unavailable data.')}</p>
        <a class="btn btn--primary btn--sm" href="#/settings">${icon('gear', 'icon--sm')} Open Settings → YouTube</a>
      </div>
    </div>`;

  const charts = `
    <div class="grid grid--2">
      <div class="card">
        <div class="card__head">${icon('trendUp')}<h2>Views over time</h2>
          <div class="right"><span class="tiny muted">Last 14 days</span></div></div>
        <div class="card__body">
          ${lineChart(d.series?.views || [], { labels: d.series?.labels || [] })}
          <div class="legend" style="margin-top:10px">
            <span><i style="background:var(--accent)"></i> Views per day</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card__head">${icon('chart')}<h2>Published videos per week</h2></div>
        <div class="card__body">
          ${barChart(d.series?.publishedWeekly || [], { labels: d.series?.weekLabels || [] })}
          <div class="legend" style="margin-top:10px">
            <span><i style="background:var(--accent)"></i> Published</span>
            <span><i style="background:var(--violet)"></i> Shorts</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card__head">${icon('video')}<h2>Top performing videos</h2></div>
      ${d.topVideos?.length ? `<div class="table">
        <div class="table__head" style="grid-template-columns:76px minmax(0,2.5fr) 1fr 1fr 1fr">
          <div>Thumb</div><div>Video</div><div>Views</div><div>Likes</div><div>Published</div>
        </div>
        ${d.topVideos.map((v) => `
          <div class="table__row" style="grid-template-columns:76px minmax(0,2.5fr) 1fr 1fr 1fr">
            <div class="cell-main">${thumb(v)}</div>
            <div class="cell-main">
              <div class="cell-title truncate">${esc(v.title)}</div>
              <div class="cell-sub">${v.youtubeUrl ? `<a href="${esc(v.youtubeUrl)}" target="_blank" rel="noopener">Open on YouTube</a>` : esc(v.stage || '')}</div>
            </div>
            <div data-col="Views"><strong>${fmtNum(v.views)}</strong></div>
            <div data-col="Likes">${fmtNum(v.likes)}</div>
            <div data-col="Published"><span class="small muted">${esc(fmtDateTime(v.publishedAt))}</span></div>
          </div>`).join('')}
      </div>` : emptyState('chart', 'No video metrics yet', 'Metrics appear after videos are published and the channel is connected.')}
    </div>`;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Analytics</h1>
        <div class="sub">Channel and video performance — from real YouTube APIs only.</div>
      </div>
      <div class="page-head__actions">
        ${d.connected
          ? `<span class="badge-soft">${icon('check', 'icon--sm')} YouTube Analytics connected</span>`
          : `<span class="badge-soft" style="background:var(--amber-soft);color:var(--amber);border-color:rgba(180,83,9,.2)">${icon('alert', 'icon--sm')} Not connected</span>`}
      </div>
    </div>

    ${d.demo ? `<div class="callout callout--warn" style="margin-bottom:18px">${icon('info')}<div><strong>Illustrative chart data.</strong> The console is in demo mode — these series demonstrate the analytics layout and are not real channel metrics.</div></div>` : ''}

    <div class="grid grid--stats" style="margin-bottom:18px">
      ${statCard({ iconName: 'eye', tone: 'orange', label: 'Total views', value: d.connected || d.demo ? fmtNum(d.totals?.views) : '—', delta: d.connected ? 'From YouTube Analytics API' : 'Unavailable — not zero' })}
      ${statCard({ iconName: 'youtube', tone: 'red', label: 'Published videos', value: d.connected || d.demo ? fmtNum(d.totals?.published) : '—', delta: d.connected ? 'All time' : 'Unavailable — not zero' })}
      ${statCard({ iconName: 'trendUp', tone: 'green', label: 'Avg. view duration', value: d.connected || d.demo ? (d.totals?.avgDuration || '—') : '—', delta: d.connected ? 'Across published videos' : 'Unavailable — not zero' })}
      ${statCard({ iconName: 'chart', tone: 'blue', label: 'Watch time (hrs)', value: d.connected || d.demo ? fmtNum(d.totals?.watchHours) : '—', delta: d.connected ? 'Last 28 days' : 'Unavailable — not zero' })}
    </div>

    ${d.connected || d.demo ? charts : notConnected}

    <div class="callout" style="margin-top:18px">${icon('info')}<div><strong>Data honesty.</strong> Unavailable metrics are shown as “—” with an explanation, never as zero. Charts display live API data only when the YouTube Analytics API is connected and authorised in Settings.</div></div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console</span><span>·</span><span>Analytics</span>
    </div>`;
}

export async function renderAnalytics() {
  await refresh();
}
