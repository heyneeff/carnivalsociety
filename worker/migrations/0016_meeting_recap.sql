-- Meetings gain a date and a separate recap doc. The date shows next to the
-- tab; once a recap has been written, a "Meeting Recap" button appears to
-- view/edit it, kept apart from the main run-of-show content.

ALTER TABLE guild_meetings ADD COLUMN meeting_date TEXT;
ALTER TABLE guild_meetings ADD COLUMN recap TEXT NOT NULL DEFAULT '';
