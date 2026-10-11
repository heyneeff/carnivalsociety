-- Courtyard launch: Courtyard board, event volunteers, password resets, last-seen.
-- Apply AFTER 2026-10-04-tiers-tickets.sql. On remote, run each statement as
-- its own --command (D1 multi-statement gotcha), --local first.

ALTER TABLE users ADD COLUMN last_seen_at TEXT;

-- Readable by every signed-in member (courtyard included); only moderators
-- start threads here, inner members can reply.
INSERT INTO boards (id, chapter_id, name, slug, description) VALUES
  (lower(hex(randomblob(16))), NULL, 'Courtyard', 'courtyard', 'News, calls for volunteers, and what''s coming up. Open to everyone who has joined.');

-- Separate from event_crew on purpose: volunteering must not unlock the
-- inner-only crew Hub tools.
CREATE TABLE event_volunteers (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_event_volunteers_user ON event_volunteers(user_id);

-- Only the SHA-256 of the emailed token is stored; single use, 1h expiry.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
