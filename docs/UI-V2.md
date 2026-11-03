# Console UI v2 — simple design (31 Oct 2026)

Goal: anyone opening the console for the first time can use it without technical help.
Main path: **Make a video → Check it → Publish.** UI-only change; API and safeguards unchanged.

## Navigation
- Phone/tablet (≤1024 px): bottom tab bar — **Home · Videos · (+) Make · Settings**. No sidebar.
- Desktop: slim sidebar with a "Make a new video" button, Home / Videos / Settings, and an **Advanced** group.
- Advanced pages (also linked from Settings → More tools): Video makers (`#/makers`, was Pipelines),
  Calendar, Technical history (`#/runs`, was Run History), Channel stats (`#/analytics`).
- Old links still work: `#/overview` → Home, `#/queue` → Videos, `#/pipelines` → Video makers.

## Screens
- **Home**: Needs you (videos waiting for your check, approved-not-uploaded, recent failures), big
  "Make a new video", Uploads today (x of N), Being made (step x of y · about N min left · Stop),
  Recent videos, next automatic video, System status folded (banner only when something is wrong).
- **Make**: pick "Long video + Short" or "Short only", optional topic, category → Start making.
  "More ways to make" (folded): what to run (phase), Let the system choose, Make both and compare,
  Save as an idea.
- **Videos**: To check / Being made / All, search & filters folded. Tap → check screen with player,
  "What goes to YouTube" (+ Edit), Details folded (checks, files, steps, logs, IDs) and a sticky
  action bar: **Approve & publish** (one confirm), Redo, Reject (reason chips + text; reason required).
- **Settings**: Safety rules summary, Everyday settings, More tools, Advanced groups (Video makers,
  Video maker plan, Publishing rules, Automatic schedule, Cloud connection, System status, About).
  Same element ids and the same save payload as before.

## Vocabulary
One table in `assets/js/ui.js` (`statusInfo`) — e.g. needs-review/awaiting-review → "Waiting for your
check", failed → "Didn’t finish", publish_failed → "Upload didn’t finish", published → "On YouTube
(Unlisted)". Errors go through `friendlyError()` (title + what to do next).

Tests: `node --test tests/ui.test.js`.

## Delete (added 2026-11-01, commit 9e4e895)
- Delete lives on the video detail sheet and as a bulk action in Videos (select mode).
- Deletes from the system only: dashboard/D1 rows, GitHub runs, artifacts and draft files. It never deletes anything from YouTube; a published video's sheet says so.
- Linked versions (other versions made from this video: Redo / fallback children, e.g. a "Short only" version made from a long video) are **never deleted by default** (since 3 Nov 2026). The confirm sheet lists each linked version on its own row — video maker, title, status, and "on YouTube (stays there)" — with an unticked checkbox. Only the versions the owner ticks are deleted with it (`POST /api/jobs/:id/delete {include:[ids]}`; `GET …/delete?include=` shows the plan, with `linked[]`). Unticked versions stay and are detached from the deleted video (parent cleared). A version that is uploading can't be ticked.
- Delete also removes the video's stored files in Cloudflare R2 (drafts/ and published/); the sheet counts them as "stored video files".
- Deleting does not free the daily cap (cap_ledger).
- Screens: notes/ui-screens-2026-10-31/delete/ in the project workspace.

## Review player (added 3 Nov 2026)
Replaces the browser's default `<video>` on the check screen (`assets/js/player.js`, no library, ~20 KB).
- Big play/pause; tap the left / right third of the picture to skip −5 s / +5 s, middle = play/pause.
- Draggable scrubber (36 px touch target) with a thumbnail strip (sprite made by the engine), chapter marks
  (long video), amber QC-warning marks (silence / black / frozen picture from qc.json) and blue note marks.
- Buttons: −5 / +5, frame back / forward (hidden ≤420 px, still on , and .), speed 0.5/1/1.5/2×, captions (CC),
  mute, full screen; chips: **Full quality** (switches to the original render at the same moment),
  **Download original**, **Next warning (n)**, **Note at m:ss**; chapter chips jump to a chapter.
- Engine A shows "Long video | Short" tabs in the same player.
- Keyboard: Space/K play · ←/→ 5 s · J/L 10 s · , . frame · < > speed · M mute · F full screen · C captions ·
  N note · Q next warning · 0–9 jump to 0–90 %.
- Timestamped notes are kept in this browser per video and pre-fill the Reject reason and the Redo feedback
  ("0:12 — Blurry image", "0:03 (Short) — …").
- Streaming: `preload="metadata"`, HTTP Range from R2 (206), nothing downloaded first; the progress bar is
  drawn with requestAnimationFrame and a drag seeks once on release (fastSeek while dragging where supported).

## Video storage — Cloudflare R2 (added 3 Nov 2026)
- Bucket `dypol-media` (free 10 GB), private (no r2.dev / custom domain). Binding `MEDIA` in `console/wrangler.toml`.
- Engines upload after each draft (`scripts/dypol_r2.py`, S3 API, secrets R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
  R2_SECRET_ACCESS_KEY / R2_BUCKET) to `drafts/<job_id>/`: the ORIGINAL render(s) (must be 720p–1080p: long
  1280×720–1920×1080, Short 720×1280–1080×1920; never upscaled; out of range fails the draft unless repo
  variable `DYPOL_RESOLUTION_POLICY=warn`), a review copy (H.264 CRF 28, veryfast, +faststart, keyframe every
  1 s; long ~960×540, Short ~720×1280, never above the source), thumbnail strips, WebVTT captions, thumbnail,
  qc.json and manifest.json (last). An upload failure only warns; the console then uses the GitHub artifacts.
- Console: `/api/jobs/:id/media` tries R2 first (`kind=video|short` review copy, `quality=full` original,
  `kind=info|sprite|captions` for the player) and falls back to artifacts. All behind the login.
- Lifecycle rule `expire-drafts`: `drafts/` objects are deleted after 30 days. Published videos are moved to
  `published/<job_id>/` (no expiry) after publish (webhook) and whenever the storage line is opened.
- Settings → Advanced → System status → **Video storage**: "x of 10 GB used · n drafts, n published · drafts
  removed after 30 days" (`GET /api/storage`).

Tests: `node --test tests/r2.test.js tests/delete.test.js tests/ui.test.js`.
