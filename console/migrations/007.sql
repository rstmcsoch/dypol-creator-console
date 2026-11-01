-- Delete video (31 Oct 2026). Also self-applied by ensureProgressSchema.
CREATE TABLE IF NOT EXISTS deletions (
  job_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active', plan TEXT, done TEXT,
  lease_owner TEXT, lease_exp INTEGER, last_error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS cap_ledger (
  day TEXT PRIMARY KEY, deleted_published INTEGER NOT NULL DEFAULT 0);
ALTER TABLE activity ADD COLUMN job_id TEXT;
