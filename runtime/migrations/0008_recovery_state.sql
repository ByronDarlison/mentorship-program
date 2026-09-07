CREATE TABLE recovery_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cycle_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cycle_sequence>=0),
  status TEXT NOT NULL DEFAULT 'empty' CHECK(status IN ('empty','pending','ready')),
  cycle_id TEXT,
  started_at TEXT,
  created_at TEXT,
  backup_key TEXT,
  backup_sha256 TEXT,
  checkpoint_key TEXT,
  checkpoint_sha256 TEXT,
  expiry TEXT CHECK(expiry IS NULL OR expiry IN ('pending','complete','failed','unconfirmed')),
  CHECK((status='empty')=(cycle_id IS NULL)),
  CHECK(status<>'ready' OR (created_at IS NOT NULL AND backup_key IS NOT NULL AND backup_sha256 IS NOT NULL AND checkpoint_key IS NOT NULL AND checkpoint_sha256 IS NOT NULL))
);
INSERT INTO recovery_state(id) VALUES(1);
