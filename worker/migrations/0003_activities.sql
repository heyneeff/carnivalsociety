-- Games and Events (carnival-day attractions, distinct from the guild-wide
-- Events calendar) — each one can have its own materials list. Materials
-- stay in the same event_materials table with an optional activity_id tag,
-- so an item added under a game/event automatically shows up in the crew's
-- shared Materials tab too instead of needing to be entered twice.

CREATE TABLE event_activities (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game', 'event')),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_activities_event ON event_activities(event_id);

ALTER TABLE event_materials ADD COLUMN activity_id TEXT REFERENCES event_activities(id) ON DELETE SET NULL;

CREATE INDEX idx_materials_activity ON event_materials(activity_id);
