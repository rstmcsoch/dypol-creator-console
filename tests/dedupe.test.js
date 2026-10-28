/**
 * Unit tests for the production duplicate-prevention normalisation
 * (console/functions/api/_lib/util.js) — the same code Cloudflare runs.
 * Run: node --test tests/dedupe.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopic, topicKey } from '../console/functions/api/_lib/util.js';

test('normalisation is case/punctuation/stopword insensitive', () => {
  assert.equal(
    normalizeTopic('The Science of Black Holes in 60 Seconds!'),
    normalizeTopic('science black holes 60 second'),
  );
});

test('plural/singular folding works', () => {
  assert.equal(normalizeTopic('Why agents need memory'), normalizeTopic('why agent needs memory'));
  assert.equal(normalizeTopic('Why AI agents need memories'), normalizeTopic('Why AI Agents Need Memory'));
});

test('diacritics are folded', () => {
  assert.equal(normalizeTopic('Café culture'), normalizeTopic('cafe culture'));
});

test('distinct topics get distinct keys', () => {
  assert.notEqual(topicKey('black holes'), topicKey('quantum computing'));
});

test('keys are stable 32-char hex', async () => {
  const k = await topicKey('The Science of Black Holes in 60 Seconds');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(k, await topicKey('science of the black hole in 60 seconds'));
});
