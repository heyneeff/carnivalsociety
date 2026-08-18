-- Games get a proposed/locked-in status (color-coded in the UI). Applies to
-- the activities table generally, though only the Games column exposes the
-- toggle for now.

ALTER TABLE event_activities ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in'));
