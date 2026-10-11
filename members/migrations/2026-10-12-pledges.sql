-- Material pledges: "I can bring it!" on an event's needs/wants list.
-- received_at = the Ringleader got it (and granted the Junk Saint stamp).
CREATE TABLE material_pledges (
  material_id TEXT NOT NULL REFERENCES event_materials(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (material_id, user_id)
);
CREATE INDEX idx_material_pledges_user ON material_pledges(user_id);
