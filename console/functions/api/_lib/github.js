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

/** Dispatch a workflow. inputs: { [name]: string }. */
export async function dispatchWorkflow(token, { owner, repo, workflowFile, ref = 'dypol-integration', inputs = {} }) {
  await gh(token, `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
  return true;
}

/** List recent workflow runs (optionally filtered by workflow file or event). */
export async function listWorkflowRuns(token, { owner, repo, workflowFile, perPage = 20 } = {}) {
  const path = workflowFile
    ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`
    : `/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`;
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
  }));
}

export async function getWorkflowRun(token, { owner, repo, runId }) {
  const r = await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}`);
  return {
    runId: String(r.id),
    status: r.status,
    conclusion: r.conclusion,
    startedAt: r.created_at,
    updatedAt: r.updated_at,
    githubUrl: r.html_url,
    displayTitle: r.display_title,
  };
}

export async function listRunJobs(token, { owner, repo, runId }) {
  const data = await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=20`);
  return (data.jobs || []).map((j) => ({
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
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
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
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  try {
    const data = await gh(token, `/repos/${owner}/${repo}/contents/${path}${q}`);
    return Array.isArray(data) ? data.map((f) => ({ name: f.name, path: f.path })) : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
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
export async function updateRepoFile(token, { owner, repo, path, content, message }) {
  const b64 = btoa(unescape(encodeURIComponent(content)));
  let sha = null;
  try {
    const existing = await gh(token, `/repos/${owner}/${repo}/contents/${path}`);
    sha = existing.sha || null;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await gh(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || `DYPOL Creator Console: update ${path}`,
      content: b64,
      ...(sha ? { sha } : {}),
    }),
  });
  return true;
}
