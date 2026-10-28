"""B-roll generation for Verticals v3 — migrated to the current Gemini image API.

Drop-in replacement for verticals/broll.py.

WHAT WAS WRONG (upstream, as of Oct 2026):
  The previous implementation called the retired experimental endpoint
  ``gemini-2.0-flash-exp-image-generation:generateContent`` (shut down by Google
  on 2025-11-11). Simply renaming the model would NOT have been enough: the
  request/response contract also changed.

THIS MODULE USES:
  * Model (configurable): ``GEMINI_IMAGE_MODEL`` env var. Default
    ``gemini-nano-banana-2.1`` (GA since 2026-10-06 — the current official
    high-efficiency Gemini image model). A fallback chain is tried in order
    (see MODEL_FALLBACKS) so a single retirement never breaks production again.
  * Endpoint: ``POST https://generativelanguage.googleapis.com/v1beta/
    models/{model}:generateContent`` (the supported generateContent surface;
    ``generate_content`` in the google-genai SDK also works).
  * Request format: ``generationConfig.responseModalities: ["TEXT","IMAGE"]``
    (BOTH modalities required — ["IMAGE"] alone is rejected) plus
    ``generationConfig.imageConfig.aspectRatio`` / ``imageSize``.
  * Response parsing: candidates[0].content.parts[] with ``inlineData``
    (camelCase, REST) or ``inline_data`` (snake_case), and ``text`` parts
    carrying any safety/notes. ``promptFeedback.blockReason`` and
    ``candidates[0].finishReason`` are surfaced as clear errors.

RETRIES / TIMEOUTS:
  * Per-model timeout: GEMINI_IMAGE_TIMEOUT (default 90s).
  * Exponential backoff via the project's with_retry decorator (3 retries).
  * A model is abandoned after its retries and the next fallback model is tried.

NON-AI FALLBACK (documented, never silent):
  Order: configured model chain -> Pexels stock photo (if PEXELS_API_KEY set)
  -> Pillow gradient card. Every frame records its provenance in
  ``broll_manifest.json`` next to the frames ("gemini", "pexels", or
  "fallback:gradient") and the pipeline LOGS A WARNING whenever a frame is not
  AI-generated. A fallback frame is never presented as original AI output.

Environment variables
---------------------
  GEMINI_API_KEY        required for AI generation (AI Studio key)
  GEMINI_IMAGE_MODEL    optional, default "gemini-nano-banana-2.1"
  GEMINI_IMAGE_MODELS   optional, comma-separated override of the fallback chain
  GEMINI_IMAGE_TIMEOUT  optional seconds, default 90
  GEMINI_IMAGE_SIZE     optional, "1K" | "2K" | "4K" (default: API default)
  PEXELS_API_KEY        optional, enables stock-photo fallback
  BROLL_ALLOW_FALLBACK  "0" disables fallback frames (hard-fail instead)
"""

import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

from .config import VIDEO_WIDTH, VIDEO_HEIGHT, get_gemini_key, get_pexels_key, run_cmd
from .log import log
from .retry import with_retry

API_BASE = "https://generativelanguage.googleapis.com/v1beta"

DEFAULT_MODEL = "gemini-nano-banana-2.1"
MODEL_FALLBACKS = [
    "gemini-3.1-flash-lite-image",   # Nano Banana 2 Lite (cheap single-shot)
    "gemini-3.1-flash-image",        # Nano Banana 2 (deprecated 2026-10-06, still serving)
    "gemini-3-pro-image",            # Nano Banana Pro
]

# Portrait ratio requested from the model. Some model builds reject 9:16 —
# we then retry the request with the next ratio and centre-crop (see below).
ASPECT_RATIO_CANDIDATES = ["9:16", "2:3"]


