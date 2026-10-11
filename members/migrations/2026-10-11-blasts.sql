-- Blasts: the Ringleader rings everyone's telephone. One row per blast,
-- one receipt per recipient (seen_at = they picked up).
CREATE TABLE blasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  audience TEXT NOT NULL,          -- JSON {type, value, label}
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE blast_receipts (
  blast_id INTEGER NOT NULL REFERENCES blasts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at TEXT,
  PRIMARY KEY (blast_id, user_id)
);
CREATE INDEX idx_blast_receipts_user ON blast_receipts(user_id, seen_at);
