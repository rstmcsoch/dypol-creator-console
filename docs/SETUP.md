# Setup — DYPOL Creator Console

## 1. Run locally (demo mode)

Requirements: Node.js ≥ 18. No npm install needed.

```bash
node dev/server.js
# → http://localhost:8788   password: dypol-demo
```

Demo mode: in-memory job registry, simulated runs clearly labelled `DEMO`,
identical API contract to production. Change the demo password with
`DYPOL_ADMIN_PASSWORD`. Override the port with `PORT`.

## 2. Deploy the console (production)

Detailed walkthrough (dashboard + CLI + tablet route) in **DEPLOYMENT.md**.
Short version — **all commands run from `console/`** so the deploy can never
pick up an empty or wrongly-nested directory:

```bash
cd console

# a) D1 database
npm run db:create          # wrangler d1 create dypol-console
# paste the database_id into wrangler.toml, then:
npm run db:schema          # --file=schema.sql
npm run db:migrate         # ONLY if your DB predates the audit release (002.sql)

# b) secrets (see SECRETS.md for how to produce values)
npx wrangler pages secret put ADMIN_PASSWORD_HASH
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put GITHUB_TOKEN
# optional: GEMINI_API_KEY, YOUTUBE_* 

# c) deploy the SPA + functions (runs the preflight completeness check first)
npm run deploy
```

Android tablet (no CLI): Cloudflare dashboard → Workers & Pages → Create →
Pages → *Upload assets* with the **contents of `console/`** at the zip root —
step-by-step in DEPLOYMENT.md §A.

## 3. Prepare the engine forks

Apply everything in `engines/` to **your forks** (never to upstream):

```bash
# Engine A — Gemini YouTube Automation
gh repo fork <UPSTREAM_OWNER>/gemini-youtube-automation --clone
cp engine-a-patches/main.dispatch.yml <forkA>/.github/workflows/main.yml
# apply the two small edits in engine-a-patches/code_patches.md
# add secrets: CLIENT_SECRET_B64, CREDENTIALS_B64, GOOGLE_API_KEY, PEXELS_API_KEY

# Engine B (paused; do not configure now) — Verticals v3
gh repo fork <UPSTREAM_OWNER>/youtube-shorts-pipeline --clone
cp engine-b-patches/broll.py <forkB>/verticals/broll.py
cp engine-b-patches/verticals.workflow.yml <forkB>/.github/workflows/verticals.yml
# apply engine-b-patches/config_additions.md
# add secrets: GEMINI_API_KEY, YOUTUBE_TOKEN_JSON, YOUTUBE_CLIENT_SECRET_B64, (PEXELS_API_KEY)
```

Verify the Engine B (paused; do not configure now) image-generation migration (no network required):

```bash
python3 tests/broll_migration.test.py
```

## 4. Wire the console to your forks

Console → **Settings → GitHub repositories**:

* Engine A repository: `<GITHUB_OWNER>/gemini-youtube-automation`, workflow `main.yml`
* Engine B (paused; do not configure now) repository: `<GITHUB_OWNER>/youtube-shorts-pipeline`, workflow `verticals.yml`
* Branch: `main` (or your default branch)
* Save, then **Test GitHub connection**.

## 5. First production test (safe)

1. Settings → keep **Review required ON**, visibility **private**, cap **2/day**.
2. Pipelines → Engine A → **Start run** → phase **draft** (produces without
   publishing) or **full** if your fork's uploader honors `YOUTUBE_PRIVACY_STATUS=private`.
3. Run History → **Sync GitHub runs** — statuses arrive from real GitHub data.
4. Content Queue → review the video → **Approve & Schedule** → **Publish**.
5. Confirm the YouTube Studio upload shows **private** with the recorded video ID.
6. Only then consider `unlisted`/`public` and higher caps.

## 6. Test the console itself

```bash
node --test tests/api.smoke.test.js    # auth, dedupe, gates, caps, locks
node --test tests/dedupe.test.js       # normalisation unit tests
python3 tests/broll_migration.test.py  # Engine B (paused; do not configure now) image-gen migration
```

Current automated results: see docs/TESTING.md for the full matrix
(verified locally; live GitHub/YouTube checks need real credentials).

## 7. Optional: keep statuses live

Wire a scheduled trigger (e.g. GitHub Action `schedule` on a small sync repo,
or Cloudflare Cron Trigger calling `POST /api/sync/github` with a service
token) to poll run statuses periodically. The **Sync GitHub runs** button in
Run History performs the same sync manually.
