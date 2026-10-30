-- DYPOL Creator Console — migration 004 (non-destructive): publish-result loop,
-- run phases, reviewer notes, multi-video links, failure log excerpts, hashed
-- login throttle. The Pages Functions self-apply all of this idempotently at
-- runtime (functions/api/_lib/webhook.js#ensureProgressSchema, called from the
-- API middleware), so running this file by hand is optional.
--   wrangler d1 execute dypol-console --remote --file=migrations/004.sql

ALTER TABLE jobs ADD COLUMN publish_run_id TEXT;
ALTER TABLE jobs ADD COLUMN uploading_since INTEGER;
ALTER TABLE jobs ADD COLUMN review_note TEXT;
ALTER TABLE jobs ADD COLUMN videos TEXT;
ALTER TABLE jobs ADD COLUMN error_log TEXT;
ALTER TABLE runs ADD COLUMN phase TEXT;

CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash   TEXT PRIMARY KEY,
  attempts   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
DELETE FROM settings WHERE key LIKE 'throttle:%';
