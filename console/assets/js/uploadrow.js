/* "Upload to YouTube" row on the review popup — which state it is in for a
   job. Pure (no DOM) so it is testable. The row sits right under the player:
   Private / Unlisted / Public, each behind its own confirm (Public needs
   PUBLISH typed, checked again on the server).
   Shown for every made (or being-made) video; hidden only for saved ideas.
   When the options can't be used the buttons stay visible but disabled, with
   the reason as text. Videos already on YouTube show the visibility they were
   sent with (as recorded by the console). */

export const UPLOAD_CHOICES = [
  ['private', 'Private', 'lock'],
  ['unlisted', 'Unlisted', 'eye'],
  ['public', 'Public', 'upload'],
];
export const PRIVACY_WORD = { private: 'Private', unlisted: 'Unlisted', public: 'Public' };

const MAKING = ['dispatched', 'running', 'generating', 'rendering'];
const REASON = {
  making: 'Being made — the options unlock when it’s ready to check.',
  uploading: 'Uploading to YouTube right now.',
  published: 'Already on YouTube — change visibility in YouTube Studio.',
  publish_failed: 'The upload stopped — tap Try upload again below.',
  rejected: 'Rejected — tap Redo for a new version.',
  failed: 'It didn’t finish — try again first.',
  cancelled: 'Stopped — there is nothing to upload.',
  superseded: 'Replaced by a newer version.',
  demo: 'Demo video — nothing to upload.',
  deleting: 'Being deleted.',
  other: 'Not ready to upload.',
};

/**
 * → { show, allowed, mode: 'approve'|'publish'|null, reason, current, onYouTube }
 * realBlock: a real publish blocker (daily cap, duplicate…) for approved videos.
 */
export function uploadRowState(j, { realBlock = null } = {}) {
  const s = j && j.status;
  if (!s || s === 'queued') return { show: false, allowed: false, mode: null, reason: '', current: null, onYouTube: false };
  const onYouTube = s === 'published' || !!(j.youtubeUrl || (j.videos || []).length);
  const current = onYouTube && PRIVACY_WORD[j.privacy] ? j.privacy : null;
  const off = (reason, mode = null) => ({ show: true, allowed: false, mode, reason, current, onYouTube });
  if (j.demo) return off(REASON.demo);
  if (j.deletion) return off(REASON.deleting);
  if (s === 'needs-review' || s === 'awaiting-review') return { show: true, allowed: true, mode: 'approve', reason: '', current, onYouTube };
  if (s === 'approved' || s === 'scheduled') {
    return realBlock ? off(String(realBlock), 'publish') : { show: true, allowed: true, mode: 'publish', reason: '', current, onYouTube };
  }
  if (MAKING.includes(s)) return off(REASON.making);
  if (s === 'published') return off(REASON.published);
  return off(REASON[s] || REASON.other);
}

/** The visibility the console last sent to YouTube, read from the job's publish log line. */
export function privacyFromLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = /Publish dispatched \(visibility=(private|unlisted|public)\b/.exec(String(list[i] && list[i].msg || ''));
    if (m) return m[1];
  }
  return null;
}
