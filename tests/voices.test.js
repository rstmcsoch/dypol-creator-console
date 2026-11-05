/**
 * Voices + design patterns (5 Nov 2026): validation, Create/Redo inputs,
 * Settings defaults + engine-variable sync with a graceful notice.
 * Run: node --test tests/voices.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './_d1shim.js';

const ROOT = new URL('../console/', import.meta.url).pathname;
const V = await import(`${ROOT}functions/api/_lib/voices.js`);
const gh = await import(`${ROOT}functions/api/_lib/github.js`);
const wh = await import(`${ROOT}functions/api/_lib/webhook.js`);
const dbm = await import(`${ROOT}functions/api/_lib/db.js`);
const flow = await import(`${ROOT}functions/api/_lib/jobflow.js`);
const settingsApi = await import(`${ROOT}functions/api/settings.js`);
const { onRequestPost: runPost } = await import(`${ROOT}functions/api/engines/[engine]/run.js`);
const { onRequestPost: regenPost } = await import(`${ROOT}functions/api/jobs/[id]/regenerate.js`);

const A = 'rstmcsoch/gemini-youtube-automation';
const B = 'rstmcsoch/youtube-shorts-pipeline';
const b64 = (s) => Buffer.from(s).toString('base64');

let calls, routes, realFetch;
beforeEach(() => {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.method === method && u.includes(r.match)) {
        const out = typeof r.res === 'function' ? r.res(u, opts) : r.res;
        return new Response(out.body == null ? null : JSON.stringify(out.body), { status: out.status || 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const route = (method, match, res) => routes.push({ method, match, res });

const WORKFLOW = (extra = '') => `name: Main
on:
  workflow_dispatch:
    inputs:
      phase:
        type: string
      topic:
        type: string
      job_id:
        type: string
${extra}jobs:
  build:
    runs-on: ubuntu-latest
`;
const WITH_VOICE = '      voice:\n        type: string\n      design_pattern:\n        type: string\n';

async function makeEnv() {
  wh._resetSchemaCache();
  gh._resetInputsCache();
  settingsApi._resetTokenCache();
  const DB = createD1(readFileSync(`${ROOT}schema.sql`, 'utf8'));
  await wh.ensureProgressSchema(DB);
  await dbm.saveSettings(DB, {
    github: { gemini: { repo: A, workflow: 'main.yml' }, verticals: { repo: B, workflow: 'verticals.yml' }, branch: 'dypol-integration' },
    engines: { gemini: { enabled: true }, verticals: { enabled: true } },
    publishing: { visibility: 'unlisted', dailyCap: 2, reviewRequired: true, autoPublish: false, dedupe: true },
  });
  return { DB, GITHUB_TOKEN: 'ghp_test', SESSION_SECRET: 's', __noRetryWait: true };
}
const ctx = (env, params = {}, body = {}, method = 'POST') => ({
  env, params, request: new Request('https://c.pages.dev/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});

test('voices.json and the server id list match; default is am_michael', () => {
  const doc = JSON.parse(readFileSync(`${ROOT}config/voices.json`, 'utf8'));
  assert.deepEqual(doc.voices.map((v) => v.id), V.KOKORO_VOICE_IDS);
  assert.equal(doc.voices.length, 28);
  assert.equal(doc.default, 'am_michael');
  assert.equal(V.DEFAULT_VOICE, 'am_michael');
  for (const v of doc.voices) {
    assert.ok(v.label && v.lang && ['male', 'female'].includes(v.gender), v.id);
  }
  assert.equal(doc.voices.find((v) => v.id === 'am_michael').label, 'Michael · US male');
  assert.equal(doc.voices.find((v) => v.id === 'bf_emma').lang, 'en-gb');
});

test('validateVoice: known ids, blends, custom voices, rejects junk', () => {
  assert.deepEqual(V.validateVoice('am_michael'), { ok: true, value: 'am_michael' });
  assert.equal(V.validateVoice(' bf_emma ').value, 'bf_emma');
  assert.equal(V.validateVoice('af_bella:0.6,am_michael:0.4').ok, true);
  assert.equal(V.validateVoice('af_bella:0.6, am_michael:0.4').value, 'af_bella:0.6,am_michael:0.4');
  assert.equal(V.validateVoice('af_bella:0.5,am_adam:0.3,bm_lewis:0.2').ok, true);
  assert.equal(V.validateVoice('af_bella:0.7,am_michael:0.4').ok, false, 'weights must add up to 1');
  assert.equal(V.validateVoice('af_bella:0.5,af_bella:0.5').ok, false, 'no duplicate parts');
  assert.equal(V.validateVoice('af_bella:1').ok, false, 'a blend needs 2+ voices');
  assert.equal(V.validateVoice('xx_nobody:0.5,am_michael:0.5').ok, false);
  assert.equal(V.validateVoice('jf_alpha').ok, false, 'not in the list and not added');
  assert.equal(V.validateVoice('').ok, false);
  assert.equal(V.validateVoice('am_michael; rm -rf /').ok, false);
  assert.equal(V.validateVoice('<script>').ok, false);
  const custom = [{ id: 'jf_alpha', label: 'Alpha' }, { id: 'zf_xiaobei:0.5,af_heart:0.5', label: 'Mix' }];
  assert.equal(V.validateVoice('jf_alpha', custom).ok, true);
  assert.equal(V.validateVoice('jf_alpha:0.3,am_michael:0.7', custom).ok, true, 'custom single ids blend too');
  assert.equal(V.validateVoice('zf_xiaobei:0.5,af_heart:0.5', custom).ok, true, 'saved custom blend');
});

test('design pattern + custom voice sanitising', () => {
  assert.deepEqual(V.validateDesignPattern('elements'), { ok: true, value: 'elements' });
  assert.equal(V.validateDesignPattern('characters').ok, false, 'coming soon — not accepted yet');
  assert.equal(V.validateDesignPattern('').ok, false);
  assert.deepEqual(V.sanitizeCustomVoices([{ id: 'jf_alpha', label: ' <b>Alpha</b> ' }, { id: 'jf_alpha' }, { id: 'af_bella:0.6,am_michael:0.4' }]),
    [{ id: 'jf_alpha', label: 'bAlpha/b' }, { id: 'af_bella:0.6,am_michael:0.4', label: 'af_bella:0.6,am_michael:0.4' }]);
  assert.throws(() => V.sanitizeCustomVoices([{ id: 'Not A Voice' }]));
  assert.throws(() => V.sanitizeCustomVoices('x'));
  assert.throws(() => V.sanitizeCustomVoices(Array.from({ length: 31 }, (_, i) => ({ id: `af_v${i}x` }))));
});

test('buildDraftInputs adds voice/design_pattern only when given', () => {
  const s = { publishing: { visibility: 'unlisted' }, defaults: {} };
  const a = flow.buildDraftInputs(s, 'gemini', { topic: 't' });
  assert.ok(!('voice' in a) && !('design_pattern' in a));
  const b = flow.buildDraftInputs(s, 'gemini', { topic: 't', voice: 'bf_emma', designPattern: 'elements' });
  assert.equal(b.voice, 'bf_emma');
  assert.equal(b.design_pattern, 'elements');
});

test('Create: bad voice / pattern are refused (400) before any job or dispatch', async () => {
  const env = await makeEnv();
  const r1 = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Voice test one', voice: 'xx_nobody' }));
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).code, 'bad-voice');
  const r2 = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Voice test two', design_pattern: 'characters' }));
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).code, 'bad-design-pattern');
  const r3 = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Voice test three', voice: 'af_bella:0.9,am_michael:0.4' }));
  assert.equal(r3.status, 400);
  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  assert.equal(calls.filter((c) => c.url.includes('/dispatches')).length, 0);
});

test('Create sends voice + design_pattern when declared; Redo carries them over', async () => {
  const env = await makeEnv();
  route('GET', '/contents/.github/workflows/main.yml', { body: { type: 'file', content: b64(WORKFLOW(WITH_VOICE)) } });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 7001 } });
  const res = await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Blended narrator topic', voice: 'af_bella:0.6,am_michael:0.4', design_pattern: 'elements' }));
  assert.equal(res.status, 202);
  const { jobId } = await res.json();
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.equal(d.body.inputs.voice, 'af_bella:0.6,am_michael:0.4');
  assert.equal(d.body.inputs.design_pattern, 'elements');

  routes.find((r) => r.match === '/dispatches').res = { status: 200, body: { workflow_run_id: 7002 } };
  await dbm.updateJob(env.DB, jobId, { status: 'needs-review' });
  const rr = await regenPost(ctx(env, { id: jobId }, {}));
  assert.equal(rr.status, 202);
  const d2 = calls.filter((c) => c.url.includes('/dispatches')).pop();
  assert.equal(d2.body.inputs.voice, 'af_bella:0.6,am_michael:0.4');
  assert.equal(d2.body.inputs.design_pattern, 'elements');
});

test('Create without a voice uses the Settings default; undeclared inputs are dropped', async () => {
  const env = await makeEnv();
  await dbm.saveSettings(env.DB, { defaults: { voice: 'bm_george' } });
  route('GET', '/contents/.github/workflows/main.yml', { body: { type: 'file', content: b64(WORKFLOW(WITH_VOICE)) } });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 7101 } });
  assert.equal((await runPost(ctx(env, { engine: 'gemini' }, { topic: 'Default voice topic' }))).status, 202);
  const d = calls.find((c) => c.url.includes('/dispatches'));
  assert.equal(d.body.inputs.voice, 'bm_george');
  assert.equal(d.body.inputs.design_pattern, 'elements');

  const env2 = await makeEnv();
  calls.length = 0;
  routes.length = 0;
  route('GET', '/contents/.github/workflows/main.yml', { body: { type: 'file', content: b64(WORKFLOW()) } });
  route('POST', '/dispatches', { status: 200, body: { workflow_run_id: 7102 } });
  assert.equal((await runPost(ctx(env2, { engine: 'gemini' }, { topic: 'Old workflow topic', voice: 'am_echo' }))).status, 202);
  const d2 = calls.find((c) => c.url.includes('/dispatches'));
  assert.ok(!('voice' in d2.body.inputs), 'workflow does not declare voice yet');
});

test('Settings: defaults + customVoices validated; engine variables PATCHed', async () => {
  const env = await makeEnv();
  const bad = await settingsApi.onRequestPut(ctx(env, {}, { defaults: { voice: 'xx_nobody' } }, 'PUT'));
  assert.equal(bad.status, 400);
  const badC = await settingsApi.onRequestPut(ctx(env, {}, { customVoices: [{ id: 'bad voice' }] }, 'PUT'));
  assert.equal(badC.status, 400);

  route('PATCH', '/actions/variables/', { status: 204, body: null });
  const ok = await settingsApi.onRequestPut(ctx(env, {}, {
    customVoices: [{ id: 'jf_alpha', label: 'Alpha' }],
    defaults: { voice: 'jf_alpha', designPattern: 'elements' },
  }, 'PUT'));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.engineSync.ok, true);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => c.url.replace('https://api.github.com', '')).sort(), [
    '/repos/rstmcsoch/gemini-youtube-automation/actions/variables/DYPOL_DEFAULT_PATTERN',
    '/repos/rstmcsoch/gemini-youtube-automation/actions/variables/DYPOL_DEFAULT_VOICE',
    '/repos/rstmcsoch/youtube-shorts-pipeline/actions/variables/DYPOL_DEFAULT_PATTERN',
    '/repos/rstmcsoch/youtube-shorts-pipeline/actions/variables/DYPOL_DEFAULT_VOICE',
  ]);
  assert.equal(patches.find((c) => c.url.endsWith('DYPOL_DEFAULT_VOICE')).body.value, 'jf_alpha');
  const s = await dbm.getSettings(env.DB);
  assert.equal(s.defaults.voice, 'jf_alpha');
  assert.equal(s.defaults.designPattern, 'elements');
  assert.deepEqual(s.customVoices, [{ id: 'jf_alpha', label: 'Alpha' }]);

  // Same values again: already synced, no GitHub calls.
  calls.length = 0;
  await settingsApi.onRequestPut(ctx(env, {}, { defaults: { voice: 'jf_alpha', designPattern: 'elements' } }, 'PUT'));
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('Settings: a refused variable write keeps the save and returns the notice', async () => {
  const env = await makeEnv();
  route('PATCH', '/actions/variables/', { status: 403, body: { message: 'Resource not accessible by personal access token' } });
  route('GET', '/actions/variables/DYPOL_DEFAULT_VOICE', { status: 200, body: { name: 'DYPOL_DEFAULT_VOICE', value: 'am_michael' } });
  const res = await settingsApi.onRequestPut(ctx(env, {}, { defaults: { voice: 'bf_emma' } }, 'PUT'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.engineSync.ok, false);
  assert.equal(body.engineSync.notice, 'Saved in console; engines still use am_michael');
  assert.equal((await dbm.getSettings(env.DB)).defaults.voice, 'bf_emma');

  // Variable missing (404 on PATCH) → created with POST.
  const env2 = await makeEnv();
  routes.length = 0; calls.length = 0;
  route('POST', '/actions/variables', { status: 201, body: {} });
  const r2 = await settingsApi.onRequestPut(ctx(env2, {}, { defaults: { designPattern: 'elements' } }, 'PUT'));
  assert.equal((await r2.json()).engineSync.ok, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
});

test('Make + Settings UI: voice and design pattern controls, disabled Characters option', () => {
  const make = readFileSync(`${ROOT}assets/js/pages/make.js`, 'utf8');
  const set = readFileSync(`${ROOT}assets/js/pages/settings.js`, 'utf8');
  const lib = readFileSync(`${ROOT}assets/js/voices.js`, 'utf8');
  assert.match(make, /id="mk-voice"/);
  assert.match(make, /id="mk-pattern"/);
  assert.match(make, /voice: v\.voice, design_pattern: v\.design_pattern/);
  assert.match(set, /id="s-default-voice"/);
  assert.match(set, /id="s-default-pattern"/);
  assert.match(set, /id="btn-add-voice"/);
  assert.match(set, /designPattern: val\('#s-default-pattern'\)/);
  assert.match(lib, /Characters — coming soon', enabled: false/);
  assert.match(lib, /\/config\/voices\.json/);
});
