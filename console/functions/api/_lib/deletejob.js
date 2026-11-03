/**
 * Delete video — removes a job and everything it left in OUR systems:
 * GitHub runs (+ logs), artifacts, files committed on dypol-integration, and
 * every D1 row. Nothing is ever deleted from YouTube (owner's rule, 31 Oct
 * 2026): a published video stays on YouTube; only the duplicate/upload guard
 * keeps its YouTube id + topic hash (no title, no job id).
 *
 * Order (one pass per request, resumable):
 *   0. `deletions` row = lock + plan (ids/counts only, no titles). While it
 *      exists, approve/publish/retry/redo/reconcile/webhook/fallback skip the job.
 *   1. cancel running runs, wait until GitHub reports them completed
 *      (force-cancel after 60 s)
 *   2. per run: delete every artifact, then the run (removes its logs)
 *   3. one commit per engine repo (Git Data API) removing the job's files
 *      (+ its content_plan.json entry, + images/demo.gif if this job wrote it)
 *   4. re-sweep GitHub for runs that started after the plan was made
 *   5. the job's stored files in Cloudflare R2 (drafts/<id>/ + published/<id>/)
 *   6. one atomic D1 batch deleting every row (+ the deletions row)
 *
 * Linked versions (Redo / fallback children, e.g. a Short-only version made
 * from a long video) are listed on the confirm sheet and deleted ONLY when the
 * owner ticks them (`include`); nothing linked is deleted by default (owner's
 * decision after the 1 Nov 2026 incident). Kept versions are detached
 * (parent_job_id cleared) so they stay complete videos.
 * D1 rows go last, so the job row itself is the tombstone until everything
 * else is gone. 404/410 from GitHub = already gone, so every step is idempotent.
 *
 * Workers Free allows 50 subrequests per request; each pass spends at most
 * BUDGET GitHub calls and the client calls again ("continue").
 */
import { splitRepo, integrationRef } from './github.js';
import { getJob, utcDayStartIso } from './db.js';
import { deleteJobObjects, countJobObjects, hasR2 } from './r2.js';

const API = 'https://api.github.com';
export const DELETE_BUDGET = 35;
export const LEASE_MS = 60e3;
export const FORCE_CANCEL_AFTER_MS = 60e3;
const DELETE_MESSAGE = 'dypol: remove files of a deleted video';
const PLAN_FILE = 'content_plan.json';
const DEMO_GIF = 'images/demo.gif';
const ACTIVE = ['dispatched', 'running', 'generating', 'rendering', 'queued'];

/* ---------------- schema / lock helpers ---------------- */

/** Job ids with a deletion in progress (cached per call site). Never throws. */
export async function deletingIds(db) {
  try {
    const { results } = await db.prepare('SELECT job_id, plan FROM deletions').all();
    const ids = new Set();
    for (const r of results || []) {
      ids.add(r.job_id);
      try { for (const j of JSON.parse(r.plan || '{}').jobs || []) ids.add(j.id); } catch { /* ignore */ }
    }
    return ids;
  } catch { return new Set(); }
}
export async function isDeleting(db, jobId) {
  if (!jobId) return false;
  return (await deletingIds(db)).has(jobId);
}

class Pause extends Error {
  constructor(reason, retryAfterMs) { super(reason); this.pause = true; this.retryAfterMs = retryAfterMs || 0; }
}

export class GhBudget {
  constructor(limit = DELETE_BUDGET) { this.limit = limit; this.used = 0; }
  take() { if (this.used >= this.limit) throw new Pause('budget'); this.used += 1; }
}

/** GitHub call that never throws on HTTP status (except rate limits → Pause). */
async function ghx(token, budget, method, path, body) {
  budget.take();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DYPOL-Creator-Console',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  const h = (k) => res.headers.get(k);
  const limited = res.status === 429 || (res.status === 403 && (h('retry-after') || h('x-ratelimit-remaining') === '0'
    || /rate limit/i.test(data?.message || '')));
  if (limited) {
    const ra = Number(h('retry-after')) * 1000 || Math.max(5000, (Number(h('x-ratelimit-reset')) || 0) * 1000 - Date.now());
    throw new Pause('rate-limit', Math.min(ra || 60000, 300000));
  }
  if (res.status >= 500) throw new Pause('github-unavailable', 5000);
  return { status: res.status, ok: res.ok, data };
}
const gone = (s) => s === 404 || s === 410;
const refusal = (r) => (r.status === 403 ? 'GitHub refused (the console token lacks permission)'
  : `GitHub answered ${r.status}${r.data?.message ? ` (${String(r.data.message).slice(0, 120)})` : ''}`);

