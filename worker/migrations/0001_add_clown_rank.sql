-- Adds 'clown' to the guild_rank set. SQLite can't ALTER a CHECK constraint,
-- so this rebuilds the users table with the same columns/defaults/FKs and a
-- widened CHECK, copies the data across, and swaps it in.

CREATE TABLE users_new (
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

INSERT INTO users_new SELECT * FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
