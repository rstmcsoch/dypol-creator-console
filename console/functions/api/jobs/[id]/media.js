import { json } from '../../_lib/util.js';
import { getJob, getSettings, listRuns } from '../../_lib/db.js';
import { splitRepo, listRunArtifacts, downloadArtifact } from '../../_lib/github.js';
import { listEntries, extractNamed } from '../../_lib/ziputil.js';

/**
 * GET /api/jobs/:id/media?kind=video|short|thumb|manifest|list
 * Streams the draft's rendered video, thumbnail or visual-credits manifest
 * straight out of the job's GitHub Actions artifact, so review happens inside
 * the console (no GitHub visit needed).
 */
const PICK = {
  video: (n) => /\.mp4$/i.test(n) && !/short_video/i.test(n),
  short: (n) => /\.mp4$/i.test(n) && /short/i.test(n),
  thumb: (n) => /thumbnail.*\.(png|jpe?g)$/i.test(n) || /\.(png|jpe?g)$/i.test(n) && /thumb/i.test(n),
  manifest: (n) => /(broll_manifest|visual_manifest|source_manifest)\.json$/i.test(n),
};
const TYPES = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json' };

export async function onRequestGet(context) {
  const db = context.env.DB;
  const token = context.env.GITHUB_TOKEN;
  const kind = new URL(context.request.url).searchParams.get('kind') || 'video';
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });
  const settings = await getSettings(db);
  const slug = settings.github[job.engine]?.repo;
  const runId = job.runId || (await listRuns(db)).find((r) => r.jobId === job.id && r.runId)?.runId;
  if (!token || !slug || !runId) return json(null, 404, { error: 'No GitHub run linked to this job yet.', code: 'no-run' });
  const gh = splitRepo(slug);

  const artifacts = (await listRunArtifacts(token, { ...gh, runId })) || [];
  // Prefer the draft/candidate bundle; skip tiny result files.
  const ordered = artifacts
    .filter((a) => !a.expired && (a.sizeInBytes ?? a.size_in_bytes ?? 1) > 2048)
    .sort((a, b) => (/(candidate|draft)/i.test(b.name) ? 1 : 0) - (/(candidate|draft)/i.test(a.name) ? 1 : 0));
  for (const art of ordered.slice(0, 3)) {
    const zip = await downloadArtifact(token, { ...gh, artifactId: art.id });
    const names = listEntries(zip);
    if (kind === 'list') return json(null, 200, { artifact: art.name, entries: names });
    let pick = PICK[kind] ? names.filter(PICK[kind]) : [];
    if (kind === 'video' && !pick.length) pick = names.filter((n) => /\.mp4$/i.test(n));
    if (!pick.length) continue;
    if (kind === 'manifest') {
      const out = [];
      for (const n of pick.slice(0, 3)) {
        const e = await extractNamed(zip, n);
        if (e) { try { out.push({ file: n, data: JSON.parse(new TextDecoder().decode(e.bytes)) }); } catch { /* skip */ } }
      }
      return json(null, 200, { manifests: out });
    }
    const entry = await extractNamed(zip, pick[0]);
    if (!entry) continue;
    const ext = pick[0].split('.').pop().toLowerCase();
    return new Response(entry.bytes, {
      headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' },
    });
  }
  return json(null, 404, { error: `No ${kind} found in this run's artifacts.`, code: 'no-media' });
}
