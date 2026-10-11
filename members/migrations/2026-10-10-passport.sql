-- Carnival Passport: merit-badge stamps that earn rank (see vault note
-- "CSI Rank and Passport Rule"). On remote, run each statement as its own
-- --command (D1 multi-statement gotcha), --local first.

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
