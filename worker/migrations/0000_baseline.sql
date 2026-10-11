-- Baseline schema dump of the live carnivalsociety-members D1 database,
-- captured 2026-08-17. This documents what's actually running; it was
-- never committed anywhere before now. Do not re-run this against the
-- live database -- it's a record, not a migration to apply.

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  home_chapter_id TEXT REFERENCES chapters(id),
  rank TEXT NOT NULL DEFAULT 'apprentice' CHECK (rank IN ('apprentice', 'journeyman', 'master')),
  is_ringleader INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  dues_paid INTEGER NOT NULL DEFAULT 0,
  dues_amount TEXT,
  dues_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, steward_role TEXT CHECK (steward_role IN ('founder_steward','systems_steward','participation_steward','archive_steward','place_living_steward','temporal_steward','operations_finance_steward','carnival_director')), birthday TEXT, skills TEXT, onboarded INTEGER NOT NULL DEFAULT 0);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id), -- null = guild-wide
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id), -- null = guild-wide
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, connected_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, connected_user_id));

CREATE TABLE field_data (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, center_name TEXT, communities TEXT NOT NULL DEFAULT '[]', reltypes TEXT NOT NULL DEFAULT '[]', people TEXT NOT NULL DEFAULT '[]', connections TEXT NOT NULL DEFAULT '[]', layouts TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE projects_data (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, projects TEXT NOT NULL DEFAULT '[]', todos TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')), leadership_docs TEXT NOT NULL DEFAULT '[]');

CREATE INDEX idx_conv_participants_user ON conversation_participants(user_id);
CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id);
CREATE INDEX idx_events_starts ON events(starts_at);
CREATE INDEX idx_member_connections_connected ON member_connections(connected_user_id);
CREATE INDEX idx_member_connections_user ON member_connections(user_id);
CREATE INDEX idx_posts_board ON posts(board_id);
CREATE INDEX idx_posts_parent ON posts(parent_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
