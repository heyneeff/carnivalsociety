-- What's inside a carnival, for its public page: a headline ("Halloween
-- Carnival") and a lineup ("Burlesque, FreakShow, Games, …", comma-separated).
ALTER TABLE events ADD COLUMN tagline TEXT;
ALTER TABLE events ADD COLUMN lineup TEXT;
