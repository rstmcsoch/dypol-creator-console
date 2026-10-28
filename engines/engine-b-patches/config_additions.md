# Verticals v3 — `verticals/config.py` additions

Add the following helper to `verticals/config.py` (next to the existing
`get_gemini_key()`), then copy the new `verticals/broll.py` from this folder
over the upstream file.

```python
# --- DYPOL Creator Console additions -------------------------------

def get_pexels_key() -> str:
    """Pexels API key for the non-AI stock-photo b-roll fallback (optional)."""
    return _get_key("PEXELS_API_KEY")


def get_gemini_image_model() -> str:
    """Current Gemini image model (configurable).

    Upstream hard-coded the retired gemini-2.0-flash-exp-image-generation
    endpoint (shut down 2025-11-11). The default below is the current GA
    image model; override with GEMINI_IMAGE_MODEL at any time.
    """
    import os
    return os.environ.get("GEMINI_IMAGE_MODEL", "gemini-nano-banana-2.1")
```

Notes
-----

* `_get_key` already exists in upstream `verticals/config.py` and reads
  environment/config; reusing it keeps behaviour consistent.
* `requirements.txt` needs **no changes** — the fix uses the same
  `requests` + `Pillow` stack the pipeline already depends on.
* Optional env vars consumed by the new `broll.py`:
  `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_MODELS`, `GEMINI_IMAGE_TIMEOUT`,
  `GEMINI_IMAGE_SIZE`, `PEXELS_API_KEY`, `BROLL_ALLOW_FALLBACK`.
