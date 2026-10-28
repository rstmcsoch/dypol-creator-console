# Engine integration patches

Everything in this folder is applied to **your own forks** — the upstream
repositories are never modified.

```
engine-a-patches/   → your GitHub fork: `gemini-youtube-automation`
engine-b-patches/   → your GitHub fork: `youtube-shorts-pipeline`
```

## Engine A — Gemini YouTube Automation

| File | Apply as | Purpose |
|---|---|---|
| `main.dispatch.yml` | `.github/workflows/main.yml` (replace) | Dispatch inputs (`phase`, `topic`, `privacy`, `language`, `job_id`, `review_required`, `auto_publish`, metadata overrides), job-scoped least-privilege permissions, schedule gate (`dypol-control.json`), multi-video `upload_results.json` → `dypol-results/` + artifact backup. Keeps the daily 12:30 PM IST schedule. |
| `dypol_control.py` | `dypol_control.py` (add, repo root) | **Real phase semantics**: draft = generate + save candidate (no upload); publish = upload the saved candidate only (never regenerate); full = upload only under explicit auto-publish. Topic input, plan preservation, multi-video recording, `videos.insert` privacy verification. |
| `uploader.py` | `src/uploader.py` (replace) | Visibility from `YOUTUBE_PRIVACY_STATUS` (default **private**), insert-body verification before upload, returns full video records (id/url/visibility/kind) so long-form AND Short IDs are both kept. |
| `code_patches.md` | manual edits to `main.py`, `src/generator.py` | Wiring for `dypol_control` (exact diff), plus the `gemini-2.5-flash` → `gemini-3.6-flash` model migration (configurable `GEMINI_TEXT_MODEL`). |

Existing secrets stay valid: `CLIENT_SECRET_B64`, `CREDENTIALS_B64`,
`GOOGLE_API_KEY`, `PEXELS_API_KEY`.

## Engine B — Verticals v3

| File | Apply as | Purpose |
|---|---|---|
| `broll.py` | `verticals/broll.py` (replace) | Migrates the retired `gemini-2.0-flash-exp-image-generation` call to the current Gemini image API (`gemini-nano-banana-2.1` via `generateContent` with `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`). Configurable model + fallback chain, retries, timeouts, Pexels/gradient non-AI fallback with honest provenance (`broll_manifest.json`). |
| `config_additions.md` | add to `verticals/config.py` | `get_pexels_key()` + `get_gemini_image_model()` helpers. |
| `verticals.workflow.yml` | `.github/workflows/verticals.yml` (new) | Two-phase produce/publish with a **durable draft handoff** (per-job artifact + `dypol-drafts/<job>.json` snapshot), cross-run artifact retrieval for publish, job-scoped permissions, schedule gate, result commit + artifact backup. |
| `apply_draft_overrides.py` | `scripts/apply_draft_overrides.py` (add) | Validates the approved draft before upload (missing/expired drafts fail safely), applies the review panel's title/description/tags/visibility, prints the effective insert body. |
| `report_upload.py` | `scripts/report_upload.py` (add) | Writes the verified `dypol-results/<run>.json` (multi-video, with producing-run provenance) that the console syncs to record real YouTube IDs. |

New secrets for the fork: `GEMINI_API_KEY`, `YOUTUBE_TOKEN_JSON`,
`YOUTUBE_CLIENT_SECRET_B64`, optional `PEXELS_API_KEY` / `ANTHROPIC_API_KEY`.

## Quick apply (from a clone of your fork)

```bash
# Engine A
cp engine-a-patches/main.dispatch.yml  <forkA>/.github/workflows/main.yml
cp engine-a-patches/dypol_control.py   <forkA>/dypol_control.py
cp engine-a-patches/uploader.py        <forkA>/src/uploader.py
# then apply the main.py wiring in engine-a-patches/code_patches.md

# Engine B
cp engine-b-patches/broll.py           <forkB>/verticals/broll.py
cp engine-b-patches/verticals.workflow.yml <forkB>/.github/workflows/verticals.yml
cp engine-b-patches/apply_draft_overrides.py <forkB>/scripts/apply_draft_overrides.py
cp engine-b-patches/report_upload.py   <forkB>/scripts/report_upload.py
# then apply engine-b-patches/config_additions.md
```

Verify the patches with the full suite in `tests/` (phase semantics, handoff,
workflow structure, b-roll migration) — see `docs/TESTING.md`.
(python3, no network needed).
