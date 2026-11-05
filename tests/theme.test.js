/**
 * Light/dark theme toggle — unit + static checks.
 * Run: node --test tests/theme.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../console/', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const SRC = read('assets/js/theme.js');

function fakeEnv({ stored = null, systemDark = false, storageThrows = false } = {}) {
  const attrs = {}; const style = {};
  const meta = { _c: '#FF7100', setAttribute(k, v) { if (k === 'content') this._c = v; } };
  const mkBtn = () => ({ a: {}, setAttribute(k, v) { this.a[k] = v; } });
  const btns = [mkBtn(), mkBtn()];
  const listeners = {}; const mqListeners = [];
  const store = { v: stored };
  const doc = {
    readyState: 'complete',
    documentElement: { style, setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k] ?? null; } },
    querySelector: (s) => (s.includes('theme-color') ? meta : null),
    querySelectorAll: () => btns,
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const mq = { matches: systemDark, addEventListener: (_t, fn) => mqListeners.push(fn) };
  const win = {
    document: doc,
    matchMedia: () => mq,
    localStorage: {
      getItem: () => { if (storageThrows) throw new Error('blocked'); return store.v; },
      setItem: (_k, v) => { if (storageThrows) throw new Error('blocked'); store.v = v; },
    },
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  const click = () => listeners.click({ target: { closest: () => btns[0] }, preventDefault() {} });
  return { win, doc, attrs, style, meta, btns, store, mq, mqListeners, click, api: win.DypolTheme };
}

test('first visit follows the device setting', () => {
  assert.equal(fakeEnv({ systemDark: true }).attrs['data-theme'], 'dark');
  assert.equal(fakeEnv({ systemDark: false }).attrs['data-theme'], 'light');
});

test('a saved choice beats the device setting', () => {
  assert.equal(fakeEnv({ stored: 'light', systemDark: true }).attrs['data-theme'], 'light');
  assert.equal(fakeEnv({ stored: 'dark', systemDark: false }).attrs['data-theme'], 'dark');
  assert.equal(fakeEnv({ stored: 'purple', systemDark: false }).attrs['data-theme'], 'light', 'junk value ignored');
});

test('clicking the toggle flips theme, saves it, and updates button + meta', () => {
  const e = fakeEnv();
  assert.equal(e.btns[0].a['aria-pressed'], 'false');
  e.click();
  assert.equal(e.attrs['data-theme'], 'dark');
  assert.equal(e.store.v, 'dark');
  assert.equal(e.style.colorScheme, 'dark');
  assert.equal(e.meta._c, e.api.META.dark);
  for (const b of e.btns) { assert.equal(b.a['aria-pressed'], 'true'); assert.equal(b.a['aria-label'], 'Switch to light mode'); }
  e.click();
  assert.equal(e.attrs['data-theme'], 'light');
  assert.equal(e.store.v, 'light');
  assert.equal(e.meta._c, e.api.META.light);
});

test('still switches when storage is blocked (private mode)', () => {
  const e = fakeEnv({ storageThrows: true });
  assert.equal(e.attrs['data-theme'], 'light');
  e.click();
  assert.equal(e.attrs['data-theme'], 'dark');
});

test('device change is followed only until the user picks', () => {
  const e = fakeEnv();
  e.mq.matches = true; e.mqListeners.forEach((f) => f());
  assert.equal(e.attrs['data-theme'], 'dark');
  e.click(); // user picks light
  e.mq.matches = true; e.mqListeners.forEach((f) => f());
  assert.equal(e.attrs['data-theme'], 'light');
});

test('html: theme script loads in <head> before CSS, toggle sits in the top bar and on login', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.indexOf('/assets/js/theme.js') > -1 && head.indexOf('/assets/js/theme.js') < head.indexOf('app.css'));
  assert.doesNotMatch(head, /theme\.js"[^>]*(defer|async|type="module")/);
  const bar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(bar, /data-theme-toggle/);
  assert.ok(bar.indexOf('data-theme-toggle') > bar.indexOf('topbar__spacer'), 'toggle is on the right side');
  assert.match(html, /theme-toggle--float/);
  assert.equal((html.match(/data-theme-toggle/g) || []).length, 2);
});

test('css: dark tokens defined and hard-coded light surfaces overridden', () => {
  const css = read('assets/css/app.css');
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  for (const v of ['--bg', '--card', '--ink', '--border', '--accent-soft', '--green-soft', '--red-soft']) assert.match(dark, new RegExp(`${v}:`), v);
  for (const sel of ['.topbar', '.tabbar', '.avatar', '.toast', '.btn--danger', '.login']) assert.ok(css.includes(`[data-theme="dark"] ${sel}`), sel);
  assert.match(css, /\.theme-toggle:focus-visible/);
  assert.match(css, /min-height: 44px/);
});
