#!/usr/bin/env python3
"""Extract the verified YouTube upload result from a Verticals draft JSON.

Add as scripts/report_upload.py in YOUR FORK of youtube-shorts-pipeline.

The DYPOL Creator Console syncs the produced dypol-results/<run_id>.json file
to record the REAL YouTube video ID — it never guesses IDs and never marks a
draft-only run as published.

Usage (called by .github/workflows/verticals.yml):
    python3 scripts/report_upload.py \
        --draft drafts/short.json --job-id JOB --run-id RUN \
        --out dypol-results/RUN.json

If no verified upload exists in the draft state, the script exits 0 WITHOUT
writing the output file (the console then keeps the job unpublished).
"""
import argparse
import json
import sys
from pathlib import Path


def find_upload(draft: dict):
    """Search the draft state for a verified YouTube upload record.

    Verticals' PipelineState stores the upload stage result under
    draft['_pipeline_state']['upload'] with artifact metadata; older/newer
    variants may keep youtube_id / video_id / url keys at other levels.
    Search conservatively and only accept explicit YouTube identifiers.
    """
    candidates = []

    state = draft.get("_pipeline_state", {}) if isinstance(draft, dict) else {}
    upload = state.get("upload", {}) if isinstance(state, dict) else {}
    if isinstance(upload, dict):
        candidates.append(upload)
        for v in upload.values():
            if isinstance(v, dict):
                candidates.append(v)
    if isinstance(draft, dict):
        candidates.append(draft)
        for key in ("upload", "result", "youtube", "video"):
            node = draft.get(key)
            if isinstance(node, dict):
                candidates.append(node)

    for node in candidates:
        if not isinstance(node, dict):
            continue
        youtube_id = (
            node.get("youtube_id") or node.get("video_id")
            or node.get("youtube_video_id") or node.get("id")
        )
        url = node.get("youtube_url") or node.get("video_url") or node.get("url")
        status = str(node.get("status") or "").lower()
        if not youtube_id and url and "youtu" in str(url):
            tail = str(url).rstrip("/").split("/")[-1]
            if tail and tail not in ("watch", "youtube.com"):
                youtube_id = tail.split("?")[0]
        if youtube_id and (status in ("", "done", "uploaded", "success", "complete", "completed")):
            return {
                "youtube_id": str(youtube_id),
                "youtube_url": url or f"https://youtu.be/{youtube_id}",
            }
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", required=True)
    ap.add_argument("--job-id", default="")
    ap.add_argument("--run-id", default="")
    ap.add_argument("--producing-run-id", default="",
                    help="GitHub run id that produced the draft (handoff provenance)")
    ap.add_argument("--draft-source", default="",
                    help="where the publish run got the draft: 'durable' | 'artifact' | 'same-run'")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    draft_path = Path(args.draft)
    if not draft_path.exists():
        print(f"draft not found: {draft_path}", file=sys.stderr)
        return 0  # do not fail the workflow; the console simply sees no result

    try:
        draft = json.loads(draft_path.read_text())
    except Exception as e:
        print(f"draft unreadable: {e}", file=sys.stderr)
        return 0

    found = find_upload(draft)
    if not found:
        print("no verified upload in draft state — writing no result file")
        return 0

    videos = [{
        "kind": found.get("kind", "video"),
        "youtube_id": found["youtube_id"],
        "youtube_url": found["youtube_url"],
        "visibility": found.get("visibility", ""),
    }]
    # Engine A style drafts may carry several uploads in upload_results form
    for extra in (draft.get("videos") or []):
        vid = extra.get("youtube_id") or extra.get("id")
        if vid and vid != found["youtube_id"]:
            videos.append({
                "kind": extra.get("kind", "video"),
                "youtube_id": vid,
                "youtube_url": extra.get("youtube_url") or f"https://youtu.be/{vid}",
                "visibility": extra.get("visibility", ""),
            })

    out = {
        "job_id": args.job_id,
        "run_id": args.run_id,
        "producing_run_id": args.producing_run_id or "",
        "draft_source": args.draft_source or "",
        "youtube_id": found["youtube_id"],
        "youtube_url": found["youtube_url"],
        "videos": videos,
        "video_count": len(videos),
        "status": "uploaded",
        "source": "verticals draft state",
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2))
    print(f"wrote verified upload result → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