def _model_chain() -> list:
    override = os.environ.get("GEMINI_IMAGE_MODELS", "").strip()
    if override:
        return [m.strip() for m in override.split(",") if m.strip()]
    primary = os.environ.get("GEMINI_IMAGE_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    return [primary] + [m for m in MODEL_FALLBACKS if m != primary]


def _timeout() -> int:
    try:
        return int(os.environ.get("GEMINI_IMAGE_TIMEOUT", "90"))
    except ValueError:
        return 90


class ImageGenError(RuntimeError):
    """Raised when a single model attempt fails with a clear, final reason."""


def _extract_image(data: dict) -> bytes:
    """Pull the first image part out of a generateContent response.

    Handles both REST (camelCase ``inlineData``) and SDK-style
    (snake_case ``inline_data``) part encodings.
    """
    prompt_fb = data.get("promptFeedback") or {}
    if prompt_fb.get("blockReason"):
        raise ImageGenError(
            f"Prompt blocked by Gemini safety filters: {prompt_fb['blockReason']}"
        )

    candidates = data.get("candidates") or []
    if not candidates:
        raise ImageGenError(f"No candidates in Gemini response: {json.dumps(data)[:300]}")

    cand = candidates[0]
    finish = cand.get("finishReason")
    if finish and finish not in ("STOP", "MAX_TOKENS"):
        raise ImageGenError(f"Generation finished with reason {finish!r} (no image)")

    for part in (cand.get("content", {}) or {}).get("parts", []) or []:
        inline = part.get("inlineData") or part.get("inline_data") or {}
        if inline.get("data"):
            return base64.b64decode(inline["data"])

    texts = [p.get("text", "") for p in (cand.get("content", {}) or {}).get("parts", []) if p.get("text")]
    raise ImageGenError(
        "Gemini returned no image part"
        + (f" (model said: {' '.join(texts)[:160]})" if texts else "")
    )


def _generate_image_gemini(prompt: str, output_path: Path, api_key: str, model: str) -> str:
    """One generateContent call against a single model. Returns the model used."""
    url = f"{API_BASE}/models/{model}:generateContent"
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}

    last_err = None
    for aspect in ASPECT_RATIO_CANDIDATES:
        image_config = {"aspectRatio": aspect}
        size = os.environ.get("GEMINI_IMAGE_SIZE", "").strip()
        if size in ("1K", "2K", "4K"):
            image_config["imageSize"] = size

        body = {
            "contents": [{
                "parts": [{
                    "text": (
                        "Generate a vertical 9:16 b-roll image for a short video. "
                        "No text, no watermark, no captions in the image. "
                        f"Scene: {prompt}"
                    )
                }]
            }],
            "generationConfig": {
                # BOTH modalities are required by the current API.
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": image_config,
                "candidateCount": 1,
            },
        }

        try:
            r = requests.post(url, json=body, timeout=_timeout(), headers=headers)
        except requests.RequestException as e:
            last_err = ImageGenError(f"Network error calling {model}: {e}")
            break  # network problems won't improve with a different aspect ratio

        if r.status_code == 200:
            try:
                output_path.write_bytes(_extract_image(r.json()))
                return model
            except ImageGenError as e:
                last_err = e
                break  # response parsed but content unusable — try next model
        if r.status_code == 400 and "aspect" in r.text.lower():
            last_err = ImageGenError(f"{model} rejected aspect ratio {aspect}")
            continue  # try the next aspect ratio with the same model

        try:
            detail = r.json().get("error", {}).get("message", r.text[:200])
        except Exception:
            detail = r.text[:200]
        hint = ""
        if r.status_code in (403, 404) and "GEMINI_API_KEY" not in os.environ:
            hint = " — GEMINI_API_KEY is not set in this environment"
        elif r.status_code == 403:
            hint = (
                " — check that GEMINI_API_KEY is an AI Studio key "
                "(https://aistudio.google.com/apikey), not a Vertex credential"
            )
        elif r.status_code == 404:
            hint = f" — model {model!r} is not available to this key; set GEMINI_IMAGE_MODEL to a current model"
        last_err = ImageGenError(f"Gemini API {r.status_code} ({model}): {detail}{hint}")
        break

    raise last_err or ImageGenError(f"Unknown failure generating with {model}")


@with_retry(max_retries=3, base_delay=2.0)
def _generate_with_retry(prompt: str, output_path: Path, api_key: str, model: str) -> str:
    return _generate_image_gemini(prompt, output_path, api_key, model)


def _pexels_fallback(prompt: str, output_path: Path) -> bool:
    """Non-AI fallback 1: a Pexels stock photo (licence: free commercial use)."""
    key = get_pexels_key()
    if not key:
        return False
    try:
        resp = requests.get(
            "https://api.pexels.com/v1/search",
            headers={"Authorization": key},
            params={"query": prompt, "per_page": 1, "orientation": "portrait"},
            timeout=15,
        )
        resp.raise_for_status()
        photos = resp.json().get("photos") or []
        if not photos:
            return False
        src = photos[0].get("src", {})
        url = src.get("large2x") or src.get("large") or src.get("original")
        if not url:
            return False
        img_resp = requests.get(url, timeout=30)
        img_resp.raise_for_status()
        output_path.write_bytes(img_resp.content)
        Image.open(output_path).convert("RGB").save(output_path)
        return True
    except Exception as e:
        log(f"Pexels fallback failed: {e}")
        return False


