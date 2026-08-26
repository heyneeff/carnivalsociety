-- Priority flag for materials, surfaced as a checkbox on the Needs list.

ALTER TABLE event_materials ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
