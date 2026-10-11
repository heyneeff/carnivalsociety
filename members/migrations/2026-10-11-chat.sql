-- Live chat in the Dressing Room (polled every few seconds; D1 has no push).
-- Everyone signed in can chat, courtyard included; authors and moderators
-- can delete. Old messages are purged by the daily cron (30 days).
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
-- Who's "here now": refreshed by each chat poll.
CREATE TABLE chat_presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL
);
