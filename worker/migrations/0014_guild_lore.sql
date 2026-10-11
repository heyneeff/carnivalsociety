-- Guild Lore — Carny Code / Oath / Toast, recited at meetings. One shared
-- doc, readable by every signed-in member (crew hub, not ringleader-gated
-- like Meetings), editable only by Ringleaders.

CREATE TABLE guild_lore (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);
