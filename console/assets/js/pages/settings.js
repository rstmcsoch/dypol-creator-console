/* Settings — engines, orchestration, scheduling, publishing, security, health.
   AUDIT: every visible control is persisted AND enforced by the backend
   (engine enable gates dispatch, concurrency/retry limits gate runs, draft
   mode gates publishing). Connection badges reflect tested state, never
   mere credential presence. */
import { api } from '../api.js';
import { icon, esc, toast, statusPill } from '../ui.js';

const MODES = [
  { id: 'primary_with_fallback', name: 'Mode 1 — Primary with fallback', desc: 'Run Engine A first. Engine B runs only when the primary attempt genuinely fails and fallback is appropriate.' },
  { id: 'alternate', name: 'Mode 2 — Alternate engines', desc: 'Production runs alternate between the two engines on a configurable schedule (odd/even days or run index).' },
  { id: 'draft_both', name: 'Mode 3 — Both engines, draft mode', desc: 'Both engines produce a candidate video for comparison. Nothing publishes until you pick a winner — neither engine can auto-publish a duplicate.' },
];

async function refresh() {
  const root = document.getElementById('page-root');
  const s = await api.settings();
  const h = s.health || {};
  const yt = s.youtube || { state: 'missing-credentials' };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Settings</h1>
        <div class="sub">Engine connections, orchestration policy, publishing safeguards and system health.</div>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--primary" id="btn-save">${icon('check', 'icon--sm')} Save settings</button>
      </div>
    </div>

    <div class="callout" style="margin-bottom:20px">${icon('lock')}<div><strong>Credential safety.</strong> API credentials are stored only in server-side secrets (Cloudflare Pages secrets / GitHub Actions Secrets). They are never returned to the browser, never written to local storage, and never shown here — this page reports only “configured / not configured”.</div></div>

    <div class="rail-grid">
      <div class="stack">

        <!-- Engines -->
        <div class="card">
          <div class="card__head">${icon('zap')}<h2>Engines</h2></div>
          <div class="card__body">
            <div class="switch-row">
              <div class="switch-row__text"><strong>Engine A — Gemini YouTube Automation: enabled</strong>
                <span>Controls whether this engine receives new scheduled or manual jobs. Jobs already running are unaffected.</span></div>
              <button class="switch ${(s.engines?.gemini?.enabled ?? true) ? 'is-on' : ''}" id="s-eng-gemini" aria-label="Toggle Engine A"></button>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><strong>Engine B — Verticals v3: enabled</strong>
                <span>Same semantics as Engine A. Fallback dispatch also respects this switch.</span></div>
              <button class="switch ${(s.engines?.verticals?.enabled ?? false) ? 'is-on' : ''}" id="s-eng-verticals" aria-label="Toggle Engine B"></button>
            </div>
            <div class="grid grid--2" style="gap:14px;margin-top:14px">
              <div class="field"><label class="field__label">Default engine (new topics)</label>
                <select class="select" id="s-default-engine">
                  <option value="gemini" ${s.defaults?.engine === 'gemini' ? 'selected' : ''}>Engine A — Gemini Automation</option>
                  <option value="verticals" ${s.defaults?.engine === 'verticals' ? 'selected' : ''}>Engine B — Verticals v3</option>
                </select></div>
              <div class="field"><label class="field__label">Default niche</label>
                <select class="select" id="s-default-niche">
                  ${['general', 'tech', 'science', 'education', 'finance', 'gaming', 'motivation'].map((n) => `<option ${s.defaults?.niche === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select></div>
            </div>
          </div>
        </div>

        <!-- GitHub -->
        <div class="card">
          <div class="card__head">${icon('github')}<h2>GitHub repositories &amp; workflows</h2>
            <div class="right"><button class="btn btn--secondary btn--sm" id="btn-test-gh">${icon('refresh', 'icon--sm')} Test connection</button></div>
          </div>
          <div class="card__body stack" style="gap:14px">
            <div class="grid grid--2" style="gap:14px">
              <div class="field"><label class="field__label">Engine A repository</label>
                <input class="input mono" id="s-repo-a" value="${esc(s.github?.gemini?.repo || '')}" placeholder="owner/repo">
                <div class="field__hint">Gemini YouTube Automation fork under your account.</div></div>
              <div class="field"><label class="field__label">Engine A workflow file</label>
                <input class="input mono" id="s-wf-a" value="${esc(s.github?.gemini?.workflow || '')}" placeholder="main.yml"></div>
              <div class="field"><label class="field__label">Engine B repository</label>
                <input class="input mono" id="s-repo-b" value="${esc(s.github?.verticals?.repo || '')}" placeholder="owner/repo">
                <div class="field__hint">Verticals v3 fork (with the fixed image-generation module).</div></div>
              <div class="field"><label class="field__label">Engine B workflow file</label>
                <input class="input mono" id="s-wf-b" value="${esc(s.github?.verticals?.workflow || '')}" placeholder="verticals.yml"></div>
              <div class="field"><label class="field__label">Branch</label>
                <input class="input mono" id="s-branch" value="${esc(s.github?.branch || 'dypol-integration')}" placeholder="dypol-integration"></div>
              <div class="field"><label class="field__label">GitHub token (server secret)</label>
                <input class="input" value="${s.github?.tokenConfigured ? '••••••••  (configured)' : 'Not configured'}" disabled>
                <div class="field__hint">Set as the <span class="mono">GITHUB_TOKEN</span> secret on Cloudflare Pages. Fine-grained PAT: Actions r/w + Contents r/w (control file) on the two forks.</div></div>
            </div>
          </div>
        </div>

        <!-- Orchestration -->
        <div class="card">
          <div class="card__head">${icon('zap')}<h2>Dual-engine orchestration</h2></div>
          <div class="card__body stack" style="gap:12px">
            ${MODES.map((m) => `
              <label class="card card--pad row" style="cursor:pointer;gap:12px;align-items:flex-start;${s.orchestration?.mode === m.id ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
                <input type="radio" name="orch-mode" value="${m.id}" ${s.orchestration?.mode === m.id ? 'checked' : ''} style="margin-top:3px;accent-color:var(--accent)">
                <div><strong class="small">${esc(m.name)}</strong>
                  <div class="tiny muted" style="margin-top:3px;line-height:1.6">${esc(m.desc)}</div></div>
              </label>`).join('')}
            <div class="grid grid--2" style="gap:14px">
              <div class="field"><label class="field__label">Fallback policy</label>
                <select class="select" id="s-fallback">
                  <option value="on_failure" ${s.orchestration?.fallback === 'on_failure' ? 'selected' : ''}>Fallback only on genuine failure</option>
                  <option value="never" ${s.orchestration?.fallback === 'never' ? 'selected' : ''}>Never fall back</option>
                  <option value="on_failure_and_duplicate" ${s.orchestration?.fallback === 'on_failure_and_duplicate' ? 'selected' : ''}>Fallback on failure or blocked duplicate</option>
                </select></div>
              <div class="field"><label class="field__label">Alternate schedule (Mode 2)</label>
                <select class="select" id="s-alt">
                  <option value="days" ${s.orchestration?.alternate === 'days' ? 'selected' : ''}>Alternate by day (odd/even)</option>
                  <option value="run" ${s.orchestration?.alternate === 'run' ? 'selected' : ''}>Alternate by run index</option>
                  <option value="manual" ${s.orchestration?.alternate === 'manual' ? 'selected' : ''}>Manual assignment only</option>
                </select></div>
              <div class="field"><label class="field__label">Maximum concurrency</label>
                <input class="input" type="number" min="1" max="3" id="s-concurrency" value="${esc(String(s.orchestration?.maxConcurrency ?? 1))}">
                <div class="field__hint">Server-side limit on simultaneously active jobs (1–3). Excess dispatch requests are refused, not queued silently.</div></div>
              <div class="field"><label class="field__label">Retry count (failed runs)</label>
                <input class="input" type="number" min="0" max="5" id="s-retry" value="${esc(String(s.orchestration?.retryLimit ?? 2))}">
                <div class="field__hint">Bounded retries for retry-safe failures. Non-retryable errors (permissions, config) are never auto-retried.</div></div>
            </div>
          </div>
        </div>

        <!-- Publishing safeguards -->
        <div class="card">
          <div class="card__head">${icon('shield')}<h2>Publishing safeguards</h2></div>
          <div class="card__body">
            <div class="switch-row">
              <div class="switch-row__text"><strong>Review required before publishing</strong>
                <span>Videos must be approved in the Content Queue before upload. Recommended default.</span></div>
              <button class="switch ${s.publishing?.reviewRequired ? 'is-on' : ''}" id="s-review" aria-label="Toggle review required"></button>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><strong>Draft-only mode</strong>
                <span>Generate and save production results without uploading anything. Overrides all other publish paths.</span></div>
              <button class="switch ${s.publishing?.draftMode ? 'is-on' : ''}" id="s-draft" aria-label="Toggle draft only"></button>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><strong>Automatic publishing</strong>
                <span>Only takes effect after review-required has been tested end-to-end. Duplicate checks, caps and locks remain active.</span></div>
              <button class="switch ${s.publishing?.autoPublish ? 'is-on' : ''}" id="s-auto" aria-label="Toggle auto publish"></button>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><strong>Duplicate prevention (normalised topic matching)</strong>
                <span>Blocks publishing when the normalised topic matches an existing active or published video across both engines.</span></div>
              <button class="switch ${s.publishing?.dedupe ? 'is-on' : ''}" id="s-dedupe" aria-label="Toggle duplicate prevention"></button>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><strong>Strict publishing lock</strong>
                <span>Serialises publish attempts so concurrent jobs cannot bypass the duplicate check or daily cap.</span></div>
              <button class="switch ${s.publishing?.publishLock ? 'is-on' : ''}" id="s-lock" aria-label="Toggle publishing lock"></button>
            </div>
            <div class="grid grid--2" style="gap:14px;margin-top:14px">
              <div class="field"><label class="field__label">Default upload visibility</label>
                <select class="select" id="s-privacy">
                  <option value="private" ${s.publishing?.visibility === 'private' ? 'selected' : ''}>Private (recommended for tests)</option>
                  <option value="unlisted" ${s.publishing?.visibility === 'unlisted' ? 'selected' : ''}>Unlisted</option>
                  <option value="public" ${s.publishing?.visibility === 'public' ? 'selected' : ''}>Public</option>
                </select>
                <div class="field__hint">Verified in the workflow's upload step env (YOUTUBE_PRIVACY_STATUS), not just displayed here.</div></div>
              <div class="field"><label class="field__label">Daily publishing cap</label>
                <input class="input" type="number" min="1" max="10" id="s-cap" value="${esc(String(s.publishing?.dailyCap ?? 2))}">
                <div class="field__hint">Server-side hard limit on uploads per channel per day (IST), counting in-flight uploads.</div></div>
              <div class="field"><label class="field__label">Default video format</label>
                <select class="select" id="s-format">
                  <option value="per_engine" ${s.defaults?.format === 'per_engine' ? 'selected' : ''}>Per engine (16:9 + Shorts / 9:16)</option>
                  <option value="long-form" ${s.defaults?.format === 'long-form' ? 'selected' : ''}>Long-form 16:9</option>
                  <option value="short" ${s.defaults?.format === 'short' ? 'selected' : ''}>Short 9:16</option>
                </select></div>
              <div class="field"><label class="field__label">Default language</label>
                <select class="select" id="s-lang">
                  ${['en', 'hi', 'es', 'pt', 'de', 'fr', 'ja', 'ko'].map((l) => `<option value="${l}" ${s.defaults?.language === l ? 'selected' : ''}>${l}</option>`).join('')}
                </select></div>
            </div>
          </div>
        </div>

        <!-- Scheduling -->
        <div class="card">
          <div class="card__head">${icon('calendar')}<h2>Scheduling</h2></div>
          <div class="card__body grid grid--2" style="gap:14px">
            <div class="field"><label class="field__label">Timezone</label>
              <input class="input" id="s-tz" value="${esc(s.schedule?.timezone || 'Asia/Kolkata')}" disabled>
              <div class="field__hint">The console operates in Asia/Kolkata (IST). Schedule pauses write dypol-control.json to both forks so workflows honour them.</div></div>
            <div class="field"><label class="field__label">Frequency</label>
              <select class="select" id="s-freq">
                <option value="daily" ${s.schedule?.frequency === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="twice_daily" ${s.schedule?.frequency === 'twice_daily' ? 'selected' : ''}>Twice daily</option>
                <option value="weekdays" ${s.schedule?.frequency === 'weekdays' ? 'selected' : ''}>Weekdays only</option>
                <option value="manual" ${s.schedule?.frequency === 'manual' ? 'selected' : ''}>Manual only</option>
              </select>
              <div class="field__hint">Cadence metadata for the native GitHub cron. Changing the exact cron time requires editing the workflow file (documented) — GitHub schedules can fire late.</div></div>
            <div class="field"><label class="field__label">Publishing window start</label>
              <input class="input" type="time" id="s-wstart" value="${esc(s.schedule?.windowStart || '18:00')}"></div>
            <div class="field"><label class="field__label">Publishing window end</label>
              <input class="input" type="time" id="s-wend" value="${esc(s.schedule?.windowEnd || '21:00')}"></div>
          </div>
        </div>
      </div>

      <!-- Right rail: health -->
      <div class="stack rail">
        <div class="card">
          <div class="card__head">${icon('server')}<h2>System health</h2></div>
          <div class="card__body qc">
            ${[
              ['Backend mode', h.mode === 'demo' ? 'warn' : 'ok', h.mode === 'demo' ? 'Demo (local)' : 'Live'],
              ['Job registry (D1)', h.db === 'ok' ? 'ok' : 'off', h.db === 'ok' ? 'Connected' : 'Not connected'],
              ['GitHub token secret', h.githubToken ? 'ok' : 'off', h.githubToken ? 'Configured' : 'Missing'],
              ['Gemini API key secret', h.geminiKey ? 'ok' : 'off', h.geminiKey ? 'Configured' : 'Missing'],
              ['YouTube OAuth', h.youtubeOAuth ? 'warn' : 'off', h.youtubeOAuth ? 'Configured · untested' : 'Missing'],
              ['YouTube Analytics', h.youtubeAnalytics ? 'ok' : 'off', h.youtubeAnalytics ? 'Connected' : 'Not connected'],
              ['Publishing lock', s.publishing?.publishLock ? 'ok' : 'off', s.publishing?.publishLock ? 'Enabled (by setting)' : 'Disabled (by setting)'],
            ].map(([name, state, label]) => `
              <div class="qc__row ${state === 'ok' ? '' : state === 'warn' ? 'is-warn' : 'is-off'}">
                ${icon(state === 'ok' ? 'check' : state === 'warn' ? 'alert' : 'info', 'icon--sm')}
                <span>${esc(name)}</span><span class="spacer"></span>
                <span class="pill">${esc(label)}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('youtube')}<h2>YouTube channel</h2>
            <div class="right"><button class="btn btn--secondary btn--sm" id="btn-test-yt">${icon('refresh', 'icon--sm')} Test</button></div>
          </div>
          <div class="card__body stack" style="gap:10px">
            <div class="row">${statusPill(yt.state)}</div>
            ${yt.state === 'configured-untested' ? `
              <div class="callout callout--warn">${icon('alert')}<div><strong>Credentials configured, authorisation untested.</strong> A configured credential is not proof of validity — the console tests it at the next upload. Keep visibility on <span class="mono">private</span> for the first test.</div></div>`
            : `
              <div class="callout callout--warn">${icon('alert')}<div><strong>OAuth not configured.</strong> Manual setup required: see <span class="mono">docs/SECRETS.md</span> (Google Cloud Console → OAuth client → first token → Pages secrets).</div></div>`}
            <dl class="kv">
              <dt>Channel</dt><dd>${esc(h.channelName || '—')}</dd>
              <dt>Upload visibility</dt><dd>${esc(s.publishing?.visibility || 'private')}</dd>
              <dt>Quota note</dt><dd class="tiny muted">YouTube Data API default quota is 10,000 units/day (≈6 uploads).</dd>
            </dl>
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('sparkles')}<h2>Provider readiness</h2>
            <div class="right"><button class="btn btn--secondary btn--sm" id="btn-test-gemini">${icon('refresh', 'icon--sm')} Test</button></div>
          </div>
          <div class="card__body">
            <div class="tiny muted" style="line-height:1.7">Checks Gemini availability server-side without exposing the key. A valid key does not guarantee a specific model is available, free, or un-billed — model IDs retire often (see docs/FREE_TIER.md).</div>
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('pause')}<h2>Automation control</h2></div>
          <div class="card__body stack" style="gap:10px">
            <div class="switch-row" style="padding:6px 0">
              <div class="switch-row__text"><strong>Pause future scheduling</strong>
                <span>Prevents scheduled runs (via dypol-control.json on both forks). Preserves generated videos, records, credentials and configuration.</span></div>
              <button class="switch ${s.schedule?.automationPaused ? 'is-on' : ''}" id="s-pause" aria-label="Toggle automation pause"></button>
            </div>
            <button class="btn btn--secondary btn--block" id="btn-test-dedupe">${icon('copy', 'icon--sm')} Run duplicate-check self test</button>
          </div>
        </div>

        <div class="card">
          <div class="card__head">${icon('info')}<h2>About</h2></div>
          <div class="card__body">
            <dl class="kv">
              <dt>Product</dt><dd>DYPOL Creator Console</dd>
              <dt>Parent brand</dt><dd>DYPOL LABS</dd>
              <dt>Version</dt><dd>1.0.0</dd>
              <dt>Console mode</dt><dd>${esc(h.mode || 'unknown')}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console v1.0.0</span><span>·</span><span>Build · Automate · Create</span>
    </div>`;

  const toggle = (id) => {
    const el = root.querySelector(id);
    if (el) el.onclick = () => el.classList.toggle('is-on');
  };
  ['#s-review', '#s-auto', '#s-dedupe', '#s-lock', '#s-pause', '#s-draft', '#s-eng-gemini', '#s-eng-verticals'].forEach(toggle);

  root.querySelector('#btn-save').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const val = (id) => root.querySelector(id)?.value;
    const on = (id) => root.querySelector(id)?.classList.contains('is-on');
    const mode = root.querySelector('input[name="orch-mode"]:checked')?.value;
    try {
      const res = await api.saveSettings({
        github: {
          gemini: { repo: val('#s-repo-a'), workflow: val('#s-wf-a') },
          verticals: { repo: val('#s-repo-b'), workflow: val('#s-wf-b') },
          branch: val('#s-branch'),
        },
        engines: {
          gemini: { enabled: on('#s-eng-gemini') },
          verticals: { enabled: on('#s-eng-verticals') },
        },
        orchestration: {
          mode, fallback: val('#s-fallback'), alternate: val('#s-alt'),
          maxConcurrency: Number(val('#s-concurrency')), retryLimit: Number(val('#s-retry')),
        },
        publishing: {
          reviewRequired: on('#s-review'), autoPublish: on('#s-auto'),
          dedupe: on('#s-dedupe'), publishLock: on('#s-lock'), draftMode: on('#s-draft'),
          visibility: val('#s-privacy'), dailyCap: Number(val('#s-cap')),
        },
        defaults: {
          format: val('#s-format'), language: val('#s-lang'),
          niche: val('#s-default-niche'), engine: val('#s-default-engine'),
        },
        schedule: {
          frequency: val('#s-freq'), windowStart: val('#s-wstart'), windowEnd: val('#s-wend'),
          automationPaused: on('#s-pause'),
        },
      });
      toast('Settings saved', res.message || 'Configuration updated.', 'ok');
      await refresh();
    } catch (err) {
      btn.disabled = false;
      toast('Save failed', err.message, 'bad');
    }
  };

  const testTarget = async (target, label) => {
    try {
      const res = await api.testConnection(target);
      toast(label, res.message, res.ok ? 'ok' : 'warn');
    } catch (err) { toast(`${label} failed`, err.message, 'bad'); }
  };
  root.querySelector('#btn-test-gh').onclick = () => testTarget('github', 'GitHub connection');
  root.querySelector('#btn-test-yt').onclick = () => testTarget('youtube', 'YouTube connection');
  root.querySelector('#btn-test-gemini').onclick = () => testTarget('gemini', 'Gemini readiness');
  root.querySelector('#btn-test-dedupe').onclick = () => testTarget('dedupe', 'Duplicate-check self test');
}

export async function renderSettings() {
  await refresh();
}
