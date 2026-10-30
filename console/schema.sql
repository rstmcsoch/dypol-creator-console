-- DYPOL Creator Console — Cloudflare D1 schema
-- Apply with: wrangler d1 execute dypol-console --file=schema.sql

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  engine        TEXT NOT NULL CHECK (engine IN ('gemini','verticals')),
  title         TEXT NOT NULL,
  topic         TEXT,
  topic_key     TEXT NOT NULL,
  niche         TEXT DEFAULT 'general',
  format        TEXT DEFAULT 'short',
  status        TEXT NOT NULL DEFAULT 'queued',
  stage         TEXT,
  progress      INTEGER DEFAULT 0,
  description   TEXT DEFAULT '',
  tags          TEXT DEFAULT '[]',
  duration_sec  INTEGER,
  thumbnail     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  scheduled_for TEXT,
  published_at  TEXT,
  youtube_id    TEXT,
  youtube_url   TEXT,
  error         TEXT,
  error_category TEXT,
  error_retryable INTEGER,
  quality       TEXT DEFAULT '{}',
  logs          TEXT DEFAULT '[]',
  run_id        TEXT,
  parent_job_id TEXT,
  attempt       INTEGER DEFAULT 1,
  publish_blocked TEXT,
  duplicate_of  TEXT,
  current_step  TEXT,
  publish_run_id TEXT,
  uploading_since INTEGER,
  review_note   TEXT,
  videos        TEXT,
  error_log     TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_topic_key ON jobs(topic_key);
CREATE INDEX IF NOT EXISTS idx_jobs_engine ON jobs(engine);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  run_id         TEXT,
  engine         TEXT NOT NULL,
  workflow       TEXT NOT NULL,
  job_id         TEXT,
  started_at     TEXT NOT NULL,
  duration_sec   INTEGER,
  status         TEXT NOT NULL,
  failure_reason TEXT,
  github_url     TEXT,
  steps          TEXT DEFAULT '[]',
  logs           TEXT DEFAULT '[]',
  artifacts      TEXT DEFAULT '[]',
  conclusion     TEXT,
  current_step   TEXT,
  completed_at   TEXT,
  updated_at     TEXT,
  phase          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_engine ON runs(engine);

CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  topic_key   TEXT NOT NULL,
  youtube_id  TEXT NOT NULL,
  job_id      TEXT,
  at          TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_uploads_key ON uploads(topic_key);
CREATE INDEX IF NOT EXISTS idx_uploads_at ON uploads(at);

CREATE TABLE IF NOT EXISTS activity (
  id    TEXT PRIMARY KEY,
  ts    TEXT NOT NULL,
  icon  TEXT,
  tone  TEXT,
  title TEXT,
  sub   TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  name       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Live progress (GitHub webhooks) — see migrations/003.sql
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

-- Login throttle keyed by a salted SHA-256 of the client IP (no raw IPs stored).
CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash   TEXT PRIMARY KEY,
  attempts   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Quota & health panel cache (refreshed at most every 30 minutes).
CREATE TABLE IF NOT EXISTS quota_cache (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
