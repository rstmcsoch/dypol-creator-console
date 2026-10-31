/* Make a new video — the ONE place to start a video.
   Main path: pick the kind → optional topic → Start making.
   "More ways to make" (collapsed) keeps every other start option:
   let the system choose (orchestrated), make both and compare, what to run
   (phase), and saving an idea for later (topic queue). */
import { api } from '../api.js';
import {
  icon, esc, toast, confirmModal, errorToast, UI_PREFS, MAKERS,
} from '../ui.js';

const NICHES = [
  ['general', 'General'], ['tech', 'Tech'], ['science', 'Science'], ['education', 'Education'],
  ['finance', 'Money & finance'], ['gaming', 'Gaming'], ['motivation', 'Motivation'],
];
const PHASES = [
  ['draft', 'Make a video', 'Recommended. Made in the cloud, then waits for your check.'],
  ['publish', 'Upload the last video I approved', 'Doesn’t make anything new. Sends an already-approved video to YouTube.'],
  ['full', 'Make, then upload what I approved', 'While “I check every video” is on, this works the same as “Make a video”.'],
];

let form = { engine: null, phase: 'draft' };

function kindCard(id, enabled) {
  const m = MAKERS[id];
  const on = form.engine === id;
  return `<button type="button" class="kind ${on ? 'is-on' : ''}" data-kind="${id}" role="radio" aria-checked="${on}"
      ${enabled ? '' : 'aria-disabled="true" data-why="This video maker is switched off. Turn it on in Settings → Advanced → Video makers."'}>
    <span class="kind__art kind__art--${id}" aria-hidden="true">${id === 'gemini' ? '<i class="r169"></i><i class="r916"></i>' : '<i class="r916"></i>'}</span>
    <span class="kind__text"><strong>${esc(m.name)}</strong><span>${esc(m.help)}</span><span class="muted">About 15 minutes</span></span>
    <span class="kind__check">${icon('check', 'icon--sm')}</span>
  </button>`;
}

