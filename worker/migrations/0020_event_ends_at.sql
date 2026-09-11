-- Events had only a start time, so a still-running multi-day event fell out
-- of every "upcoming" query the moment its starts_at passed — even though
-- it hadn't ended yet. This lets an event declare when it actually wraps up.
ALTER TABLE events ADD COLUMN ends_at TEXT;
