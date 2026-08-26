-- Guild-wide meeting docs (run-of-show notes, agendas), editable by any
-- Ringleader. Not per-event — this is guild-wide leadership content, same
-- gate as Members Hub / Guild Map / Projects / Member Network.

CREATE TABLE guild_meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
