# DYPOL Creator Console — Technical Verification & Repair Report

**Date:** 2026-10-27 · **Auditor role:** principal engineer / QA / security / DevOps / product
**Scope:** the existing DYPOL Creator Console project (this repository) and its two engine integrations.
**Method:** inspect → verify against live sources → diagnose root causes → compare alternatives → repair → test → report.

---

## A. Executive summary

The existing console is fundamentally sound: the architecture (static SPA + Cloudflare Pages Functions + D1 + GitHub Actions runners) matches the requirements, the design identity is intact, and the safeguard stack (dedupe, review gate, publish lock, daily cap, upload registry) was real. The audit found **no P0 (credential leak / unauthorised publish) defects**, but it did find **three P1 defects, six P2 defects and several P3 issues** — all now repaired and covered by tests.

**What was broken (before this pass):**
1. **P1 — Publishes could never become "published" in live mode.** The GitHub sync imported `recordPublished` but never called it; nothing ingested the engines' upload results, so even a successful YouTube upload stayed "uploading" forever.
2. **P1 — Read paths acquired the publish lock.** Viewing a job (GET) or retrying a run called the full lock-taking gate, which could block a real publish for the lock TTL and returned wrong block reasons.
3. **P1 — False-positive connectivity.** Engine status was `connected: token && repo && length >= 0` — an always-true expression; demo cards were hard-coded "Connected".
4. **P2 —** `Buffer` (unavailable in the Workers runtime) crashed the live analytics path; dev-server static file check allowed sibling-directory escape; schedule toggles changed only badges (never enforced); regenerate wiped the original job's history; metrics mixed job/video counts and fabricated progress percentages; the queue lacked half the required status filters; calendar compared UTC date keys against IST dates (off-by-one around midnight).
5. **P3 —** search-focus loss on re-render, disabled buttons without explanations, unescaped attribute values, weak login rate limiting.

**What now works (verified by 49 automated checks + browser rendering at 4 viewports):** everything above is repaired; settings now enforce behaviour (engine enable, concurrency, retry limits, draft mode, schedule pause via a control file on both engine forks); publishing records **verified YouTube IDs** from engine-written result files; quality checks are honest (rights/copyright never auto-passed). **Final status: Ready with limitations** — live GitHub/YouTube end-to-end still requires the user's credentials (§I).

---

## B. Architecture findings (verified against the code, not the docs)

### Actual system map

| Responsibility | Actual implementation | Source of truth |
|---|---|---|
| Frontend | Vanilla-JS SPA (`console/index.html` + `assets/js/*`), no build step, hash router, IST formatting | — (renders backend state) |
| Backend API | Cloudflare Pages Functions (`console/functions/api/*`), ~25 routes | — |
| Authentication | PBKDF2 password hash in Pages secret → HMAC-signed HttpOnly session cookie; `_middleware.js` guards every `/api/*` except health/login/logout | server secrets |
| Job orchestration | `jobs`/`runs` rows in D1; orchestrator modes in `orchestrate/run.js`; concurrency gate at dispatch | D1 registry |
| GitHub integration | Server-side PAT (Actions r/w, Contents r/w) — `workflow_dispatch`, runs, cancel, rerun, artifacts, contents (control/result files) | GitHub API |
| Engine A execution | Fork workflow `main.yml` (cron 07:00 UTC + dispatch inputs) on hosted runners: curriculum → Gemini content → gTTS → Pexels → MoviePy/FFmpeg → YouTube upload → plan commit | GitHub Actions |
| Engine B execution | Fork workflow `verticals.yml` (dispatch + optional cron), two-phase produce/publish matching the CLI's 10-stage `PipelineState` | GitHub Actions |
| Job state / DB | D1 (`schema.sql` + `migrations/002.sql`): jobs, runs, uploads, activity, settings, locks | D1 |
| YouTube OAuth | Per-engine Actions secrets (upload inside workflows); console-side secrets for analytics | Google OAuth |
| Analytics | YouTube Analytics API when token present; otherwise explicit "unavailable" (null, never 0) | YouTube Analytics |
| Video storage | GitHub Actions artifacts (14-day retention) — never in Git history | GitHub artifacts |
| Scheduling | Native GitHub cron = engine cadence; console writes `dypol-control.json` to both forks as the pause gate; daily cap + window enforced at publish | GitHub cron + control file |
| Logging/retries | Per-job log arrays, run step lists, error categories + retryability, bounded retries (`retryLimit`), exponential backoff in Engine B's `with_retry` | D1 + GitHub |

