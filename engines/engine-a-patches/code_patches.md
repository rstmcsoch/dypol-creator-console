# Engine A — code patches for YOUR fork of `gemini-youtube-automation`

> Never modify the upstream repository. Apply every change below **in your own
> fork**, on the `main` branch.

Files in this directory:

| File | Action |
|---|---|
| `main.dispatch.yml` | **Replace** `.github/workflows/main.yml` |
| `dypol_control.py` | **Add** at the repo root (next to `main.py`) |
| `uploader.py` | **Replace** `src/uploader.py` |
| `code_patches.md` (this file) | Apply the `main.py` diff below |

---

## 1. `main.py` — phase-aware production (the real wiring)

The upstream `main.py` generates AND uploads inline, ignores `DYPOL_PHASE` /
`DYPOL_TOPIC`, and discards the Short's video id. Replace its body with the
structure below (shown as a complete `main()` + helpers you can paste over the
existing ones — the heavy generation code in `produce_lesson_videos` stays).

### 1a. Imports + policy (top of `main.py`)

```python
# after the existing imports:
from dypol_control import (
    resolve_policy, execute_phase, CandidateNotFound, PolicyViolation,
    record_upload_results, find_candidate, save_candidate,
)
```

### 1b. Split `produce_lesson_videos` into generate + upload

Keep every generation line of the current function, but STOP before the
"📤 Uploading to YouTube..." section and return a **candidate dict** instead:

```python
def generate_lesson_assets(lesson):
    """Existing generation code from produce_lesson_videos, ending with the
    long/short video + thumbnail paths. Returns the DYPOL candidate dict."""
    ...  # unchanged generation code (lesson content, TTS, slides, create_video)
    return {
        "job_id": os.environ.get("DYPOL_JOB_ID", ""),
        "lesson_title": lesson["title"],
        "assets": [
            {"kind": "long",  "path": str(long_video_path),  "thumb_path": str(long_thumb_path),
             "title": lesson["title"],
             "description": long_desc, "tags": long_tags},
            {"kind": "short", "path": str(short_video_path), "thumb_path": str(short_thumb_path),
             "title": short_title,
             "description": short_desc, "tags": "AI,Shorts,TechTip"},
        ],
    }


def upload_candidate_asset(asset, policy):
    """Upload ONE candidate asset and return its full record (never a bare id)."""
    return upload_to_youtube(
        asset["path"], asset["title"], asset["description"], asset["tags"],
        thumbnail_path=asset.get("thumb_path"), kind=asset.get("kind", "video"),
    )
```

### 1c. New `main()` (phase semantics enforced)

```python
def main():
    print("🚀 DYPOL phase-aware production")
    OUTPUT_DIR.mkdir(exist_ok=True)
    policy = resolve_policy()
    print(f"🚦 {policy.describe()}")
    plan = get_content_plan()                       # existing loader (kept)

    try:
        result = execute_phase(
            policy,
            generate_fn=generate_lesson_assets,     # draft/full only
            upload_fn=upload_candidate_asset,       # upload only when allowed
            plan=plan,
            candidate_root=OUTPUT_DIR / "candidates",
            results_path=OUTPUT_DIR / "upload_results.json",
            run_id=os.environ.get("GITHUB_RUN_ID", ""),
        )
    except CandidateNotFound as e:
        print(f"❌ {e}")
        sys.exit(1)          # fail safely: no regeneration, no upload
    except PolicyViolation as e:
        print(f"❌ Policy violation: {e}")
        sys.exit(1)

    update_content_plan(plan)                       # history preserved (atomic)
    print(f"📦 Content plan saved. Result: {json.dumps(result, indent=2)}")
```

**What this guarantees (and what the tests prove):**

| Phase | Generates? | Uploads? | Plan effect |
|---|---|---|---|
| `draft` | ✅ intended lesson/topic only | ❌ never | lesson → `draft_ready`, candidate saved under `output/candidates/<job_id>/` |
| `publish` | ❌ never | ✅ saved candidate only (both assets) | lesson → `complete` with **both** video ids appended (`uploads[]`) |
| `full` | ✅ | ✅ **only if** `DYPOL_AUTO_PUBLISH=1` and `DYPOL_REVIEW_REQUIRED=0` | as above when uploaded; otherwise behaves exactly like draft |

* Completed lessons (`status: complete`) are never re-selected for generation.
* A run that fails never rewrites the plan to look successful (atomic writes).
* Long-form and Short uploads are recorded separately — `youtube_id` (long)
  and `youtube_short_id` (short) in the plan, and `videos[0]`/`videos[1]` in
  `output/upload_results.json`. The first record is never overwritten by the
  second.

## 2. `uploader.py` (replacement file provided)

Replaces `src/uploader.py` wholesale. Key behaviours verified by tests:

* `YOUTUBE_PRIVACY_STATUS` env drives visibility, **default `private`** — the
  old hard-coded `'public'` is gone.
* The exact `videos.insert` body is built by `dypol_control.build_insert_body`
  and **verified** (`verify_insert_body`) immediately before the API call —
  a wrong `privacyStatus` refuses the upload with a hard error.
* Returns `{youtube_id, youtube_url, title, visibility, kind,
  thumbnail_uploaded}` — a record, not a bare id.

## 3. `main.dispatch.yml` (replacement file provided)

* `phase`/`topic`/`privacy`/`job_id`/`title_override`/`description_override`
  inputs → `DYPOL_PHASE` / `DYPOL_TOPIC` / `YOUTUBE_PRIVACY_STATUS` /
  `DYPOL_JOB_ID` env for the production step (topic now reaches the
  generation code through `dypol_control.select_next_lesson`).
* Review-required cannot be bypassed: the workflow also passes
  `DYPOL_REVIEW_REQUIRED` / `DYPOL_AUTO_PUBLISH` from the console, and the
  Python policy refuses `full`-phase uploads unless auto-publish is explicitly
  enabled. A successful `workflow_dispatch` is only an acceptance — never an
  approval.
* `output/upload_results.json` (multi-video) is copied to
  `dypol-results/<run_id>.json` and pushed for the console sync; the same
  file is also uploaded as a workflow artifact so a git-push failure cannot
  lose the record of a completed upload.
* Job-scoped `permissions`: workflow `contents: write` is required (the result
  and plan commits push to the fork). If you prefer least-privilege at job
  level, move the `permissions:` block under `build-and-deploy:` — the `gate`
  job needs only `contents: read`.

## 4. Env reference (set by the workflow, consumed by the patch)

| Env | Meaning | Default |
|---|---|---|
| `DYPOL_PHASE` | `draft` / `publish` / `full` | `draft` |
| `DYPOL_TOPIC` | console topic (end-to-end into generation) | empty |
| `DYPOL_JOB_ID` | console job id (required for `publish`) | empty |
| `DYPOL_REVIEW_REQUIRED` | `1` blocks `full` uploads | `1` |
| `DYPOL_AUTO_PUBLISH` | `1` allows `full` uploads (with review off) | `0` |
| `YOUTUBE_PRIVACY_STATUS` | `private`/`unlisted`/`public` | `private` |
| `GEMINI_TEXT_MODEL` | script model (upstream default now `gemini-3.6-flash`) | `gemini-3.6-flash` |
