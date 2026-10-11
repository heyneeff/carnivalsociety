-- Run of show: an event's timeline (load-in, doors, acts, strike…),
-- shown on its flyer with NOW / UP NEXT while the event is on.
CREATE TABLE run_of_show (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at TEXT NOT NULL,          -- ISO datetime (UTC)
  title TEXT NOT NULL,
  who TEXT,                  -- who's leading it (free text)
  place TEXT,                -- where on site
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_run_of_show_event ON run_of_show(event_id, at);