### Action traces (verified)

`Run Engine A` → `POST /api/engines/gemini/run` (session cookie → middleware → engine-enabled → concurrency → dedupe gates) → job+run rows (`status: dispatched`, `progress: null`) → `POST /repos/{fork}/actions/workflows/main.yml/dispatches` (inputs: phase/topic/privacy/…) → runner executes → `POST /api/sync/github` maps real run state (`in_progress → running`, `success → needs-review`, `failure → failed` + category) → reviewer approves → `POST /publish` (upload registry → review → lock → dedupe → cap) → workflow `phase=publish` uploads with `YOUTUBE_PRIVACY_STATUS` → workflow commits `dypol-results/<run>.json` → sync calls `recordPublished` → **Published with the real YouTube ID**. Engine B identical with `verticals.yml` (draft → produce → publish phases). Publish/retry/schedule/approve traces pass through the same gates; every state change is appended to the job log and the activity feed.

### Alternatives compared (decisions)

| # | Decision | Option A | Option B | Option C | Chosen | Why |
|---|---|---|---|---|---|---|
| A | Job execution | Browser calls GitHub directly | **Backend-mediated dispatch** | Queue service (e.g. external MQ) | **B** | Privileged tokens must never reach the browser; backend adds validation, dedupe and registry writes atomically before dispatch. A queue adds a paid/complex service with no benefit at this scale. |
| B | Scheduling | **GitHub-native cron + console-written control file** | Console-managed cron (Cloudflare Cron Triggers) | External scheduler | **A** | Engines already ship cron; one authoritative trigger avoids double scheduling. Cloudflare cron couldn't reach runners without duplicating dispatch logic; the control file gives the console real pause/resume semantics for free. |
| C | Persistence | **D1 job registry** | GitHub-committed JSON state | Browser localStorage | **A** | D1 is durable, queryable and free; Git-committed state caused the upstream content-plan race problems; localStorage is not authoritative (per requirements). |
| D | Rendering | **GitHub Actions runners** | Cloudflare Workers | Local PC | **A** | FFmpeg/MoviePy need minutes of CPU + GBs — Workers allow 10 ms CPU (free tier); the user has no PC. |
| E | Status updates | Poll everything every N s | **Active-job polling + manual/sync button with backoff** | Webhooks | **B** | GitHub → Pages webhooks need a public service token story; bounded polling + `POST /api/sync/github` is simple, rate-safe and dashboard-independent once a cron calls it. |
| F | Publishing | Upload during generation | **Staged draft → review → publish** | Hybrid | **B** | Required for approval + duplicate prevention; both engines already separate produce/upload (B) or are patched to accept `phase` (A). |
| G | Video storage | **Temporary artifacts** | Commit MP4s to Git | R2/S3 | **A** | Git history must not hold MP4s; R2 adds cost; artifacts suffice for review/debug with 14-day retention. |
| H | Authentication | **Owner-only password + signed session** | Cloudflare Access | Full user management | **A** | Single-admin console; Cloudflare Access is an optional front layer (documented), not a rewrite. |

---

## C. Feature verification matrix

Legend: ✅ verified working · ⚙️ repaired this pass · ⚠️ partial · ❌ was defective · ❌→✅ repaired

