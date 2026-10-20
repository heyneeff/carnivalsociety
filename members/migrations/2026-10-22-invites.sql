-- Bring a friend: every member gets a personal invite link (/i/<code>); a
-- friend who signs up through it is credited to them. Shill (1 friend let in)
-- and Ballyhoo (5) are passport stamps, so they count toward Apprentice.
ALTER TABLE users ADD COLUMN invite_code TEXT;
ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code);
CREATE INDEX idx_users_invited_by ON users(invited_by);
CREATE UNIQUE INDEX idx_stamps_invite_once ON stamps(user_id, kind) WHERE kind IN ('shill', 'ballyhoo');