/* ---------------- lineage + discovery ---------------- */

/**
 * Linked versions of a job (all descendants: Redo / fallback children), for the
 * confirm sheet: id, engine, title, status. Never ancestors.
 */
export async function linkedVersions(db, rootId) {
  const all = await lineageJobs(db, rootId);
  return all.slice(1).map((j) => ({
    id: j.id, engine: j.engine, title: j.title || j.topic || '', status: j.status, parentJobId: j.parentJobId || null,
    onYouTube: !!(j.youtubeId || (j.videos || []).some((v) => v?.youtube_id)), createdAt: j.createdAt,
  }));
}

/** The job plus only the linked versions the owner ticked (include). */
export async function selectedJobs(db, rootId, include = []) {
  const all = await lineageJobs(db, rootId);
  if (!all.length) return [];
  const want = new Set((Array.isArray(include) ? include : []).map(String));
  return [all[0], ...all.slice(1).filter((j) => want.has(j.id))];
}

/** The job plus all descendants (Redo / fallback children), never ancestors. */
export async function lineageJobs(db, rootId) {
  const root = await getJob(db, rootId);
  if (!root) return [];
  const out = [root];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const ph = frontier.map(() => '?').join(',');
    const { results } = await db.prepare(`SELECT id FROM jobs WHERE parent_job_id IN (${ph})`).bind(...frontier).all();
    frontier = [];
    for (const r of results || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id); frontier.push(r.id);
      out.push(await getJob(db, r.id));
    }
  }
  return out.filter(Boolean);
}

const engineRepo = (settings, engine) => settings.github?.[engine]?.repo || null;
export const titleMatches = (displayTitle, jobId) => {
  const t = String(displayTitle || '');
  return t === jobId || t.startsWith(`${jobId} (`);
};

async function listRepoRuns(token, budget, slug, pages = 2) {
  const { owner, repo } = splitRepo(slug);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const r = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/actions/runs?per_page=100&page=${p}`);
    if (!r.ok) break;
    const list = r.data?.workflow_runs || [];
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

async function listDir(token, budget, slug, dir, ref) {
  const { owner, repo } = splitRepo(slug);
  const r = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`);
  return r.ok && Array.isArray(r.data) ? r.data.map((f) => f.path) : [];
}

