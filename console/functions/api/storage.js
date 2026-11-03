import { json } from './_lib/util.js';
import { storageUsage, sweepPublished, hasR2 } from './_lib/r2.js';

/**
 * GET /api/storage — Cloudflare R2 video storage use (Settings → Advanced).
 * Also moves published videos out of drafts/ (so the 30-day expiry never
 * removes them). Session-protected by _middleware.js.
 */
export async function onRequestGet(context) {
  const env = context.env;
  if (!hasR2(env)) return json(null, 200, { configured: false });
  let moved = 0;
  try { moved = (await sweepPublished(env, env.DB, { maxJobs: 1 })).moved; } catch { /* reported by the next view */ }
  try {
    return json(null, 200, { ...(await storageUsage(env)), movedToPublished: moved });
  } catch (err) {
    return json(null, 200, { configured: true, error: `Storage unavailable: ${String(err.message || err).slice(0, 120)}` });
  }
}
