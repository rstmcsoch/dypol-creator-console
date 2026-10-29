/**
 * Minimal ZIP reader for GitHub Actions artifact downloads.
 * Artifact zips contain one or more DEFLATE (or stored) entries; we only need
 * the first small .json file (the upload-result backup) — enough to recover a
 * verified YouTube ID when the git push of dypol-results/ failed after a
 * successful upload.
 *
 * Uses DecompressionStream('deflate-raw'), available in the Workers runtime
 * and Node 18+.
 */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;

function findEocd(view) {
  // EOCD is at the end; scan back over the (max 64 KB) comment window.
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns { name, bytes } for the first entry whose name ends with `suffix`
 *  (default '.json'), or null. Never throws on unrelated corruption — returns
 *  null so callers can fail safely. */
export async function extractFirstEntry(bytes, suffix = '.json') {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0) return null;
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    for (let n = 0; n < count && p + 46 <= bytes.byteLength; n++) {
      if (view.getUint32(p, true) !== CDIR_SIG) return null;
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOfs = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (name.endsWith(suffix) && !name.endsWith('/')) {
        const lNameLen = view.getUint16(localOfs + 26, true);
        const lExtraLen = view.getUint16(localOfs + 28, true);
        const dataOfs = localOfs + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(dataOfs, dataOfs + compSize);
        const out = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
        if (out) return { name, bytes: out };
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  }
}

/** List entry names in a ZIP (central directory only). */
export function listEntries(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0) return [];
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const names = [];
    for (let n = 0; n < count && p + 46 <= bytes.byteLength; n++) {
      if (view.getUint32(p, true) !== CDIR_SIG) break;
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } catch { return []; }
}

/** Extract one named entry ({ name, bytes }) or null. */
export async function extractNamed(bytes, wanted) {
  const r = await extractFirstEntry(bytes, wanted);
  return r && r.name === wanted ? r : null;
}