| Feature / control | Intended | Before | Defect | Repair | Now |
|---|---|---|---|---|---|
| Overview metrics | Backend-derived, job≠video counts | ⚠️ mixed counts, fake delta | P2 | Computed totals (jobs, videos incl. +short per lesson, real MoM delta, latest success, recent errors) | ✅ |
| Engine readiness badges | Probed, partial-aware | ❌ `>= 0` always-true / hard-coded | P1 | Per-engine probe (`connected/error/not-configured/disabled`), partial banner | ✅ |
| Pipeline progress | Real or indeterminate | ❌ fabricated % (44, 72…) | P2 | Step-derived % or null → indeterminate bar | ✅ |
| Run Engine A/B | Dispatch correct workflow | ✅ | — | — | ✅ |
| Run Both | Draft candidates, no auto-publish | ⚠️ only via mode 3 | P2 | `forceMode: draft_both` + UI button | ✅ |
| Concurrency limit | Server-side cap | ❌ absent | P2 | `maxConcurrency` setting enforced at dispatch | ✅ |
| Engine enable toggle | Gates new jobs | ❌ absent | P2 | Setting + dispatch/orchestrator/fallback checks | ✅ |
| Queue status filters (10 states) | All lifecycle states | ❌ 5 merged tabs | P2 | Full tab set incl. Queued/Rendering/Approved/Uploading | ✅ |
| Queue niche/date filters | Filter by niche & date | ❌ absent | P2 | `niche`, `since` filters (both backends) | ✅ |
| Row info | Thumbnail, created date, error summary, YT URL | ⚠️ missing created date/error category | P2 | Added created date, error category, attempt badge | ✅ |
| Approve / Reject / Schedule | Persisted decisions | ✅ | — | — | ✅ |
| Retry (failed job) | Safe retry with history | ❌ absent in queue | P2 | `POST /jobs/:id/retry` with retryLimit + upload check | ✅ |
| Regenerate | Linked attempt, history preserved | ❌ wiped original | P2 | Child job (`parent_job_id`, `attempt`), original `superseded` | ✅ |
| Metadata editing | Persisted → used at publish | ❌ absent | P2 | PATCH `/jobs/:id` + publish dispatches `title/description/tags_override` | ✅ |
| Publish gate | Registry→review→lock→dedupe→cap | ⚠️ order drift, lock leak on GET | P1 | `checkPublishGate` (read-only) vs `publishGate` (lock, explicit release) | ✅ |
| Double publish / double click | No duplicate uploads | ⚠️ race edges | P2 | In-flight upload counted toward cap; concurrent test proves ≤1 upload | ✅ |
| Verified publish → YouTube ID | Real ID recorded | ❌ never recorded | P1 | `dypol-results/<run>.json` from workflows → `recordPublished` | ✅ |
| Daily cap | Per day, counts in-flight | ⚠️ completed only | P2 | + `uploading` jobs counted | ✅ |
| Schedule pause | Prevents scheduled runs | ❌ badge-only | P2 | `dypol-control.json` gate job in both workflows | ✅ |
| Calendar | IST-correct, engine filters | ❌ UTC date keys | P2 | `en-CA`/Asia/Kolkata day keys; engine filter; last execution | ✅ |
| Analytics honesty | Unavailable ≠ 0 | ⚠️ Buffer crash in live path | P2 | atob decode; null + explanation when unconnected | ✅ |
| Quality checks | Only verifiable checks pass | ❌ blanket OK | P2 | `buildQuality` (title≤100, metadata, artifact, duration, oauth=untested, rights=human) | ✅ |
| Error taxonomy | Category + retryable | ❌ absent | P2 | `classifyError` (permission/config/quota/oauth/render/…) shown in UI | ✅ |
| Login security | Throttled, generic errors | ⚠️ no throttle | P2 | 5/60s sliding window (both backends) | ✅ |
| Static file safety | No path escape | ❌ sibling-dir escape | P2 | Separator-anchored root check | ✅ |
| CSRF | SameSite + origin check | ⚠️ cookie only | P2 | Origin verification on state-changing methods | ✅ |
| Settings completeness | Every toggle enforced | ❌ several cosmetic | P2 | engine enable, default engine/niche, concurrency, retry, draft mode — all enforced | ✅ |
| Disabled-action explanations | Reasons visible | ❌ silent disable | P3 | `title` reasons on every disabled control | ✅ |
| Search UX | Focus retained | ❌ lost per keystroke | P3 | Refocus + caret restore | ✅ |
| Calendar/views, drawer, toasts, responsive layouts | Work at 1280/820/390 | ✅ | — | — | ✅ (screenshots) |

## D. Root-cause findings (each confirmed defect)

