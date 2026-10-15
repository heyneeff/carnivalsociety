-- Backers (2026-10-14): the people who backed the Mercury Oracle with extra
-- support. Name + email only. They skip the waitlist; the first time they
-- open their Dressing Room the Ringleader pops out of the cone to thank
-- them (welcomed_at) and the Mercury Oracle deck lands on their dresser
-- (deck_at, so it's placed once and never comes back if they move it).
CREATE TABLE backers (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  welcomed_at TEXT,
  deck_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
