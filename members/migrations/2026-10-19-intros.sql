-- Introductions + faces (2026-10-14). Every newcomer introduces themself
-- (where they're from, what brings them) before stepping in; it's posted in
-- the pinned "Introduce yourself!" thread in the Courtyard once they're in
-- (intro_post_id). Members who were already here count as introduced.
-- Photos: one small square picture per member, kept in the database
-- (resized in the browser to ~320px), served at /api/photos/<id>.
ALTER TABLE users ADD COLUMN intro TEXT;
ALTER TABLE users ADD COLUMN introduced_at TEXT;
ALTER TABLE users ADD COLUMN intro_post_id TEXT;
UPDATE users SET introduced_at = datetime('now') WHERE introduced_at IS NULL;
CREATE TABLE user_photos (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
