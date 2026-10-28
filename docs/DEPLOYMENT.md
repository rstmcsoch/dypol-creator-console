# Deployment — Cloudflare Pages + D1 (free tier)

Target: deployable from an Android tablet through web UIs (Cloudflare
dashboard + GitHub web), with `wrangler` CLI as the alternative.

## A. Cloudflare dashboard path (Android tablet friendly — no CLI)

**A1. Direct asset upload (simplest on a tablet):**

1. Prepare the upload: the zip must contain the **contents of `console/`**
   at its root (`index.html`, `assets/`, `functions/`, `wrangler.toml`,
   `schema.sql`, …) — not the `console` folder itself. (The release zip
   `dypol-creator-console.zip` nests the project folder — extract it and
   re-zip just `console/`'s contents if needed.)
2. **dash.cloudflare.com** → *Workers & Pages* → *Create* → **Pages** →
   *Upload assets* → name the project `dypol-creator-console` → upload the zip.
   Build command: **none**. Output directory: **`/`** (leave as-is).
3. *Settings → Functions* → **D1 database bindings**: create binding `DB`
   → create database `dypol-console` (this binding name must be exactly `DB`).
4. *Settings → Environment variables* → add the **encrypted** secrets from
   docs/SECRETS.md (`ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `GITHUB_TOKEN`, …).
5. Open the deployed URL → login with the password you hashed.
6. **Apply the schema** once: Cloudflare dashboard → D1 → *dypol-console* →
   Console tab → paste and run the statements from `console/schema.sql`
   (and `console/migrations/002.sql` only if your DB predates the audit release).

**A2. Git-connected repo (also dashboard-only):** connect the repo →
build command **none** → output directory **`console`** (repo-relative) →
same binding + secrets steps as above.

> Which output directory? It depends on what you uploaded: **`/`** when the
> upload's root already *is* the app (A1), **`console`** when the dashboard
> sees the whole repository (A2). Uploading the repo zip in A1 mode with
> output `/` would deploy the README at the site root — if the site shows a
> file listing or 404, the directory level is wrong.

## B. wrangler CLI path (from the `console/` directory)

All commands run **inside `console/`** — `console/wrangler.toml` sets
`pages_build_output_dir = "."` relative to itself, and `npm run preflight`
refuses to deploy if `index.html`/`functions/` are missing (so an empty or
wrongly-nested directory can never be deployed silently).

```bash
cd dypol-creator-console/console
npx wrangler login                       # or: npm i -g wrangler && wrangler login
npm run db:create                        # wrangler d1 create dypol-console
#   → paste the returned database_id into console/wrangler.toml
npm run db:schema                        # wrangler d1 execute … --file=schema.sql
npm run db:migrate                       # only for DBs created before the audit release
npx wrangler pages secret put ADMIN_PASSWORD_HASH   # once per secret
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put GITHUB_TOKEN
npm run deploy                           # preflight + wrangler pages deploy .
```

## C. Post-deploy checklist

- [ ] Login works with the hashed password; wrong password is rejected.
- [ ] `/api/health` reports `db: ok` and correct secret booleans.
- [ ] Settings → GitHub: *Test GitHub connection* passes.
- [ ] A `draft`-phase run dispatches the Engine A fork workflow (GitHub → Actions).
- [ ] Run History → *Sync GitHub runs* updates the run's real status.
- [ ] Review → Approve → Publish produces a **private** YouTube upload.
- [ ] Re-publishing the same job answers “already on YouTube — no duplicate”.
- [ ] Daily cap blocks the third upload (with cap=2).
- [ ] Analytics page says “not connected” honestly (no invented numbers).

## D. Custom domain (optional)

Pages → *Custom domains* → add your domain (Cloudflare DNS handles TLS).
Session cookies are `Secure`, so HTTPS is mandatory (the default pages.dev
domain already provides it).

## E. Keeping the free tier free

* Pages/Functions: 100k requests/day — far above personal-console usage.
* D1: 5M row reads + 100k row writes/day (hard-capped since 2026-09-01 —
  the console's queries are tiny; a busy month is well under 1% of this).
* GitHub Actions: public forks = free; private repos = 2,000 min/month. One
  Engine A run ≈ 25–35 min, one Engine B run ≈ 6–12 min → keep schedules
  modest on private repos.
* Artifact storage: watch retention (set 7–14 days in the workflows).
* Gemini: model calls are billed per token/image after free-tier quotas —
  see FREE_TIER.md. Not unlimited, even with an API key.

## F. What the dashboard backend must NOT do (by design)

* No FFmpeg / rendering / heavy Python in Workers (CPU 10 ms free limit).
* No long-lived processes (Workers are request-scoped).
* No credential echo — secrets are write-only through platform secret storage.
