# Testing — DYPOL Creator Console

All results below are from real test runs in this repository on 2026-10-27
(pre-deployment repair suite; Node.js 20.20.2, Python 3.13.16). Simulated
tests use mocked credentials and are labelled; live-service tests need real
credentials and are listed separately in §Manual. Nothing is faked or
aspirational.

## Automated test matrix (pre-deployment repair)

| # | Suite | Command | Checks | Result | Type |
|---|---|---|---|---|---|
| 1 | API smoke, safeguards & gate regressions | `node --test tests/api.smoke.test.js` | 28 | **28/28 PASS** | simulated (demo backend) |
| 2 | Duplicate-prevention normalisation | `node --test tests/dedupe.test.js` | 5 | **5/5 PASS** | unit |
| 3 | Deployment consistency | `node --test tests/deploy_checks.test.js` | 6 | **6/6 PASS** | static/unit |
| 4 | Artifact-result recovery (ziputil) | `node --test tests/ziputil.test.js` | 4 | **4/4 PASS** | unit (real zip bytes) |
| 5 | Engine A phase semantics | `python3 tests/engine_a_phase.test.py` | 20 | **20/20 PASS** | simulated (mock upload fns) |
| 6 | Engine B draft→publish handoff | `python3 tests/engine_b_handoff.test.py` | 10 | **10/10 PASS** | simulated |
| 7 | Workflow structure & least-privilege | `python3 tests/workflow_checks.test.py` | 9 | **9/9 PASS** | static (YAML parse) |
| 8 | Engine B image-gen migration | `python3 tests/broll_migration.test.py` | 18 | **18/18 PASS** | static |
| | **Total** | | **100** | **100/100 PASS** | |

Static checks (always run before release): `node --check` on every JS file,
`py_compile` on every Python patch/test, YAML parse on both workflows — all clean.

### What each new suite proves (per the pre-deployment requirements)

| Required proof | Test |
|---|---|
| Engine A draft mode does not upload anything | `engine_a_phase` — `test_draft_saves_candidate_and_never_uploads` |
| Engine A publish mode does not regenerate the lesson | `engine_a_phase` — `test_publish_uploads_saved_candidate_without_generating` |
| Both Engine A video IDs preserved after full production | `engine_a_phase` — `test_both_video_ids_preserved_separately` (+ plan `youtube_id`/`youtube_short_id`) |
| Engine B can publish a draft from an earlier workflow run | `workflow_checks` — cross-run `download-artifact` + durable `dypol-drafts/` snapshot; `engine_b_handoff` provenance tests |
| Missing artifacts fail safely (no accidental generation/publication) | `engine_a_phase` — `test_missing_candidate_fails_safely`; `engine_b_handoff` — `test_media_missing_refused` |
| Review-required blocks unapproved uploads | `engine_a_phase` — `test_full_blocked_under_review_required`; `api.smoke` — `full-phase dispatch is demoted to draft` |
| Duplicate clicks/retries cannot upload the same candidate twice | `api.smoke` — `double-click publish cannot double-upload`, `re-publishing a job already uploading is refused` |
| Result reporting handles real and simulated failures | `engine_a_phase` — `test_partial_upload_failure_keeps_first_record` (partial recorded); `engine_b_handoff` — failed/simulated uploads write nothing; `ziputil` — recovery from artifact backup |
| Least-privilege workflow permissions support all operations | `workflow_checks` — job-scoped `contents: write` only where pushes happen; `deploy_checks` — no secrets in config |

## Manual verification (requires YOUR credentials — not yet run)

These cannot be claimed until performed against the real services:

1. Fork + patch both engines (`engines/README.md`), then a **draft**-phase
   dispatch of each engine → GitHub Actions completes → console *Sync GitHub*
   shows the real run status and artifacts.
2. Approve a draft → *Publish* with visibility **private** → confirm the
   workflow's `videos.insert` log shows `privacyStatus='private'` and
   `dypol-results/<run>.json` carries the real video ID → console marks it
   Published with that ID.
3. Re-publish the same job → must answer “already on YouTube — no duplicate”.
4. Engine B two-run handoff: dispatch `draft` (run 1) → publish (run 2 with
   `job_id` + `draft_run_id`) → confirm the upload used run 1's artifact.
5. Third upload of the day → must be refused by the daily cap.

## Visual & responsive checks (2026-10-27)

| Viewport | Verified |
|---|---|
| 1440×900 desktop | full dashboard, tables, drawers |
| 1280×800 tablet landscape | 2-column layouts keep working |
| 820×1180 tablet portrait | stacked cards, sidebar becomes drawer |
| 390×844 mobile | tables reflow to labelled stacked rows, single column, full-width drawer |

Screenshots in `screenshots/` (12 files). Chromium 131 headless via
playwright-core; run harness kept at `/home/user/pw/shot.mjs` (environment).
