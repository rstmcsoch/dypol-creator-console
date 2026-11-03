import { json } from '../../_lib/util.js';
import { getJob, getSettings, listRuns } from '../../_lib/db.js';
import { splitRepo, listRunArtifacts, downloadArtifact, artifactBlobUrl } from '../../_lib/github.js';
import { listEntries, extractNamed } from '../../_lib/ziputil.js';
import { openRemoteZip, streamEntry, RangeUnsupported } from '../../_lib/remotezip.js';
import { r2Manifest, pickR2File, keyFor, streamR2 } from '../../_lib/r2.js';

/**
 * GET /api/jobs/:id/media?kind=video|short|thumb|manifest|list|info|sprite|captions
 *                          [&quality=preview|full][&download=1][&video=long|short]
 *
 * 1. Cloudflare R2 first (binding MEDIA, private bucket, behind the console login):
 *    drafts/<job_id>/ (or published/<job_id>/) written by the engines. video/short
 *    stream the compressed review copy (CRF 28, 1 s keyframes, +faststart) with
 *    HTTP Range (206) so the player seeks without downloading the file;
 *    quality=full streams the ORIGINAL render. kind=info returns the player data
 *    (sizes, thumbnail strips, chapters, QC warning times, captions); sprite and
 *    captions return the strip image and the WebVTT track.
 * 2. Fallback when the job is not in R2: the GitHub artifacts (below).
 *
 * Review happens inside the console (no GitHub visit needed):
 *  - video / short prefer the small "preview-<job_id>" artifact (480p/720p H.264,
 *    +faststart, stored uncompressed) and STREAM the zip entry with HTTP Range
 *    reads against GitHub's pre-signed storage URL — nothing is buffered, and
 *    the player can seek (206 Partial Content).
 *  - Without a preview artifact (older drafts) it streams the entry from the
 *    full draft/candidate artifact (deflated entries are inflated on the fly).
 *  - quality=full always uses the full-quality render; download=1 adds
 *    Content-Disposition: attachment.
 *  - If storage ignores Range, falls back to the old whole-zip download.
 */
const PICK = {
  video: (n) => /\.mp4$/i.test(n) && !/(short_video|preview_short)/i.test(n),
  short: (n) => /\.mp4$/i.test(n) && /short/i.test(n),
  thumb: (n) => /thumbnail.*\.(png|jpe?g)$/i.test(n) || /\.(png|jpe?g)$/i.test(n) && /thumb/i.test(n),
  manifest: (n) => /(broll_manifest|visual_manifest|source_manifest)\.json$/i.test(n),
};
const TYPES = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json' };
const isPreview = (a) => /^preview-/i.test(a.name);
const isBundle = (a) => /(candidate|draft)/i.test(a.name);

/** Per-isolate cache of zip directories (offsets are stable; signed URLs are not). */
const DIR_CACHE = new Map();
const DIR_TTL = 10 * 60e3;
function cachedDir(artifactId) {
  const hit = DIR_CACHE.get(artifactId);
  if (hit && Date.now() - hit.at < DIR_TTL) return hit;
  DIR_CACHE.delete(artifactId);
  return null;
}
export function _resetMediaCache() { DIR_CACHE.clear(); }

export function pickEntry(names, kind) {
  let pick = PICK[kind] ? names.filter(PICK[kind]) : [];
  if ((kind === 'video' || kind === 'short') && !pick.length) pick = names.filter((n) => /\.mp4$/i.test(n));
  return pick;
}

/** Choose artifacts in the order they should be tried for this request. */
export function orderArtifacts(artifacts, kind, quality) {
  const live = (artifacts || []).filter((a) => !a.expired && (a.sizeInBytes ?? a.size_in_bytes ?? 1) > 2048);
  const previews = live.filter(isPreview);
  const bundles = live.filter((a) => !isPreview(a) && isBundle(a));
  const rest = live.filter((a) => !isPreview(a) && !isBundle(a));
  const video = kind === 'video' || kind === 'short';
  if (video && quality !== 'full') return [...previews, ...bundles, ...rest];
  return [...bundles, ...rest];
}

