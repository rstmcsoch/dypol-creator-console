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
  duplicate_of  TEXT
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
  artifacts      TEXT DEFAULT '[]'
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
