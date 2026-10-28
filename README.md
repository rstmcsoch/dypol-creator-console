# DYPOL Creator Console

**Dual-engine AI YouTube automation dashboard** · a **DYPOL LABS** product.

`DYPOL Creator Console` is a polished, tablet-first web console for running two
independent AI video-production pipelines from an Android tablet or any browser:

| Engine | Repository (upstream) | What it produces |
|---|---|---|
| **A — Gemini YouTube Automation** | `<GITHUB_OWNER>/gemini-youtube-automation` | Long-form educational video (16:9) + promotional Short per lesson |
| **B — Verticals v3** | `<GITHUB_OWNER>/youtube-shorts-pipeline` | Research-driven vertical Shorts (9:16) |

The console orchestrates both engines through **GitHub Actions**
(workflow-dispatch + workflow-runs APIs), keeps a **central job registry** with
**duplicate prevention**, a **publishing lock**, a **daily upload cap**, and a
**review-required approval gate**. Production/rendering always happens on
GitHub-hosted runners — never in the dashboard backend.

---

## What is in this package

```
dypol-creator-console/
├── console/                  # ← deploy THIS as a Cloudflare Pages project
│   ├── index.html            # SPA shell + login screen (vanilla JS, zero deps)
│   ├── assets/               # design system + pages (Overview, Pipelines,
│   │                         #   Content Queue, Calendar, Analytics, Run History, Settings)
│   ├── functions/api/        # Cloudflare Pages Functions (backend API)
│   │   └── _lib/             #   D1 access, GitHub client, safeguards, auth
│   ├── schema.sql            # D1 schema (jobs, runs, uploads, activity, settings, locks)
│   ├── wrangler.toml
│   └── scripts/hash-password.cjs
├── dev/server.js             # local demo server (same API contract, in-memory)
├── engines/
│   ├── engine-a-patches/     # upgraded workflow + code patches for Engine A's fork
│   └── engine-b-patches/     # FIXED image-generation module + new workflow for Engine B's fork
├── tests/                    # automated tests (all passing — see docs/TESTING.md)
└── docs/                     # setup, deployment, secrets, orchestration,
                              #   free-tier limits, testing, limitations
```

## Quick start (local demo)

```bash
node dev/server.js
# open http://localhost:8788  →  password: dypol-demo
```

The local server runs in **demo mode**: job state is in memory, runs are
simulated, and every simulated record is labelled `DEMO` in the UI. The API
contract is identical to the production backend.

## Production deployment (Cloudflare Pages free tier)

1. Create the D1 database and apply `console/schema.sql`.
2. Deploy `console/` as a Pages project (build output directory = `console`).
3. Set the server-side secrets (never in the frontend): see **docs/SECRETS.md**.
4. Fork the two engine repos and apply **engines/** patches to your forks.
5. Point the console at your forks in **Settings → GitHub repositories**.

Full walkthrough: **docs/SETUP.md** · **docs/DEPLOYMENT.md**.

## Security model (summary)

* Admin login (PBKDF2 password hash in a server secret) → HMAC-signed
  `HttpOnly; Secure; SameSite=Strict` session cookie.
* **Every state-changing API route is authenticated.** Unauthenticated visitors
  cannot start production, change settings, or publish to YouTube.
* GitHub tokens, Gemini API keys, YouTube OAuth secrets and refresh tokens live
  **only** in Cloudflare Pages secrets / GitHub Actions Secrets. The browser
  receives only `configured / not configured` booleans.
* **Review-required publishing is the default.** Test uploads default to
  `private` visibility. Automation can be paused without deleting anything.

## Execution modes (dual-engine orchestration)

1. **Primary with fallback** — Engine A first; Engine B only after a genuine
   primary failure (and only if nothing was uploaded).
2. **Alternate engines** — runs alternate between engines (by day or run index).
3. **Both engines, draft mode** — two candidates for comparison; nothing
   publishes until you pick one.

Duplicate prevention (normalised topic matching + upload-registry checks),
a publishing lock, and a daily cap protect every path. Details and documented
limitations: **docs/ORCHESTRATION.md**, **docs/LIMITATIONS.md**.

## Engine fixes included

* **Engine B `verticals/broll.py`** — the retired
  `gemini-2.0-flash-exp-image-generation` call (shut down 2025-11-11) is
  replaced with the current Gemini image API
  (`gemini-nano-banana-2.1` via `generateContent`, correct
  `responseModalities: ["TEXT","IMAGE"]` + `imageConfig` contract), with a
  configurable model chain, retries, timeouts, Pexels/gradient non-AI fallback,
  and an honest `broll_manifest.json` provenance record.
* **Engine A** — `gemini-2.5-flash` (retired 2026-10-20) migrated to
  `gemini-3.6-flash`; upload visibility now defaults to **private** via
  `YOUTUBE_PRIVACY_STATUS`; workflow accepts dispatch inputs.

## Free-tier reality check

Everything is designed for genuine free tiers (Cloudflare Pages + D1 + GitHub
Actions). Verified limits and caveats: **docs/FREE_TIER.md**. Gemini model
usage is **not free after free-tier quotas** — a Gemini API key does not imply
unlimited free generation.

## Documentation

| Doc | Contents |
|---|---|
| [AUDIT.md](AUDIT.md) | **Technical verification & repair report** (architecture audit, defect root causes, alternatives, test evidence, security report, status) |
| [docs/SETUP.md](docs/SETUP.md) | Local run + first deployment |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloudflare Pages/D1 step-by-step |
| [docs/SECRETS.md](docs/SECRETS.md) | All secrets + YouTube OAuth manual setup |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design & data flow |
| [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) | Modes, dedupe, locks, caps, retries |
| [docs/FREE_TIER.md](docs/FREE_TIER.md) | Verified platform limits |
| [docs/TESTING.md](docs/TESTING.md) | Test results (what was verified) |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Honest limitations |
| [REPORT.md](REPORT.md) | Completion report — works / incomplete / manual |

---
DYPOL LABS · Build · Automate · Create — *DYPOL Creator Console v1.0.0*
