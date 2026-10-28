#!/usr/bin/env python3
"""Engine A phase-semantics regression tests (mocked credentials — simulated).

Proves the guarantees the DYPOL Creator Console depends on:
  * draft mode never uploads anything,
  * publish mode never regenerates a lesson,
  * a successful full production preserves BOTH video IDs (long + Short),
  * review-required blocks full-phase uploads even with auto-publish set,
  * a missing candidate fails safely (no regeneration, no upload),
  * completed lessons are never re-generated; topic input works end-to-end,
  * the videos.insert body is privacy-verified (default private).

Run:  python3 tests/engine_a_phase.test.py   →  "All Engine A phase tests passed."
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engines" / "engine-a-patches"))
import dypol_control as dpc  # noqa: E402


def make_candidate(job_id="job-1", title="Black Holes 101"):
    return {
        "job_id": job_id,
        "lesson_title": title,
        "assets": [
            {"kind": "long", "path": "long.mp4", "thumb_path": "long.png",
             "title": title, "description": "d", "tags": "a,b"},
            {"kind": "short", "path": "short.mp4", "thumb_path": "short.png",
             "title": "Quick Tip #Shorts", "description": "d2", "tags": "c"},
        ],
    }


class FakeIO:
    """Records generate/upload calls so we can prove what DID NOT happen."""
    def __init__(self, tmp: Path, fail_upload_kinds=()):
        self.tmp = tmp
        self.generate_calls = []
        self.upload_calls = []
        self.fail_upload_kinds = set(fail_upload_kinds)
        (tmp / "long.mp4").write_bytes(b"video-bytes-long")
        (tmp / "short.mp4").write_bytes(b"video-bytes-short")

    def generate(self, lesson):
        self.generate_calls.append(lesson)
        cand = make_candidate(title=lesson.get("title", "T"))
        for a in cand["assets"]:
            a["path"] = str(self.tmp / Path(a["path"]).name)
            a["thumb_path"] = str(self.tmp / Path(a["thumb_path"]).name)
            Path(a["thumb_path"]).write_bytes(b"png")
        return cand

    def upload(self, asset, policy):
        self.upload_calls.append(asset)
        if asset["kind"] in self.fail_upload_kinds:
            raise RuntimeError("simulated YouTube API failure")
        n = len(self.upload_calls)
        return {
            "youtube_id": f"vid-{asset['kind']}-{n}",
            "youtube_url": f"https://youtu.be/vid-{asset['kind']}-{n}",
            "title": asset["title"],
            "visibility": policy.visibility,
            "kind": asset["kind"],
        }


def run_phase(env, io, plan, tmp):
    policy = dpc.resolve_policy(env)
    return dpc.execute_phase(
        policy,
        generate_fn=io.generate,
        upload_fn=io.upload,
        plan=plan,
        candidate_root=tmp / "candidates",
        results_path=tmp / "upload_results.json",
        run_id="run-99",
    )


class PhasePolicyTests(unittest.TestCase):
    def test_draft_never_uploads(self):
        env = {"DYPOL_PHASE": "draft"}
        p = dpc.resolve_policy(env)
        self.assertTrue(p.allow_generate)
        self.assertFalse(p.allow_upload)

    def test_publish_requires_job_id(self):
        with self.assertRaises(dpc.PolicyViolation):
            dpc.resolve_policy({"DYPOL_PHASE": "publish"})

    def test_publish_uploads_but_never_generates(self):
        p = dpc.resolve_policy({"DYPOL_PHASE": "publish", "DYPOL_JOB_ID": "j"})
        self.assertFalse(p.allow_generate)
        self.assertTrue(p.allow_upload)

    def test_full_blocked_under_review_required(self):
        p = dpc.resolve_policy({"DYPOL_PHASE": "full", "DYPOL_REVIEW_REQUIRED": "1",
                                "DYPOL_AUTO_PUBLISH": "1"})
        self.assertFalse(p.allow_upload, "review-required must block full uploads")

    def test_full_allowed_only_with_explicit_auto_publish(self):
        p = dpc.resolve_policy({"DYPOL_PHASE": "full", "DYPOL_REVIEW_REQUIRED": "0",
                                "DYPOL_AUTO_PUBLISH": "1"})
        self.assertTrue(p.allow_upload)
        p2 = dpc.resolve_policy({"DYPOL_PHASE": "full", "DYPOL_REVIEW_REQUIRED": "0",
                                 "DYPOL_AUTO_PUBLISH": "0"})
        self.assertFalse(p2.allow_upload)

    def test_invalid_phase_and_visibility_rejected(self):
        with self.assertRaises(dpc.PolicyViolation):
            dpc.resolve_policy({"DYPOL_PHASE": "yolo"})
        with self.assertRaises(dpc.PolicyViolation):
            dpc.resolve_policy({"DYPOL_PHASE": "draft", "YOUTUBE_PRIVACY_STATUS": "everyone"})

    def test_default_visibility_is_private(self):
        self.assertEqual(dpc.resolve_policy({}).visibility, "private")


class InsertBodyTests(unittest.TestCase):
    def test_verify_rejects_wrong_privacy(self):
        body = dpc.build_insert_body("t", "d", "a,b", "private")
        self.assertEqual(body["status"]["privacyStatus"], "private")
        dpc.verify_insert_body(body, "private")  # ok
        body["status"]["privacyStatus"] = "public"
        with self.assertRaises(dpc.PolicyViolation):
            dpc.verify_insert_body(body, "private")

    def test_verify_rejects_missing_title(self):
        body = dpc.build_insert_body("t", "d", [], "private")
        body["snippet"]["title"] = ""  # simulate a malformed request body
        with self.assertRaises(dpc.PolicyViolation):
            dpc.verify_insert_body(body, "private")


class PhaseExecutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.io = FakeIO(self.tmp)
        self.plan = {"lessons": [
            {"chapter": "1", "part": "1", "title": "Done Lesson", "status": "complete",
             "youtube_id": "old-vid", "uploads": [{"kind": "long", "youtube_id": "old-vid"}]},
            {"chapter": "1", "part": "2", "title": "Black Holes 101", "status": "pending"},
        ]}

    def test_draft_saves_candidate_and_never_uploads(self):
        res = run_phase({"DYPOL_PHASE": "draft", "DYPOL_JOB_ID": "job-1"}, self.io, self.plan, self.tmp)
        self.assertEqual(self.io.upload_calls, [], "draft must not upload anything")
        self.assertEqual(res["status"], "draft_only")
        self.assertTrue((self.tmp / "candidates" / "job-1" / "candidate.json").exists())
        # history preserved: completed lesson untouched, pending → draft_ready
        self.assertEqual(self.plan["lessons"][0]["status"], "complete")
        self.assertEqual(self.plan["lessons"][1]["status"], "draft_ready")

    def test_publish_uploads_saved_candidate_without_generating(self):
        run_phase({"DYPOL_PHASE": "draft", "DYPOL_JOB_ID": "job-1"}, self.io, self.plan, self.tmp)
        gen_after_draft = len(self.io.generate_calls)
        res = run_phase({"DYPOL_PHASE": "publish", "DYPOL_JOB_ID": "job-1",
                         "YOUTUBE_PRIVACY_STATUS": "private"}, self.io, self.plan, self.tmp)
        self.assertEqual(len(self.io.generate_calls), gen_after_draft,
                         "publish must NOT regenerate")
        self.assertEqual(len(self.io.upload_calls), 2, "publish uploads both saved assets")
        self.assertEqual(res["status"], "uploaded")
        self.assertEqual(res["video_count"], 2)

    def test_both_video_ids_preserved_separately(self):
        run_phase({"DYPOL_PHASE": "draft", "DYPOL_JOB_ID": "job-1"}, self.io, self.plan, self.tmp)
        res = run_phase({"DYPOL_PHASE": "publish", "DYPOL_JOB_ID": "job-1"}, self.io, self.plan, self.tmp)
        ids = [v["youtube_id"] for v in res["videos"]]
        self.assertEqual(len(set(ids)), 2, "long and short IDs must be distinct")
        self.assertNotEqual(res["youtube_id"], "", "primary (long) id recorded")
        lesson = self.plan["lessons"][1]
        self.assertEqual(lesson["youtube_id"], ids[0], "long-form id kept")
        self.assertEqual(lesson.get("youtube_short_id"), ids[1], "short id kept separately")
        self.assertEqual(len(lesson["uploads"]), 2, "both uploads appended — never overwritten")

    def test_full_without_policy_behaves_as_draft(self):
        res = run_phase({"DYPOL_PHASE": "full", "DYPOL_JOB_ID": "job-2"}, self.io, self.plan, self.tmp)
        self.assertEqual(self.io.upload_calls, [], "full + review-required must not upload")
        self.assertEqual(res["status"], "draft_only")

    def test_full_with_auto_publish_uploads(self):
        res = run_phase({"DYPOL_PHASE": "full", "DYPOL_JOB_ID": "job-3",
                         "DYPOL_REVIEW_REQUIRED": "0", "DYPOL_AUTO_PUBLISH": "1"},
                        self.io, self.plan, self.tmp)
        self.assertEqual(len(self.io.upload_calls), 2)
        self.assertEqual(res["status"], "uploaded")

    def test_missing_candidate_fails_safely(self):
        with self.assertRaises(dpc.CandidateNotFound):
            run_phase({"DYPOL_PHASE": "publish", "DYPOL_JOB_ID": "ghost"}, self.io, self.plan, self.tmp)
        self.assertEqual(self.io.upload_calls, [], "missing candidate must not upload")
        self.assertEqual(self.io.generate_calls, [], "missing candidate must not regenerate")

    def test_completed_lessons_never_regenerated_without_topic(self):
        plan = {"lessons": [{"title": "Only Done", "status": "complete"}]}
        with self.assertRaises(dpc.PolicyViolation):
            run_phase({"DYPOL_PHASE": "draft"}, self.io, plan, self.tmp)
        self.assertEqual(self.io.generate_calls, [])

    def test_topic_input_reaches_generation_end_to_end(self):
        env = {"DYPOL_PHASE": "draft", "DYPOL_TOPIC": "Quantum Entanglement"}
        os.environ["DYPOL_TOPIC"] = "Quantum Entanglement"
        try:
            res = run_phase(env, self.io, self.plan, self.tmp)
        finally:
            os.environ.pop("DYPOL_TOPIC", None)
        self.assertEqual(self.io.generate_calls[0]["title"], "Quantum Entanglement")
        titles = [l["title"] for l in self.plan["lessons"]]
        self.assertIn("Black Holes 101", titles, "existing plan preserved")
        self.assertIn("Quantum Entanglement", titles, "topic appended, history kept")
        self.assertEqual(res["status"], "draft_only")

    def test_existing_completed_lesson_matched_by_topic_not_regenerated(self):
        os.environ["DYPOL_TOPIC"] = "Done Lesson"
        try:
            lesson = dpc.select_next_lesson(self.plan, "Done Lesson")
        finally:
            os.environ.pop("DYPOL_TOPIC", None)
        self.assertEqual(lesson["status"], "complete")  # returned for re-publish, not re-gen

    def test_plan_save_is_atomic_and_readable(self):
        dpc.save_plan(self.tmp / "plan.json", self.plan)
        back = dpc.load_plan(self.tmp / "plan.json")
        self.assertEqual(len(back["lessons"]), 2)


class UploadFailureTests(unittest.TestCase):
    def test_partial_upload_failure_keeps_first_record(self):
        tmp = Path(tempfile.mkdtemp())
        io = FakeIO(tmp, fail_upload_kinds={"short"})  # long succeeds, short fails
        plan = {"lessons": [{"title": "Black Holes 101", "status": "pending"}]}
        run_phase({"DYPOL_PHASE": "draft", "DYPOL_JOB_ID": "j-fail"}, io, plan, tmp)  # save candidate
        with self.assertRaises(RuntimeError):
            run_phase({"DYPOL_PHASE": "publish", "DYPOL_JOB_ID": "j-fail"}, io, plan, tmp)
        self.assertEqual(len(io.upload_calls), 2, "both attempted; short failed")
        # the SUCCESSFUL upload is still recorded — never lost
        res = json.loads((tmp / "upload_results.json").read_text())
        self.assertEqual(res["status"], "partial")
        self.assertEqual(res["video_count"], 1)
        self.assertEqual(res["videos"][0]["kind"], "long")


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=1)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("All Engine A phase tests passed.")
    else:
        sys.exit(1)
