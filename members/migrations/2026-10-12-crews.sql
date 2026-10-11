-- Crew tables: a little chat for everyone volunteering at an event.
CREATE TABLE crew_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_crew_messages_event ON crew_messages(event_id, id);
-- Handshakes: two crewmates who met at an event, both said yes. One row per
-- pair, ever (user_a < user_b); met_at is set when the second person agrees.
-- The Troupe Album is everyone you've shaken hands with.
CREATE TABLE handshakes (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  asked_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  met_at TEXT,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX idx_handshakes_b ON handshakes(user_b);
