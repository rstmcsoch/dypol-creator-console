/* Settings — everyday settings first; every advanced control (makers, plan,
   publishing rules, schedule, cloud connection, system status) kept in
   collapsed groups with the same element ids and the same save payload.
   AUDIT: every visible control is persisted AND enforced by the backend
   (engine enable gates dispatch, concurrency/retry limits gate runs, draft
   mode gates publishing). Connection badges reflect tested state, never
   mere credential presence. */
import { api } from '../api.js';
import { quotaPanelShell, mountQuotaPanel } from '../quota-panel.js';
import { icon, esc, toast, statusPill, errorToast, UI_PREFS } from '../ui.js';

const MODES = [
  { id: 'primary_with_fallback', name: 'Main maker first, backup if it breaks', desc: '“Long video + Short” runs first. Only if it really fails does “Short only” try instead. (Mode 1)' },
  { id: 'alternate', name: 'Take turns', desc: 'The two makers take turns, by day or by run. (Mode 2)' },
  { id: 'draft_both', name: 'Make both, I pick the better one', desc: 'Both makers make a version. Nothing goes up until you choose — never both. (Mode 3)' },
];
const NICHES = [['general', 'General'], ['tech', 'Tech'], ['science', 'Science'], ['education', 'Education'], ['finance', 'Money & finance'], ['gaming', 'Gaming'], ['motivation', 'Motivation']];
const LANGS = [['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['de', 'German'], ['fr', 'French'], ['ja', 'Japanese'], ['ko', 'Korean']];

const sw = (id, on, title, help, label) => `
  <div class="switch-row">
    <div class="switch-row__text"><strong>${title}</strong><span>${help}</span></div>
    <button type="button" class="switch ${on ? 'is-on' : ''}" id="${id}" role="switch" aria-checked="${!!on}" aria-label="${esc(label || title)}"></button>
  </div>`;
const group = (id, ic, title, sub, inner, open = false) => `
  <details class="card adv" id="${id}" ${open ? 'open' : ''}>
    <summary>${icon(ic, 'icon--sm')} ${title} <span class="muted small">${sub}</span></summary>
    <div class="adv__body">${inner}</div>
  </details>`;

async function refresh() {
  const root = document.getElementById('page-root');
  const s = await api.settings();
  const h = s.health || {};
  const yt = s.youtube || { state: 'missing-credentials' };
  const P = s.publishing || {};
  const vis = P.visibility || 'private';
  const VIS = { private: 'Private', unlisted: 'Unlisted', public: 'Public' };
  const openWhich = new URLSearchParams(location.hash.split('?')[1] || '').get('open');
  const rule = (ok, text) => `<li class="${ok ? '' : 'is-off'}">${icon(ok ? 'check' : 'alert', 'icon--sm')}<span>${text}</span></li>`;

  root.innerHTML = `
    <div class="page-head page-head--simple">
      <div><h1>Settings</h1>
        <div class="sub">Everyday settings first. Advanced settings are further down and most people never need them.</div></div>
    </div>

    <section class="card card--pad safety">
      <div class="safety__title">${icon('shield', 'icon--sm')} Safety rules</div>
      <ul class="safety__list">
        ${rule(P.reviewRequired, P.reviewRequired ? 'You check every video before it goes on YouTube' : 'Your check before publishing is OFF')}
        ${rule(!P.autoPublish, !P.autoPublish ? 'Nothing is published without your tap' : 'Publishing without you is ON')}
        ${rule(vis !== 'public', `Videos go up as <strong>${esc(VIS[vis] || vis)}</strong>${vis === 'unlisted' ? ' — only people with the link can see them' : ''}`)}
        ${rule(true, `At most <strong>${esc(String(P.dailyCap ?? 2))}</strong> uploads a day`)}
        ${rule(P.dedupe, P.dedupe ? 'Repeat topics are blocked' : 'Repeat-topic blocking is OFF')}
        ${rule(P.publishLock, P.publishLock ? 'Only one upload at a time' : 'One-upload-at-a-time is OFF')}
      </ul>
      <div class="field__hint">Change these under Advanced → Publishing rules.</div>
    </section>

    <section class="card">
      <div class="card__head">${icon('sparkles')}<h2>Everyday settings</h2></div>
      <div class="card__body stack">
        ${sw('s-pause', s.schedule?.automationPaused, 'Pause automatic videos', 'When on, no video starts by itself. You can still tap Make. Nothing is deleted.')}
        <div class="field"><label class="field__label" for="s-default-engine">Default kind of video</label>
          <select class="select select--lg" id="s-default-engine">
            <option value="gemini" ${s.defaults?.engine === 'gemini' ? 'selected' : ''}>Long video + Short</option>
            <option value="verticals" ${s.defaults?.engine === 'verticals' ? 'selected' : ''}>Short only</option>
          </select>
          <div class="field__hint">Picked first on the Make page and used for saved ideas.</div></div>
        <div class="field"><label class="field__label" for="s-default-niche">Default category</label>
          <select class="select select--lg" id="s-default-niche">
            ${NICHES.map(([v, l]) => `<option value="${v}" ${s.defaults?.niche === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <div class="field__hint">Used to pick a topic when you leave the topic empty.</div></div>
        <div class="field"><span class="field__label">Upload between (India time)</span>
          <div class="row" style="gap:10px">
            <input class="input input--lg" type="time" id="s-wstart" aria-label="Upload from" value="${esc(s.schedule?.windowStart || '18:00')}">
            <span class="muted">to</span>
            <input class="input input--lg" type="time" id="s-wend" aria-label="Upload until" value="${esc(s.schedule?.windowEnd || '21:00')}">
          </div>
          <div class="field__hint">Automatic uploads happen in this window.</div></div>
        <div class="field"><label class="field__label" for="s-cap">Uploads per day</label>
          <input class="input input--lg" type="number" min="1" max="10" id="s-cap" value="${esc(String(P.dailyCap ?? 2))}">
          <div class="field__hint">Hard limit — extra uploads are blocked. The count resets at 5:30 AM. Keep it at 2.</div></div>
        <div class="field"><label class="field__label" for="s-lang">Language of new videos</label>
          <select class="select select--lg" id="s-lang">
            ${LANGS.map(([v, l]) => `<option value="${v}" ${s.defaults?.language === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
      </div>
    </section>

    <section class="card">
      <div class="card__head">${icon('layers')}<h2>More tools</h2></div>
      <div class="link-list">
        <a class="link-row" href="#/calendar">${icon('calendar', 'icon--sm')}<span><strong>Calendar</strong><span>When videos were made and went up</span></span>${icon('chevronR', 'icon--sm')}</a>
        <a class="link-row" href="#/makers">${icon('layers', 'icon--sm')}<span><strong>Video makers</strong><span>Steps, last run, automatic schedule</span></span>${icon('chevronR', 'icon--sm')}</a>
        <a class="link-row" href="#/runs">${icon('history', 'icon--sm')}<span><strong>Technical history</strong><span>Every cloud run with steps and logs</span></span>${icon('chevronR', 'icon--sm')}</a>
        <a class="link-row" href="#/analytics">${icon('chart', 'icon--sm')}<span><strong>Channel stats</strong><span>Views and watch time (not connected yet)</span></span>${icon('chevronR', 'icon--sm')}</a>
      </div>
    </section>

    <div class="sec-title" style="margin-top:22px">Advanced</div>
    <div class="stack-sm">
    ${group('adv-makers', 'video', 'Video makers', 'switch makers on or off', `
      ${sw('s-eng-gemini', s.engines?.gemini?.enabled ?? true, '“Long video + Short” maker', 'When off, it never starts — not by hand and not automatically. Videos already being made finish.', 'Long video plus Short maker on or off')}
      ${sw('s-eng-verticals', s.engines?.verticals?.enabled ?? false, '“Short only” maker', 'Same as above. The backup step also respects this switch.', 'Short only maker on or off')}
      <div class="field" style="margin-top:10px"><label class="field__label" for="s-format">Default video shape</label>
        <select class="select" id="s-format">
          <option value="per_engine" ${s.defaults?.format === 'per_engine' ? 'selected' : ''}>Each maker’s own (16:9 + Short, or 9:16)</option>
          <option value="long-form" ${s.defaults?.format === 'long-form' ? 'selected' : ''}>Long video 16:9</option>
          <option value="short" ${s.defaults?.format === 'short' ? 'selected' : ''}>Short 9:16</option>
        </select></div>`, openWhich === 'makers')}

    ${group('adv-plan', 'zap', 'Video maker plan', 'used by “Let the system choose” and automatic videos', `
      <div class="stack-sm">
      ${MODES.map((m) => `
        <label class="choice ${s.orchestration?.mode === m.id ? 'is-on' : ''}">
          <input type="radio" name="orch-mode" value="${m.id}" ${s.orchestration?.mode === m.id ? 'checked' : ''}>
          <span><strong>${esc(m.name)}</strong><span class="muted">${esc(m.desc)}</span></span>
        </label>`).join('')}
      </div>
      <div class="grid grid--2" style="gap:14px;margin-top:14px">
        <div class="field"><label class="field__label" for="s-fallback">If the main maker fails</label>
          <select class="select" id="s-fallback">
            <option value="on_failure" ${s.orchestration?.fallback === 'on_failure' ? 'selected' : ''}>Try the backup maker</option>
            <option value="never" ${s.orchestration?.fallback === 'never' ? 'selected' : ''}>Stop and tell me</option>
            <option value="on_failure_and_duplicate" ${s.orchestration?.fallback === 'on_failure_and_duplicate' ? 'selected' : ''}>Try the backup, also when the topic was a repeat</option>
          </select></div>
        <div class="field"><label class="field__label" for="s-alt">How they take turns</label>
          <select class="select" id="s-alt">
            <option value="days" ${s.orchestration?.alternate === 'days' ? 'selected' : ''}>Swap every day</option>
            <option value="run" ${s.orchestration?.alternate === 'run' ? 'selected' : ''}>Swap every run</option>
            <option value="manual" ${s.orchestration?.alternate === 'manual' ? 'selected' : ''}>Only when I choose</option>
          </select>
          <div class="field__hint">Only used by “Take turns”.</div></div>
        <div class="field"><label class="field__label" for="s-concurrency">Videos made at the same time</label>
          <input class="input" type="number" min="1" max="3" id="s-concurrency" value="${esc(String(s.orchestration?.maxConcurrency ?? 1))}">
          <div class="field__hint">1 to 3. Extra starts are refused, not queued.</div></div>
        <div class="field"><label class="field__label" for="s-retry">Automatic tries after a failure</label>
          <input class="input" type="number" min="0" max="5" id="s-retry" value="${esc(String(s.orchestration?.retryLimit ?? 2))}">
          <div class="field__hint">Only for safe-to-repeat failures. Setup problems are never retried. Each video still gets at most 2 tries by hand.</div></div>
      </div>`, openWhich === 'plan')}

    ${group('adv-publish', 'shield', 'Publishing rules', 'safety switches', `
      ${sw('s-review', P.reviewRequired, 'I check every video before it goes up', 'Strongly recommended. Videos wait in “To check” until you approve them.', 'Check every video before publishing')}
      ${sw('s-draft', P.draftMode, 'Make drafts only', 'Videos are made but nothing is sent to YouTube, even after you approve. Use when testing.', 'Make drafts only')}
      ${sw('s-auto', P.autoPublish, 'Publish without me', 'Keep OFF. Only works after “I check every video” was tested end to end. Limits still apply.', 'Publish without me')}
      ${sw('s-dedupe', P.dedupe, 'Block repeat topics', 'Stops a video whose topic matches one you already made or are making — slightly reworded ones too.', 'Block repeat topics')}
      ${sw('s-lock', P.publishLock, 'One upload at a time', 'Uploads wait for each other so the daily limit and repeat check can’t be skipped.', 'One upload at a time')}
      <div class="field" style="margin-top:10px"><label class="field__label" for="s-privacy">Who can see new uploads</label>
        <select class="select" id="s-privacy">
          <option value="private" ${vis === 'private' ? 'selected' : ''}>Private — only you</option>
          <option value="unlisted" ${vis === 'unlisted' ? 'selected' : ''}>Unlisted — anyone with the link (current rule)</option>
          <option value="public" ${vis === 'public' ? 'selected' : ''}>Public — everyone</option>
        </select>
        <div class="field__hint">Keep Unlisted. You can make a video Public later in YouTube Studio.</div></div>`, openWhich === 'publish')}

    ${group('adv-schedule', 'calendar', 'Automatic schedule', 'how often videos start by themselves', `
      <div class="grid grid--2" style="gap:14px">
        <div class="field"><label class="field__label" for="s-freq">How often</label>
          <select class="select" id="s-freq">
            <option value="daily" ${s.schedule?.frequency === 'daily' ? 'selected' : ''}>Every day</option>
            <option value="twice_daily" ${s.schedule?.frequency === 'twice_daily' ? 'selected' : ''}>Twice a day</option>
            <option value="weekdays" ${s.schedule?.frequency === 'weekdays' ? 'selected' : ''}>Weekdays only</option>
            <option value="manual" ${s.schedule?.frequency === 'manual' ? 'selected' : ''}>Only when I tap Make</option>
          </select>
          <div class="field__hint">The exact start time is set in the video maker itself and can run a little late.</div></div>
        <div class="field"><label class="field__label" for="s-tz">Time zone</label>
          <input class="input" id="s-tz" value="${esc(s.schedule?.timezone || 'Asia/Kolkata')}" disabled>
          <div class="field__hint">Fixed to India time (IST).</div></div>
      </div>`, openWhich === 'schedule')}

    ${group('adv-cloud', 'github', 'Cloud connection', 'where the video makers live', `
      <div class="row" style="justify-content:flex-end;margin-bottom:10px"><button type="button" class="btn btn--secondary btn--sm" id="btn-test-gh">${icon('refresh', 'icon--sm')} Test connection</button></div>
      <div class="grid grid--2" style="gap:14px">
        <div class="field"><label class="field__label" for="s-repo-a">“Long video + Short” project</label>
          <input class="input mono" id="s-repo-a" value="${esc(s.github?.gemini?.repo || '')}" placeholder="owner/repo"></div>
        <div class="field"><label class="field__label" for="s-wf-a">Its start file</label>
          <input class="input mono" id="s-wf-a" value="${esc(s.github?.gemini?.workflow || '')}" placeholder="main.yml"></div>
        <div class="field"><label class="field__label" for="s-repo-b">“Short only” project</label>
          <input class="input mono" id="s-repo-b" value="${esc(s.github?.verticals?.repo || '')}" placeholder="owner/repo"></div>
        <div class="field"><label class="field__label" for="s-wf-b">Its start file</label>
          <input class="input mono" id="s-wf-b" value="${esc(s.github?.verticals?.workflow || '')}" placeholder="verticals.yml"></div>
        <div class="field"><label class="field__label" for="s-branch">Branch</label>
          <input class="input mono" id="s-branch" value="${esc(s.github?.branch || 'dypol-integration')}" placeholder="dypol-integration"></div>
        <div class="field"><label class="field__label">Connection key</label>
          <input class="input" value="${s.github?.tokenConfigured ? '••••••••  (set)' : 'Not set'}" disabled>
          <div class="field__hint">Kept on the server and never shown here. Only change the fields above if the projects moved.</div></div>
      </div>`, openWhich === 'cloud')}

    ${group('status', 'server', 'System status', 'limits, storage and connections', `
      ${quotaPanelShell('quota-panel-settings')}
      <div class="card" style="margin-top:12px">
        <div class="card__head">${icon('server')}<h2>Connections</h2></div>
        <div class="card__body qc">
          ${[
            ['Console mode', h.mode === 'demo' ? 'warn' : 'ok', h.mode === 'demo' ? 'Demo (pretend data)' : 'Live'],
            ['Video list storage', h.db === 'ok' ? 'ok' : 'off', h.db === 'ok' ? 'Connected' : 'Not connected'],
            ['Cloud connection key', !h.githubToken ? 'off' : h.githubTokenValid ? (expSoon(h.githubTokenExpiresAt) ? 'warn' : 'ok') : 'off',
              !h.githubToken ? 'Missing' : h.githubTokenValid ? (h.githubTokenExpiresAt ? `Working · expires ${fmtDay(h.githubTokenExpiresAt)}` : 'Working') : (h.githubTokenMessage || 'Refused')],
            ['Progress updates from the cloud', h.webhookSecret ? 'ok' : 'off', h.webhookSecret ? 'Set up' : 'Missing'],
            ['“Long video + Short” sign-ins', ev(h.engines?.gemini) ? 'ok' : 'warn', ev(h.engines?.gemini) ? `Working · last success ${fmtDay(ev(h.engines?.gemini))}` : 'Not proven yet'],
            ['“Short only” sign-ins', ev(h.engines?.verticals) ? 'ok' : 'warn', ev(h.engines?.verticals) ? `Working · last success ${fmtDay(ev(h.engines?.verticals))}` : 'Not proven yet'],
            ['YouTube upload', h.youtubeLastUpload ? 'ok' : 'warn', h.youtubeLastUpload ? `Working · last upload ${fmtDay(h.youtubeLastUpload)}` : 'Proven at the first upload'],
            ['YouTube stats', h.youtubeAnalytics ? 'ok' : 'off', h.youtubeAnalytics ? 'Connected' : 'Not connected yet'],
            ['One upload at a time', P.publishLock ? 'ok' : 'off', P.publishLock ? 'On' : 'Off'],
          ].map(([name, state, label]) => `
            <div class="qc__row ${state === 'ok' ? '' : state === 'warn' ? 'is-warn' : 'is-off'}">
              ${icon(state === 'ok' ? 'check' : state === 'warn' ? 'alert' : 'info', 'icon--sm')}
              <span>${esc(name)}</span><span class="spacer"></span>
              <span class="pill">${esc(label)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card__head">${icon('youtube')}<h2>YouTube channel</h2>
          <div class="right"><button type="button" class="btn btn--secondary btn--sm" id="btn-test-yt">${icon('refresh', 'icon--sm')} Test</button></div></div>
        <div class="card__body stack" style="gap:10px">
          <div class="row">${statusPill(yt.state)}</div>
          <div class="small muted">${yt.state === 'verified-by-upload'
            ? `Uploads work — the last one went up on ${esc(fmtDay(yt.lastUpload))}. The YouTube sign-in is kept inside the video makers, not here.`
            : 'The YouTube sign-in is kept inside the video makers, so it can only be proven by the first successful upload.'}</div>
          <dl class="kv">
            <dt>Channel</dt><dd>${esc(h.channelName || '—')}</dd>
            <dt>New uploads</dt><dd>${esc(VIS[vis] || vis)}</dd>
            <dt>YouTube’s own limit</dt><dd class="tiny muted">About 6 uploads a day (10,000 units).</dd>
          </dl>
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card__head">${icon('sparkles')}<h2>Checks</h2></div>
        <div class="card__body stack-sm">
          <div class="more-row"><div><strong>AI writer check</strong><span class="muted">Checks the AI writing service is reachable. A working key doesn’t guarantee a model is free.</span></div>
            <button type="button" class="btn btn--secondary btn--sm" id="btn-test-gemini">${icon('refresh', 'icon--sm')} Test</button></div>
          <div class="more-row"><div><strong>Repeat-topic check</strong><span class="muted">Makes sure the repeat-topic blocker works.</span></div>
            <button type="button" class="btn btn--secondary btn--sm" id="btn-test-dedupe">${icon('copy', 'icon--sm')} Test</button></div>
        </div>
      </div>`, openWhich === 'status')}

    ${group('adv-about', 'info', 'About', 'version', `
      <dl class="kv">
        <dt>Product</dt><dd>DYPOL Creator Console</dd>
        <dt>Made by</dt><dd>DYPOL LABS</dd>
        <dt>Version</dt><dd>2.0 (simple design)</dd>
        <dt>Mode</dt><dd>${esc(h.mode === 'demo' ? 'Demo' : h.mode ? 'Live' : 'unknown')}</dd>
      </dl>
      <div class="field__hint">Passwords and keys live only on the server and in the cloud projects. They are never sent to this page or saved on your phone.</div>`)}
    </div>

    <div class="save-bar">
      <span class="save-bar__hint" id="save-hint">Changes are saved when you tap Save.</span>
      <button class="btn btn--primary btn--lg" id="btn-save">${icon('check', 'icon--sm')} Save changes</button>
    </div>`;

  const dirty = () => {
    const hint = root.querySelector('#save-hint');
    if (hint) { hint.textContent = 'You have unsaved changes.'; hint.classList.add('is-dirty'); }
  };
  root.querySelectorAll('input, select').forEach((el) => el.addEventListener('change', dirty));
  root.querySelectorAll('input[name="orch-mode"]').forEach((r) => r.addEventListener('change', () => {
    root.querySelectorAll('input[name="orch-mode"]').forEach((x) => x.closest('.choice').classList.toggle('is-on', x.checked));
  }));
  const toggle = (id) => {
    const el = root.querySelector(id);
    if (el) el.onclick = () => { el.classList.toggle('is-on'); el.setAttribute('aria-checked', String(el.classList.contains('is-on'))); dirty(); };
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
      toast('Saved', 'Your settings are updated.', 'ok');
      Object.assign(UI_PREFS, {
        visibility: val('#s-privacy'), dailyCap: Number(val('#s-cap')), defaultEngine: val('#s-default-engine'),
        defaultNiche: val('#s-default-niche'), paused: on('#s-pause'), reviewRequired: on('#s-review'),
        engines: { gemini: { enabled: on('#s-eng-gemini') }, verticals: { enabled: on('#s-eng-verticals') } },
      });
      await refresh();
    } catch (err) {
      btn.disabled = false;
      errorToast(err, 'Couldn’t save');
    }
  };

  const testTarget = async (target, label) => {
    try {
      const res = await api.testConnection(target);
      toast(res.ok ? `${label}: working` : `${label}: needs attention`, res.message, res.ok ? 'ok' : 'warn', 7000);
    } catch (err) { errorToast(err, `${label} didn’t work`); }
  };
  root.querySelector('#btn-test-gh').onclick = () => testTarget('github', 'Cloud connection');
  root.querySelector('#btn-test-yt').onclick = () => testTarget('youtube', 'YouTube');
  root.querySelector('#btn-test-gemini').onclick = () => testTarget('gemini', 'AI writer');
  root.querySelector('#btn-test-dedupe').onclick = () => testTarget('dedupe', 'Repeat-topic check');
  const st = root.querySelector('#status');
  if (openWhich) root.querySelector(`#${openWhich === 'status' ? 'status' : `adv-${openWhich}`}`)?.scrollIntoView({ block: 'start' });
  if (st.open) mountQuotaPanel(root, 'quota-panel-settings');
  else st.addEventListener('toggle', () => { if (st.open) mountQuotaPanel(root, 'quota-panel-settings'); }, { once: true });
}

const fmtDay = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? String(t || '') : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); };
const expSoon = (t) => !!t && Date.parse(t) - Date.now() < 14 * 864e5;
const ev = (e) => (e ? (e.lastUpload || e.lastSuccessfulRun) : null);

export async function renderSettings() {
  await refresh();
}
