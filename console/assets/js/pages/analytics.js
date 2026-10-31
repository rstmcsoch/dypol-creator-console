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
        <h3>Channel stats aren’t connected yet</h3>
        <p>${esc('Views and watch time will show here once YouTube stats are connected. Until then nothing is shown — we never guess numbers.')}</p>
        <a class="btn btn--primary btn--sm" href="#/settings">${icon('gear', 'icon--sm')} Open Settings</a>
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
    <a class="back-link" href="#/settings">${icon('chevronL', 'icon--sm')} Settings</a>
    <div class="page-head">
      <div>
        <h1>Channel stats</h1>
        <div class="sub">How your videos are doing on YouTube.</div>
      </div>
      <div class="page-head__actions">
        ${d.connected
          ? `<span class="badge-soft">${icon('check', 'icon--sm')} Connected</span>`
          : `<span class="badge-soft" style="background:var(--amber-soft);color:var(--amber);border-color:rgba(180,83,9,.2)">${icon('alert', 'icon--sm')} Not connected yet</span>`}
      </div>
    </div>

    ${d.demo ? `<div class="callout callout--warn" style="margin-bottom:18px">${icon('info')}<div><strong>Demo charts.</strong> Pretend numbers to show the layout.</div></div>` : ''}

    <div class="grid grid--stats" style="margin-bottom:18px">
      ${statCard({ iconName: 'eye', tone: 'orange', label: 'Total views', value: d.connected || d.demo ? fmtNum(d.totals?.views) : '—', delta: d.connected ? 'From YouTube' : 'Not connected yet' })}
      ${statCard({ iconName: 'youtube', tone: 'red', label: 'Published videos', value: d.connected || d.demo ? fmtNum(d.totals?.published) : '—', delta: d.connected ? 'All time' : 'Not connected yet' })}
      ${statCard({ iconName: 'trendUp', tone: 'green', label: 'Avg. view duration', value: d.connected || d.demo ? (d.totals?.avgDuration || '—') : '—', delta: d.connected ? 'Across published videos' : 'Not connected yet' })}
      ${statCard({ iconName: 'chart', tone: 'blue', label: 'Watch time (hrs)', value: d.connected || d.demo ? fmtNum(d.totals?.watchHours) : '—', delta: d.connected ? 'Last 28 days' : 'Not connected yet' })}
    </div>

    ${d.connected || d.demo ? charts : notConnected}

    <div class="callout" style="margin-top:18px">${icon('info')}<div>“—” means not connected yet, not zero. We only show real numbers from YouTube.</div></div>`;
}

export async function renderAnalytics() {
  await refresh();
}
