/**
 * Read single entries out of a REMOTE zip (a GitHub Actions artifact) with
 * HTTP Range requests, so a 100 MB draft artifact never has to be downloaded
 * or buffered to show one video or read one small JSON file.
 *
 *  - openRemoteZip(url): 2 requests (size probe + tail: EOCD + central
 *    directory; +1 if the directory does not fit in the last 64 KB). ZIP64 aware.
 *  - entryDataOffset(url, entry): 1 request (the 30-byte local header).
 *  - streamEntry(url, entry, rangeHeader): 1 request. Stored entries (method 0,
 *    e.g. upload-artifact compression-level: 0) are streamed byte-for-byte and
 *    support client Range (206). Deflated entries are streamed through
 *    DecompressionStream('deflate-raw') without buffering (200, no Range).
 *
 * Every function throws RangeUnsupported when the server ignores Range, so
 * callers can fall back to a whole-file download.
 */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const Z64_LOCATOR_SIG = 0x07064b50;
const Z64_EOCD_SIG = 0x06064b50;
const TAIL = 65557; // 22-byte EOCD + max 64 KB comment

export class RangeUnsupported extends Error {}

const UA = { 'User-Agent': 'DYPOL-Creator-Console' };

async function rangeFetch(url, range, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { ...UA, Range: `bytes=${range}` } });
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (res.status === 200 || res.status === 416) throw new RangeUnsupported(`Range not honoured (HTTP ${res.status})`);
    const err = new Error(`Range read failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function totalFromContentRange(h) {
  const m = /\/(\d+)\s*$/.exec(h || '');
  return m ? Number(m[1]) : null;
}

const u64 = (view, o) => view.getUint32(o, true) + view.getUint32(o + 4, true) * 2 ** 32;

/** Parse a central directory buffer into entries. */
export function parseCentralDirectory(bytes, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= bytes.byteLength; n++) {
    if (view.getUint32(p, true) !== CDIR_SIG) break;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let localOfs = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extended information extra field (0x0001): only the maxed fields are present, in order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xFFFFFFFF && q + 8 <= e + 4 + len) { size = u64(view, q); q += 8; }
        if (compSize === 0xFFFFFFFF && q + 8 <= e + 4 + len) { compSize = u64(view, q); q += 8; }
        if (localOfs === 0xFFFFFFFF && q + 8 <= e + 4 + len) { localOfs = u64(view, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, method, flags, compSize, size, localOfs });
    p = eEnd + commentLen;
  }
  return entries;
}

/** Open a remote zip: { url, total, entries }. */
export async function openRemoteZip(url, fetchImpl = fetch) {
  // Azure blob storage (where GitHub keeps artifacts) ignores suffix ranges
  // ("bytes=-N" returns the WHOLE blob), so learn the size with a 1-byte probe
  // and then ask for an explicit tail window.
  const probe = await rangeFetch(url, '0-0', fetchImpl);
  const total = totalFromContentRange(probe.headers.get('Content-Range'));
  try { await probe.arrayBuffer(); } catch { /* ignore */ }
  if (!total) throw new Error('Remote zip: missing Content-Range total');
  const tailStart = Math.max(0, total - TAIL);
  const res = await rangeFetch(url, `${tailStart}-${total - 1}`, fetchImpl);
  const tail = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Remote zip: end of central directory not found');
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOfs = view.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOfs === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === Z64_LOCATOR_SIG) {
      const z64Abs = u64(view, loc + 8);
      const z = z64Abs - tailStart;
      if (z >= 0 && view.getUint32(z, true) === Z64_EOCD_SIG) {
        count = u64(view, z + 32);
        cdSize = u64(view, z + 40);
        cdOfs = u64(view, z + 48);
      }
    }
  }
  let cd;
  if (cdOfs >= tailStart) {
    cd = tail.subarray(cdOfs - tailStart, cdOfs - tailStart + cdSize);
  } else {
    const r = await rangeFetch(url, `${cdOfs}-${cdOfs + cdSize - 1}`, fetchImpl);
    cd = new Uint8Array(await r.arrayBuffer());
  }
  return { url, total, entries: parseCentralDirectory(cd, count) };
}

/** Absolute offset of an entry's data (reads its local header). */
export async function entryDataOffset(url, entry, fetchImpl = fetch) {
  const r = await rangeFetch(url, `${entry.localOfs}-${entry.localOfs + 29}`, fetchImpl);
  const b = new Uint8Array(await r.arrayBuffer());
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 30 || view.getUint32(0, true) !== LOCAL_SIG) throw new Error('Remote zip: bad local header');
  return entry.localOfs + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}

/** Parse a single "bytes=a-b" / "bytes=a-" / "bytes=-n" header against `size`. null = whole file. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * Stream one entry. Returns { status, headers, body } for a Response.
 * `dataOfs` may be passed when already known (cached).
 */
export async function streamEntry(url, entry, { range = null, contentType = 'application/octet-stream', dataOfs = null, fetchImpl = fetch } = {}) {
  const ofs = dataOfs ?? await entryDataOffset(url, entry, fetchImpl);
  const base = { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=600' };
  if (entry.method === 0) {
    const size = entry.size;
    const want = parseRange(range, size);
    if (want?.invalid) return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` }, body: null, dataOfs: ofs };
    const start = want ? want.start : 0;
    const end = want ? want.end : size - 1;
    const r = await rangeFetch(url, `${ofs + start}-${ofs + end}`, fetchImpl);
    const headers = { ...base, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
    if (want) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return { status: want ? 206 : 200, headers, body: r.body, dataOfs: ofs };
  }
  if (entry.method === 8) {
    const r = await rangeFetch(url, `${ofs}-${ofs + entry.compSize - 1}`, fetchImpl);
    const body = r.body.pipeThrough(new DecompressionStream('deflate-raw'));
    return { status: 200, headers: { ...base, 'Accept-Ranges': 'none' }, body, dataOfs: ofs };
  }
  throw new Error(`Remote zip: unsupported compression method ${entry.method}`);
}

/** Read a small entry fully (e.g. candidate.json). Caps at `maxBytes`. */
export async function readEntryBytes(url, entry, { maxBytes = 2_000_000, fetchImpl = fetch } = {}) {
  if (entry.size > maxBytes || entry.compSize > maxBytes) throw new Error('Remote zip: entry too large to read');
  const out = await streamEntry(url, entry, { fetchImpl });
  return new Uint8Array(await new Response(out.body).arrayBuffer());
}
