PRAGMA foreign_keys = ON;
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  submission_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('mentee','mentor')),
  answers TEXT NOT NULL CHECK(json_valid(answers)),
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('captured','pending','sending','sent','held','cancelled')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  provider_id TEXT
);
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
