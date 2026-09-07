-- Splits each scheduled day into time slots (2-4pm, 4-6pm, 12-2am), plus an
-- "Anytime" bucket ('') for items placed on a day before slots existed, or
-- not pinned to a specific time. NULL schedule_slot on the Ongoing bucket
-- (schedule_day = '') is normalized to '' by the app the same way.
ALTER TABLE event_activities ADD COLUMN schedule_slot TEXT NOT NULL DEFAULT '';
