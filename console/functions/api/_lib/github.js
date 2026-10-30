/**
 * GitHub API client (server-side only).
 *
 * Token comes from the GITHUB_TOKEN Pages secret — never exposed to the client.
 * Minimum recommended credential: a fine-grained PAT scoped to ONE repository
 * (or the two engine forks) with:
 *   · Actions    — Read & write  (workflow_dispatch, cancel, re-run)
 *   · Contents   — Read          (workflow file lookup)
 *   · Metadata   — Read          (required by GitHub, read-only)
 * Never request org-wide or destructive permissions.
 */

const API = 'https://api.github.com';

/* ONE source of truth for which branch the console touches. Every contents
 * read/write, workflow dispatch and run listing goes through integrationRef(),
 * so a missing `ref` can never fall back to the repo's default branch (main). */
export const INTEGRATION_BRANCH = 'dypol-integration';
const FORBIDDEN_BRANCHES = new Set(['main', 'master', '']);
export function integrationRef(settingsOrRef) {
  const raw = typeof settingsOrRef === 'string' ? settingsOrRef
    : settingsOrRef?.github?.branch;
  const b = String(raw || '').trim();
  return !b || FORBIDDEN_BRANCHES.has(b.toLowerCase()) ? INTEGRATION_BRANCH : b;
}

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DYPOL-Creator-Console',
  };
}

async function gh(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub API ${res.status} for ${path}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Dispatch a workflow on the integration branch. inputs: { [name]: string }.
 * Asks GitHub for the run details (return_run_details, Feb 2026). Returns
 * { runId, htmlUrl } when GitHub returns them, or { runId: null } for an
 * empty 204 (older behaviour) — callers then rely on webhook/time linking.
 * If GitHub rejects the return_run_details parameter itself, the dispatch is
 * retried once without it.
 */
export async function dispatchWorkflow(token, { owner, repo, workflowFile, ref, inputs = {} }) {
  const path = `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
  const body = { ref: integrationRef(ref), inputs };
  let data;
  try {
    data = await gh(token, path, { method: 'POST', body: JSON.stringify({ ...body, return_run_details: true }) });
  } catch (err) {
    if (err.status === 422 && /return_run_details/i.test(err.message || '')) {
      await gh(token, path, { method: 'POST', body: JSON.stringify(body) });
      return { runId: null, htmlUrl: null };
    }
    throw err;
  }
  const runId = data?.workflow_run_id ?? data?.id ?? null;
  return { runId: runId ? String(runId) : null, htmlUrl: data?.html_url || null };
}

/** List recent workflow runs on the integration branch (optionally per workflow file). */
export async function listWorkflowRuns(token, { owner, repo, workflowFile, perPage = 20, branch } = {}) {
  const q = `per_page=${perPage}&branch=${encodeURIComponent(integrationRef(branch))}`;
  const path = workflowFile
    ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${q}`
    : `/repos/${owner}/${repo}/actions/runs?${q}`;
  const data = await gh(token, path);
  return (data.workflow_runs || []).map((r) => ({
    runId: String(r.id),
    number: r.run_number,
    name: r.name,
    event: r.event,
    status: r.status,           // queued | in_progress | completed
    conclusion: r.conclusion,   // success | failure | cancelled | ...
    startedAt: r.created_at,
    updatedAt: r.updated_at,
    githubUrl: r.html_url,
    actor: r.actor?.login,
    displayTitle: r.display_title,
    headBranch: r.head_branch,
  }));
}

export async function getWorkflowRun(token, { owner, repo, runId }) {
  const r = await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}`);
  return {
    runId: String(r.id),
    name: r.name,
    event: r.event,
    path: r.path,
    status: r.status,
    conclusion: r.conclusion,
    startedAt: r.created_at,
    runStartedAt: r.run_started_at,
    updatedAt: r.updated_at,
    githubUrl: r.html_url,
    displayTitle: r.display_title,
  };
}

export async function listRunJobs(token, { owner, repo, runId }) {
  const data = await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=20`);
  return (data.jobs || []).map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    steps: (j.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion })),
  }));
}

export async function listRunArtifacts(token, { owner, repo, runId }) {
  const data = await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
  return (data.artifacts || []).map((a) => ({
    id: a.id,
    name: a.name,
    sizeInBytes: a.size_in_bytes || 0,
    size: `${Math.round((a.size_in_bytes || 0) / 1e6)} MB`,
    expired: a.expired,
    downloadUrl: a.archive_download_url,
  }));
}