export async function renderMake(root) {
  const enabled = {
    gemini: UI_PREFS.engines?.gemini?.enabled ?? true,
    verticals: UI_PREFS.engines?.verticals?.enabled ?? true,
  };
  if (!form.engine || !enabled[form.engine]) {
    form.engine = enabled[UI_PREFS.defaultEngine] ? UI_PREFS.defaultEngine : (enabled.gemini ? 'gemini' : 'verticals');
  }
  const niche = UI_PREFS.defaultNiche || 'general';

  const draw = () => {
    root.innerHTML = `
    <div class="page-head page-head--simple">
      <div><h1>Make a new video</h1>
        <div class="sub">It takes about 15 minutes. You’ll check it before anything goes on YouTube.</div></div>
    </div>
    ${UI_PREFS.paused ? `<div class="callout callout--warn">${icon('pause')}<div><strong>Automatic videos are paused.</strong> Starting a video by hand may be refused until you turn off “Pause automatic videos” in Settings.</div></div>` : ''}

    <form class="make" id="make-form" autocomplete="off">
      <div class="step"><span class="step__n">1</span><div class="step__t">What kind of video?</div></div>
      <div class="kinds" role="radiogroup" aria-label="Kind of video">
        ${kindCard('gemini', enabled.gemini)}
        ${kindCard('verticals', enabled.verticals)}
      </div>

      <div class="step"><span class="step__n">2</span><div class="step__t">Topic <span class="muted">(optional)</span></div></div>
      <div class="field">
        <input class="input input--lg" id="mk-topic" maxlength="200" placeholder="e.g. How solar panels work" />
        <div class="field__hint">Leave empty and the video maker picks a fresh topic for you. Repeat topics are blocked automatically.</div>
      </div>
      ${form.engine === 'verticals' ? `
      <div class="field">
        <label class="field__label" for="mk-context">Facts to include <span class="muted">(optional)</span></label>
        <textarea class="textarea" id="mk-context" rows="3" maxlength="2000" placeholder="Key facts, dates or sources the Short should use"></textarea>
        <div class="field__hint">Helps the Short stay accurate. No personal names.</div>
      </div>` : ''}
      <div class="field">
        <label class="field__label" for="mk-niche">Category</label>
        <select class="select select--lg" id="mk-niche">${NICHES.map(([v, l]) => `<option value="${v}" ${v === niche ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="field__hint">Used to pick a topic when you leave it empty.</div>
      </div>

      <div class="next-steps">
        <div class="next-steps__title">What happens next</div>
        <ol>
          <li><strong>Made in the cloud</strong> — about 15 minutes. Follow it on Home.</li>
          <li><strong>You check it</strong> — watch it and fix the title if you like.</li>
          <li><strong>You tap Approve &amp; publish</strong> — it goes on YouTube as ${esc((UI_PREFS.visibility || 'unlisted').replace(/^./, (c) => c.toUpperCase()))}.</li>
        </ol>
      </div>

      <div class="sticky-cta">
        <button class="btn btn--primary btn--xl btn--block" type="submit" id="mk-go">${icon('play', 'icon--sm')} Start making</button>
      </div>

      <details class="card adv" id="mk-more">
        <summary>${icon('settings2', 'icon--sm')} More ways to make <span class="muted small">for advanced use</span></summary>
        <div class="adv__body stack">
          <div class="field">
            <div class="field__label">What to run</div>
            <div class="choice-list" id="mk-phase">
              ${PHASES.map(([v, l, h]) => `<label class="choice ${form.phase === v ? 'is-on' : ''}">
                <input type="radio" name="mk-phase" value="${v}" ${form.phase === v ? 'checked' : ''}>
                <span><strong>${esc(l)}</strong><span class="muted">${esc(h)}</span></span></label>`).join('')}
            </div>
            <div class="field__hint">Used by the Start making button above.</div>
          </div>
          <div class="more-row">
            <div><strong>Let the system choose</strong><span class="muted">Uses your video maker plan (Settings → Advanced): main maker first, backup if it breaks.</span></div>
            <button type="button" class="btn btn--secondary" id="mk-auto">${icon('zap', 'icon--sm')} Choose for me</button>
          </div>
          <div class="more-row">
            <div><strong>Make both and compare</strong><span class="muted">Each maker makes a version. You check both and publish the one you like.</span></div>
            <button type="button" class="btn btn--secondary" id="mk-both">${icon('copy', 'icon--sm')} Make both</button>
          </div>
          <div class="more-row">
            <div><strong>Save as an idea for later</strong><span class="muted">Keeps the topic in your list. Nothing starts now.</span></div>
            <button type="button" class="btn btn--secondary" id="mk-idea">${icon('plus', 'icon--sm')} Save idea</button>
          </div>
          <a class="link-row" href="#/makers">Video makers page (steps, schedule, last run) ${icon('chevronR', 'icon--sm')}</a>
        </div>
      </details>
    </form>`;
    wire();
  };

  const values = () => ({
    topic: root.querySelector('#mk-topic').value.trim(),
    niche: root.querySelector('#mk-niche').value,
    context: root.querySelector('#mk-context')?.value.trim() || undefined,
  });

  const started = (title, msg) => {
    toast(title, msg, 'ok', 6000);
    location.hash = '#/home';
  };

  function wire() {
    root.querySelectorAll('[data-kind]').forEach((b) => {
      b.onclick = () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        const keep = values();
        form.engine = b.dataset.kind;
        draw();
        root.querySelector('#mk-topic').value = keep.topic;
        root.querySelector('#mk-niche').value = keep.niche;
      };
    });
    root.querySelectorAll('input[name="mk-phase"]').forEach((r) => {
      r.onchange = () => {
        form.phase = r.value;
        root.querySelectorAll('#mk-phase .choice').forEach((c) => c.classList.toggle('is-on', c.querySelector('input').checked));
      };
    });
    root.querySelector('#make-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = root.querySelector('#mk-go');
      const v = values();
      btn.disabled = true; // double-submission guard
      btn.textContent = 'Starting…';
      try {
        await api.engineRun(form.engine, { topic: v.topic || undefined, phase: form.phase, niche: v.niche, context: v.context });
        started('Started!', `Your ${MAKERS[form.engine].name} is being made. Follow it on Home — about 15 minutes.`);
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `${icon('play', 'icon--sm')} Start making`;
        errorToast(err, 'Couldn’t start the video');
      }
    };
    root.querySelector('#mk-auto').onclick = async (e) => {
      const v = values();
      if (!await confirmModal('Let the system choose?', `<p>The system starts the main video maker. If it breaks, the backup maker tries instead.</p><p class="small muted">${v.topic ? `Topic: “${esc(v.topic)}”` : 'No topic — the maker picks one.'} You still check the video before it goes up.</p>`, 'Start', false, 'Not now')) return;
      e.target.disabled = true;
      try {
        await api.post('/api/orchestrate/run', { topic: v.topic, niche: v.niche });
        started('Started!', 'The system picked a video maker. Follow it on Home.');
      } catch (err) { e.target.disabled = false; errorToast(err, 'Couldn’t start'); }
    };
    root.querySelector('#mk-both').onclick = async (e) => {
      const v = values();
      if (!await confirmModal('Make both and compare?', `<p>Both video makers make a version (about 15 minutes). You check both and publish the one you like — nothing goes up on its own.</p><p class="small muted">${v.topic ? `Topic: “${esc(v.topic)}”` : 'No topic — each maker picks one.'}</p>`, 'Make both', false, 'Not now')) return;
      e.target.disabled = true;
      try {
        await api.post('/api/orchestrate/run', { topic: v.topic, niche: v.niche, forceMode: 'draft_both' });
        started('Started both!', 'Two versions are being made. Follow them on Home.');
      } catch (err) { e.target.disabled = false; errorToast(err, 'Couldn’t start'); }
    };
    root.querySelector('#mk-idea').onclick = async (e) => {
      const v = values();
      if (!v.topic) { toast('Type a topic first', 'An idea needs a topic, e.g. “How solar panels work”.', 'warn'); root.querySelector('#mk-topic').focus(); return; }
      e.target.disabled = true;
      try {
        await api.createJob({ topic: v.topic, engine: form.engine, niche: v.niche });
        toast('Idea saved', `“${v.topic}” is in your Videos list as “In line”.`, 'ok');
        root.querySelector('#mk-topic').value = '';
      } catch (err) { errorToast(err, 'Couldn’t save the idea'); }
      e.target.disabled = false;
    };
  }

  draw();
}
