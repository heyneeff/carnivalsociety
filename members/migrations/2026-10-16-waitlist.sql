-- The waitlist (2026-10-16): new sign-ups wait (waitlisted_at set) until the
-- Ringleader lets them in (NULL again). They can still buy tickets meanwhile.
-- Everyone already here is in.
ALTER TABLE users ADD COLUMN waitlisted_at TEXT;
