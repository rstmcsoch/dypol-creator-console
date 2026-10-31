-- DYPOL Creator Console — migration 006 (non-destructive): Retry = fresh
-- workflow_dispatch. jobs.retry_count (max 2 per job) and runs.inputs (the
-- exact inputs sent, so a retry resends them, incl. reviewer_feedback).
-- Self-applied at runtime by ensureProgressSchema; running this is optional.
--   wrangler d1 execute dypol-console --remote --file=migrations/006.sql
ALTER TABLE jobs ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN inputs TEXT;
