ALTER TABLE applications ADD COLUMN decision TEXT NOT NULL DEFAULT 'waiting' CHECK(decision IN ('waiting','approved','declined'));
ALTER TABLE applications ADD COLUMN readiness INTEGER NOT NULL DEFAULT 0 CHECK(readiness IN (0,1));
ALTER TABLE applications ADD COLUMN retention TEXT NOT NULL DEFAULT 'awaiting-review' CHECK(retention IN ('awaiting-review','keep','delete-requested'));
CREATE TABLE cohorts (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  first_cohort INTEGER UNIQUE CHECK(first_cohort IS NULL OR first_cohort=1)
);
CREATE TABLE pairs (
  id TEXT PRIMARY KEY,
  mentee_id TEXT NOT NULL REFERENCES applications(id),
  mentor_id TEXT NOT NULL REFERENCES applications(id),
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
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_open_mentee ON pairs(mentee_id) WHERE status != 'ended';
CREATE TABLE chair_actions (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subjects TEXT NOT NULL CHECK(json_valid(subjects)),
  result TEXT NOT NULL CHECK(json_valid(result)),
  created_at TEXT NOT NULL
);
CREATE TABLE matching_copies (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  facts TEXT NOT NULL CHECK(json_valid(facts))
);
