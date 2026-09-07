ALTER TABLE applications ADD COLUMN details_removed_at TEXT;
ALTER TABLE applications ADD COLUMN retention_execution TEXT;
ALTER TABLE requests ADD COLUMN reviewed_at TEXT;
