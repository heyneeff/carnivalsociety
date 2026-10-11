-- Adds 'clown' to the guild_rank set. SQLite can't ALTER a CHECK constraint,
-- so this rebuilds the users table with the same columns/defaults and a
-- widened CHECK, then swaps it in under the same name.
--
-- D1 enforces foreign keys, and sessions/posts/events/member_connections/
-- field_data/projects_data all reference `users` by name. Renaming `users`
-- out of the way first (the original approach) breaks those references: SQLite
-- rewrites the child tables' FK clauses to point at the new name during the
-- rename, so the rebuilt `users` table swapping back in doesn't reconnect to
-- them and a later DROP of the renamed-away original then violates FK
-- constraints against those now-orphaned references. Instead: disable FK
-- enforcement for this statement batch, build the replacement under a
-- throwaway name, drop the original `users` (which the still-intact child
-- tables still point at by name), then rename the replacement into that
-- freed-up name so those references resolve correctly again.

PRAGMA foreign_keys=OFF;

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

INSERT INTO users_new SELECT id, email, password_hash, salt, display_name, home_chapter_id, rank, is_ringleader, avatar_url, dues_paid, dues_amount, dues_date, created_at, steward_role, birthday, skills, onboarded FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys=ON;
