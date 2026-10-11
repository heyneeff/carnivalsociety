-- Carnival Society International — members app schema (Cloudflare D1 / SQLite)
-- Full schema for a FRESH database: snapshot of production (wrangler d1 export
-- --no-data, 2026-10-10) + seeds + every file in migrations/ to date.
-- Fresh DB:  npx wrangler d1 execute carnivalsociety-members --local --file=schema.sql
-- Prod is NOT rebuilt from this file; it gets the migrations/ deltas. When you
-- add a migration, append it here too so this stays the source of truth.
-- Per-column history/rationale for users lives in git history of this file.

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id), -- null = guild-wide
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, ends_at TEXT);
CREATE TABLE field_data (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, center_name TEXT, communities TEXT NOT NULL DEFAULT '[]', reltypes TEXT NOT NULL DEFAULT '[]', people TEXT NOT NULL DEFAULT '[]', connections TEXT NOT NULL DEFAULT '[]', layouts TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE projects_data (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, projects TEXT NOT NULL DEFAULT '[]', todos TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')), leadership_docs TEXT NOT NULL DEFAULT '[]');
CREATE TABLE member_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, connected_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, connected_user_id));
CREATE TABLE event_crew (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE event_meetups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  proposed_at TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, category TEXT NOT NULL DEFAULT 'meeting' CHECK (category IN ('meeting', 'field_trip')));
CREATE TABLE event_meetup_rsvps (
  meetup_id TEXT NOT NULL REFERENCES event_meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('yes', 'no', 'maybe')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meetup_id, user_id)
);
CREATE TABLE event_projects (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES event_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_project_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES event_projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_materials (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'need' CHECK (category IN ('need', 'want')),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, activity_id TEXT REFERENCES event_activities(id) ON DELETE SET NULL, priority INTEGER NOT NULL DEFAULT 0);
CREATE TABLE event_activities (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game', 'event')),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, starts_at TEXT, ends_at TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in')), assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL, schedule_day TEXT, schedule_position INTEGER NOT NULL DEFAULT 0, schedule_slot TEXT NOT NULL DEFAULT '');
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
, signups_seen_at TEXT, city TEXT, phone TEXT, instagram_handle TEXT, knows_who TEXT, heard_about_us TEXT, is_organization INTEGER NOT NULL DEFAULT 0, materials_to_donate TEXT);
CREATE TABLE event_merch (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in')));
CREATE TABLE event_signs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in')));
CREATE TABLE event_raffle (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'locked_in')),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE guild_meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, meeting_date TEXT, recap TEXT NOT NULL DEFAULT '');
CREATE TABLE guild_lore (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);
CREATE TABLE event_activity_assignees (
  activity_id TEXT NOT NULL REFERENCES event_activities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, user_id)
);
CREATE TABLE impact_logs (id TEXT PRIMARY KEY, event_date TEXT NOT NULL, event_name TEXT NOT NULL, venue_id TEXT REFERENCES venues(id), travel_miles REAL, travel_mode TEXT, material_sourcing TEXT, waste_generated TEXT, waste_diverted TEXT, notes TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, address TEXT, contact_name TEXT, contact_email TEXT, contact_phone TEXT, website TEXT, notes TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_posts_board ON posts(board_id);
CREATE INDEX idx_posts_parent ON posts(parent_id);
CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id);
CREATE INDEX idx_conv_participants_user ON conversation_participants(user_id);
CREATE INDEX idx_events_starts ON events(starts_at);
CREATE INDEX idx_member_connections_user ON member_connections(user_id);
CREATE INDEX idx_member_connections_connected ON member_connections(connected_user_id);
CREATE INDEX idx_event_crew_user ON event_crew(user_id);
CREATE INDEX idx_meetups_event ON event_meetups(event_id);
CREATE INDEX idx_meetup_rsvps_user ON event_meetup_rsvps(user_id);
CREATE INDEX idx_projects_event ON event_projects(event_id);
CREATE INDEX idx_projects_parent ON event_projects(parent_id);
CREATE INDEX idx_project_items_project ON event_project_items(project_id);
CREATE INDEX idx_materials_event ON event_materials(event_id);
CREATE INDEX idx_activities_event ON event_activities(event_id);
CREATE INDEX idx_materials_activity ON event_materials(activity_id);
CREATE INDEX idx_merch_event ON event_merch(event_id);
CREATE INDEX idx_signs_event ON event_signs(event_id);
CREATE INDEX idx_raffle_event ON event_raffle(event_id);
CREATE INDEX idx_impact_logs_date ON impact_logs(event_date);

-- ============================================================
-- SEEDS
-- ============================================================
INSERT INTO chapters (id, name, slug) VALUES
  (lower(hex(randomblob(16))), 'Boulder', 'boulder'),
  (lower(hex(randomblob(16))), 'Denver', 'denver'),
  (lower(hex(randomblob(16))), 'Los Angeles', 'los-angeles');

