-- The door ledger: one row per person let in at a physical event, however
-- they got in (via) and whatever they paid at the door (amount_cents,
-- method; registration_cents is the one-time $5 inside that amount).
-- Guests on a pass have no account (user_id NULL). voided_at = a mistake,
-- left in the ledger but out of every count.
CREATE TABLE door_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  via TEXT NOT NULL,                 -- ticket | pass | door | comp | crew
  ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  gift_id TEXT REFERENCES room_gifts(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  registration_cents INTEGER NOT NULL DEFAULT 0,
  method TEXT,                       -- cash | card (Square) | NULL
  first_time INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  by_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT
);
CREATE INDEX idx_door_entries_event ON door_entries(event_id, created_at);
CREATE UNIQUE INDEX idx_door_entries_once ON door_entries(event_id, user_id) WHERE user_id IS NOT NULL AND voided_at IS NULL;
-- Door settings per event: how many fit, and the walk-up price.
ALTER TABLE events ADD COLUMN capacity INTEGER;
ALTER TABLE events ADD COLUMN door_cents INTEGER;
