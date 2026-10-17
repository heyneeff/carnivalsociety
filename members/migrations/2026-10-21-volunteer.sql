-- Waitlist signup: "I want to volunteer" checkbox.
ALTER TABLE users ADD COLUMN wants_to_volunteer INTEGER NOT NULL DEFAULT 0;
