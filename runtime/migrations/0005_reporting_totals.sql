CREATE TABLE outcome_totals (
  metric TEXT PRIMARY KEY CHECK(metric IN ('menteeProgress','menteeValue','mentorValue','mentorReturn')),
  included INTEGER NOT NULL DEFAULT 0 CHECK(included>=0),
  positive INTEGER NOT NULL DEFAULT 0 CHECK(positive>=0 AND positive<=included),
  missing INTEGER NOT NULL DEFAULT 0 CHECK(missing>=0 AND missing<=included),
  interpretationPending INTEGER NOT NULL DEFAULT 0 CHECK(interpretationPending>=0 AND interpretationPending<=included)
);
INSERT INTO outcome_totals(metric) VALUES('menteeProgress'),('menteeValue'),('mentorValue'),('mentorReturn');
ALTER TABLE deletion_ledger DROP COLUMN actor;
ALTER TABLE deletion_ledger DROP COLUMN action_hash;
