-- Drag-and-drop day schedule for events (games stay undated). NULL means
-- unscheduled. Reuses the existing `position` column for ordering within a
-- day, same as everywhere else in event_activities.

ALTER TABLE event_activities ADD COLUMN schedule_day TEXT;