export async function cancelRun(token, { owner, repo, runId }) {
  await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' });
  return true;
}

export async function rerunFailedJobs(token, { owner, repo, runId }) {
  await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
  return true;
}

/**
 * Last `lines` lines of one Actions job's log (GET /actions/jobs/{id}/logs).
 * GitHub answers with a 302 to a short-lived storage URL; the redirect is
 * followed WITHOUT the Authorization header. Timestamps/ANSI codes stripped.
 * Returns '' when the log is unavailable (expired, no permission).
 */
export async function fetchJobLogTail(token, { owner, repo, jobId, lines = 40 }) {
  if (!jobId) return '';
  try {
    let res = await fetch(`${API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: headers(token), redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location') || res.headers.get('location');
      if (!loc) return '';
      res = await fetch(loc, { headers: { 'User-Agent': 'DYPOL-Creator-Console' } });
    }
    if (!res.ok) return '';
    return tailLog(await res.text(), lines);
  } catch { return ''; }
}

/** Keep the last N meaningful log lines (strip timestamps, ANSI, group markers). */
export function tailLog(text, lines = 40) {
  const out = String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^##\[(group|endgroup)\].*$/, ''))
    .filter((l) => l.trim());
  return out.slice(-lines).join('\n').slice(-6000);
}

/**
 * Token health for the System health card: validity plus the
 * github-authentication-token-expiration response header (fine-grained PATs).
 */
export async function checkToken(token) {
  if (!token) return { ok: false, status: 0, message: 'Not configured' };
  try {
    const res = await fetch(`${API}/user`, { headers: headers(token) });
    const exp = res.headers.get('github-authentication-token-expiration');
    let login = null;
    try { login = (await res.json())?.login || null; } catch { /* ignore */ }
    const expiresAt = exp ? new Date(exp.replace(' UTC', 'Z').replace(' ', 'T')).toISOString() : null;
    return {
      ok: res.ok, status: res.status, login,
      expiresAt: expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? expiresAt : (exp || null),
      message: res.ok ? 'Valid' : `GitHub rejected the token (HTTP ${res.status})`,
    };
  } catch (err) {
    return { ok: false, status: 0, message: `GitHub unreachable: ${err.message}` };
  }
}

/* ---------------- Workflow inputs (strip undeclared before dispatch) ------- */

/** Inputs declared by the engine workflows on dypol-integration (verified
 *  30 Oct 2026). Used when the workflow file cannot be read live. */
export const STATIC_WORKFLOW_INPUTS = {
  'main.yml': ['phase', 'topic', 'language', 'privacy', 'job_id', 'draft_run_id', 'review_required',
    'auto_publish', 'title_override', 'description_override'],
  'verticals.yml': ['phase', 'topic', 'context', 'niche', 'language', 'privacy', 'job_id', 'draft_run_id',
    'title_override', 'description_override', 'tags_override', 'review_required', 'auto_publish'],
};

/** Parse `on.workflow_dispatch.inputs` keys out of workflow YAML (no YAML lib). */
export function parseDispatchInputs(yaml) {
  const lines = String(yaml || '').split(/\r?\n/);
  let i = lines.findIndex((l) => /^\s*workflow_dispatch\s*:/.test(l));
  if (i < 0) return null;
  const wdIndent = lines[i].match(/^\s*/)[0].length;
  let inputsIndent = -1;
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= wdIndent) return [];
    if (/^\s*inputs\s*:/.test(l)) { inputsIndent = ind; break; }
  }
  if (inputsIndent < 0) return [];
  const keys = [];
  let keyIndent = -1;
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= inputsIndent) break;
    if (keyIndent < 0) keyIndent = ind;
    if (ind === keyIndent) {
      const m = l.match(/^\s*['"]?([A-Za-z0-9_-]+)['"]?\s*:/);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

const inputsCache = new Map(); // `${owner}/${repo}/${file}` -> { at, keys }
export function _resetInputsCache() { inputsCache.clear(); }

/** Declared dispatch inputs of a workflow (live read on dypol-integration,
 *  cached 10 min; falls back to STATIC_WORKFLOW_INPUTS). */
export async function getWorkflowInputs(token, { owner, repo, workflowFile, ref }) {
  const file = String(workflowFile || '').split('/').pop();
  const key = `${owner}/${repo}/${file}`;
  const hit = inputsCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.keys;
  let keys = null;
  try {
    const yaml = await fetchRepoFile(token, { owner, repo, path: `.github/workflows/${file}`, ref });
    keys = yaml ? parseDispatchInputs(yaml) : null;
  } catch { keys = null; }
  if (!keys || !keys.length) keys = STATIC_WORKFLOW_INPUTS[file] || null;
  if (keys) inputsCache.set(key, { at: Date.now(), keys });
  return keys;
}

/** Drop inputs the workflow does not declare (GitHub 422s on unexpected inputs). */
export function filterInputs(inputs, declared) {
  if (!declared) return { inputs: { ...inputs }, stripped: [] };
  const allowed = new Set(declared);
  const out = {}, stripped = [];
  for (const [k, v] of Object.entries(inputs || {})) {
    if (v === undefined || v === null) continue;
    if (allowed.has(k)) out[k] = String(v); else stripped.push(k);
  }
  return { inputs: out, stripped };
}

/** Verify connectivity + reveal token scope status. */
export async function testConnection(token) {
  const res = await fetch(`${API}/user`, { headers: headers(token) });
  if (!res.ok) {
    return { ok: false, message: `GitHub rejected the token (HTTP ${res.status}). Check the GITHUB_TOKEN secret.` };
  }
  return { ok: true, message: 'GitHub token accepted.' };
}

export function splitRepo(slug) {
  const [owner, repo] = String(slug || '').split('/');
  return { owner, repo };
}

/* ---------------- Repo-level checks (audit: real readiness, not badges) ---- */

/** Verify the repository is reachable with this token. */
export async function getRepo(token, { owner, repo }) {
  return gh(token, `/repos/${owner}/${repo}`);
}

/** Verify a workflow file actually exists on the default branch. */
export async function getWorkflow(token, { owner, repo, workflowFile }) {
  return gh(token, `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}`);
}

/**
 * Read a small UTF-8 file from the repo (contents API). Returns null if missing.
 * Used for: dypol-control.json (schedule gating) and dypol-results/*.json
 * (verified upload results written by the engine workflows).
 */
export async function fetchRepoFile(token, { owner, repo, path, ref }) {
  const q = `?ref=${encodeURIComponent(integrationRef(ref))}`;
  try {
    const data = await gh(token, `/repos/${owner}/${repo}/contents/${path}${q}`);
    if (!data || data.type !== 'file' || !data.content) return null;
    const b64 = String(data.content).replace(/\n/g, '');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bin);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** List files under a directory (contents API). Returns [{name, path}] or []. */
export async function listRepoDir(token, { owner, repo, path, ref }) {
  const q = `?ref=${encodeURIComponent(integrationRef(ref))}`;
  try {
    const data = await gh(token, `/repos/${owner}/${repo}/contents/${path}${q}`);
    return Array.isArray(data) ? data.map((f) => ({ name: f.name, path: f.path })) : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Read the engine's verified upload result for ONE run by exact path:
 * dypol-results/<runId>.json on the integration branch. Returns the parsed
 * object or null (missing / malformed). Never lists the directory.
 */
export async function fetchRunResult(token, { owner, repo, runId, ref }) {
  if (!runId || !/^\d+$/.test(String(runId))) return null;
  const raw = await fetchRepoFile(token, { owner, repo, path: `dypol-results/${runId}.json`, ref });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Download a workflow-run artifact (zip bytes). Used to recover upload
 *  results when the git push of dypol-results/ failed after a real upload. */
export async function downloadArtifact(token, { owner, repo, artifactId }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    headers: headers(token), redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`Failed to download artifact ${artifactId}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Create-or-update a small UTF-8 file in the repo (contents API).
 * Used to write dypol-control.json so the workflows' schedule gate reflects
 * dashboard settings. Requires Contents: read & write on the PAT.
 */
export async function updateRepoFile(token, { owner, repo, path, content, message, branch }) {
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const ref = integrationRef(branch);
  let sha = null;
  try {
    const existing = await gh(token, `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    sha = existing.sha || null;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await gh(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || `DYPOL Creator Console: update ${path}`,
      content: b64,
      branch: ref,
      ...(sha ? { sha } : {}),
    }),
  });
  return true;
}
