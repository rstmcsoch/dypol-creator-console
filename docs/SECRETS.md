# Secrets & credentials — DYPOL Creator Console

**Rule: every credential lives server-side** (Cloudflare Pages secrets and/or
GitHub Actions Secrets). Nothing here is ever sent to the browser, stored in
local storage, placed in URLs, committed to source control, or logged. The
Settings page shows only `configured / not configured` booleans.

## Cloudflare Pages secrets

Set via dashboard → *dypol-creator-console* → Settings → Environment variables
(secrets), or `npx wrangler pages secret put <NAME>`.

| Secret | Required | Purpose | How to generate |
|---|---|---|---|
| `ADMIN_PASSWORD_HASH` | ✅ | Console login | `node console/scripts/hash-password.cjs 'your-strong-password'` → paste the printed `pbkdf2$…` string |
| `SESSION_SECRET` | ✅ | HMAC key for session cookies | `openssl rand -hex 32` |
| `GITHUB_TOKEN` | ✅ for live runs | workflow-dispatch / runs / cancel / re-run | Fine-grained PAT (below) |
| `GITHUB_WEBHOOK_SECRET` | ✅ for live progress | verifies `X-Hub-Signature-256` on `POST /api/webhooks/github` | Random 32+ byte string; the SAME value is set on each engine repo's webhook. Never commit it. |
| `GEMINI_API_KEY` | optional | engine health checks (engines use their own Actions secret) | AI Studio key |
| `YOUTUBE_CLIENT_SECRET_B64` | for uploads | OAuth client secret (base64) | Google Cloud Console (below) |
| `YOUTUBE_TOKEN_B64` | for uploads | OAuth user token JSON (base64) | produced by the OAuth flow (below) |
| `YOUTUBE_ANALYTICS_TOKEN_B64` | optional | live Analytics metrics | OAuth token with `yt-analytics.readonly` |

```bash
# base64 helpers
base64 -w0 client_secrets.json   # → YOUTUBE_CLIENT_SECRET_B64
base64 -w0 token.json            # → YOUTUBE_TOKEN_B64
```

## `GITHUB_TOKEN` — minimum permissions

Create a **fine-grained PAT** (GitHub → Settings → Developer settings →
Personal access tokens) restricted to exactly your two engine forks:

| Access | Level | Why |
|---|---|---|
| Actions | **Read & write** | workflow_dispatch, cancel run, re-run failed jobs, list runs/artifacts |
| Contents | **Read & write** | write `dypol-control.json` (schedule gate) + read `dypol-results/*.json` (verified upload results) on the forks |
| Metadata | Read | required by GitHub, read-only |

No org-wide scope, no admin, no delete permissions. Store it only as the
Cloudflare Pages secret. **Do not** commit it. Rotate periodically.

## GitHub webhooks — live progress

Each engine repo (`rstmcsoch/gemini-youtube-automation`, `rstmcsoch/youtube-shorts-pipeline`)
has a repository webhook → `https://dypol-creator-console.pages.dev/api/webhooks/github`,
content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events:
**Workflow runs** + **Workflow jobs**. The endpoint is exempt from the session
cookie but rejects any delivery without a valid HMAC-SHA256 signature (401),
ignores other repos/events (202) and de-duplicates by `X-GitHub-Delivery`.
`POST /api/sync/github` remains the polling fallback. Rotating the secret:
update the Pages secret, redeploy, then update both webhooks.

## GitHub Actions Secrets (per engine fork)

### Engine A fork (`gemini-youtube-automation`)
Unchanged from upstream: `CLIENT_SECRET_B64`, `CREDENTIALS_B64`,
`GOOGLE_API_KEY`, `PEXELS_API_KEY`.
Optional repo **variable** `GEMINI_TEXT_MODEL` (default `gemini-3.6-flash`).

### Engine B fork (`youtube-shorts-pipeline`)
| Secret | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | script generation + image generation (AI Studio key) |
| `YOUTUBE_TOKEN_JSON` | ✅ for upload | contents of the OAuth token JSON file |
| `YOUTUBE_CLIENT_SECRET_B64` | ✅ for refresh | OAuth client secret for token refresh |
| `PEXELS_API_KEY` | optional | stock-photo b-roll fallback |
| `ANTHROPIC_API_KEY` | optional | Claude provider for scripts |

## YouTube OAuth — manual setup (required for uploads)

The console cannot complete this part for you; Google requires an interactive
consent flow. One-time setup:

1. **Google Cloud Console** → create a project → enable
   *YouTube Data API v3* (and *YouTube Analytics API* if you want live metrics).
2. **OAuth consent screen** → External (or Internal) → add scope
   `https://www.googleapis.com/auth/youtube.upload` (plus
   `yt-analytics.readonly` for analytics) → add your Google account as a test
   user while the app is in Testing.
3. **Credentials** → Create **OAuth client ID** → type *Desktop app* →
   download `client_secrets.json`.
4. **First token** — run the engine's helper once on any machine you trust:
   ```bash
   python scripts/setup_youtube_oauth.py   # Engine B fork (interactive consent)
   # Engine A: run its uploader once locally with client_secrets.json present
   ```
   This produces a token JSON (containing `refresh_token`).
5. Store the outputs:
   * Engine A: `base64 -w0 client_secrets.json > CLIENT_SECRET_B64`,
     `base64 -w0 credentials.json > CREDENTIALS_B64` (upstream convention).
   * Engine B: `base64 -w0 token.json` → Actions secret `YOUTUBE_TOKEN_JSON`
     (raw JSON also fine — the workflow writes it to `.secrets/youtube_token.json`).
   * Console (optional live analytics): `YOUTUBE_TOKEN_B64`,
     `YOUTUBE_ANALYTICS_TOKEN_B64`.
6. **Visibility**: keep `privacy=private` for the first test uploads. Promote
   to `unlisted`/`public` only in Settings or per-dispatch.

### Token refresh notes
* Both engines refresh expired tokens using the client secret + refresh token
  and persist the refreshed token inside the run (Engine B:
  `write_secret_file`).
* If a run fails with *“token expired and has no refresh token”*, the consent
  flow was done without `access_type=offline` — redo step 4.
* Never paste tokens into the console UI; there is no field for them.

## What the console can see vs what it cannot

| Visible in UI / API responses | Never leaves server |
|---|---|
| `github.tokenConfigured: true/false` | PAT value |
| `youtubeOAuth: true/false` | client secret, token JSON, refresh token |
| `geminiKey: true/false` | Gemini API key |
| run/job metadata, statuses, logs text produced by workflows | any credential |

Self-check: `tests/api.smoke.test.js` asserts settings responses contain no
token-shaped strings (`ghp_`, `github_pat_`, `ya29.`).
