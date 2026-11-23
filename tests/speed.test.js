// Speed fixes (23 Nov 2026): tab switches must not wait on GitHub or R2 listings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const R = new URL('../console/', import.meta.url).pathname;
const read = (f) => readFileSync(R + f, 'utf8');

test('client reuses fresh GET data, shares in-flight requests, clears on any action', () => {
  const s = read('assets/js/api.js');
  assert.match(s, /const FRESH_MS = 20000/);
  assert.match(s, /inflight\.has\(path\)/);
  assert.match(s, /if \(method !== 'GET'\) cache\.clear\(\)/);
  assert.match(s, /session\|health\|auth/);
  assert.match(read('assets/js/app.js'), /clearApiCache\(\); \/\/ an explicit refresh/);
});

test('jobs list runs engine checks after the response', () => {
  assert.match(read('functions/api/jobs/index.js'), /context\.waitUntil\(bg\)/);
});

test('storage sweep is background and usage is cached', () => {
  const s = read('functions/api/storage.js');
  assert.match(s, /context\.waitUntil\(sweep\)/);
  assert.match(s, /usageCache\.at > 300000/);
});

test('overview GitHub probe is cached and time-boxed', () => {
  const s = read('functions/api/overview.js');
  assert.match(s, /hit\.at < 120000/);
  assert.match(s, /setTimeout\(\(\) => r\(\{ state: 'unverified'/);
});

test('idle warm-up, one D1 list read when unfiltered, poll pauses in background', () => {
  assert.match(read('assets/js/app.js'), /navigate\(\);\n  warmTabs\(\);/);
  assert.match(read('functions/api/jobs/index.js'), /filtered \? await listJobs\(db, \{\}\) : jobs/);
  assert.match(read('assets/js/progress.js'), /visibilityState === 'hidden' \? 30000/);
});
