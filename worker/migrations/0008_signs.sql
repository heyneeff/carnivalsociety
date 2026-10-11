-- Signs: same shape as event_merch (name + who's making it), just its own
-- category so signage doesn't get mixed in with the general Merch list.

CREATE TABLE event_signs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_signs_event ON event_signs(event_id);
