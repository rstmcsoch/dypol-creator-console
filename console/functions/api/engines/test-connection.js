import { json, readBody } from '../_lib/util.js';
import { getSettings } from '../_lib/db.js';
import { testConnection, splitRepo, getRepo, getWorkflow } from '../_lib/github.js';

/**
 * POST /api/engines/test-connection { target: 'github'|'dedupe'|'gemini'|'youtube' }
 * Real readiness checks — a badge must be earned, never assumed.
 */
export async function onRequestPost(context) {
  const body = await readBody(context.request);
  const db = context.env.DB;
  const env = context.env;

  if (body.target === 'github') {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      return json(null, 200, { ok: false, message: 'GITHUB_TOKEN is not configured as a server secret.' });
    }
    const settings = await getSettings(db);
    const base = await testConnection(token);
    if (!base.ok) return json(null, 200, { ok: false, message: base.message });

    const lines = [base.message];
    let allOk = true;
    for (const id of ['gemini', 'verticals']) {
      if (settings.engines?.[id]?.enabled === false) {
        lines.push(`${id}: disabled; skipped.`);
        continue;
      }
      const slug = settings.github[id]?.repo;
      const wf = settings.github[id]?.workflow;
      if (!slug || !wf) { lines.push(`${id}: repository/workflow not configured.`); allOk = false; continue; }
      try {
        await getRepo(token, splitRepo(slug));
        try {
          await getWorkflow(token, { ...splitRepo(slug), workflowFile: wf });
          lines.push(`${id}: ${slug} ✓ workflow ${wf} ✓`);
        } catch (e) {
          lines.push(`${id}: ${slug} reachable but workflow ${wf} NOT FOUND (${e.message}).`);
          allOk = false;
        }
      } catch (e) {
        lines.push(`${id}: ${slug} not reachable (${e.message}).`);
        allOk = false;
      }
    }
    return json(null, 200, { ok: allOk, message: lines.join(' · ') });
  }

  if (body.target === 'dedupe') {
    const { normalizeTopic, topicKey } = await import('../_lib/util.js');
    const sample = 'The Science of Black Holes in 60 Seconds';
    const key = await topicKey(sample);
    const norm = normalizeTopic(sample);
    const { listJobs } = await import('../_lib/db.js');
    const dup = (await listJobs(db, {})).some((j) => j.title.toLowerCase().includes('black hole'));
    return json(null, 200, {
      ok: true,
      message: `Normalisation self test: "${sample}" → "${norm}" (key ${key}). Containment matching ${dup ? 'detects' : 'does not currently detect'} a seeded match.`,
    });
  }

  if (body.target === 'gemini') {
    // Provider readiness WITHOUT exposing the key: list models server-side.
    if (!env.GEMINI_API_KEY) {
      return json(null, 200, { ok: false, message: 'GEMINI_API_KEY is not configured (server secret). Engines use their own GitHub Actions secret for production.' });
    }
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
      });
      if (res.status === 401 || res.status === 403) {
        return json(null, 200, { ok: false, message: 'Gemini rejected the API key (auth failure). Keys are not interchangeable with Vertex credentials.' });
      }
      if (!res.ok) {
        return json(null, 200, { ok: false, message: `Gemini API responded ${res.status}.` });
      }
      const data = await res.json();
      const names = (data.models || []).map((m) => m.name).filter((n) => /image|nano-banana|flash/i.test(n)).slice(0, 4);
      return json(null, 200, {
        ok: true,
        message: `Gemini API reachable. Key accepted. Example available models: ${names.join(', ') || 'see models list'} (model availability is per-key and changes over time).`,
      });
    } catch (err) {
      return json(null, 200, { ok: false, message: `Gemini API unreachable: ${err.message}` });
    }
  }

  if (body.target === 'youtube') {
    // Distinguish credential presence from tested authorisation.
    const hasClient = !!env.YOUTUBE_CLIENT_SECRET_B64;
    const hasToken = !!env.YOUTUBE_TOKEN_B64;
    if (!hasClient || !hasToken) {
      return json(null, 200, {
        ok: false,
        state: 'missing-credentials',
        message: `YouTube OAuth: ${!hasClient ? 'client secret missing' : 'token missing'} — complete the OAuth setup in docs/SECRETS.md.`,
      });
    }
    // Token presence is NOT proof of validity — say exactly that.
    return json(null, 200, {
      ok: true,
      state: 'configured-untested',
      message: 'YouTube OAuth credentials are configured. Validity is tested at the next upload attempt (a configured credential is not proof of authorisation).',
    });
  }

  return json(null, 400, { error: 'Unknown target.', code: 'validation' });
}
