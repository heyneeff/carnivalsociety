-- One ticket can admit a group: the buyer plus guests (2026-10-18).
ALTER TABLE tickets ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
