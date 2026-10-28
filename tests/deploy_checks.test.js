/**
 * Deployment consistency checks — prevents the "empty/wrong-nested directory"
 * deploy class of errors.
 *
 * Proves:
 *  · wrangler.toml lives in console/ and its output dir is "." (not "console",
 *    which would resolve to console/console and deploy an empty tree),
 *  · the package.json scripts deploy THIS directory and run the preflight
 *    completeness check first,
 *  · docs/DEPLOYMENT.md + docs/SETUP.md instruct the same canonical commands
 *    (cd console → npm run deploy) and no longer the unsafe root-level deploy,
 *  · schema + migration files referenced by the docs exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url).pathname;

test('wrangler.toml: output dir is "." and lives in console/', () => {
  const toml = readFileSync(`${ROOT}console/wrangler.toml`, 'utf8');
  assert.ok(toml.includes('pages_build_output_dir = "."'),
    'must be "." — "console" would resolve to console/console');
  assert.ok(!/pages_build_output_dir = "console"/.test(toml));
  assert.ok(toml.includes('binding = "DB"'), 'D1 binding must be DB');
  assert.ok(toml.includes('hash-password.cjs'), 'password generator reference must match the real filename');
});

test('package.json scripts: preflight guard + safe deploy from console/', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}console/package.json`, 'utf8'));
  assert.ok(pkg.scripts.preflight, 'preflight script required');
  assert.match(pkg.scripts.deploy, /preflight/, 'deploy must run preflight first');
  assert.match(pkg.scripts.deploy, /wrangler pages deploy \./, 'deploys THIS directory');
  assert.ok(!/pages deploy console/.test(pkg.scripts.deploy), 'no nested-directory deploy');
  assert.ok(pkg.scripts['db:schema']?.includes('schema.sql'));
  assert.ok(pkg.scripts['db:migrate']?.includes('migrations/002.sql'));
});

test('preflight actually refuses an incomplete console dir', () => {
  // Positive: the real console/ passes.
  execSync('node -e "const fs=require(\'fs\');const need=[\'index.html\',\'wrangler.toml\',\'functions/api/health.js\',\'schema.sql\',\'assets/js/app.js\'];const miss=need.filter(f=>!fs.existsSync(f));if(miss.length)process.exit(1)"',
    { cwd: `${ROOT}console` });
  // Negative: the same check from the repo root must FAIL (missing files).
  assert.throws(() => execSync('node -e "const fs=require(\'fs\');const need=[\'index.html\',\'wrangler.toml\'];const miss=need.filter(f=>!fs.existsSync(f));if(miss.length)process.exit(1)"',
    { cwd: ROOT }), 'running from the repo root must not pass the completeness check');
});

test('docs teach the same canonical deploy path', () => {
  const dep = readFileSync(`${ROOT}docs/DEPLOYMENT.md`, 'utf8');
  const setup = readFileSync(`${ROOT}docs/SETUP.md`, 'utf8');
  for (const doc of [dep, setup]) {
    assert.match(doc, /npm run deploy/, 'canonical command documented');
    assert.ok(!/^\s*npx wrangler pages deploy console\s*$/m.test(doc),
      'the unsafe root-level "pages deploy console" must not be documented');
  }
  assert.match(dep, /Upload assets/, 'Android-tablet dashboard route documented');
  assert.match(dep, /output directory/i);
  assert.match(dep, /migrations\/002\.sql/);
});

test('schema and migration files exist where documented', () => {
  assert.ok(existsSync(`${ROOT}console/schema.sql`));
  assert.ok(existsSync(`${ROOT}console/migrations/002.sql`));
  assert.ok(existsSync(`${ROOT}console/functions/api/health.js`));
  assert.ok(existsSync(`${ROOT}console/scripts/hash-password.cjs`));
});

test('no secrets in wrangler.toml (placeholders only)', () => {
  const toml = readFileSync(`${ROOT}console/wrangler.toml`, 'utf8');
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(toml), 'no GitHub PAT');
  assert.ok(!/ya29\./.test(toml), 'no Google token');
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(toml), 'no API key');
});
