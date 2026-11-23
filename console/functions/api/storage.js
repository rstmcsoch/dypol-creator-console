import { json } from './_lib/util.js';
import { storageUsage, sweepPublished, hasR2 } from './_lib/r2.js';

/**
 * GET /api/storage — Cloudflare R2 video storage use (Settings → Advanced).
 * Also moves published videos out of drafts/ (so the 30-day expiry never
 * removes them). Session-protected by _middleware.js.
 */
let usageCache = null;

export async function onRequestGet(context) {
  const env = context.env;
  if (!hasR2(env)) return json(null, 200, { configured: false });
  // Speed (23 Nov): the move of published files runs after the response, and the
  // bucket total is reused for 5 minutes per worker instead of listing R2 on every visit.
  const sweep = sweepPublished(env, env.DB, { maxJobs: 1 }).catch(() => {});
  if (typeof context.waitUntil === 'function') context.waitUntil(sweep); else await sweep;
  try {
    if (!usageCache || Date.now() - usageCache.at > 300000) usageCache = { at: Date.now(), value: await storageUsage(env) };
    return json(null, 200, { ...usageCache.value, movedToPublished: 0 });
  } catch (err) {
    return json(null, 200, { configured: true, error: `Storage unavailable: ${String(err.message || err).slice(0, 120)}` });
  }
}
