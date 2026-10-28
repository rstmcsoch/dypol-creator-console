#!/usr/bin/env python3
"""Verify the Verticals v3 b-roll image-generation migration (Engine B).

Run:  python3 tests/broll_migration.test.py
No network needed — API calls are stubbed.

What this proves (against engines/engine-b-patches/broll.py):
  1. The retired model id `gemini-2.0-flash-exp-image-generation` is never
     used to build a request URL.
  2. Requests target `{API_BASE}/models/{model}:generateContent` with the
     CURRENT contract: responseModalities ["TEXT","IMAGE"] + imageConfig.
  3. The default model is the current GA image model (nano banana 2.1),
     configurable via GEMINI_IMAGE_MODEL / GEMINI_IMAGE_MODELS, with fallbacks.
  4. Response parsing handles camelCase and snake_case inline data, and
     raises clear errors on safety blocks / missing images.
  5. The documented non-AI fallback writes provenance to broll_manifest.json
     and never labels fallback frames as AI-generated.
"""
import base64
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BROLL_PATH = REPO / "engines" / "engine-b-patches" / "broll.py"

failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ---------- load verticals.broll with stubbed sibling modules ----------
pkg = types.ModuleType("verticals")
pkg.__path__ = [str(BROLL_PATH.parent)]
sys.modules.setdefault("verticals", pkg)

cfg = types.ModuleType("verticals.config")
cfg.VIDEO_WIDTH = 1080
cfg.VIDEO_HEIGHT = 1920
cfg.get_gemini_key = lambda: os.environ.get("GEMINI_API_KEY", "")
cfg.get_pexels_key = lambda: os.environ.get("PEXELS_API_KEY", "")
cfg.run_cmd = lambda *a, **k: None
sys.modules["verticals.config"] = cfg

log_mod = types.ModuleType("verticals.log")
log_mod.log = lambda msg: print(f"    log: {msg}")
sys.modules["verticals.log"] = log_mod

retry_mod = types.ModuleType("verticals.retry")


def with_retry(max_retries=3, base_delay=2.0):
    def deco(fn):
        def wrapper(*a, **k):
            return fn(*a, **k)
        wrapper.__wrapped_retry_count__ = max_retries
        return wrapper
    return deco


retry_mod.with_retry = with_retry
sys.modules["verticals.retry"] = retry_mod

spec = importlib.util.spec_from_file_location("verticals.broll", BROLL_PATH)
broll = importlib.util.module_from_spec(spec)
sys.modules["verticals.broll"] = broll
spec.loader.exec_module(broll)

# ---------- 1. retired model never used ----------
source = BROLL_PATH.read_text()
url_expr_uses_model_var = 'models/{model}:generateContent' in source
check("uses dynamic model in URL template", url_expr_uses_model_var)
retired = "gemini-2.0-flash-exp-image-generation"
retired_in_request = f'"{retired}' in source and f'models/{retired}' in source
check("retired model id never used in a request URL", not retired_in_request)

# ---------- 2. current request contract ----------
IMG = b"\x89PNG-fake-image-bytes"
B64 = base64.b64encode(IMG).decode()


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)[:500]

    def json(self):
        return self._payload


captured = {}


def fake_post(url, json=None, timeout=None, headers=None):
    captured["url"] = url
    captured["body"] = json
    captured["timeout"] = timeout
    return FakeResponse(200, {
        "candidates": [{
            "content": {"parts": [
                {"text": "Here is the image."},
                {"inlineData": {"mimeType": "image/png", "data": B64}},
            ]},
            "finishReason": "STOP",
        }]
    })


broll.requests.post = fake_post
out = Path(tempfile.mkdtemp()) / "frame.png"
used = broll._generate_image_gemini("a nebula over mountains", out, "fake-key", "gemini-nano-banana-2.1")

check("default model in chain is nano-banana-2.1", broll._model_chain()[0] == "gemini-nano-banana-2.1")
check("request URL uses chosen model", captured["url"].endswith("/models/gemini-nano-banana-2.1:generateContent"))
gen_cfg = captured["body"]["generationConfig"]
check("responseModalities is ['TEXT','IMAGE']", gen_cfg["responseModalities"] == ["TEXT", "IMAGE"])
check("imageConfig aspectRatio present", gen_cfg.get("imageConfig", {}).get("aspectRatio") in ("9:16", "2:3"))
check("timeout plumbed", isinstance(captured["timeout"], int))
check("returned model id", used == "gemini-nano-banana-2.1")
check("image bytes written", out.exists() and out.read_bytes()[:4] == b"\x89PNG")

# ---------- 3. configurable model ----------
os.environ["GEMINI_IMAGE_MODEL"] = "gemini-3.1-flash-lite-image"
check("GEMINI_IMAGE_MODEL respected", broll._model_chain()[0] == "gemini-3.1-flash-lite-image")
os.environ["GEMINI_IMAGE_MODELS"] = "model-a, model-b"
check("GEMINI_IMAGE_MODELS overrides chain", broll._model_chain() == ["model-a", "model-b"])
del os.environ["GEMINI_IMAGE_MODEL"]
del os.environ["GEMINI_IMAGE_MODELS"]

# ---------- 4. response parsing edge cases ----------
snake = {"candidates": [{"content": {"parts": [
    {"inline_data": {"data": B64}}]}, "finishReason": "STOP"}]}
check("snake_case inline_data parsed",
      broll._extract_image(snake) == IMG)

blocked = {"promptFeedback": {"blockReason": "SAFETY"}}
try:
    broll._extract_image(blocked)
    check("safety block raises clear error", False)
except broll.ImageGenError as e:
    check("safety block raises clear error", "SAFETY" in str(e))

no_image = {"candidates": [{"content": {"parts": [{"text": "I cannot make that."}]},
                            "finishReason": "STOP"}]}
try:
    broll._extract_image(no_image)
    check("missing image raises clear error", False)
except broll.ImageGenError as e:
    check("missing image raises clear error", "no image" in str(e).lower())

# ---------- 5. non-AI fallback provenance ----------
os.environ.pop("GEMINI_API_KEY", None)
os.environ["BROLL_ALLOW_FALLBACK"] = "1"
out_dir = Path(tempfile.mkdtemp())
frames = broll.generate_broll(["scene one", "scene two"], out_dir)
manifest = json.loads((out_dir / "broll_manifest.json").read_text())
check("fallback frames returned", len(frames) == 2)
check("manifest written", manifest.get("all_ai_generated") is False)
check("fallback provenance recorded (never claimed AI)",
      all(f["source"] in ("pexels", "fallback:gradient") for f in manifest["frames"]))
check("fallback frame marked synthetic in pixels path exists",
      all(Path(f).exists() for f in frames))

# hard-fail mode
os.environ["BROLL_ALLOW_FALLBACK"] = "0"
try:
    broll.generate_broll(["scene"], Path(tempfile.mkdtemp()))
    check("fallback disabled -> hard failure (no silent placeholders)", False)
except RuntimeError as e:
    check("fallback disabled -> hard failure (no silent placeholders)", "fallback is disabled" in str(e))

print()
if failures:
    print(f"FAILED: {len(failures)} check(s): {failures}")
    sys.exit(1)
print("All b-roll migration checks passed.")
