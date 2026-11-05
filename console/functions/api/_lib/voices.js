/**
 * Narration voice + design pattern validation (server side).
 *
 * The id list mirrors console/config/voices.json (the file the Make and
 * Settings pages read). tests/voices.test.js fails if the two drift apart.
 * Kept as a JS module so Pages Functions and Node tests import it the same way.
 *
 * A voice is either a known id (Kokoro English list + ids saved in settings
 * `customVoices`) or a blend "a:0.6,b:0.4" of known single ids whose weights
 * add up to 1.
 */
export const KOKORO_VOICE_IDS = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];
export const DEFAULT_VOICE = 'am_michael';
export const DESIGN_PATTERNS = ['elements'];
export const DEFAULT_DESIGN_PATTERN = 'elements';
export const MAX_CUSTOM_VOICES = 30;

/** Shape of a single Kokoro voice id: 2-letter prefix (lang+gender) + name. */
const ID_RE = /^[a-z]{2}_[a-z0-9]{2,24}$/;

/** "a:0.6,b:0.4" → [{ id, weight }] or null when it is not blend syntax. */
export function parseBlend(spec) {
  const s = String(spec ?? '').replace(/\s+/g, '');
  if (!s.includes(':')) return null;
  const parts = s.split(',');
  if (parts.length < 2 || parts.length > 4) return null;
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([a-z]{2}_[a-z0-9]{2,24}):(\d*\.?\d+)$/);
    if (!m) return null;
    const weight = Number(m[2]);
    if (!(weight > 0 && weight < 1)) return null;
    out.push({ id: m[1], weight });
  }
  if (new Set(out.map((p) => p.id)).size !== out.length) return null;
  const sum = out.reduce((a, p) => a + p.weight, 0);
  if (Math.abs(sum - 1) > 0.011) return null;
  return out;
}

/** Normalised string form of a voice spec (spaces removed). */
export const normVoice = (v) => String(v ?? '').trim().replace(/\s+/g, '');

/** Syntactic check for an id or blend the owner may ADD as a custom voice
 *  (it may be a Kokoro voice outside the English list, e.g. another language). */
export function isVoiceSyntax(v) {
  const s = normVoice(v);
  return ID_RE.test(s) || !!parseBlend(s);
}

/** Single ids that are known: Kokoro English list + custom single ids. */
export function knownVoiceIds(customVoices = []) {
  const ids = new Set(KOKORO_VOICE_IDS);
  for (const c of Array.isArray(customVoices) ? customVoices : []) {
    const id = normVoice(c?.id);
    if (ID_RE.test(id)) ids.add(id);
  }
  return ids;
}

/** Validate a voice for a run. Returns { ok, value } or { ok:false, error }. */
export function validateVoice(v, customVoices = []) {
  const s = normVoice(v);
  if (!s) return { ok: false, error: 'Pick a voice.' };
  if (s.length > 120) return { ok: false, error: 'Voice is too long.' };
  const known = knownVoiceIds(customVoices);
  if (known.has(s)) return { ok: true, value: s };
  const customBlends = new Set((Array.isArray(customVoices) ? customVoices : [])
    .map((c) => normVoice(c?.id)).filter((id) => id.includes(':')));
  const blend = parseBlend(s);
  if (blend) {
    const unknown = blend.filter((p) => !known.has(p.id)).map((p) => p.id);
    if (!unknown.length || customBlends.has(s)) return { ok: true, value: s };
    return { ok: false, error: `Unknown voice in blend: ${unknown.join(', ')}.` };
  }
  if (s.includes(':') || s.includes(',')) {
    return { ok: false, error: 'A blend looks like “af_bella:0.6,am_michael:0.4” — 2 to 4 voices, weights adding up to 1.' };
  }
  return { ok: false, error: `Unknown voice “${s}”. Pick one from the list or add it in Settings → Add voice.` };
}

export function validateDesignPattern(p) {
  const s = String(p ?? '').trim();
  return DESIGN_PATTERNS.includes(s)
    ? { ok: true, value: s }
    : { ok: false, error: `Design pattern must be one of: ${DESIGN_PATTERNS.join(', ')}.` };
}

/** Clean a customVoices list from the Settings page; throws on a bad entry. */
export function sanitizeCustomVoices(list) {
  if (!Array.isArray(list)) throw new Error('customVoices must be a list.');
  if (list.length > MAX_CUSTOM_VOICES) throw new Error(`At most ${MAX_CUSTOM_VOICES} custom voices.`);
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const id = normVoice(c?.id);
    if (!isVoiceSyntax(id)) throw new Error(`“${String(c?.id ?? '').slice(0, 60)}” is not a voice id (like am_michael) or a blend (like af_bella:0.6,am_michael:0.4).`);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = String(c?.label ?? '').trim().replace(/[<>]/g, '').slice(0, 60) || id;
    out.push({ id, label });
  }
  return out;
}
