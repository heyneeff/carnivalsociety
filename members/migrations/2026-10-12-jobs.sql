-- Jobs: tickets pinned to an event's flyer ("Bring a truck", "Door 7–9pm").
-- Members claim them first come, first served; a job can need a few people.
-- Marking a claim done grants that event's Roustabout stamp.
CREATE TABLE event_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT,
  shift TEXT,                      -- free text: "7–9pm", "Saturday morning"
  slots INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_jobs_event ON event_jobs(event_id);
CREATE TABLE job_claims (
  job_id TEXT NOT NULL REFERENCES event_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX idx_job_claims_user ON job_claims(user_id);
