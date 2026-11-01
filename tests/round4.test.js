/**
 * Round 4 (1 Nov 2026): NVIDIA hosted FLUX backup image maker in the quota panel.
 * Run: node --test tests/round4.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../console/', import.meta.url).pathname;
const quota = await import(`${ROOT}functions/api/_lib/quota.js`);

test('quota: nvidia_flux limit line is read and never mistaken for the Cloudflare FLUX limit', () => {
  const a = quota.scanLog('⚠️ nvidia_flux quota/limit hit (HTTP 429 Too Many Requests); skipping nvidia_flux for the rest of this run\n'
    + 'DYPOL_PROVIDER_LIMIT provider=nvidia_flux action=skip_for_rest_of_run');
  assert.equal(a.nvidiaFlux, true);
  assert.equal(a.flux, false, 'provider=nvidia_flux is not provider=flux');
  assert.deepEqual(a.providers, ['nvidia_flux']);
  assert.match(a.nvidiaFluxLine, /nvidia_flux/);
  const b = quota.scanLog('2026-11-01T10:00:00.0000000Z DYPOL_PROVIDER_LIMIT provider=nvidia_flux status=429 action=skip_for_rest_of_run detail=NVIDIA hosted FLUX.1-schnell');
  assert.equal(b.nvidiaFlux, true);
  assert.match(b.nvidiaFluxLine, /^DYPOL_PROVIDER_LIMIT provider=nvidia_flux/);
});

test('quota: both FLUX limits in one run are both reported', () => {
  const s = quota.scanLog('DYPOL_PROVIDER_LIMIT provider=flux action=skip_for_rest_of_run\n'
    + 'DYPOL_PROVIDER_LIMIT provider=nvidia_flux status=429 action=skip_for_rest_of_run');
  assert.equal(s.flux, true);
  assert.equal(s.nvidiaFlux, true);
  assert.deepEqual(s.providers.sort(), ['flux', 'nvidia_flux']);
  assert.equal(quota.scanLog('NVIDIA FLUX request ok; flux image saved').nvidiaFlux, false);
});

test('quota: provider_limits from candidate / broll manifest carry nvidia_flux', () => {
  const j = quota.judgeFromJson({ judge_status: 'active', provider_limits: { flux: { status: 429 }, nvidia_flux: { status: 429 } } });
  assert.ok(j.providerLimits.nvidia_flux);
  assert.equal(quota.CACHE_KEY, 'panel-v4', 'panel shape changed: cache key bumped');
});

test('quota panel UI shows the backup image maker row with plain words', () => {
  const src = readFileSync(`${ROOT}assets/js/quota-panel.js`, 'utf8');
  assert.match(src, /Backup image maker \(daily limit\)/);
  assert.match(src, /e\.nvidiaFlux \?/, 'older cached panels without nvidiaFlux still render');
  assert.match(src, /Daily backup image limit reached/);
});