def _gradient_card(prompt: str, output_path: Path, index: int) -> None:
    """Non-AI fallback 2: a clearly synthetic gradient card (never fakeable as AI art)."""
    w, h = VIDEO_WIDTH, VIDEO_HEIGHT
    palette = [(22, 26, 48), (38, 18, 52), (12, 34, 56)]
    top, bottom = palette[index % len(palette)], palette[(index + 1) % len(palette)]
    img = Image.new("RGB", (w, h), top)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line(
            [(0, y), (w, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    font = None
    for candidate in (
        "assets/fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ):
        try:
            font = ImageFont.truetype(candidate, 64)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = (prompt[:60] + "…") if len(prompt) > 60 else prompt
    draw.text((w // 2, h // 2), text, fill=(240, 240, 245), font=font, anchor="mm")
    draw.text((w // 2, h - 180), "SYNTHETIC FALLBACK FRAME — NOT AI-GENERATED",
              fill=(255, 170, 60), font=font, anchor="mm")
    img.save(output_path)


def _fit_9_16(path: Path) -> None:
    """Centre-crop/resize to the pipeline's 9:16 canvas."""
    img = Image.open(path).convert("RGB")
    target_w, target_h = VIDEO_WIDTH, VIDEO_HEIGHT
    orig_w, orig_h = img.size
    scale = max(target_w / orig_w, target_h / orig_h)
    new_w, new_h = int(orig_w * scale), int(orig_h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left, top = (new_w - target_w) // 2, (new_h - target_h) // 2
    img.crop((left, top, left + target_w, top + target_h)).save(path)


def generate_broll(prompts: list, out_dir: Path) -> list:
    """Generate up to 3 b-roll frames.

    Returns frame paths exactly like the upstream function, and writes a
    ``broll_manifest.json`` provenance record so downstream stages (and the
    DYPOL Creator Console) can display what each frame really is.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    api_key = get_gemini_key()
    allow_fallback = os.environ.get("BROLL_ALLOW_FALLBACK", "1") != "0"
    chain = _model_chain()
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "requested_model": os.environ.get("GEMINI_IMAGE_MODEL", DEFAULT_MODEL),
        "model_chain": chain,
        "frames": [],
    }

    if not api_key:
        log(
            "GEMINI_API_KEY not set — b-roll AI generation unavailable. "
            "Get an AI Studio key at https://aistudio.google.com/apikey"
        )

    frames = []
    for i, prompt in enumerate(prompts[:3]):
        out_path = out_dir / f"broll_{i}.png"
        entry = {"index": i, "prompt": prompt, "source": None, "model": None, "error": None}
        log(f"Generating b-roll frame {i + 1}/3 (model chain: {', '.join(chain)})…")

        if api_key:
            for model in chain:
                try:
                    used = _generate_with_retry(prompt, out_path, api_key, model)
                    _fit_9_16(out_path)
                    entry.update(source="gemini", model=used)
                    log(f"Frame {i + 1}: generated by {used}")
                    break
                except Exception as e:
                    log(f"Frame {i + 1}: {model} failed — {e}")
                    entry["error"] = f"{model}: {e}"
        else:
            entry["error"] = "GEMINI_API_KEY not set"

        if entry["source"] is None and allow_fallback:
            if _pexels_fallback(prompt, out_path):
                _fit_9_16(out_path)
                entry.update(source="pexels", model=None,
                             error=entry["error"] or "gemini unavailable")
                log(
                    f"Frame {i + 1}: using PEXELS STOCK PHOTO fallback — this frame "
                    "is NOT AI-generated and is recorded as such in broll_manifest.json"
                )
            else:
                _gradient_card(prompt, out_path, i)
                entry.update(source="fallback:gradient", model=None,
                             error=entry["error"] or "gemini unavailable")
                log(
                    f"Frame {i + 1}: using SYNTHETIC GRADIENT fallback — this frame "
                    "is NOT AI-generated and is recorded as such in broll_manifest.json"
                )

        if entry["source"] is None:
            # fallback disabled and generation failed -> fail loudly, do not fake
            raise RuntimeError(
                f"B-roll frame {i + 1} failed and fallback is disabled "
                f"(BROLL_ALLOW_FALLBACK=0). Last error: {entry['error']}"
            )

        frames.append(out_path)
        manifest["frames"].append(entry)

    manifest["all_ai_generated"] = all(f["source"] == "gemini" for f in manifest["frames"])
    (out_dir / "broll_manifest.json").write_text(json.dumps(manifest, indent=2))
    if not manifest["all_ai_generated"]:
        log(
            "WARNING: one or more b-roll frames are fallback content (see "
            "broll_manifest.json). Downstream metadata must not describe them "
            "as AI-generated artwork."
        )
    return frames


def animate_frame(img_path: Path, out_path: Path, duration: float, effect: str = "zoom_in"):
    """Ken Burns animation on a single frame (unchanged from upstream)."""
    fps = 30
    frames = int(duration * fps)
    w, h = VIDEO_WIDTH, VIDEO_HEIGHT

    if effect == "zoom_in":
        vf = (
            f"scale={int(w * 1.12)}:{int(h * 1.12)},"
            f"zoompan=z='1.12-0.12*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":d={frames}:s={w}x{h}:fps={fps}"
        )
    elif effect == "pan_right":
        vf = (
            f"scale={int(w * 1.15)}:{int(h * 1.15)},"
            f"zoompan=z=1.15:x='0.15*iw*on/{frames}':y='ih*0.075'"
            f":d={frames}:s={w}x{h}:fps={fps}"
        )
    else:  # zoom_out
        vf = (
            f"scale={int(w * 1.12)}:{int(h * 1.12)},"
            f"zoompan=z='1.0+0.12*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":d={frames}:s={w}x{h}:fps={fps}"
        )

    run_cmd([
        "ffmpeg", "-loop", "1", "-i", str(img_path),
        "-vf", vf, "-t", str(duration), "-r", str(fps),
        "-pix_fmt", "yuv420p", str(out_path), "-y", "-loglevel", "quiet",
    ])
