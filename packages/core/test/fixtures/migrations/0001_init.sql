-- Projection table convention: id + version + updated_at, plus whatever the read model needs.
CREATE TABLE counters (
  id         TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Test-only switch used to simulate projection failures.
CREATE TABLE test_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
