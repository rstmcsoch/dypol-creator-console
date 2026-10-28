#!/usr/bin/env python3
"""Validate an approved Verticals draft and apply the review-panel metadata.

Add as scripts/apply_draft_overrides.py in YOUR FORK of
youtube-shorts-pipeline. Used by the publish job BEFORE upload:

  --validate           : fail (exit 2) if the draft is missing, empty, or
                         references media that no longer exists. NEVER
                         regenerates or uploads anything as a side effect.
  --apply              : write the approved title/description/tags/visibility
                         into the draft's upload metadata so the actual
                         YouTube request carries exactly what the reviewer saw.
  --print-insert-body  : show the effective snippet/status (no secrets) so the
                         workflow log proves what will be sent.

Missing or broken drafts must fail loudly — a silent replacement upload would
bypass the review gate.
"""
import argparse
import json
import sys
from pathlib import Path

REQUIRED_DRAFT_KEYS = ("_pipeline_state",)
VALID_VISIBILITY = ("private", "unlisted", "public")


def load_draft(path: Path) -> dict:
    if not path or not Path(path).exists():
        print(f"::error::Approved draft not found: {path}. "
              "The artifact may have expired or the producing run was cleaned up. "
              "No upload was attempted — re-run phase=draft deliberately to create a new candidate.",
              file=sys.stderr)
        sys.exit(2)
    try:
        draft = json.loads(Path(path).read_text())
    except Exception as e:
        print(f"::error::Approved draft unreadable ({e}). No upload was attempted.", file=sys.stderr)
        sys.exit(2)
    if not isinstance(draft, dict) or not any(k in draft for k in REQUIRED_DRAFT_KEYS):
        print("::error::Draft JSON is missing pipeline state — refusing to upload. "
              "No upload was attempted.", file=sys.stderr)
        sys.exit(2)
    return draft


def media_paths(draft: dict) -> list[Path]:
    """Collect video/media references recorded in the draft state."""
    paths = []
    state = draft.get("_pipeline_state", {}) or {}
    for stage in state.values():
        if not isinstance(stage, dict):
            continue
        arts = stage.get("artifacts") if isinstance(stage.get("artifacts"), dict) else {}
        for key in ("video", "mp4", "media", "output", "thumbnail"):
            v = arts.get(key) or stage.get(key)
            if isinstance(v, str) and v:
                paths.append(Path(v))
    for key in ("video_path", "output_path", "media_path"):
        v = draft.get(key)
        if isinstance(v, str) and v:
            paths.append(Path(v))
    return paths


def validate(draft: dict, path: Path) -> None:
    state = draft.get("_pipeline_state", {}) or {}
    produce_done = any(
        isinstance(s, dict) and str(s.get("status", "")).lower() in ("done", "complete", "completed", "success")
        for s in state.values()
    )
    if state and not produce_done:
        print("::error::Draft pipeline state shows production is incomplete — refusing to upload.",
              file=sys.stderr)
        sys.exit(2)
    missing = [p for p in media_paths(draft) if not p.exists()]
    if media_paths(draft) and missing:
        print("::error::Draft references media that no longer exists: "
              + ", ".join(str(p) for p in missing)
              + ". No upload was attempted — restore the artifact or re-run phase=draft deliberately.",
              file=sys.stderr)
        sys.exit(2)
    print(f"✅ Draft validated: {path} (media refs: {len(media_paths(draft)) or 'none recorded'})")


def apply_overrides(draft: dict, title: str, description: str, tags: str, privacy: str) -> dict:
    if privacy not in VALID_VISIBILITY:
        print(f"::error::Invalid visibility {privacy!r} — expected one of {VALID_VISIBILITY}. "
              "No upload was attempted.", file=sys.stderr)
        sys.exit(2)
    meta = draft.setdefault("upload_metadata", {})
    if title:
        meta["title"] = str(title)[:100]
    if description:
        meta["description"] = str(description)
    if tags:
        meta["tags"] = [t.strip() for t in str(tags).split(",") if t.strip()]
    meta["privacy_status"] = privacy
    draft.setdefault("_pipeline_state", {}).setdefault("upload", {})["status"] = "pending"
    print("✅ Approved metadata applied to draft "
          f"(title={meta.get('title', '(unchanged)')!r}, privacy={privacy})")
    return draft


def print_insert_body(draft: dict) -> None:
    meta = draft.get("upload_metadata", {})
    body = {
        "snippet": {
            "title": meta.get("title", "(draft default)"),
            "description": (meta.get("description") or "")[:200],
            "tags": meta.get("tags", []),
        },
        "status": {"privacyStatus": meta.get("privacy_status", "private")},
    }
    print("EFFECTIVE videos.insert body (metadata only, no secrets):")
    print(json.dumps(body, indent=2))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", required=True)
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--title", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--tags", default="")
    ap.add_argument("--privacy", default="private")
    ap.add_argument("--print-insert-body", action="store_true")
    args = ap.parse_args()

    path = Path(args.draft)
    draft = load_draft(path)          # exits 2 on any problem
    if args.validate:
        validate(draft, path)
    if args.apply:
        draft = apply_overrides(draft, args.title, args.description, args.tags, args.privacy)
        path.write_text(json.dumps(draft, indent=2))
    if args.print_insert_body:
        print_insert_body(draft)
    return 0


if __name__ == "__main__":
    sys.exit(main())
