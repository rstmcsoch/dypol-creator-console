/* DYPOL Creator Console — API client.
   All requests go to same-origin /api/* (Cloudflare Pages Functions in production,
   dev/server.js locally). Credentials travel in an HttpOnly session cookie —
   no tokens or secrets are ever stored in the browser. */

class ApiError extends Error {
  constructor(message, status, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the console backend. Check your connection.', 0, 'network');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const code = data?.code || 'error';
    const msg = data?.error || `Request failed (${res.status})`;
    if (res.status === 401 && !path.includes('/auth/login')) {
      window.dispatchEvent(new CustomEvent('dypol:unauthorized'));
    }
    throw new ApiError(msg, res.status, code);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  login: (password) => request('POST', '/api/auth/login', { password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  session: () => request('GET', '/api/session'),
  health: () => request('GET', '/api/health'),
  overview: () => request('GET', '/api/overview'),
  engines: () => request('GET', '/api/engines'),
  engineRun: (engine, payload) => request('POST', `/api/engines/${engine}/run`, payload || {}),
  engineCancel: (engine, payload) => request('POST', `/api/engines/${engine}/cancel`, payload || {}),
  jobs: (q = '') => request('GET', `/api/jobs${q}`),
  job: (id) => request('GET', `/api/jobs/${id}`),
  createJob: (payload) => request('POST', '/api/jobs', payload),
  jobAction: (id, action, payload) => request('POST', `/api/jobs/${id}/${action}`, payload || {}),
  jobRetry: (id) => request('POST', `/api/jobs/${id}/retry`, {}),
  runs: () => request('GET', '/api/runs'),
  run: (id) => request('GET', `/api/runs/${id}`),
  retryRun: (id) => request('POST', `/api/runs/${id}/retry`, {}),
  calendar: (month) => request('GET', `/api/calendar${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  schedule: (payload) => request('POST', '/api/schedule', payload),
  analytics: () => request('GET', '/api/analytics'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (payload) => request('PUT', '/api/settings', payload),
  syncGithub: () => request('POST', '/api/sync/github', {}),
  testConnection: (target) => request('POST', '/api/engines/test-connection', { target }),
};

export { ApiError };