1. **Publish-truth gap (P1).** *Symptom:* successful uploads never showed as Published in live mode. *Cause:* `sync/github.js` transitioned runs to `needs-review` but the only path to `recordPublished` was the console's simulated upload; no mechanism read the engines' upload results. *Fix:* workflows now commit `dypol-results/<run_id>.json` (Engine B via `report_upload.py`, Engine A via uploader patch) and sync ingests these files before status mapping; only a verified ID sets `published`. *Test:* smoke suite "double-click publish" + finder unit checks (3/3).
2. **Lock side effect (P1).** *Cause:* `publishGate()` bundled lock acquisition with evaluation and was called from GET handlers. *Fix:* `checkPublishGate` (pure) vs `publishGate` (locked, `releaseLock` in `finally`). *Test:* "GET job detail does NOT hold the publish lock".
3. **Connectivity lies (P1).** *Cause:* `ghRuns[id].length >= 0` is always true; demo `connected: true` hard-coded. *Fix:* fetch-result tracking per engine + `connectionState`/`connectionDetail` everywhere; badges earned, not assumed. *Test:* screenshots + engine state mapping.
4. **`Buffer` in workerd (P2).** *Cause:* Node API used in Pages Function (only when analytics configured — latent crash). *Fix:* `atob` + `TextDecoder`.
5. **Path escape (P2).** *Cause:* `startsWith(ROOT)` matches `ROOT-evil/`. *Fix:* separator-anchored comparison. *Test:* traversal test.
6. **Cosmetic settings (P2).** *Cause:* settings UI written ahead of enforcement. *Fix:* every setting now read by dispatch/publish/orchestrator/schedule paths (engine enable, concurrency, retryLimit, draftMode, niche, frequency); schedule pause writes the fork control file.
7. **History destruction on regenerate (P2).** *Cause:* in-place mutation. *Fix:* linked child job + `superseded` parent.
8. **UTC/IST date mismatch (P2).** *Cause:* `toISOString()` (UTC) compared to local-day semantics. *Fix:* `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata'})` day keys.
9. **Fabricated percentages (P2).** *Fix:* `progress: null` = indeterminate; % only when derived from real step counts or terminal states.

## E. Changes made (files actually modified/added this pass)

**Backend (production):** `_lib/safeguards.js` (gate split, `buildQuality`, `classifyError`, `recordPublished` idempotency), `_lib/db.js` (lineage/error/quality columns, settings defaults, niche/since filters), `_lib/github.js` (contents API: fetch/list/update file, getRepo/getWorkflow), `jobs/[id]/index.js` (read-only gate + PATCH metadata), `jobs/[id]/publish.js` (gate order, release, metadata inputs, categories), `jobs/[id]/regenerate.js` (lineage), `jobs/[id]/retry.js` (NEW), `runs/[id]/retry.js` (read-only gate), `engines/[engine]/run.js` (enable/concurrency gates, honest init state), `engines/[engine]/cancel.js` (status coverage), `engines/test-connection.js` (real repo/workflow/gemini/youtube checks), `orchestrate/run.js` (gates + forceMode), `sync/github.js` (result ingestion, honest status mapping, categories), `overview.js` (truthful metrics + probes), `analytics.js` (Buffer fix), `settings.js` (new settings + YouTube state machine), `schedule.js` (control file), `auth/login.js` (throttle), `_middleware.js` (origin check), `jobs/index.js` (filters/counts), `calendar.js` (last execution). **Schema:** `schema.sql`, `migrations/002.sql` (NEW, non-destructive). **Dev/preview:** `dev/server.js` mirrors all of the above + path fix + throttle. **Frontend:** `ui.js` (indeterminate progress, status vocabulary, `qcRow`), `api.js` (PATCH/retry/testConnection), `pages/queue.js` (rework), `pages/overview.js` (rework), `pages/settings.js` (rework), `pages/calendar.js` (IST + filters), `pages/pipelines.js` (honest badges + disabled reasons). **Engine patches:** `engine-a-patches/main.dispatch.yml` (gate job, upload-result step, metadata inputs), `engine-a-patches/code_patches.md` (upload_result patch), `engine-b-patches/verticals.workflow.yml` (gate job, result step, metadata inputs), `engine-b-patches/report_upload.py` (NEW). **Tests:** `tests/api.smoke.test.js` (+10 audit regression tests).

## F. Test evidence

