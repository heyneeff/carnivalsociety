-- Merch: simple per-event checklist of items to make, each with a name and
-- who's making it. No status/materials of its own — just a name + assignee.

CREATE TABLE event_merch (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_merch_event ON event_merch(event_id);
