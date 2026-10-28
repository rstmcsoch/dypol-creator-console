import { json, readBody } from '../../_lib/util.js';
import { getSettings, saveSettings } from '../../_lib/db.js';

/** POST /api/engines/:engine/schedule { enabled } — toggles that engine's scheduled runs. */
export async function onRequestPost(context) {
  const db = context.env.DB;
  const engine = context.params.engine;
  const body = await readBody(context.request);
  const settings = await getSettings(db);
  const key = `schedules.${engine}`;
  await saveSettings(db, { schedules: { ...(settings.schedules || {}), [engine]: !!body.enabled } });
  return json(null, 200, {
    ok: true,
    message: `Schedule ${body.enabled ? 'enabled' : 'disabled'} for ${engine}. Existing videos, records and credentials are preserved.`,
  });
}
