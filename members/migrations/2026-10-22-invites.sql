-- Bring a friend: every member gets a personal invite link (/i/<code>); a
-- friend who signs up through it is credited to them. 1, 3 and 5 friends let
-- in are passport stamps (invite1/3/5), so they count toward Apprentice.
ALTER TABLE users ADD COLUMN invite_code TEXT;
ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code);
CREATE INDEX idx_users_invited_by ON users(invited_by);
CREATE UNIQUE INDEX idx_stamps_invite_once ON stamps(user_id, kind) WHERE kind IN ('invite1', 'invite3', 'invite5');
