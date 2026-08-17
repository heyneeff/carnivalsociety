-- Per-event crew hub: schedule, planning meetups + RSVPs, a shared project
-- board, and a materials-needed list. Scoped by event_id against the
-- existing `events` table so any future carnival gets its own instance —
-- Unison is just the first row in `events`.

CREATE TABLE event_crew (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE event_schedule_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  location TEXT,
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_meetups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  proposed_at TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_meetup_rsvps (
  meetup_id TEXT NOT NULL REFERENCES event_meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('yes', 'no', 'maybe')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meetup_id, user_id)
);

CREATE TABLE event_projects (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES event_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_project_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES event_projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_materials (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_event_crew_user ON event_crew(user_id);
CREATE INDEX idx_schedule_event ON event_schedule_items(event_id);
CREATE INDEX idx_meetups_event ON event_meetups(event_id);
CREATE INDEX idx_meetup_rsvps_user ON event_meetup_rsvps(user_id);
CREATE INDEX idx_projects_event ON event_projects(event_id);
CREATE INDEX idx_projects_parent ON event_projects(parent_id);
CREATE INDEX idx_project_items_project ON event_project_items(project_id);
CREATE INDEX idx_materials_event ON event_materials(event_id);
