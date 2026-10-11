-- Courtyard / inner-member tiers + event ticketing.
-- Apply: npx wrangler d1 execute carnivalsociety-members --remote --file=migrations/2026-10-04-tiers-tickets.sql
-- (--local first.) Run each statement as its own --command on remote (see the
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
