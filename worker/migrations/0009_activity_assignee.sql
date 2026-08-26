-- Games and events can now have a person assigned to run/own them, same
-- pattern as Merch/Signs.

ALTER TABLE event_activities ADD COLUMN assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;
