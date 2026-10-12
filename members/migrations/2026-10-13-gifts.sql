-- Surprises: the Ringleader leaves a wrapped gift in someone's Dressing Room.
-- Unwrapping puts the item in their room for good, with the note attached.
-- A guest pass (kind 'pass') is a real Admit One: its code is scanned at the
-- door like a ticket, once (redeemed_at). event_id NULL = any carnival.
CREATE TABLE room_gifts (
  id TEXT PRIMARY KEY,
  room_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'item',     -- 'item' | 'pass'
  img TEXT NOT NULL,
  note TEXT,
  code TEXT UNIQUE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at TEXT,
  redeemed_at TEXT,
  redeemed_event_id TEXT REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX idx_room_gifts_room ON room_gifts(room_user_id, created_at);