function decodeB64(s) {
  const bin = Uint8Array.from(atob(String(s || '').replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bin);
}

/** Titles/topics a content_plan entry may be removed for (not shared with a surviving job). */
async function exclusiveTitles(db, jobs) {
  const ids = jobs.map((j) => j.id);
  const ph = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT title, topic FROM jobs WHERE id NOT IN (${ph})`).bind(...ids).all();
  const taken = new Set();
  for (const r of results || []) { if (r.title) taken.add(norm(r.title)); if (r.topic) taken.add(norm(r.topic)); }
  const mine = new Set(), shared = new Set();
  for (const j of jobs) for (const t of [j.title, j.topic]) {
    if (!t) continue;
    (taken.has(norm(t)) ? shared : mine).add(norm(t));
  }
  return { mine, shared };
}
const norm = (s) => String(s || '').trim().toLowerCase();
const planEntryMatches = (e, set) => e && (set.has(norm(e.title)) || set.has(norm(e.topic)) || set.has(norm(e.part)));

/**
 * Work out everything a deletion has to remove. Read-only.
 * Plan holds ids, paths and counts — never titles or descriptions.
 */
export async function buildPlan(db, env, settings, rootId, budget = new GhBudget(), { include = [] } = {}) {
  const jobs = await selectedJobs(db, rootId, include);
  if (!jobs.length) return null;
  const token = env.GITHUB_TOKEN;
  const ref = integrationRef(settings);
  const ids = jobs.map((j) => j.id);
  const ph = ids.map(() => '?').join(',');
  const dayStart = utcDayStartIso();

  // Runs known to D1 (job_id) + ids stored on the jobs themselves.
  const runs = new Map(); // runId -> {runId, slug, engine}
  const addRun = (runId, engine) => {
    const id = String(runId || '');
    if (!/^\d+$/.test(id) || runs.has(id)) return;
    const slug = engineRepo(settings, engine);
    if (slug) runs.set(id, { runId: id, slug, engine });
  };
  const { results: runRows } = await db.prepare(`SELECT id, run_id, engine, job_id FROM runs WHERE job_id IN (${ph})`).bind(...ids).all();
  for (const r of runRows || []) addRun(r.run_id, r.engine);
  for (const j of jobs) { addRun(j.runId, j.engine); addRun(j.publishRunId, j.engine); }

  const notes = [];
  const files = {}; // slug -> {paths:[], planEntries, planShared, demoGif}
  let artifacts = 0;
  if (token) {
    // Runs named "<job_id> (<phase>)" in BOTH engine repos (5xx-recovered,
    // retries, publish runs, runs D1 never linked).
    for (const engine of ['gemini', 'verticals']) {
      const slug = engineRepo(settings, engine);
      if (!slug) continue;
      for (const r of await listRepoRuns(token, budget, slug)) {
        if (ids.some((id) => titleMatches(r.display_title, id))) {
          if (!runs.has(String(r.id))) runs.set(String(r.id), { runId: String(r.id), slug, engine });
        }
      }
    }
    for (const run of runs.values()) {
      const { owner, repo } = splitRepo(run.slug);
      const r = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/actions/runs/${run.runId}/artifacts?per_page=100`);
      if (r.ok) { run.artifacts = r.data?.total_count ?? (r.data?.artifacts || []).length; artifacts += run.artifacts; }
      else if (gone(r.status)) run.gone = true;
    }
    // Committed files on dypol-integration.
    const runIds = new Set(runs.keys());
    for (const engine of ['gemini', 'verticals']) {
      const slug = engineRepo(settings, engine);
      if (!slug) continue;
      const entry = files[slug] = { paths: [], planEntries: 0, planShared: 0, demoGif: false };
      const results = await listDir(token, budget, slug, 'dypol-results', ref);
      for (const p of results) {
        const m = /dypol-results\/(\d+)\.json$/.exec(p);
        if (m && runIds.has(m[1])) entry.paths.push(p);
      }
      if (engine === 'verticals') {
        const drafts = await listDir(token, budget, slug, 'dypol-drafts', ref);
        for (const p of drafts) if (ids.some((id) => p === `dypol-drafts/${id}.json`)) entry.paths.push(p);
      }
      if (engine === 'gemini') {
        const { owner, repo } = splitRepo(slug);
        const cp = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/contents/${PLAN_FILE}?ref=${encodeURIComponent(ref)}`);
        if (cp.ok && cp.data?.content) {
          try {
            const plan = JSON.parse(decodeB64(cp.data.content));
            const { mine, shared } = await exclusiveTitles(db, jobs);
            for (const e of plan.lessons || []) {
              if (planEntryMatches(e, mine)) entry.planEntries++;
              else if (planEntryMatches(e, shared)) entry.planShared++;
            }
          } catch { notes.push('content_plan.json unreadable'); }
        }
        if (runIds.size) {
          const c = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(DEMO_GIF)}&sha=${encodeURIComponent(ref)}&per_page=1`);
          const msg = c.ok && Array.isArray(c.data) && c.data[0] ? String(c.data[0].commit?.message || '') : '';
          const m = /\brun (\d+)\b/.exec(msg);
          if (m && runIds.has(m[1])) entry.demoGif = true;
        }
      }
      if (!entry.paths.length && !entry.planEntries && !entry.demoGif && !entry.planShared) delete files[slug];
    }
  } else {
    notes.push('GitHub token missing — only dashboard records can be removed');
  }

  // D1 counts (one query).
  const runList = [...runs.keys()];
  const rph = runList.length ? runList.map(() => '?').join(',') : "''";
  const c = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM runs WHERE job_id IN (${ph}) OR run_id IN (${rph})) AS runs,
      (SELECT COUNT(*) FROM gh_jobs WHERE gh_run_id IN (${rph})) AS gh_jobs,
      (SELECT COUNT(*) FROM job_steps WHERE gh_run_id IN (${rph})) AS steps,
      (SELECT COUNT(*) FROM uploads WHERE job_id IN (${ph})) AS uploads`)
    .bind(...ids, ...runList, ...runList, ...runList, ...ids).first().catch(() => ({}));

  const published = jobs.filter((j) => j.status === 'published' || j.youtubeId);
  let storedFiles = 0;
  if (hasR2(env)) { try { storedFiles = await countJobObjects(env, ids); } catch { notes.push('video storage unreadable'); } }
  const plan = {
    v: 1,
    rootId,
    jobs: jobs.map((j) => ({
      id: j.id, engine: j.engine, status: j.status,
      onYouTube: !!(j.youtubeId || (j.videos || []).some((v) => v?.youtube_id)),
      youtubeVideos: (j.videos || []).filter((v) => v?.youtube_id).length || (j.youtubeId ? 1 : 0),
      publishedToday: j.status === 'published' && !!j.publishedAt && j.publishedAt >= dayStart,
      createdAt: j.createdAt,
    })),
    runs: [...runs.values()].map((r) => ({ runId: r.runId, slug: r.slug, engine: r.engine, artifacts: r.artifacts || 0 })),
    files,
    counts: {
      attempts: jobs.length,
      githubRuns: runs.size,
      savedFiles: artifacts,
      repoFiles: Object.values(files).reduce((n, f) => n + f.paths.length + (f.demoGif ? 1 : 0) + (f.planEntries ? 1 : 0), 0),
      planEntries: Object.values(files).reduce((n, f) => n + f.planEntries, 0),
      planShared: Object.values(files).reduce((n, f) => n + f.planShared, 0),
      dashboardRows: jobs.length + Number(c?.runs || 0) + Number(c?.gh_jobs || 0) + Number(c?.steps || 0) + Number(c?.uploads || 0),
      youtubeStays: published.reduce((n, j) => n + ((j.videos || []).filter((v) => v?.youtube_id).length || 1), 0),
      beingMade: jobs.filter((j) => ACTIVE.includes(j.status)).length,
      storedFiles,
    },
    notes,
  };
  return plan;
}

/** Plain-language list of what will be removed (for the confirm sheet). */
export function describePlan(plan) {
  const c = plan.counts;
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const items = [`Dashboard record${c.attempts > 1 ? `s (${c.attempts} attempts)` : ''}`];
  if (c.githubRuns) items.push(s(c.githubRuns, 'GitHub run (with its log)', 'GitHub runs (with their logs)'));
  if (c.savedFiles) items.push(s(c.savedFiles, 'saved file on GitHub', 'saved files on GitHub'));
  if (c.repoFiles) items.push(s(c.repoFiles, 'file in the code repository', 'files in the code repository'));
  if (c.storedFiles) items.push(s(c.storedFiles, 'stored video file', 'stored video files'));
  return items;
}

/* ---------------- execution ---------------- */

async function loadDeletion(db, jobId) {
  const r = await db.prepare('SELECT * FROM deletions WHERE job_id = ?').bind(jobId).first();
  if (!r) return null;
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  return { ...r, plan: parse(r.plan, null), done: parse(r.done, {}) };
}
async function saveDeletion(db, d, patch = {}) {
  const next = { ...d, ...patch };
  await db.prepare('UPDATE deletions SET plan = ?, done = ?, state = ?, last_error = ?, updated_at = ? WHERE job_id = ?')
    .bind(JSON.stringify(next.plan), JSON.stringify(next.done || {}), next.state || 'active', next.last_error || null, Date.now(), d.job_id).run();
  return next;
}

/** Remaining work, in plain counts, for the UI. */
export function remainingOf(d) {
  const done = d.done || {};
  const runsLeft = (d.plan?.runs || []).filter((r) => !(done.runs || {})[r.runId] || String(done.runs[r.runId]).startsWith('failed')).length;
  const slugs = new Set([...Object.keys(d.plan?.files || {}), ...(d.plan?.runs || []).map((r) => r.slug)]);
  const filesLeft = [...slugs].filter((slug) => (done.files || {})[slug] !== 'done').length;
  return { githubRuns: runsLeft, repoCommits: filesLeft, dashboardRecords: 1 };
}

/** Step 1+2: cancel / wait / delete artifacts + run. Returns 'waiting' when a run is still stopping. */
async function deleteRuns(env, d, budget, results) {
  const token = env.GITHUB_TOKEN;
  d.done.runs = d.done.runs || {};
  d.done.cancelAt = d.done.cancelAt || {};
  let waiting = false;
  for (const run of d.plan.runs) {
    const st = d.done.runs[run.runId];
    if (st === 'done') continue;
    const { owner, repo } = splitRepo(run.slug);
    const base = `/repos/${owner}/${repo}/actions/runs/${run.runId}`;
    const g = await ghx(token, budget, 'GET', base);
    if (gone(g.status)) { d.done.runs[run.runId] = 'done'; results.push({ item: `GitHub run ${run.runId}`, ok: true, note: 'already gone' }); continue; }
    if (!g.ok) { d.done.runs[run.runId] = `failed: ${refusal(g)}`; results.push({ item: `GitHub run ${run.runId}`, ok: false, note: refusal(g) }); continue; }
    if (g.data?.status !== 'completed') {
      const first = d.done.cancelAt[run.runId];
      const force = first && Date.now() - first > FORCE_CANCEL_AFTER_MS;
      const c = await ghx(token, budget, 'POST', `${base}/${force ? 'force-cancel' : 'cancel'}`);
      if (!first) d.done.cancelAt[run.runId] = Date.now();
      if (c.status === 403) { d.done.runs[run.runId] = `failed: ${refusal(c)}`; results.push({ item: `GitHub run ${run.runId}`, ok: false, note: refusal(c) }); continue; }
      results.push({ item: `GitHub run ${run.runId}`, ok: true, note: force ? 'force-stopping' : 'stopping' });
      waiting = true;
      continue;
    }
    // Artifacts first (each listed live: retries can create same-named duplicates).
    let artOk = true;
    for (let page = 1; page <= 5; page++) {
      const l = await ghx(token, budget, 'GET', `${base}/artifacts?per_page=100&page=${page}`);
      if (!l.ok) { if (!gone(l.status)) { artOk = false; results.push({ item: `Saved files of run ${run.runId}`, ok: false, note: refusal(l) }); } break; }
      const list = l.data?.artifacts || [];
      for (const a of list) {
        const del = await ghx(token, budget, 'DELETE', `/repos/${owner}/${repo}/actions/artifacts/${a.id}`);
        const ok = del.ok || gone(del.status);
        if (ok) d.done.artifacts = (d.done.artifacts || 0) + 1;
        else { artOk = false; results.push({ item: `Saved file ${a.id}`, ok: false, note: refusal(del) }); }
      }
      if (list.length < 100) break;
    }
    if (!artOk) { d.done.runs[run.runId] = 'failed: saved files'; continue; }
    const del = await ghx(token, budget, 'DELETE', base);
    if (del.ok || gone(del.status)) {
      d.done.runs[run.runId] = 'done';
      results.push({ item: `GitHub run ${run.runId}`, ok: true, note: 'deleted with its log and saved files' });
    } else if (del.status === 409) {
      waiting = true; // GitHub still finalising the run
      results.push({ item: `GitHub run ${run.runId}`, ok: true, note: 'GitHub is still closing it' });
    } else {
      d.done.runs[run.runId] = `failed: ${refusal(del)}`;
      results.push({ item: `GitHub run ${run.runId}`, ok: false, note: refusal(del) });
    }
  }
  return waiting ? 'waiting' : 'ok';
}

/**
 * Step 3: one commit per repo via the Git Data API (ref → commit → tree →
 * commit → ref). Paths are re-checked live so a tree entry never names a
 * missing file. Retries once when the branch moved (422).
 */
async function deleteFiles(db, env, settings, d, budget, results) {
  const token = env.GITHUB_TOKEN;
  const ref = integrationRef(settings);
  d.done.files = d.done.files || {};
  const jobs = (await Promise.all((d.plan.jobs || []).map((j) => getJob(db, j.id)))).filter(Boolean);
  // Every repo this lineage touched: files found at planning time plus the
  // result/draft paths of every run (a run may have committed after planning).
  const targets = {};
  for (const [slug, f] of Object.entries(d.plan.files || {})) targets[slug] = { ...f, paths: [...f.paths] };
  for (const r of d.plan.runs || []) {
    const t = targets[r.slug] = targets[r.slug] || { paths: [], planEntries: 0, demoGif: false };
    t.paths.push(`dypol-results/${r.runId}.json`);
    if (r.engine === 'verticals') for (const j of d.plan.jobs) t.paths.push(`dypol-drafts/${j.id}.json`);
  }
  for (const t of Object.values(targets)) t.paths = [...new Set(t.paths)];
  for (const [slug, want] of Object.entries(targets)) {
    if (d.done.files[slug] === 'done') continue;
    const { owner, repo } = splitRepo(slug);
    let committed = false, lastErr = null;
    for (let attempt = 0; attempt < 2 && !committed; attempt++) {
      const head = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
      if (!head.ok) { lastErr = refusal(head); break; }
      const headSha = head.data?.object?.sha;
      const commit = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
      if (!commit.ok) { lastErr = refusal(commit); break; }
      // Live existence check (recursive tree of the head commit).
      const tree = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/git/trees/${commit.data.tree.sha}?recursive=1`);
      if (!tree.ok) { lastErr = refusal(tree); break; }
      const have = new Set((tree.data?.tree || []).filter((t) => t.type === 'blob').map((t) => t.path));
      const entries = want.paths.filter((p) => have.has(p)).map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
      if (want.demoGif && have.has(DEMO_GIF)) entries.push({ path: DEMO_GIF, mode: '100644', type: 'blob', sha: null });
      if (want.planEntries && have.has(PLAN_FILE)) {
        const cp = await ghx(token, budget, 'GET', `/repos/${owner}/${repo}/contents/${PLAN_FILE}?ref=${encodeURIComponent(headSha)}`);
        if (cp.ok && cp.data?.content) {
          try {
            const raw = decodeB64(cp.data.content);
            const plan = JSON.parse(raw);
            const { mine } = await exclusiveTitles(db, jobs.length ? jobs : [{ id: '__none__' }]);
            const before = (plan.lessons || []).length;
            plan.lessons = (plan.lessons || []).filter((e) => !planEntryMatches(e, mine));
            if (plan.lessons.length !== before) {
              const indent = /\n(\s+)"/.exec(raw)?.[1]?.length || 2;
              entries.push({ path: PLAN_FILE, mode: '100644', type: 'blob', content: `${JSON.stringify(plan, null, indent)}\n` });
            }
          } catch { lastErr = 'content_plan.json unreadable'; }
        }
      }
      if (!entries.length) { committed = true; break; }
      const t = await ghx(token, budget, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: commit.data.tree.sha, tree: entries });
      if (!t.ok) { lastErr = refusal(t); break; }
      const nc = await ghx(token, budget, 'POST', `/repos/${owner}/${repo}/git/commits`, { message: DELETE_MESSAGE, tree: t.data.sha, parents: [headSha] });
      if (!nc.ok) { lastErr = refusal(nc); break; }
      const up = await ghx(token, budget, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(ref)}`, { sha: nc.data.sha, force: false });
      if (up.ok) {
        committed = true;
        results.push({ item: `${entries.length} file change${entries.length === 1 ? '' : 's'} in ${repo}`, ok: true, note: `commit ${String(nc.data.sha).slice(0, 7)} on ${ref}` });
      } else if (up.status === 422 && attempt === 0) {
        lastErr = 'branch moved — retrying';
      } else { lastErr = refusal(up); break; }
    }
    if (committed) { d.done.files[slug] = 'done'; if (!d.plan.files[slug]) d.plan.files[slug] = { paths: [], planEntries: 0, planShared: 0, demoGif: false }; }
    else {
      d.done.files[slug] = `failed: ${lastErr}`;
      results.push({ item: `Files in ${repo}`, ok: false, note: lastErr });
    }
  }
}

/** Step 4: runs that appeared after the plan (a dispatch queued before the cancel). */
async function resweep(env, settings, d, budget) {
  const ids = d.plan.jobs.map((j) => j.id);
  const known = new Set(d.plan.runs.map((r) => r.runId));
  let added = 0;
  for (const engine of ['gemini', 'verticals']) {
    const slug = engineRepo(settings, engine);
    if (!slug) continue;
    for (const r of await listRepoRuns(env.GITHUB_TOKEN, budget, slug, 1)) {
      if (!known.has(String(r.id)) && ids.some((id) => titleMatches(r.display_title, id))) {
        d.plan.runs.push({ runId: String(r.id), slug, engine, artifacts: 0 });
        known.add(String(r.id)); added++;
        if (d.done.files) delete d.done.files[slug]; // its result file must be checked again
      }
    }
  }
  return added;
}

const chunk = (arr, n = 90) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** D1 statements that remove every row of the lineage — exported for tests. */
export async function finalStatements(db, plan, { now = Date.now() } = {}) {
  const ids = plan.jobs.map((j) => j.id);
  const runIds = plan.runs.map((r) => r.runId);
  const st = [];
  const inList = (col, vals, sql) => chunk(vals).forEach((c) => st.push(db.prepare(sql.replace('$IN', `${col} IN (${c.map(() => '?').join(',')})`)).bind(...c)));
  if (runIds.length) {
    inList('gh_run_id', runIds, 'DELETE FROM job_steps WHERE $IN');
    inList('gh_run_id', runIds, 'DELETE FROM gh_jobs WHERE $IN');
    inList('run_id', runIds, 'DELETE FROM runs WHERE $IN');
    inList('name', runIds.map((r) => `progress:${r}`), 'DELETE FROM locks WHERE $IN');
  }
  inList('job_id', ids, 'DELETE FROM runs WHERE $IN');
  for (const id of ids) {
    // webhook-discovered rows ("Discovered from GitHub webhook: <job_id> (draft)")
    st.push(db.prepare('DELETE FROM runs WHERE instr(COALESCE(logs, \'\'), ?) > 0').bind(`${id} (`));
  }
  // Uploads: unpublished → gone. Published → keep ONLY youtube_id + topic hash
  // + time as the re-upload / duplicate-topic guard (no job id, no title).
  const keep = plan.jobs.filter((j) => j.onYouTube).map((j) => j.id);
  const drop = ids.filter((id) => !keep.includes(id));
  if (drop.length) inList('job_id', drop, 'DELETE FROM uploads WHERE $IN');
  if (keep.length) inList('job_id', keep, 'UPDATE uploads SET job_id = NULL, idempotency_key = NULL WHERE $IN');
  // Activity feed: stamped rows by job_id; legacy rows by exact title prefix
  // within the job's lifetime, only when no surviving video shares the title.
  inList('job_id', ids, 'DELETE FROM activity WHERE $IN');
  const jobs = (await Promise.all(ids.map((id) => getJob(db, id)))).filter(Boolean);
  const { mine } = jobs.length ? await exclusiveTitles(db, jobs) : { mine: new Set() };
  for (const j of jobs) {
    if (!j.title || !mine.has(norm(j.title))) continue;
    st.push(db.prepare(`DELETE FROM activity WHERE job_id IS NULL AND ts >= ?2 AND (sub = ?1
      OR substr(sub, 1, length(?1) + 3) = ?1 || ' · ' OR substr(sub, 1, length(?1) + 3) = ?1 || ' — ')`)
      .bind(j.title, j.createdAt || '1970'));
  }
  // Other jobs that cite one of these as their duplicate (stores title + id).
  for (const id of ids) st.push(db.prepare('UPDATE jobs SET duplicate_of = NULL WHERE instr(COALESCE(duplicate_of, \'\'), ?) > 0').bind(`"${id}"`));
  // Linked versions the owner did NOT tick stay: detach them from the deleted job.
  inList('parent_job_id', ids, 'UPDATE jobs SET parent_job_id = NULL WHERE $IN');
  // Cached quota panel holds the last upload's title — drop it (recomputed).
  st.push(db.prepare("DELETE FROM quota_cache WHERE key <> 'lock'"));
  // Today's upload cap counts uploads, not existing videos: keep the slot used.
  const today = plan.jobs.filter((j) => j.publishedToday).length;
  if (today) {
    st.push(db.prepare(`INSERT INTO cap_ledger (day, deleted_published) VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET deleted_published = deleted_published + excluded.deleted_published`)
      .bind(utcDayStartIso(now).slice(0, 10), today));
  }
  inList('id', ids, 'DELETE FROM jobs WHERE $IN');
  inList('job_id', ids, 'DELETE FROM deletions WHERE $IN');
  return st;
}

/**
 * One pass of a deletion. Returns
 *   {state:'done'} | {state:'continue'|'waiting', retryAfterMs} | {state:'partial', remaining, errors}
 *   | {state:'busy'} (another tab holds the lease) | {state:'refused', error}
 */
export async function runDeletion(db, env, settings, jobId, { owner = Math.random().toString(36).slice(2), now = Date.now(), include = [] } = {}) {
  const budget = new GhBudget();
  const results = [];
  let d = await loadDeletion(db, jobId);
  if (!d) {
    const job = await getJob(db, jobId);
    if (!job) return { state: 'done', alreadyGone: true, results };
    if (!env.GITHUB_TOKEN) {
      return { state: 'refused', code: 'github', error: 'The GitHub connection is missing, so its runs and files could not be removed. Nothing was deleted.' };
    }
    if (job.status === 'uploading') {
      return { state: 'refused', code: 'uploading', error: 'This video is uploading to YouTube right now. Delete it after the upload finishes.' };
    }
    // A job inside another deletion's lineage joins that deletion.
    const { results: others } = await db.prepare('SELECT job_id, plan FROM deletions').all();
    for (const o of others || []) {
      try { if ((JSON.parse(o.plan).jobs || []).some((j) => j.id === jobId)) return runDeletion(db, env, settings, o.job_id, { owner, now }); } catch { /* ignore */ }
    }
    let plan;
    try { plan = await buildPlan(db, env, settings, jobId, budget, { include }); } catch (e) {
      if (e.pause) return { state: 'continue', retryAfterMs: e.retryAfterMs || 2000, results, note: 'GitHub busy — trying again' };
      throw e;
    }
    if (plan.jobs.some((j) => j.status === 'uploading')) {
      return { state: 'refused', code: 'uploading', error: 'A later attempt of this video is uploading right now. Delete it after the upload finishes.' };
    }
    // Atomic create: the PRIMARY KEY makes a second tab lose the race.
    const ins = await db.prepare(`INSERT OR IGNORE INTO deletions (job_id, state, plan, done, lease_owner, lease_exp, created_at, updated_at)
      VALUES (?, 'active', ?, '{}', ?, ?, ?, ?)`).bind(jobId, JSON.stringify(plan), owner, now + LEASE_MS, now, now).run();
    d = await loadDeletion(db, jobId);
    if (!ins?.meta?.changes && d.lease_owner !== owner) return { state: 'busy', remaining: remainingOf(d) };
  } else {
    const got = await db.prepare('UPDATE deletions SET lease_owner = ?, lease_exp = ? WHERE job_id = ? AND (lease_exp IS NULL OR lease_exp < ? OR lease_owner = ?)')
      .bind(owner, now + LEASE_MS, jobId, now, owner).run();
    if (!got?.meta?.changes) return { state: 'busy', remaining: remainingOf(d) };
    // Retry: clear earlier failures so they are attempted again.
    for (const m of [d.done.runs || {}, d.done.files || {}]) for (const k of Object.keys(m)) if (String(m[k]).startsWith('failed')) delete m[k];
  }

  const release = () => db.prepare('UPDATE deletions SET lease_exp = 0 WHERE job_id = ? AND lease_owner = ?').bind(jobId, owner).run();
  try {
    if (env.GITHUB_TOKEN) {
      const r = await deleteRuns(env, d, budget, results);
      if (r === 'waiting') {
        d = await saveDeletion(db, d, { state: 'active' });
        await release();
        return { state: 'waiting', retryAfterMs: 4000, results, remaining: remainingOf(d) };
      }
      await deleteFiles(db, env, settings, d, budget, results);
      const failed = [
        ...Object.entries(d.done.runs || {}).filter(([, v]) => String(v).startsWith('failed')).map(([k, v]) => `GitHub run ${k}: ${String(v).slice(8)}`),
        ...Object.entries(d.done.files || {}).filter(([, v]) => String(v).startsWith('failed')).map(([k, v]) => `Files in ${k.split('/')[1]}: ${String(v).slice(8)}`),
      ];
      if (failed.length) {
        d = await saveDeletion(db, d, { state: 'partial', last_error: failed.join('; ').slice(0, 500) });
        await release();
        return { state: 'partial', results, errors: failed, remaining: remainingOf(d) };
      }
      const added = await resweep(env, settings, d, budget);
      if (added) {
        d = await saveDeletion(db, d, { state: 'active' });
        await release();
        return { state: 'continue', retryAfterMs: 500, results, remaining: remainingOf(d) };
      }
    }
    // Stored files in Cloudflare R2 (drafts/ + published/) of every deleted job.
    if (hasR2(env) && d.done?.r2 !== 'done') {
      try {
        const n = await deleteJobObjects(env, d.plan.jobs.map((j) => j.id));
        d.done.r2 = 'done';
        if (n) results.push({ item: `${n} stored video file${n === 1 ? '' : 's'}`, ok: true, note: 'removed' });
      } catch (e) {
        d = await saveDeletion(db, d, { state: 'partial', last_error: `Video storage: ${String(e.message || e).slice(0, 200)}` });
        await release();
        return { state: 'partial', results, errors: [`Video storage: ${String(e.message || e).slice(0, 120)}`], remaining: remainingOf(d) };
      }
    }
    const statements = await finalStatements(db, d.plan, { now });
    await db.batch(statements);
    results.push({ item: 'Dashboard records', ok: true, note: 'removed' });
    return { state: 'done', results, youtubeStays: d.plan.counts?.youtubeStays || 0 };
  } catch (e) {
    if (e.pause) {
      d = await saveDeletion(db, d, { state: 'active' });
      await release();
      return { state: 'continue', retryAfterMs: e.retryAfterMs || 500, results, remaining: remainingOf(d),
        note: e.message === 'budget' ? 'more to do' : e.message === 'rate-limit' ? 'GitHub asked us to slow down' : 'GitHub busy' };
    }
    try { d = await saveDeletion(db, d, { state: 'partial', last_error: String(e.message || e).slice(0, 300) }); await release(); } catch { /* ignore */ }
    return { state: 'partial', results, errors: [String(e.message || e)], remaining: d ? remainingOf(d) : null };
  }
}

/** Pending deletions keyed by job id, for list/detail payloads. */
export async function pendingDeletions(db) {
  try {
    const { results } = await db.prepare('SELECT job_id, state, plan, done, last_error, lease_exp FROM deletions').all();
    const map = new Map();
    for (const r of results || []) {
      let plan = null, done = {};
      try { plan = JSON.parse(r.plan); done = JSON.parse(r.done || '{}'); } catch { /* ignore */ }
      const info = { state: r.state, error: r.last_error || null, running: Number(r.lease_exp || 0) > Date.now(),
        remaining: remainingOf({ plan, done }), rootId: r.job_id };
      for (const j of plan?.jobs || [{ id: r.job_id }]) map.set(j.id, info);
    }
    return map;
  } catch { return new Map(); }
}
