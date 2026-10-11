-- The Schedule board reused `position`, the same column the Games/Events
-- lists sort by (they tie on starts_at IS NULL, so position is their only
-- sort key). Reordering the schedule board reset positions to 0,1,2... per
-- day, which bounced those same items to the top of the Games/Events lists.
-- Give the schedule board its own column so the two orderings don't collide.
ALTER TABLE event_activities ADD COLUMN schedule_position INTEGER NOT NULL DEFAULT 0;