INSERT INTO boards (id, chapter_id, name, slug, description) VALUES
  (lower(hex(randomblob(16))), NULL, 'Guild Hall', 'guild-hall', 'Guild-wide — open to every member, any chapter.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'boulder'), 'Boulder', 'boulder', 'Boulder chapter board.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'denver'), 'Denver', 'denver', 'Denver chapter board.'),
  (lower(hex(randomblob(16))), (SELECT id FROM chapters WHERE slug = 'los-angeles'), 'Los Angeles', 'los-angeles', 'Los Angeles chapter board.');

-- ============================================================
-- migrations/2026-10-04-tiers-tickets.sql
-- ============================================================
-- Courtyard / inner-member tiers + event ticketing.
-- D1 multi-statement gotcha in the vault).

-- tier is a separate column from `rank` (rank's CHECK constraint can't be altered on D1).
-- No backfill: per Neeff 2026-10-10 every existing member starts in the
-- courtyard. Ringleaders count as inner via is_ringleader (isInner() in
-- worker.js); anyone else is promoted from the Directory's "Inner" toggle.
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'courtyard';  -- 'courtyard' | 'inner'

CREATE TABLE ticket_tiers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER,                       -- NULL = unlimited
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES ticket_tiers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'void'
  price_cents INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL UNIQUE,              -- shown as QR, scanned at the door
  stripe_session_id TEXT,
  checked_in_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tickets_user ON tickets(user_id);
CREATE INDEX idx_tickets_event ON tickets(event_id, status);

-- Ledger for the nonprofit's books; UNIQUE session id makes webhook retries idempotent.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                     -- 'membership' | 'ticket'
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- migrations/2026-10-10-courtyard.sql
-- ============================================================
-- Courtyard launch: Courtyard board, event volunteers, password resets, last-seen.

ALTER TABLE users ADD COLUMN last_seen_at TEXT;

-- Readable by every signed-in member (courtyard included); only moderators
-- start threads here, inner members can reply.
INSERT INTO boards (id, chapter_id, name, slug, description) VALUES
  (lower(hex(randomblob(16))), NULL, 'Courtyard', 'courtyard', 'News, calls for volunteers, and what''s coming up. Open to everyone who has joined.');

-- Separate from event_crew on purpose: volunteering must not unlock the
-- inner-only crew Hub tools.
CREATE TABLE event_volunteers (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_event_volunteers_user ON event_volunteers(user_id);

-- Only the SHA-256 of the emailed token is stored; single use, 1h expiry.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- ============================================================
-- migrations/2026-10-10-passport.sql
-- ============================================================
-- Carnival Passport: merit-badge stamps that earn rank (see vault note
-- "CSI Rank and Passport Rule"). On remote, run each statement as its own

-- kind: fix | ticket | roustabout | sawdust | barker | junk | canvasman
CREATE TABLE stamps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  note TEXT,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stamps_user ON stamps(user_id);
-- One stamp per kind per event; The Fix Is In only ever once.
CREATE UNIQUE INDEX idx_stamps_event_once ON stamps(user_id, kind, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_stamps_fix_once ON stamps(user_id) WHERE kind = 'fix';

-- Last rank the member was shown the "welcome inside" moment for. Backfilled
-- so existing members aren't congratulated for ranks they already had.
ALTER TABLE users ADD COLUMN celebrated_rank TEXT;
UPDATE users SET celebrated_rank = rank;

-- ============================================================
-- migrations/2026-10-10-contact-sharing.sql
-- ============================================================
-- Opt-in contact sharing. Contact details are private by default: only
-- Ringleaders (and moderators running an event's volunteer list) see them.
-- Each member chooses which fields other inner members can see; anything
-- else they share person-to-person from a DM ("Share my contact").
ALTER TABLE users ADD COLUMN share_email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN share_phone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN share_instagram INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- migrations/2026-10-11-room-layout.sql
-- ============================================================
-- The Dressing Room layout Neeff arranges in the room's Arrange mode.
-- One row ('main'); data = JSON array of placed items (see ROOM_ROLES in
-- app.js). No row = the default layout baked into app.js.
CREATE TABLE room_layout (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- migrations/2026-10-11-chat.sql
-- ============================================================
-- Live chat in the Dressing Room (polled every few seconds; D1 has no push).
-- Everyone signed in can chat, courtyard included; authors and moderators
-- can delete. Old messages are purged by the daily cron (30 days).
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
-- Who's "here now": refreshed by each chat poll.
CREATE TABLE chat_presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL
);

-- ============================================================
-- migrations/2026-10-11-dm-read.sql
-- ============================================================
-- Unread letters: when each participant last read their conversation, so
-- the raven can squawk about new DMs. Backfilled to now so old messages
-- don't all show as unread on deploy.
ALTER TABLE conversation_participants ADD COLUMN last_read_at TEXT;
UPDATE conversation_participants SET last_read_at = datetime('now');

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
