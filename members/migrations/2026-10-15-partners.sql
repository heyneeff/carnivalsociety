-- Partners (2026-10-15): organizations the Ringleader trusts (is_partner).
-- A carnival can be co-hosted by one (events.partner_id); everyone let in at
-- its door becomes the partner's friend (a handshake). Partners post their
-- own events and holler at their friends. photos_url = the night's photo
-- set; adding it hollers to everyone who came.
ALTER TABLE users ADD COLUMN is_partner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN partner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN photos_url TEXT;
-- A partner's join page (/p/<partner_slug>): a blurb and a link of theirs.
ALTER TABLE users ADD COLUMN partner_slug TEXT;
ALTER TABLE users ADD COLUMN partner_blurb TEXT;
ALTER TABLE users ADD COLUMN partner_link TEXT;
CREATE UNIQUE INDEX idx_users_partner_slug ON users(partner_slug) WHERE partner_slug IS NOT NULL;
