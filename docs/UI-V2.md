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
- Deleting a job also deletes its linked versions (long + Short). The confirm sheet shows the group being deleted, but it does not list each linked version's engine or status (the live delete incident showed it did not name the linked versions). Listing each linked version on the confirm sheet is a proposed improvement awaiting the owner's decision.
- Deleting does not free the daily cap (cap_ledger).
- Screens: notes/ui-screens-2026-10-31/delete/ in the project workspace.
