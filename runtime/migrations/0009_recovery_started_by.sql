ALTER TABLE recovery_state ADD COLUMN started_by TEXT CHECK(started_by IS NULL OR started_by IN ('scheduled','operator'));
