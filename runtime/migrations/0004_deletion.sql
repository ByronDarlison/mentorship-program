PRAGMA defer_foreign_keys = ON;
CREATE TABLE pairs_nullable (
  id TEXT PRIMARY KEY,
  mentee_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  mentor_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  group_name TEXT NOT NULL REFERENCES cohorts(name),
  fit_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'matched' CHECK(status IN ('matched','active','ended')),
  mentee_trained INTEGER NOT NULL DEFAULT 0 CHECK(mentee_trained IN (0,1)),
  mentor_trained INTEGER NOT NULL DEFAULT 0 CHECK(mentor_trained IN (0,1)),
  planned_date TEXT,
  planned_revision TEXT,
  actual_date TEXT,
  ended_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK(status='ended' OR (mentee_id IS NOT NULL AND mentor_id IS NOT NULL))
);
INSERT INTO pairs_nullable SELECT * FROM pairs;
DROP TABLE pairs;
ALTER TABLE pairs_nullable RENAME TO pairs;
CREATE UNIQUE INDEX one_open_mentee ON pairs(mentee_id) WHERE status != 'ended';
CREATE TABLE anonymous_outcomes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('mentee','mentor')),
  deadline TEXT NOT NULL,
  reporting_only INTEGER NOT NULL CHECK(reporting_only IN (0,1)),
  answered TEXT NOT NULL CHECK(json_valid(answered)),
  classifications TEXT NOT NULL CHECK(json_valid(classifications))
);
CREATE TABLE anonymous_completion (
  id INTEGER PRIMARY KEY CHECK(id=1),
  required INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  missed_deadlines INTEGER NOT NULL DEFAULT 0
);
INSERT INTO anonymous_completion(id) VALUES(1);
CREATE TABLE deletion_ledger (
  application_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  action_hash TEXT NOT NULL
);
PRAGMA defer_foreign_keys = OFF;
