-- 005: Quota & health panel cache. The /api/quota handler also creates it on
-- first use (CREATE TABLE IF NOT EXISTS), so applying this is optional.
CREATE TABLE IF NOT EXISTS quota_cache (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
