-- Unread letters: when each participant last read their conversation, so
-- the raven can squawk about new DMs. Backfilled to now so old messages
-- don't all show as unread on deploy.
ALTER TABLE conversation_participants ADD COLUMN last_read_at TEXT;
UPDATE conversation_participants SET last_read_at = datetime('now');