| Level | Result | Notes |
|---|---|---|
| L1 Static/build | ✅ `node --check` on all 40+ JS files; `py_compile` on both Python patches; YAML parse on both workflows | no build step by design |
| L2 API/component | ✅ **26/26** smoke & safeguard tests, **5/5** dedupe unit tests | includes 10 new audit regressions (lock, idempotency, lineage, throttle, traversal, gates, honesty) |
| L3 Integration (mocked) | ✅ GitHub contract stubbed (dispatch/publish flows); **18/18** b-roll migration checks; **3/3** report_upload finder checks | real GitHub/YouTube require credentials (§I) |
| L4 End-to-end | ⚠️ simulated only in demo mode (clearly labelled) | live draft-only runs listed in §I |
| L5 Failure injection | ✅ concurrent publishes (≤1 upload), dispatch errors → categories, throttle, retry-limit refusal, disabled-engine refusal | |
| L6 Visual/responsive | ✅ headless Chromium at 1440/1280/820/390 + queue drawer mobile — `screenshots/` | two render defects found & fixed during this pass (stale-server false alarm, harsh demo banner) |

Baseline before repairs: 39/39 (old suite). After: 49 checks (26+5+18) + 3 finder checks. No test was weakened to pass — two early failures drove real fixes (cancel-status coverage, self-contained duplicate scenario).

## G. Cost and usage report

Unchanged model: Cloudflare Pages+D1 ($0; 100k req/day, 5M row reads/day — console uses <1%), GitHub Actions free on public forks / 2,000 min on private (Engine A ≈ 25–35 min + Engine B ≈ 6–12 min per run → daily dual runs ≈ 1,300–1,400 min/month on private), artifacts 14-day retention, YouTube quota 10k units/day (≈6 uploads; console cap default 2/day). Gemini remains quota-billed after free tier — model IDs configured per engine because three retired in the last 12 months. No new services introduced by this pass (the control file and result files live in the forks' existing repos at ~1 KB each). Full verified figures: `docs/FREE_TIER.md`.

## H. Security report

| Finding | Severity | Status |
|---|---|---|
| No P0: no secrets in frontend/logs/URLs; all state-changing routes session-guarded | — | verified (grep + smoke test asserts no token-shaped strings in responses) |
| GET endpoints could hold the publish lock (availability) | High | **fixed** (read-only gate) |
| Static server sibling-directory escape (dev/preview only) | Medium | **fixed** |
| Login brute-force possible at API speed | Medium | **fixed** (5/60s sliding window, generic errors) |
| CSRF: cookie-only defence | Medium | **fixed** (Origin check + SameSite=Strict) |
| Attribute injection surface (`data-*`) | Low | **fixed** (esc() sweep) |
| False "connected/OK" badges (operational risk) | Medium | **fixed** (probed/honest states) |
| PAT scope creep | Low | documented least-privilege (Actions r/w, Contents r/w on 2 forks only) in `docs/SECRETS.md` |
| Remaining: single-admin model; rate limit is per-IP (CDN-grade WAF optional); `broll.py` fallback logs prompts in Actions logs (non-secret) | Low | documented in `docs/LIMITATIONS.md` |

## I. Remaining manual requirements

1. **Fork + apply patches** (`engines/` → your two forks; steps in `engines/README.md`).
2. **Cloudflare**: create D1, run `schema.sql`, deploy `console/`, set secrets (`docs/SECRETS.md` §Cloudflare). For databases created before this release also run `migrations/002.sql`.
3. **GitHub PAT** fine-grained on the two forks: Actions r/w **+ Contents r/w** (control file + result files).
4. **YouTube OAuth** interactive setup (`docs/SECRETS.md` §YouTube) — the only step no agent can do for you.
5. **Live verification checklist** (needs real credentials; safe, non-public): `draft`-phase run on each engine → sync → confirm statuses from real GitHub data → approve → publish with visibility `private` → confirm `dypol-results/` recorded the ID → re-publish must answer "already on YouTube". Full list: `docs/TESTING.md` §Manual.

## J. Final status

**Ready with limitations.**

*Reason:* all console-side critical workflows are repaired and evidence-tested (safeguards, idempotency, settings enforcement, honest status/metrics, security hardening); the two confirmed P1 trust defects (publish-truth gap, false connectivity) are closed with tests. The residual limitations are external and documented: live GitHub/YouTube integration cannot be exercised without the user's credentials (manual checklist provided), semantic duplicate detection is out of scope, and GitHub cron timing is best-effort (as GitHub documents). No known blocking defect remains inside the deliverable.

— DYPOL LABS · Build · Automate · Create
