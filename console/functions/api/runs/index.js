import { json } from '../_lib/util.js';
import { listRuns } from '../_lib/db.js';

export async function onRequestGet(context) {
  const runs = await listRuns(context.env.DB);
  return json(null, 200, {
    runs,
    source: context.env.GITHUB_TOKEN
      ? 'GitHub Actions workflow-runs API + local job registry'
      : 'Local job registry only (GITHUB_TOKEN not configured — GitHub links unavailable)',
  });
}
