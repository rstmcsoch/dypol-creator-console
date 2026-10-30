import { json } from './_lib/util.js';
import { listJobs, getSettings, capUsage } from './_lib/db.js';
import { collectQuota, readQuotaCache, writeQuotaCache, ensureQuotaSchema, REFRESH_MS } from './_lib/quota.js';

/**
 * GET /api/quota[?refresh=1] — Quota & health panel (Overview + Settings).
 * Served from the D1 cache; recomputed only when the cached copy is older
 * than 30 minutes (refresh=1 cannot force it sooner). Read-only: never
 * dispatches, publishes or changes a setting.
 */
const LOCK_MS = 2 * 60e3;

export async function onRequestGet(context) {
  const db = context.env.DB;
  const now = Date.now();
  const cached = await readQuotaCache(db);
  const age = cached ? now - cached.updatedAt : Infinity;
  if (cached && age < REFRESH_MS) {
    return json(null, 200, { ...cached.data, cached: true, ageSec: Math.round(age / 1000) });
  }
  // One recompute at a time: a fresh lock row means another request is on it.
  await ensureQuotaSchema(db);
  const lock = await db.prepare('SELECT updated_at FROM quota_cache WHERE key = ?').bind('lock').first();
  if (lock && now - Number(lock.updated_at) < LOCK_MS && cached) {
    return json(null, 200, { ...cached.data, cached: true, refreshing: true, ageSec: Math.round(age / 1000) });
  }
  await db.prepare(`INSERT INTO quota_cache (key, data, updated_at) VALUES ('lock', '{}', ?)
    ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`).bind(now).run();
  try {
    const [settings, jobs, cap] = await Promise.all([getSettings(db), listJobs(db, {}), capUsage(db, now)]);
    const data = await collectQuota(context.env, { settings, jobs, capUsage: cap, now });
    await writeQuotaCache(db, data, now);
    return json(null, 200, { ...data, cached: false, ageSec: 0 });
  } catch (err) {
    if (cached) return json(null, 200, { ...cached.data, cached: true, stale: true, error: String(err.message || err).slice(0, 200) });
    return json(null, 500, { error: `Quota panel failed: ${String(err.message || err).slice(0, 200)}`, code: 'quota' });
  } finally {
    await db.prepare("DELETE FROM quota_cache WHERE key = 'lock'").run();
  }
}
