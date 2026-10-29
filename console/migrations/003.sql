-- DYPOL Creator Console — migration 003 (non-destructive): live progress via
-- GitHub webhooks (workflow_run + workflow_job).
--   wrangler d1 execute dypol-console --remote --file=migrations/003.sql
-- The Pages Functions also self-apply this idempotently at runtime
-- (functions/api/_lib/webhook.js#ensureProgressSchema), so a deploy never
-- breaks if this file has not been run. Re-running the ALTERs on a database
-- that already has the columns fails harmlessly ("duplicate column").

CREATE TABLE IF NOT EXISTS gh_jobs (
  gh_job_id    TEXT PRIMARY KEY,
  gh_run_id    TEXT NOT NULL,
  repo         TEXT,
  name         TEXT,
  status       TEXT,
  conclusion   TEXT,
  html_url     TEXT,
  started_at   TEXT,
  completed_at TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_gh_jobs_run ON gh_jobs(gh_run_id);

CREATE TABLE IF NOT EXISTS job_steps (
  gh_run_id    TEXT NOT NULL,
  gh_job_id    TEXT NOT NULL,
  number       INTEGER NOT NULL,
  name         TEXT,
  status       TEXT,
  conclusion   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  updated_at   TEXT,
  PRIMARY KEY (gh_run_id, gh_job_id, number)
);
CREATE INDEX IF NOT EXISTS idx_job_steps_run ON job_steps(gh_run_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          TEXT PRIMARY KEY,
  event       TEXT,
  received_at TEXT NOT NULL
);

ALTER TABLE runs ADD COLUMN conclusion TEXT;
ALTER TABLE runs ADD COLUMN current_step TEXT;
ALTER TABLE runs ADD COLUMN completed_at TEXT;
ALTER TABLE runs ADD COLUMN updated_at TEXT;
ALTER TABLE jobs ADD COLUMN current_step TEXT;
