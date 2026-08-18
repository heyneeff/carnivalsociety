-- Meetups get a category: a regular planning meeting, or a field trip
-- (scouting a venue, supply run, etc.) — color-coded in the UI.

ALTER TABLE event_meetups ADD COLUMN category TEXT NOT NULL DEFAULT 'meeting' CHECK (category IN ('meeting', 'field_trip'));
