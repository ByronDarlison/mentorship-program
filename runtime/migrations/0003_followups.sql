CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  role TEXT NOT NULL CHECK(role IN ('mentee','mentor')),
  kind TEXT NOT NULL CHECK(kind IN ('first','quarterly','final')),
  period INTEGER,
  booking_revision TEXT,
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  deadline TEXT,
  replied_at TEXT,
  superseded INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(answers)),
  answer_times TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(answer_times)),
  classifications TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(classifications)),
  conditions TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(conditions)),
  failure_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(failure_history)),
  token_hash TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  last_mutation TEXT
);
CREATE UNIQUE INDEX one_scheduled_request ON requests(pair_id,role,kind,COALESCE(period,0),COALESCE(booking_revision,''));
ALTER TABLE jobs ADD COLUMN request_id TEXT REFERENCES requests(id) ON DELETE CASCADE;
CREATE TABLE received_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
);
