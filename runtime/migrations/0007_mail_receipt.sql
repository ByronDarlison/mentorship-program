ALTER TABLE jobs ADD COLUMN rfc_message_id TEXT;
CREATE UNIQUE INDEX jobs_rfc_message_id ON jobs(rfc_message_id);