async function streamFromArtifact(token, gh, art, kind, request, download) {
  let dir = cachedDir(art.id);
  const url = await artifactBlobUrl(token, { ...gh, artifactId: art.id });
  if (!url) throw new RangeUnsupported('no storage redirect');
  if (!dir) {
    const zip = await openRemoteZip(url);
    dir = { at: Date.now(), entries: zip.entries, offsets: {} };
    DIR_CACHE.set(art.id, dir);
  }
  const names = dir.entries.map((e) => e.name);
  const pick = pickEntry(names, kind);
  if (!pick.length) return null;
  const entry = dir.entries.find((e) => e.name === pick[0]);
  const ext = entry.name.split('.').pop().toLowerCase();
  const out = await streamEntry(url, entry, {
    range: request.headers.get('Range'),
    contentType: TYPES[ext] || 'application/octet-stream',
    dataOfs: dir.offsets[entry.name] ?? null,
  });
  dir.offsets[entry.name] = out.dataOfs;
  const headers = { ...out.headers, 'X-DYPOL-Media-Source': isPreview(art) ? 'preview' : 'full' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${entry.name.split('/').pop().replace(/"/g, '')}"`;
  return new Response(out.body, { status: out.status, headers });
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  const token = context.env.GITHUB_TOKEN;
  const params = new URL(context.request.url).searchParams;
  const kind = params.get('kind') || 'video';
  const quality = params.get('quality') === 'full' ? 'full' : 'preview';
  const download = params.get('download') === '1';
  const job = await getJob(db, context.params.id);
  if (!job) return json(null, 404, { error: 'Job not found.', code: 'not-found' });

  // ---- 1. Cloudflare R2 ----
  const manifest = await r2Manifest(context.env, job.id);
  if (kind === 'info') return json(null, 200, playerInfo(job, manifest));
  if (manifest) {
    let name = pickR2File(manifest, job.engine, kind, quality);
    const which = params.get('video') === 'short' ? 'short' : params.get('video') === 'long' ? 'long' : null;
    if (kind === 'sprite') name = manifest.files?.[`${which || mainOf(job, manifest)}_sprite`] ? `${which || mainOf(job, manifest)}_sprite` : null;
    if (kind === 'captions') name = manifest.files?.[`${which || mainOf(job, manifest)}_captions`] ? `${which || mainOf(job, manifest)}_captions` : null;
    const key = name && keyFor(manifest, name);
    if (key) {
      const isOriginal = name === 'long' || name === 'short';
      const res = await streamR2(context.env, key, context.request, {
        download, source: isOriginal ? 'r2-original' : 'r2',
        filename: `${job.id}-${name}.${key.split('.').pop()}`,
      });
      if (res) return res;
    }
  }
  if (kind === 'sprite' || kind === 'captions') return json(null, 404, { error: `No ${kind} stored for this video.`, code: 'no-media' });
  const settings = await getSettings(db);
  const slug = settings.github[job.engine]?.repo;
  const runId = job.runId || (await listRuns(db)).find((r) => r.jobId === job.id && r.runId)?.runId;
  if (!token || !slug || !runId) return json(null, 404, { error: 'No GitHub run linked to this job yet.', code: 'no-run' });
  const gh = splitRepo(slug);

  const artifacts = (await listRunArtifacts(token, { ...gh, runId })) || [];
  const ordered = orderArtifacts(artifacts, kind, quality).slice(0, 3);

  // Small JSON / list requests and images: read via ranges too, but keep the
  // proven whole-zip path for manifests (multi-entry JSON parse).
  const streamable = kind === 'video' || kind === 'short' || kind === 'thumb';
  if (streamable) {
    let rangeBroken = false;
    for (const art of ordered) {
      try {
        const res = await streamFromArtifact(token, gh, art, kind, context.request, download);
        if (res) return res;
      } catch (err) {
        if (err instanceof RangeUnsupported) { rangeBroken = true; break; }
        // Unreadable preview (expired mid-request, corrupt): try the next artifact.
      }
    }
    if (!rangeBroken) return json(null, 404, { error: `No ${kind} found in this run's artifacts.`, code: 'no-media' });
  }

  // Fallback: whole-zip download (storage without Range support, manifest, list).
  for (const art of ordered.filter((a) => !(isPreview(a) && (kind === 'manifest' || kind === 'thumb')))) {
    const zip = await downloadArtifact(token, { ...gh, artifactId: art.id });
    const names = listEntries(zip);
    if (kind === 'list') return json(null, 200, { artifact: art.name, entries: names });
    const pick = pickEntry(names, kind);
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
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600',
      'X-DYPOL-Media-Source': isPreview(art) ? 'preview' : 'full',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${pick[0].split('/').pop().replace(/"/g, '')}"`;
    return new Response(entry.bytes, { headers });
  }
  return json(null, 404, { error: `No ${kind} found in this run's artifacts.`, code: 'no-media' });
}

const mainOf = (job, manifest) => (job.engine === 'verticals' || (!manifest?.files?.long && manifest?.files?.short) ? 'short' : 'long');

/** Player data for kind=info (no keys or bucket names leave the server). */
export function playerInfo(job, manifest) {
  if (!manifest) return { source: 'artifacts', engine: job.engine, main: job.engine === 'verticals' ? 'short' : 'long' };
  const f = manifest.files || {};
  const videos = {};
  for (const k of ['long', 'short']) {
    if (!f[k]) continue;
    const pv = f[`${k}_preview`];
    videos[k] = {
      w: f[k].w, h: f[k].h, duration: f[k].duration, fps: f[k].fps || 30, size: f[k].size,
      preview: pv ? { w: pv.w, h: pv.h, size: pv.size } : null,
      captions: !!f[`${k}_captions`],
      sprite: manifest.sprites?.[k] ? (({ interval, count, cols, rows, tw, th }) => ({ interval, count, cols, rows, tw, th }))(manifest.sprites[k]) : null,
      chapters: (manifest.chapters?.[k] || []).slice(0, 60),
      markers: (manifest.markers?.[k] || []).slice(0, 100),
      resolution: manifest.resolution?.[k] || null,
    };
  }
  return { source: 'r2', engine: job.engine, main: mainOf(job, manifest), videos, stored: manifest.prefix?.startsWith('published/') ? 'published' : 'draft' };
}
