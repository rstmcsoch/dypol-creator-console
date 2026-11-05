/* Narration voices + design patterns for the Make and Settings pages.
   The voice list comes from /config/voices.json (Kokoro English voices);
   custom voices / blends saved in Settings (`customVoices`) are added after it.
   The server validates every choice again (functions/api/_lib/voices.js). */
import { esc } from './ui.js';

export const DEFAULT_VOICE = 'am_michael';
export const DEFAULT_PATTERN = 'elements';
export const PATTERNS = [
  { id: 'elements', label: 'Elements & animation', enabled: true },
  { id: 'characters', label: 'Characters — coming soon', enabled: false },
];

let cache = null;
export async function loadVoices() {
  if (cache) return cache;
  try {
    const res = await fetch('/config/voices.json', { credentials: 'same-origin' });
    const data = res.ok ? await res.json() : null;
    cache = Array.isArray(data?.voices) ? data.voices : [];
  } catch { cache = []; }
  if (!cache.length) cache = [{ id: DEFAULT_VOICE, label: 'Michael · US male', lang: 'en-us', gender: 'male' }];
  return cache;
}

/** <option>s: built-in voices (US / UK groups) then the owner's own voices. */
export function voiceOptions(voices, custom = [], selected = DEFAULT_VOICE) {
  const opt = (v) => `<option value="${esc(v.id)}" ${v.id === selected ? 'selected' : ''}>${esc(v.label || v.id)}</option>`;
  const us = voices.filter((v) => String(v.lang || '').startsWith('en-us'));
  const uk = voices.filter((v) => !String(v.lang || '').startsWith('en-us'));
  const mine = (Array.isArray(custom) ? custom : []).filter((c) => c && c.id && !voices.some((v) => v.id === c.id));
  const known = [...voices, ...mine].some((v) => v.id === selected);
  return [
    us.length ? `<optgroup label="US English">${us.map(opt).join('')}</optgroup>` : '',
    uk.length ? `<optgroup label="UK English">${uk.map(opt).join('')}</optgroup>` : '',
    mine.length ? `<optgroup label="Your voices">${mine.map(opt).join('')}</optgroup>` : '',
    known ? '' : `<option value="${esc(selected)}" selected>${esc(selected)}</option>`,
  ].join('');
}

export function patternOptions(selected = DEFAULT_PATTERN) {
  return PATTERNS.map((p) => `<option value="${p.id}" ${p.id === selected && p.enabled ? 'selected' : ''} ${p.enabled ? '' : 'disabled'}>${esc(p.label)}</option>`).join('');
}
