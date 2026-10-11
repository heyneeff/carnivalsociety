-- The raven on your phone: web push subscriptions + the notifications the
-- service worker fetches when a (payload-less) push wakes it.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- letter | call | prize | rank | reminder | blast | test
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  ref TEXT,                      -- dedupe key (e.g. reminder:<event_id>)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, delivered_at);
CREATE UNIQUE INDEX idx_notifications_ref ON notifications(user_id, ref) WHERE ref IS NOT NULL;
-- What each member wants the raven to squawk about (all on by default).
ALTER TABLE users ADD COLUMN notify_letters INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_calls INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notify_prizes INTEGER NOT NULL DEFAULT 1;
