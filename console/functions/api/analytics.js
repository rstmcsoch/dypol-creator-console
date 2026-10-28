import { json } from './_lib/util.js';
import { listJobs } from './_lib/db.js';

/**
 * GET /api/analytics — real YouTube Analytics API data ONLY when connected.
 * Unavailable metrics are reported as unavailable — never fabricated, never "0".
 */
export async function onRequestGet(context) {
  const env = context.env;
  const jobs = await listJobs(env.DB, {});
  const hasAnalytics = !!(env.YOUTUBE_ANALYTICS_TOKEN_B64 || env.YOUTUBE_OAUTH_REFRESH_TOKEN);

  if (!hasAnalytics) {
    return json(null, 200, {
      connected: false,
      demo: false,
      reason: 'YouTube Analytics API is not connected. To enable live metrics: complete YouTube OAuth (see docs/SECRETS.md), set the YOUTUBE_ANALYTICS_TOKEN_B64 secret, and grant the yt-analytics.readonly scope. Until then the console reports metrics as unavailable — it will not display invented numbers.',
      totals: { views: null, published: jobs.filter((j) => j.status === 'published').length, avgDuration: null, watchHours: null },
      series: null,
      topVideos: jobs.filter((j) => j.status === 'published').map((j) => ({
        title: j.title, youtubeUrl: j.youtubeUrl, publishedAt: j.publishedAt,
        views: null, likes: null,
      })),
    });
  }

  // Live path: call YouTube Analytics API with the server-side token.
  // Minimal honest implementation: views/day for 14 days + totals.
  try {
    // AUDIT FIX: Buffer is unavailable in the Workers runtime — decode base64
    // with atob + TextDecoder instead.
    const bin = Uint8Array.from(atob(env.YOUTUBE_ANALYTICS_TOKEN_B64), (c) => c.charCodeAt(0));
    const token = new TextDecoder().decode(bin);
    const end = new Date();
    const start = new Date(Date.now() - 14 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const res = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${iso(start)}&endDate=${iso(end)}&metrics=views,estimatedMinutesWatched,averageViewDuration&dimensions=day`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`YouTube Analytics API ${res.status}`);
    const data = await res.json();
    const rows = data.rows || [];
    return json(null, 200, {
      connected: true, demo: false, reason: null,
      totals: {
        views: rows.reduce((s, r) => s + (r[1] || 0), 0),
        published: jobs.filter((j) => j.status === 'published').length,
        avgDuration: `${Math.round(rows.reduce((s, r) => s + (r[3] || 0), 0) / Math.max(1, rows.length))}s`,
        watchHours: Math.round(rows.reduce((s, r) => s + (r[2] || 0), 0) / 60),
      },
      series: {
        views: rows.map((r) => r[1]),
        labels: rows.map((r) => r[0]),
        publishedWeekly: [], weekLabels: [],
      },
      topVideos: jobs.filter((j) => j.status === 'published'),
    });
  } catch (err) {
    return json(null, 200, {
      connected: false,
      demo: false,
      reason: `YouTube Analytics API is configured but the request failed: ${err.message}. Metrics are shown as unavailable rather than zero.`,
      totals: { views: null, published: jobs.filter((j) => j.status === 'published').length, avgDuration: null, watchHours: null },
      series: null,
      topVideos: [],
    });
  }
}
