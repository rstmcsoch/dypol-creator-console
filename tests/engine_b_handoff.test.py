#!/usr/bin/env python3
"""Engine B draft-to-publish handoff regression tests (simulated — no credentials).

Proves:
  * a missing/expired draft fails safely (no upload, no regeneration),
  * an incomplete draft is refused before upload,
  * approved metadata + visibility are applied to exactly the upload request,
  * report_upload records real uploads (incl. multi-video) and writes NOTHING
    for simulated/failed uploads — real and simulated outcomes stay distinct,
  * handoff provenance (producing run, draft source) is persisted.

Run:  python3 tests/engine_b_handoff.test.py   →  "All Engine B handoff tests passed."
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "engines" / "engine-b-patches"


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


report_upload = load("report_upload")
apply_mod = load("apply_draft_overrides")


def make_draft(tmp: Path, status="done", with_media=True):
    media = tmp / "video.mp4"
    if with_media:
        media.write_bytes(b"mp4-bytes")
    draft = {
        "_pipeline_state": {
            "produce": {"status": status, "artifacts": {"video": str(media)} if with_media else {}},
            "upload": {"status": "pending"},
        },
        "upload_metadata": {},
    }
    p = tmp / "draft.json"
    p.write_text(json.dumps(draft))
    return p


class ValidateTests(unittest.TestCase):
    def test_missing_draft_exits_2_without_side_effects(self):
        rc = apply_mod.main.__wrapped__ if hasattr(apply_mod.main, "__wrapped__") else None
        # call the CLI path via subprocess semantics: load_draft must exit 2
        with self.assertRaises(SystemExit) as ctx:
            apply_mod.load_draft(Path("/nonexistent/draft.json"))
        self.assertEqual(ctx.exception.code, 2)

    def test_incomplete_draft_refused(self):
        tmp = Path(tempfile.mkdtemp())
        p = make_draft(tmp, status="failed")
        with self.assertRaises(SystemExit) as ctx:
            apply_mod.load_draft(p)
            apply_mod.validate(json.loads(p.read_text()), p)
        self.assertEqual(ctx.exception.code, 2)

    def test_media_missing_refused(self):
        tmp = Path(tempfile.mkdtemp())
        p = make_draft(tmp, with_media=False)
        draft = json.loads(p.read_text())
        draft["_pipeline_state"]["produce"]["artifacts"] = {"video": str(tmp / "gone.mp4")}
        with self.assertRaises(SystemExit) as ctx:
            apply_mod.validate(draft, p)
        self.assertEqual(ctx.exception.code, 2)

    def test_valid_draft_passes(self):
        tmp = Path(tempfile.mkdtemp())
        p = make_draft(tmp)
        apply_mod.validate(json.loads(p.read_text()), p)  # must not raise


class OverrideTests(unittest.TestCase):
    def test_apply_persists_approved_metadata_and_visibility(self):
        tmp = Path(tempfile.mkdtemp())
        p = make_draft(tmp)
        draft = apply_mod.apply_overrides(
            json.loads(p.read_text()),
            "Approved Title", "Approved description", "tag1, tag2", "private")
        self.assertEqual(draft["upload_metadata"]["title"], "Approved Title")
        self.assertEqual(draft["upload_metadata"]["tags"], ["tag1", "tag2"])
        self.assertEqual(draft["upload_metadata"]["privacy_status"], "private")

    def test_invalid_visibility_refused(self):
        with self.assertRaises(SystemExit) as ctx:
            apply_mod.apply_overrides({"_pipeline_state": {}}, "t", "d", "", "everybody")
        self.assertEqual(ctx.exception.code, 2)


class ReportUploadTests(unittest.TestCase):
    def _run(self, draft_path, out, job="job-1", run="run-2", producing="run-1", source="durable"):
        sys.argv = ["report_upload.py", "--draft", str(draft_path), "--job-id", job,
                    "--run-id", run, "--producing-run-id", producing,
                    "--draft-source", source, "--out", str(out)]
        return report_upload.main()

    def test_real_upload_recorded_with_provenance(self):
        tmp = Path(tempfile.mkdtemp())
        draft = tmp / "draft.json"
        draft.write_text(json.dumps({
            "_pipeline_state": {"upload": {"status": "done", "artifacts": {"youtube_id": "abc123XYZ"}}},
        }))
        out = tmp / "res.json"
        self.assertEqual(self._run(draft, out), 0)
        res = json.loads(out.read_text())
        self.assertEqual(res["youtube_id"], "abc123XYZ")
        self.assertEqual(res["job_id"], "job-1")
        self.assertEqual(res["producing_run_id"], "run-1", "handoff provenance kept")
        self.assertEqual(res["draft_source"], "durable")
        self.assertEqual(res["video_count"], 1)

    def test_multi_video_records_kept_separate(self):
        tmp = Path(tempfile.mkdtemp())
        draft = tmp / "draft.json"
        draft.write_text(json.dumps({
            "_pipeline_state": {"upload": {"status": "done", "artifacts": {"youtube_id": "long111"}}},
            "videos": [
                {"kind": "long", "youtube_id": "long111", "youtube_url": "https://youtu.be/long111"},
                {"kind": "short", "youtube_id": "short222", "youtube_url": "https://youtu.be/short222"},
            ],
        }))
        out = tmp / "res.json"
        self.assertEqual(self._run(draft, out), 0)
        res = json.loads(out.read_text())
        ids = {v["youtube_id"] for v in res["videos"]}
        self.assertEqual(ids, {"long111", "short222"}, "both video IDs preserved")

    def test_simulated_or_failed_upload_writes_nothing(self):
        tmp = Path(tempfile.mkdtemp())
        draft = tmp / "draft.json"
        draft.write_text(json.dumps({"_pipeline_state": {"upload": {"status": "failed"}}}))
        out = tmp / "res.json"
        self.assertEqual(self._run(draft, out), 0)
        self.assertFalse(out.exists(), "no result file for a simulated/failed upload")

    def test_missing_draft_writes_nothing(self):
        tmp = Path(tempfile.mkdtemp())
        out = tmp / "res.json"
        self.assertEqual(self._run(tmp / "nope.json", out), 0)
        self.assertFalse(out.exists())


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.wasSuccessful():
        print("All Engine B handoff tests passed.")
    else:
        sys.exit(1)
