-- Lets the event stream replay campaign creations when a client resumes with Last-Event-ID.
ALTER TABLE campaigns ADD COLUMN created_event_id TEXT;
CREATE INDEX campaigns_created_event_idx ON campaigns (created_event_id) WHERE created_event_id IS NOT NULL;
