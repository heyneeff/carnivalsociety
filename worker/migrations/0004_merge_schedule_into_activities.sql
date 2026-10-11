-- Schedule (day-of itinerary) is redundant with the Events activity kind —
-- both are just "a thing happening at a time/place." Fold starts_at/ends_at/
-- location onto event_activities (useful for games too, e.g. a scheduled
-- tournament slot) and drop the separate schedule table.

ALTER TABLE event_activities ADD COLUMN starts_at TEXT;
ALTER TABLE event_activities ADD COLUMN ends_at TEXT;
ALTER TABLE event_activities ADD COLUMN location TEXT;

DROP TABLE event_schedule_items;
