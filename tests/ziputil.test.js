/**
 * ziputil regression tests — recovery of upload results from artifact backups
 * (the "YouTube upload succeeded but the git push of dypol-results/ failed"
 * scenario). Uses real zip bytes produced by Python's zipfile module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFirstEntry } from '../console/functions/api/_lib/ziputil.js';

function makeZip(entries, deflated) {
  const dir = mkdtempSync(join(tmpdir(), 'ziputil-'));
  const zipPath = join(dir, 'a.zip');
  const pyPath = join(dir, 'mk.py');
  writeFileSync(pyPath, `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w',
                    zipfile.ZIP_DEFLATED if ${deflated ? 'True' : 'False'} else zipfile.ZIP_STORED)
${entries.map((e) => `z.writestr(${JSON.stringify(e.name)}, ${JSON.stringify(e.content)})`).join('\n')}
z.close()
`);
  execSync(`python3 ${pyPath}`);
  return new Uint8Array(readFileSync(zipPath));
}

const RESULT = JSON.stringify({ job_id: 'job-1', youtube_id: 'vidABC', status: 'uploaded' });

test('extracts the json entry from a DEFLATE artifact zip', async () => {
  const zip = makeZip([
    { name: 'upload_result.json', content: RESULT },
    { name: 'nested/readme.txt', content: 'ignore me' },
  ], true);
  const entry = await extractFirstEntry(zip, '.json');
  assert.ok(entry, 'entry found');
  const parsed = JSON.parse(new TextDecoder().decode(entry.bytes));
  assert.equal(parsed.youtube_id, 'vidABC');
});

test('extracts from a STORED artifact zip too', async () => {
  const zip = makeZip([{ name: 'upload_result.json', content: RESULT }], false);
  const entry = await extractFirstEntry(zip, '.json');
  assert.ok(entry);
  assert.equal(JSON.parse(new TextDecoder().decode(entry.bytes)).job_id, 'job-1');
});

test('returns null for non-zip bytes (fail safely, never throws)', async () => {
  const entry = await extractFirstEntry(new Uint8Array([1, 2, 3, 4]), '.json');
  assert.equal(entry, null);
});

test('returns null when no matching entry exists', async () => {
  const zip = makeZip([{ name: 'notes.txt', content: 'no json here' }], true);
  const entry = await extractFirstEntry(zip, '.json');
  assert.equal(entry, null);
});
