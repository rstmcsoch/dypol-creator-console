#!/usr/bin/env python3
"""Workflow structure checks — least-privilege permissions + required wiring.

Verifies the SHIPPED workflow files (what the user will commit to their forks):
  * least-privilege: workflow-level `contents: read`; only the jobs that push
    commits get `contents: write`; the gate job is read-only,
  * Engine A: DYPOL_PHASE / DYPOL_TOPIC / policy env reach the production step;
    the result step reads upload_results.json (multi-video),
  * Engine B: publish resolves the approved draft from the producing run
    (download-artifact with run-id), validates before upload, applies approved
    metadata, and a missing draft exits with an error (no silent regen).

Run:  python3 tests/workflow_checks.test.py   →  "All workflow checks passed."
"""
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "engines" / "engine-a-patches" / "main.dispatch.yml"
B = ROOT / "engines" / "engine-b-patches" / "verticals.workflow.yml"


def load(path):
    return list(yaml.safe_load_all(open(path)))[0]


def step_texts(job):
    out = []
    for step in job.get("steps", []):
        for key in ("run", "uses", "with", "env"):
            v = step.get(key)
            if isinstance(v, str):
                out.append(v)
            elif isinstance(v, dict):
                for k, x in v.items():
                    out.append(str(k))
                    out.append(str(x))
    return "\n".join(out)


class LeastPrivilegeTests(unittest.TestCase):
    def test_engine_a_permissions_scoped(self):
        doc = load(A)
        self.assertEqual(doc.get("permissions"), {"contents": "read"},
                         "workflow level must be read-only")
        build = doc["jobs"]["build-and-deploy"]
        self.assertEqual(build.get("permissions"), {"contents": "write"},
                         "only the job that pushes results may write")

    def test_engine_b_permissions_scoped(self):
        doc = load(B)
        self.assertEqual(doc.get("permissions"), {"contents": "read"})
        jobs = doc["jobs"]
        self.assertEqual(jobs["gate"].get("permissions"), {"contents": "read"})
        self.assertEqual(jobs["produce"].get("permissions"), {"contents": "write"})
        self.assertEqual(jobs["publish"].get("permissions"), {"contents": "write"},
                         "publish job must be able to push dypol-results/")


class EngineAWiringTests(unittest.TestCase):
    def test_policy_env_reaches_production(self):
        text = step_texts(load(A)["jobs"]["build-and-deploy"])
        for var in ("DYPOL_PHASE", "DYPOL_TOPIC", "DYPOL_JOB_ID",
                    "DYPOL_REVIEW_REQUIRED", "DYPOL_AUTO_PUBLISH",
                    "YOUTUBE_PRIVACY_STATUS"):
            self.assertIn(var, text, f"{var} must be passed to the production step")

    def test_result_step_reads_multivideo_results(self):
        text = step_texts(load(A)["jobs"]["build-and-deploy"])
        self.assertIn("upload_results.json", text)
        self.assertIn("dypol-results", text)
        self.assertIn("upload-result-", text, "artifact backup required")

    def test_policy_inputs_declared(self):
        doc = load(A)
        inputs = doc[True]["workflow_dispatch"]["inputs"]  # yaml 'on' parses as True
        for name in ("phase", "topic", "privacy", "job_id",
                     "review_required", "auto_publish"):
            self.assertIn(name, inputs)


class EngineBHandoffTests(unittest.TestCase):
    def test_publish_resolves_producing_run_artifact(self):
        text = step_texts(load(B)["jobs"]["publish"])
        self.assertIn("download-artifact", text)
        self.assertIn("run-id", text, "cross-run artifact retrieval required")
        self.assertIn("apply_draft_overrides.py", text)
        self.assertIn("--validate", text)
        self.assertIn("No upload was attempted", text, "missing draft must fail safely")

    def test_produce_saves_durable_snapshot(self):
        text = step_texts(load(B)["jobs"]["produce"])
        self.assertIn("dypol-drafts", text, "durable handoff snapshot required")
        self.assertIn("draft-", text, "artifact named per job id")

    def test_handoff_inputs_declared(self):
        doc = load(B)
        inputs = doc[True]["workflow_dispatch"]["inputs"]
        for name in ("phase", "job_id", "draft_run_id", "privacy",
                     "title_override", "description_override",
                     "review_required", "auto_publish"):
            self.assertIn(name, inputs)

    def test_publish_needs_gate(self):
        job = load(B)["jobs"]["publish"]
        self.assertIn("gate", job.get("needs", []))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.wasSuccessful():
        print("All workflow checks passed.")
    else:
        sys.exit(1)
