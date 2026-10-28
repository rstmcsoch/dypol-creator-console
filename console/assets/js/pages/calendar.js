/* Calendar — scheduling with month/week/day views, IST default */
import { api } from '../api.js';
import {
  icon, esc, fmtDateTime, fmtTime, toast, confirmModal, openModal, closeModal, statusPill,
} from '../ui.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let cursor = new Date();
let view = 'month';
let engineFilter = '';

function ym(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// AUDIT FIX: day keys must come from the IST calendar, not toISOString()
// (which is UTC and shifts entries by a day between 00:00–05:30 IST).
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
const dayKeyOf = (d) => dayKeyFmt.format(d);
const isoDayKey = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? dayKeyFmt.format(new Date(iso)) : '');
const jobDayKey = (j) => isoDayKey(j.scheduledFor) || isoDayKey(j.publishedAt) || isoDayKey(j.createdAt);

function evClass(job) {
  if (job.status === 'published') return 'cal-ev--green';
  if (job.status === 'failed') return 'cal-ev--amber';
  if (job.engine === 'verticals') return 'cal-ev--violet';
  if (job.status === 'scheduled') return 'cal-ev--blue';
  return '';
}

function monthGrid(jobs, year, month) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ day: prevDays - i, out: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, out: false, date: new Date(year, month, d) });
  while (cells.length % 7 !== 0) cells.push({ day: cells.length - startDow - daysInMonth + 1, out: true });

  const today = new Date();
  return `<div class="cal-grid">
    ${DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
    ${cells.map((c) => {
      const key = c.date ? dayKeyOf(c.date) : '';
      const evs = c.date ? jobs.filter((j) => jobDayKey(j) === key) : [];
      const isToday = c.date && dayKeyOf(c.date) === dayKeyOf(today);
      return `<div class="cal-cell ${c.out ? 'is-out' : ''} ${isToday ? 'is-today' : ''}">
        <div class="cal-day">${c.day}</div>
        ${evs.slice(0, 3).map((j) => `
          <button class="cal-ev ${evClass(j)}" data-cal-job="${esc(j.id)}" title="${esc(j.title)}">
            ${j.engine === 'gemini' ? '◆' : '▶'} ${esc(j.title)}
          </button>`).join('')}
        ${evs.length > 3 ? `<div class="tiny muted">+${evs.length - 3} more</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function weekList(jobs) {
  const start = new Date(cursor);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i); return d;
  });
  return `<div class="stack">${days.map((d) => {
    const key = dayKeyOf(d);
    const evs = jobs.filter((j) => jobDayKey(j) === key);
    return `<div class="card">
      <div class="card__head"><h2>${DOW[(d.getDay() + 6) % 7]} · ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}</h2>
        <div class="right"><span class="tiny muted">${evs.length} item(s)</span></div></div>
      ${evs.length ? `<div class="card__body stack" style="gap:10px">${evs.map((j) => `
        <button class="row" data-cal-job="${j.id}" style="width:100%;text-align:left;gap:12px;padding:10px;border:1px solid var(--border);border-radius:12px">
          <span class="pill pill--${j.engine === 'gemini' ? 'accent' : 'violet'}">${j.engine === 'gemini' ? 'Gemini' : 'Verticals'}</span>
          <span class="small" style="font-weight:650;flex:1;min-width:0" class="truncate">${esc(j.title)}</span>
          ${statusPill(j.status)}
          <span class="tiny muted">${j.scheduledFor ? esc(fmtTime(j.scheduledFor)) : ''}</span>
        </button>`).join('')}</div>`
      : `<div class="card__body muted small">Nothing scheduled.</div>`}
    </div>`;
  }).join('')}</div>`;
}

function dayList(jobs) {
  const key = dayKeyOf(cursor);
  const evs = jobs.filter((j) => jobDayKey(j) === key);
  return `<div class="card">
    <div class="card__head"><h2>${cursor.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2></div>
    ${evs.length ? `<div class="table">
      ${evs.map((j) => `
        <div class="table__row is-clickable" data-cal-job="${j.id}" style="grid-template-columns:minmax(0,2fr) 1fr 1fr 1.1fr">
          <div class="cell-main"><div class="cell-title">${esc(j.title)}</div><div class="cell-sub">${esc(j.topic || '')}</div></div>
          <div data-col="Engine">${j.engine === 'gemini' ? 'Gemini' : 'Verticals v3'}</div>
          <div data-col="Time"><span class="small">${j.scheduledFor ? esc(fmtTime(j.scheduledFor)) : '—'}</span></div>
          <div data-col="Status">${statusPill(j.status)}</div>
        </div>`).join('')}
    </div>` : `<div class="card__body muted small">Nothing on this day.</div>`}
  </div>`;
}

async function refresh() {
  const root = document.getElementById('page-root');
  const data = await api.calendar(ym(cursor));
  const jobs = (data.jobs || []).filter((j) => !engineFilter || j.engine === engineFilter);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Calendar</h1>
        <div class="sub">Scheduling view in ${esc(data.timezone || 'Asia/Kolkata')} (IST) · publishing window ${esc(data.publishingWindow || '18:00–21:00')}</div>
      </div>
      <div class="page-head__actions">
        <button class="btn ${data.automationPaused ? 'btn--primary' : 'btn--secondary'}" id="btn-pause">
          ${icon(data.automationPaused ? 'play' : 'pause', 'icon--sm')} ${data.automationPaused ? 'Resume automation' : 'Pause automation'}
        </button>
        <button class="btn btn--secondary" id="btn-window">${icon('clock', 'icon--sm')} Publishing window</button>
      </div>
    </div>

    ${data.automationPaused ? `<div class="callout callout--warn" style="margin-bottom:16px">${icon('pause')}<div><strong>Automation paused.</strong> Scheduled runs are on hold — previously generated videos, published records, credentials and configuration are preserved.</div></div>` : ''}

    <div class="cal-head" style="margin-bottom:14px">
      <button class="icon-btn" id="cal-prev" aria-label="Previous">${icon('chevronL')}</button>
      <button class="icon-btn" id="cal-next" aria-label="Next">${icon('chevronR')}</button>
      <button class="btn btn--secondary btn--sm" id="cal-today">Today</button>
      <div class="cal-title">${cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
      <div class="spacer"></div>
      <div class="seg" id="cal-seg">
        <button class="${view === 'month' ? 'is-active' : ''}" data-view="month">Month</button>
        <button class="${view === 'week' ? 'is-active' : ''}" data-view="week">Week</button>
        <button class="${view === 'day' ? 'is-active' : ''}" data-view="day">Day</button>
      </div>
    </div>

    <div class="row row--wrap" style="gap:14px;margin-bottom:14px">
      <div class="seg" id="engine-filter">
        <button class="${engineFilter === '' ? 'is-active' : ''}" data-ef="">Both engines</button>
        <button class="${engineFilter === 'gemini' ? 'is-active' : ''}" data-ef="gemini">Engine A · Gemini</button>
        <button class="${engineFilter === 'verticals' ? 'is-active' : ''}" data-ef="verticals">Engine B · Verticals</button>
      </div>
    </div>

    <div class="row row--wrap" style="gap:14px;margin-bottom:14px">
      <span class="badge-soft badge-soft--accent">${icon('calendar', 'icon--sm')} Daily cap: ${esc(String(data.dailyCap ?? 2))} uploads/day</span>
      <span class="badge-soft badge-soft--blue">${icon('shield', 'icon--sm')} Review before publish: ${data.reviewRequired ? 'required' : 'off'}</span>
      <span class="badge-soft badge-soft--neutral">${icon('clock', 'icon--sm')} Next run: ${esc(data.nextRunLabel || '—')}</span>
      <span class="badge-soft badge-soft--neutral">${icon('history', 'icon--sm')} Last execution: ${esc(data.lastExecutionLabel || '—')}</span>
    </div>

    ${view === 'month' ? monthGrid(jobs, cursor.getFullYear(), cursor.getMonth())
      : view === 'week' ? weekList(jobs) : dayList(jobs)}

    <div class="callout" style="margin-top:18px">${icon('info')}<div>Entries show scheduled jobs, drafts and completed uploads. Click any entry to open its review panel in the Content Queue. Changes to schedules are validated server-side against the duplicate check and daily cap.</div></div>

    <div class="footer-note">
      <span class="brand-lockup"><span class="mark">${icon('play', 'icon--sm')}</span><strong>DYPOL LABS</strong></span>
      <span>DYPOL Creator Console</span><span>·</span><span>Calendar</span>
    </div>`;

  root.querySelector('#cal-prev').onclick = () => {
    if (view === 'month') cursor.setMonth(cursor.getMonth() - 1);
    else if (view === 'week') cursor.setDate(cursor.getDate() - 7);
    else cursor.setDate(cursor.getDate() - 1);
    refresh();
  };
  root.querySelector('#cal-next').onclick = () => {
    if (view === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else if (view === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setDate(cursor.getDate() + 1);
    refresh();
  };
  root.querySelector('#cal-today').onclick = () => { cursor = new Date(); refresh(); };
  root.querySelector('#cal-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    view = b.dataset.view;
    refresh();
  });
  root.querySelector('#engine-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ef]');
    if (!b) return;
    engineFilter = b.dataset.ef;
    refresh();
  });
  root.querySelectorAll('[data-cal-job]').forEach((el) => {
    el.onclick = () => { location.hash = `#/queue?job=${encodeURIComponent(el.dataset.calJob)}`; };
  });
  root.querySelector('#btn-pause').onclick = async () => {
    const pausing = !data.automationPaused;
    if (pausing && !await confirmModal('Pause automation?', 'Future scheduled runs are paused. Generated videos, published records, credentials and configuration are preserved.', 'Pause automation', true)) return;
    try {
      const res = await api.schedule({ automationPaused: pausing });
      toast(pausing ? 'Automation paused' : 'Automation resumed', res.message, 'ok');
      await refresh();
    } catch (err) { toast('Update failed', err.message, 'bad'); }
  };
  root.querySelector('#btn-window').onclick = () => {
    openModal({
      title: 'Publishing window & daily cap',
      body: `
        <div class="field"><label class="field__label" for="w-start">Window start (IST)</label>
          <input class="input" type="time" id="w-start" value="${esc(data.windowStart || '18:00')}"></div>
        <div class="field"><label class="field__label" for="w-end">Window end (IST)</label>
          <input class="input" type="time" id="w-end" value="${esc(data.windowEnd || '21:00')}"></div>
        <div class="field"><label class="field__label" for="w-cap">Max uploads per day</label>
          <input class="input" type="number" min="1" max="10" id="w-cap" value="${esc(String(data.dailyCap ?? 2))}"></div>
        <div class="field__hint">The cap is enforced server-side at publish time. Upload attempts beyond the cap are blocked, not queued silently.</div>`,
      foot: `<button class="btn btn--secondary" id="m-cancel">Cancel</button>
             <button class="btn btn--primary" id="m-save">Save</button>`,
    });
    document.getElementById('m-cancel').onclick = closeModal;
    document.getElementById('m-save').onclick = async () => {
      try {
        const res = await api.schedule({
          windowStart: document.getElementById('w-start').value,
          windowEnd: document.getElementById('w-end').value,
          dailyCap: Number(document.getElementById('w-cap').value),
        });
        closeModal();
        toast('Schedule settings saved', res.message, 'ok');
        await refresh();
      } catch (err) { toast('Save failed', err.message, 'bad'); }
    };
  };
}

export async function renderCalendar() {
  await refresh();
}
