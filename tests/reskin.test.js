/**
 * Reskin (5 Nov 2026): owner's prototype look — Sora + Poppins only,
 * yellow/charcoal tokens, motion that respects reduced-motion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../console/', import.meta.url).pathname;
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

test('reskin.css loads after app.css; fonts are self-hosted Sora + Poppins', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('/assets/css/app.css') < html.indexOf('/assets/css/reskin.css'));
  assert.ok(html.includes('/assets/fonts/fonts.css'));
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'no third-party font requests');
  const fonts = read('assets/fonts/fonts.css');
  assert.match(fonts, /font-family: 'Sora'/);
  assert.match(fonts, /font-family: 'Poppins'/);
  assert.equal((fonts.match(/font-display: swap/g) || []).length, (fonts.match(/@font-face/g) || []).length);
  for (const m of fonts.matchAll(/url\(\/assets\/fonts\/([^)]+)\)/g)) assert.ok(existsSync(`${ROOT}assets/fonts/${m[1]}`), m[1]);
});

test('reskin tokens: Poppins body, Sora display, yellow accent, dark theme, no Inter', () => {
  const css = read('assets/css/reskin.css');
  assert.match(css, /--font: "Poppins"/);
  assert.match(css, /--font-display: "Sora"/);
  assert.match(css, /--accent: #F6D451/);
  assert.match(css, /\[data-theme="dark"\] \{[\s\S]*?--accent: #F3D14F/);
  assert.ok(!/Inter/.test(css));
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('motion: one delegated ripple listener, page enter, both wired in app.js', () => {
  const m = read('assets/js/motion.js');
  assert.match(m, /addEventListener\('pointerdown'/);
  assert.match(m, /prefers-reduced-motion/);
  const app = read('assets/js/app.js');
  assert.match(app, /initMotion\(\);/);
  assert.match(app, /pageEnter\(root\)/);
});
