-- Merch and Signs get the same proposed/locked-in status as games.

ALTER TABLE event_merch ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in'));
ALTER TABLE event_signs ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in'));
