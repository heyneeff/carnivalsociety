-- Games/Events can now have multiple crew assigned instead of just one.
-- The old event_activities.assignee_id column is left in place (unused
-- going forward) and backfilled into this join table so no assignment
-- is lost.
CREATE TABLE event_activity_assignees (
  activity_id TEXT NOT NULL REFERENCES event_activities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, user_id)
);

INSERT INTO event_activity_assignees (activity_id, user_id)
SELECT id, assignee_id FROM event_activities WHERE assignee_id IS NOT NULL;
