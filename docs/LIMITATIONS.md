# Limitations — read before relying on this system

## Duplicate detection

* Lexical only (normalised tokens + plural folding + containment). **Semantic
  duplicates** — two differently worded topics covering the same thing — are
  not detected. The upload registry covers everything these two engines
  produced through the console, not videos you upload by hand elsewhere.
* Containment matching (>12 normalised chars) can over-block very generic
  topics and under-block reordered phrasing.
* No YouTube-search-based cross-check yet (quota cost; not implemented).

## Status truthfulness

* GitHub Actions is the source of truth for run status; the registry updates
  via `POST /api/sync/github` (manual button until you wire a cron). Between
  syncs, the console shows the last known state.
* The dashboard never fabricates success: a video shows `published` only after
  the upload registry has a real YouTube ID. Failed generation stays `failed`.

## Demo vs live

* `dev/server.js` is a **demo**: runs are simulated and labelled `DEMO`.
  Live behaviour comes from the Pages Functions + real GitHub/YouTube.
* Demo analytics series are illustrative and labelled; live analytics appear
  only with YouTube Analytics OAuth.

## Engine A (Gemini YouTube Automation)

* Produces one long-form video + one promotional Short **per lesson**, with a
  curriculum in `content_plan.json` — the `topic` dispatch input is honoured
  only if you extend `main.py` to read `DYPOL_TOPIC` (documented in
  engine-a-patches; default behaviour keeps the autonomous curriculum).
* Upstream uploads were hard-coded `public`; the patch defaults to `private`
  via `YOUTUBE_PRIVACY_STATUS`, but you must apply the patch.
* gTTS is unofficial and rate-limit prone — upstream already retries; failures
  surface as failed runs (never as published videos).

## Engine B (Verticals v3)

* Whisper ASR (`openai-whisper`) is heavy — runs are slower on GitHub runners;
  keep `timeout-minutes` generous (workflow sets 45).
* The b-roll fallback chain means a quota-exhausted Gemini key yields stock or
  synthetic frames — explicitly labelled in `broll_manifest.json` and logs.
  If you require AI-only art, set `BROLL_ALLOW_FALLBACK=0` (hard-fail).
* Caption burn-in requires an FFmpeg build with libass; upstream skips burn-in
  with a warning otherwise (SRT still uploads).

## Duplicate-ish product semantics

* Mode 3 (draft both) produces two near-identical-topic jobs by design; the
  dedupe check treats them as candidates (`publishBlocked`), and only one can
  ever publish — but the queue will show both rows.
* The publishing lock is a 45 s TTL lease, not a transaction across services.
  A crashed publish could hold it until TTL expiry (then auto-releases).

## Platform limits

* Cloudflare free tier hard-caps D1 daily rows (5M read / 100k write) and
  Workers/Pages at 100k requests/day — plenty for personal use, real walls
  for heavy multi-user use.
* GitHub private-repo minutes (2,000/month) cap daily dual-engine runs on
  private forks; use public forks to remove the pressure.
* YouTube upload quota (10k units/day ≈ 6 uploads) is below any “unlimited”
  fantasy — the console's daily cap is the practical control.
* Gemini model IDs keep retiring (three retired in the last 12 months). Both
  engines take model IDs from configuration for this reason; expect to update
  defaults occasionally.

## Security scope

* Single-admin console (one password, one session type). No multi-user roles.
* Cloudflare Access / IP allowlisting can be layered in front; not included.
* Rate limiting on login is minimal (constant-time compare, generic errors).
  For hostile networks, front with Cloudflare WAF/Access rules.

## What was NOT done (and why)

* No live GitHub/YouTube integration tests — the build environment has no
  credentials, and faking them would violate the honesty requirement. The
  manual checklist in TESTING.md covers this after you deploy.
* No upstream PRs — modifications ship as patches for your forks because
  upstream repos must not be modified without explicit permission.
