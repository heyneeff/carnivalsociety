-- Real posters on the flyers (2026-10-15): the Ringleader (or a co-host)
-- uploads the carnival's poster; it hangs on every room's wall in place of
-- the stand-in flyer art. Stored resized (~900px tall) in the database and
-- served publicly at /api/public/flyers/<event id> (it's a poster, after all).
ALTER TABLE events ADD COLUMN flyer_url TEXT;
CREATE TABLE event_flyers (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
