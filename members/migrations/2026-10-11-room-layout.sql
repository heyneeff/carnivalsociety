-- The Dressing Room layout Neeff arranges in the room's Arrange mode.
-- One row ('main'); data = JSON array of placed items (see ROOM_ROLES in
-- app.js). No row = the default layout baked into app.js.
CREATE TABLE room_layout (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
