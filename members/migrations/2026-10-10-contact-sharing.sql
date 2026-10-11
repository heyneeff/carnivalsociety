-- Opt-in contact sharing. Contact details are private by default: only
-- Ringleaders (and moderators running an event's volunteer list) see them.
-- Each member chooses which fields other inner members can see; anything
-- else they share person-to-person from a DM ("Share my contact").
-- On remote, run each statement as its own --command.
ALTER TABLE users ADD COLUMN share_email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN share_phone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN share_instagram INTEGER NOT NULL DEFAULT 0;
