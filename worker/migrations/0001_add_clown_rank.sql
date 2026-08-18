-- Adds 'clown' to the guild_rank set. SQLite can't ALTER a CHECK constraint,
-- so this rebuilds the users table with the same columns/defaults and a
-- widened CHECK, copies the data across, and swaps it in. D1 enforces
-- foreign keys, and sessions/boards/posts/events/member_connections/
-- field_data/projects_data all reference `users` by name -- so the old
-- table is renamed out of the way first (never dropped while it's the
-- thing those FKs resolve against), the new one takes the `users` name,
-- and only the now-unreferenced old copy gets dropped at the end.

ALTER TABLE users RENAME TO users_old;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  home_chapter_id TEXT REFERENCES chapters(id),
  rank TEXT NOT NULL DEFAULT 'apprentice' CHECK (rank IN ('apprentice', 'journeyman', 'master', 'clown')),
  is_ringleader INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  dues_paid INTEGER NOT NULL DEFAULT 0,
  dues_amount TEXT,
  dues_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  steward_role TEXT CHECK (steward_role IN ('founder_steward','systems_steward','participation_steward','archive_steward','place_living_steward','temporal_steward','operations_finance_steward','carnival_director')),
  birthday TEXT,
  skills TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0
);

INSERT INTO users SELECT * FROM users_old;

DROP TABLE users_old;
