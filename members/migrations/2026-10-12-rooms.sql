-- Personal Dressing Rooms: each member's theme (which painting) and layout
-- (the same item JSON the room editor writes). No row = the default room.
CREATE TABLE user_rooms (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'classic',
  items TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Huzzah notes visitors stick on the mirror.
CREATE TABLE room_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_room_notes_room ON room_notes(room_user_id, id);
