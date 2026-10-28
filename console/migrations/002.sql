-- DYPOL Creator Console — migration 002 (non-destructive)
-- Apply to EXISTING databases created before the audit release:
--   wrangler d1 execute dypol-console --file=migrations/002.sql
-- Fresh databases: schema.sql already includes these columns.

ALTER TABLE jobs ADD COLUMN error_category TEXT;
ALTER TABLE jobs ADD COLUMN error_retryable INTEGER;
ALTER TABLE jobs ADD COLUMN parent_job_id TEXT;
ALTER TABLE jobs ADD COLUMN attempt INTEGER DEFAULT 1;

ALTER TABLE uploads ADD COLUMN idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
