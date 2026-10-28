# Free-tier limits & pricing reality (verified 2026-10-27)

Every platform used by DYPOL Creator Console, with what is genuinely free,
what is usage-dependent, and where surprises can appear. Sources are current
vendor docs/changelogs (see links).

## Cloudflare (console hosting + DB)

| Item | Free plan limit | Notes |
|---|---|---|
| Pages static requests | unlimited bandwidth | fair-use policy |
| Pages Functions / Workers requests | **100,000 / day** (resets 00:00 UTC) | Error 1027 when exceeded ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| Workers CPU time | 10 ms / invocation (free) | orchestration-only workloads fit easily |
| D1 databases | 10 per account | |
| D1 max database size | **500 MB** (free) | 10 GB on paid |
| D1 storage total | **5 GB** (free) | ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)) |
| D1 rows read | **5M / day** (free) | hard failure past cap since 2026-09-01 ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)) |
| D1 rows written | **100k / day** (free) | same enforcement date |
| D1 queries per invocation | 50 (free) | console routes use far fewer |

**Verdict:** genuinely free for a personal console. Not a trial, no credits.

## GitHub (production runners + artifacts)

| Item | Free allowance | Notes |
|---|---|---|
| Actions minutes — **public** repos | unlimited (fair use) | engine forks can be public |
| Actions minutes — **private** repos | **2,000 / month** | Ubuntu runner = 1× multiplier |
| Artifact storage (private) | 500 MB free included | keep retention 7–14 days |
| Artifact storage (public) | free | still bounded by retention policy |
| workflow-dispatch / runs API | free with PAT | rate limit 5,000 req/h authenticated |

Run costs (approx., private repo): Engine A ≈ 25–35 min/run, Engine B ≈
6–12 min/run. Daily Engine A + daily Engine B ≈ 1,300–1,400 min/month — fits
the 2,000-min private allowance with headroom; use public forks for comfort.

**Verdict:** genuinely free on public forks; bounded-but-free on private.

## Gemini API (scripts + images) — NOT unlimited

A Gemini API key does **not** mean unlimited free model usage. As of Oct 2026:

* Free tier exists per model with rate limits (e.g. requests/minute and
  tokens/day); exceeding it returns 429 until the window resets or you enable
  billing.
* Image generation is **billed per output image** on paid tiers (e.g. the
  earlier nano-banana generation priced ≈ $0.039/image; current nano-banana
  2.1 pricing is on the [pricing page](https://ai.google.dev/gemini-api/docs/pricing)).
* Model lifecycle is fast (dates per the official Gemini API changelog /
  model-versions documentation, checked 2026-10-27):
  `gemini-2.0-flash-exp-image-generation` shut down 2025-11-11;
  `gemini-2.5-flash-image` shut down 2026-10-02; `gemini-2.5-flash` retired
  2026-10-20. The console/engines use the current IDs documented at those
  sources (`gemini-3.6-flash`, `gemini-nano-banana-2.1`) — both configurable
  precisely because this will happen again. Re-verify IDs against the changelog
  before any long unattended run.

**Verdict:** free-tier quotas only; budget for per-image pricing if you exceed
them. Never “unrestricted”.

## YouTube Data API

| Item | Limit | Impact |
|---|---|---|
| Default quota | **10,000 units/day** | upload ≈ 1,600 units → ~6 uploads/day ceiling |
| Upload size/duration | standard account limits | 12 h verified accounts only |
| OAuth refresh tokens | long-lived with offline access | re-consent needed if revoked |

The console's daily cap (default 2/day) stays well under the quota ceiling.

## Other components

| Item | Status |
|---|---|
| Pexels API (stock fallback) | free, requires attribution-friendly use per Pexels licence |
| gTTS / Edge TTS | free endpoints, unofficial-ish for gTTS (rate limits possible) — engines already retry |
| Cloudflare Pages custom domain + TLS | free |

## Cost summary

| Layer | Cost at personal scale |
|---|---|
| Console (Pages + Functions + D1) | **$0** |
| Video production (GitHub Actions, public forks) | **$0** |
| Video production (private repos, daily runs) | **$0** within 2,000 min/month |
| Gemini models | $0 within free-tier quotas; per-token/image pricing beyond |
| YouTube API | $0 (quota-bounded) |

Numbers above were verified against vendor docs in October 2026; platform
pricing changes — re-check the linked pages before relying on them.
