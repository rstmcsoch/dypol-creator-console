/**
 * UI v2 (simple design) — static + unit checks for the console front end.
 * Run: node --test tests/ui.test.js
 * Covers: one status vocabulary, plain errors that say what to do next,
 * the progress line, the new navigation, no jargon on the main screens,
 * and that every publishing safeguard is still wired in the UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../console/', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const ui = await import(`${ROOT}assets/js/ui.js`);
const prog = await import(`${ROOT}assets/js/progress.js`);

test('one status vocabulary: review states share one label, every main state has a plain label + help', () => {
  assert.equal(ui.statusInfo('needs-review').label, 'Waiting for your check');
  assert.equal(ui.statusInfo('awaiting-review').label, ui.statusInfo('needs-review').label);
  assert.equal(ui.statusInfo('failed').label, 'Didn’t finish');
  assert.equal(ui.statusInfo('publish_failed').label, 'Upload didn’t finish');
  assert.equal(ui.statusInfo('superseded').label, 'Replaced by a redo');
  assert.equal(ui.statusInfo('stale').label, 'Taking longer than usual');
  ui.UI_PREFS.visibility = 'unlisted';
  assert.equal(ui.statusInfo('published').label, 'On YouTube (Unlisted)');
  for (const s of ['queued', 'dispatched', 'running', 'generating', 'needs-review', 'approved', 'uploading', 'published', 'failed', 'publish_failed', 'rejected', 'cancelled']) {
    const i = ui.statusInfo(s);
    assert.ok(i.label && i.help, `${s} has label and help`);
    assert.doesNotMatch(i.label, /_|dispatch|workflow|job/i, `${s} label is plain`);
  }
});

test('maker names replace Engine A/B everywhere', () => {
  assert.equal(ui.makerName('gemini'), 'Long video + Short');
  assert.equal(ui.makerName('verticals'), 'Short only');
  assert.match(ui.enginePill('gemini'), /Long video \+ Short/);
  assert.doesNotMatch(ui.enginePill('verticals'), /Verticals v3/);
});

test('errors say what to do next', () => {
  ui.UI_PREFS.dailyCap = 2;
  const cap = ui.friendlyError({ code: 'daily-cap', message: 'Daily cap reached' });
  assert.match(cap.title, /uploads are used up/);
  assert.match(cap.msg, /2 videos a day.*5:30 AM/);
  assert.match(ui.friendlyError({ code: 'duplicate' }).msg, /different topic/);
  assert.match(ui.friendlyError({ status: 0 }).title, /No connection/);
  assert.match(ui.friendlyError({ code: 'retry-limit' }).msg, /Redo/);
  const unknown = ui.friendlyError({ code: 'weird', message: 'Boom' }, 'Couldn’t start');
  assert.equal(unknown.title, 'Couldn’t start');
  assert.match(unknown.msg, /Boom.*System status/);
  assert.match(ui.failureNext('asset', 2), /Try again \(2 tries left\)/);
  assert.match(ui.failureNext('asset', 0), /Redo/);
  assert.match(ui.failureNext('oauth', 2), /setup fix/);
});

test('progress line: step x of y, plain step names, rough minutes left', () => {
  assert.equal(prog.plainStep('Run Autonomous Production Pipeline'), 'Putting the video together');
  assert.equal(prog.plainStep('broll'), 'Making the visuals');
  assert.equal(prog.plainStep('Install dependencies'), 'Getting ready');
  const startedAt = new Date(Date.now() - 5 * 60e3).toISOString();
  const p = { stepsTotal: 6, stepsFinished: 2, currentStep: 'voiceover', percent: 50, run: { startedAt } };
  const line = prog.progressLine({ status: 'running' }, p);
  assert.match(line, /^Step 3 of 6 · Recording the voice · about 5 min left$/);
  assert.equal(prog.minutesLeft({ percent: 5, run: { startedAt } }), null, 'no guess before 10%');
  assert.match(prog.progressLine({ status: 'queued' }, null), /In line/);
  assert.match(prog.progressLine({ status: 'running', progress: 40 }, null), /40% done/);
});

test('navigation: phone tab bar + 4 main routes, old links still work, advanced pages reachable', () => {
  const html = read('index.html');
  assert.match(html, /id="tabbar"/);
  assert.match(html, /id="login-remember"/);
  assert.doesNotMatch(html, /id="btn-bell"/, 'misleading bell removed');
  const app = read('assets/js/app.js');
  for (const id of ['home', 'make', 'videos', 'settings', 'makers', 'calendar', 'runs', 'analytics']) {
    assert.match(app, new RegExp(`id: '${id}'`), `route ${id}`);
  }
  assert.match(app, /overview: 'home', queue: 'videos', pipelines: 'makers'/);
  assert.match(app, /Sign out/, 'avatar opens an account sheet');
  assert.doesNotMatch(app, /btn-avatar'\)\.addEventListener\('click', async \(\) => \{\s*try \{ await api\.logout/, 'avatar no longer signs out instantly');
  const settings = read('assets/js/pages/settings.js');
  for (const href of ['#/calendar', '#/makers', '#/runs', '#/analytics']) assert.ok(settings.includes(href), `Settings links ${href}`);
});

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('main screens are free of technical jargon', () => {
  for (const f of ['overview.js', 'make.js', 'queue.js']) {
    const src = stripComments(read(`assets/js/pages/${f}`));
    for (const word of ['Engine A', 'Engine B', 'Dispatch', 'Pipeline', 'Workflow', 'Artifact', 'Orchestrat', 'Gemini', 'Verticals v3', 'Run ID', 'Job ID', 'OAuth']) {
      assert.ok(!src.includes(word), `${f} shows “${word}”`);
    }
  }
});

test('safeguards stay wired: approve confirms first, reject needs a reason, publish/retry confirm, idea keeps dedupe', () => {
  const q = read('assets/js/pages/queue.js');
  const approve = q.slice(q.indexOf("if (action === 'approve')"), q.indexOf("if (action === 'publish'"));
  assert.match(approve, /confirmModal\('Publish to YouTube\?'/);
  assert.match(approve, /if \(!await confirmModal/);
  assert.match(q, /if \(!optional && v\.length < 3\)/, 'reject reason (≥3 chars) still required');
  assert.match(q, /reasonSheet\(\{ title: 'Reject this video\?'[\s\S]{0,400}?danger: true, prefill: notesText \}\)/);
  assert.match(q, /Publish now\?/);
  assert.match(q, /Try the upload again\?/);
  assert.match(q, /b\.disabled = true; \/\/ double-submission guard/);
  // approve still = approve + publish on the server (one action), API unchanged
  assert.match(q, /api\.jobAction\(j\.id, action, payload\)/);
  const make = read('assets/js/pages/make.js');
  assert.match(make, /confirmModal\('Make both and compare\?'/, 'make-both asks first');
  assert.match(make, /confirmModal\('Let the system choose\?'/, 'orchestrated asks first');
  assert.match(make, /phase: form\.phase/);
  assert.match(make, /form = \{ engine: null, phase: 'draft' \}/, 'default phase stays draft (review gate)');
  const pipe = read('assets/js/pages/pipelines.js');
  assert.match(pipe, /confirmModal\('Let the system choose\?'/);
});

test('home keeps the quota panel (folded) and surfaces problems only when something is wrong', () => {
  const ov = read('assets/js/pages/overview.js');
  assert.match(ov, /<details class="card adv" id="home-status">/);
  assert.match(ov, /quotaProblems\(q\)/);
  assert.match(ov, /Uploads today/);
});
