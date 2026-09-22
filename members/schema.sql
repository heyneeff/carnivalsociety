-- Carnival Society International — members app schema (Cloudflare D1 / SQLite)
-- Run via: npx wrangler d1 execute carnivalsociety-members --remote --file=schema.sql
-- (use --local instead of --remote for local `wrangler dev` testing)

-- ============================================================
-- CHAPTERS
-- ============================================================
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO chapters (id, name, slug) VALUES
  (lower(hex(randomblob(16))), 'Boulder', 'boulder'),
  (lower(hex(randomblob(16))), 'Denver', 'denver'),
  (lower(hex(randomblob(16))), 'Los Angeles', 'los-angeles');

-- ============================================================
-- USERS — was `profiles` + Supabase `auth.users`; now holds credentials too
-- ============================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  home_chapter_id TEXT REFERENCES chapters(id),
  -- Default was 'apprentice' originally; new signups are given 'clown'
  -- explicitly in worker.js as of 2026-09-22 (column default below is
  -- stale/unused — changing it would require a CHECK-constraint table
  -- rebuild, which D1 blocks via mandatory foreign-key enforcement; not
  -- worth 8 other tables' worth of risk for a default that's set at the
  -- application layer anyway).
  rank TEXT NOT NULL DEFAULT 'apprentice' CHECK (rank IN ('apprentice', 'journeyman', 'master', 'clown')),
  is_ringleader INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  dues_paid INTEGER NOT NULL DEFAULT 0,
  dues_amount TEXT,
  dues_date TEXT,
  steward_role TEXT CHECK (steward_role IN (
    'founder_steward', 'systems_steward', 'participation_steward', 'archive_steward',
    'place_living_steward', 'temporal_steward', 'operations_finance_steward', 'carnival_director'
  )),
  birthday TEXT,
  skills TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  -- When this user (a Ringleader) last checked the new-signup notification bell.
  -- NULL means never checked; ringleaders compare users.created_at against this
  -- to find unseen signups (see /api/admin/new-signups in worker.js). Added via
  -- migration on 2026-09-22 — not part of the original CREATE TABLE on prod.
  signups_seen_at TEXT,
  -- Directory contact fields, added via migration on 2026-09-22. city is
  -- required at signup (enforced in worker.js, not here); phone and
  -- instagram_handle are always optional.
  city TEXT,
  phone TEXT,
  instagram_handle TEXT,
  -- Free-text onboarding fields (replaced a checkbox multi-select against
  -- member_connections, which is still used elsewhere e.g. the Member
  -- Network view — this just stopped being how onboarding populates it).
  -- Added via migration 2026-09-22.
  knows_who TEXT,
  heard_about_us TEXT,
  -- True for organization signups (a checkbox at signup / Members Hub, not
  -- a rank tier) — display code shows "Organization" as their title instead
  -- of their (otherwise-unused) rank. Added via migration 2026-09-22.
  is_organization INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- MEMBER CONNECTIONS — "who knows who," declared at onboarding (or later).
-- Guild-wide, visible to any Ringleader via /api/network — distinct from
-- field_data, which is each Ringleader's own private canvas.
-- ============================================================
CREATE TABLE member_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, connected_user_id)
);
CREATE INDEX idx_member_connections_user ON member_connections(user_id);
CREATE INDEX idx_member_connections_connected ON member_connections(connected_user_id);

-- ============================================================
-- FIELD DATA — private per-user "Guild Map" (relational field tool retrofit).
-- One row per user; each user only ever reads/writes their own row (enforced
-- in worker.js, not RLS) — this is how "only I have access" is guaranteed,
-- not just Ringleader-gating. Arrays/objects stored as JSON text, mirroring
-- the original standalone app's single localStorage blob.
-- ============================================================
CREATE TABLE field_data (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  center_name TEXT,
  communities TEXT NOT NULL DEFAULT '[]',
  reltypes TEXT NOT NULL DEFAULT '[]',
  people TEXT NOT NULL DEFAULT '[]',
  connections TEXT NOT NULL DEFAULT '[]',
  layouts TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- PROJECTS DATA — private per-user projects + to-do list. Same privacy
-- model as field_data: one row per user, scoped by session user_id in
-- worker.js, never cross-readable.
-- ============================================================
CREATE TABLE projects_data (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  projects TEXT NOT NULL DEFAULT '[]',
  todos TEXT NOT NULL DEFAULT '[]',
  -- Private personal docs for the Leadership Docs column — distinct from the
  -- static, shared CSI governance docs baked into app.js. Never readable by
  -- anyone but this user (enforced by user_id scoping in worker.js, same as
  -- everything else in this table).
  leadership_docs TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SESSIONS — replaces Supabase Auth's session handling
-- ============================================================
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- BOARDS — one guild-wide board (chapter_id null) + one per chapter
-- ============================================================
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id), -- null = guild-wide
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO boards (id, chapter_id, name, slug, description) VALUES
  (lower(hex(randomblob(16))), NULL, 'Guild Hall', 'guild-hall', 'Guild-wide — open to every member, any chapter.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'boulder'), 'Boulder', 'boulder', 'Boulder chapter board.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'denver'), 'Denver', 'denver', 'Denver chapter board.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'los-angeles'), 'Los Angeles', 'los-angeles', 'Los Angeles chapter board.');

-- ============================================================
-- POSTS — top-level posts have title set, replies set parent_id instead
-- ============================================================
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

-- ============================================================
-- DIRECT MESSAGES
-- ============================================================
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

-- ============================================================
-- EVENTS — publicly readable, managed only by Masters and Ringleaders
-- ============================================================
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

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_posts_board ON posts(board_id);
CREATE INDEX idx_posts_parent ON posts(parent_id);
CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id);
CREATE INDEX idx_conv_participants_user ON conversation_participants(user_id);
CREATE INDEX idx_events_starts ON events(starts_at);

-- Authorization note: Postgres RLS is gone — every rule below is enforced in
-- worker.js route handlers instead. Kept here as the checklist that was ported:
--   * users:   self can update display_name/home_chapter_id/avatar_url only;
--              rank/is_ringleader/dues_* are Ringleader-only writes.
--   * boards:  readable by any authenticated user; managed by moderators
--              (rank = 'master' OR is_ringleader) only.
--   * posts:   readable by any authenticated user; insertable by the author;
--              editable/deletable by author OR moderator; pin is moderator-only.
--   * events:  publicly readable (no auth required); managed by moderators only.
--   * conversations/participants/direct_messages: visible only to participants;
--              insertable only by an authenticated participant.
