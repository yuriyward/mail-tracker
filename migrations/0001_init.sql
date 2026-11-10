-- One row per email. The token is the only identifier that appears in tracking URLs.
-- The plugin registers a message while it is composed, keyed by the draft's
-- headerMessageId, and marks it sent once Mailspring reports delivery.
CREATE TABLE messages (
  token TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

-- One token per distinct destination of a message; the destination stays server-side.
CREATE TABLE links (
  token TEXT PRIMARY KEY,
  message_token TEXT NOT NULL REFERENCES messages (token) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  UNIQUE (message_token, url)
);

-- Every hit on the image or a redirect, kept raw and classified (ADR-0001).
-- `counted`: the class counts as an open or click (see src/classify.ts).
-- `duplicate`: the same actor (IP, user agent, method) hit the same image or link within
-- the dedupe window before; the row is kept but summaries skip it.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_token TEXT NOT NULL REFERENCES messages (token) ON DELETE CASCADE,
  link_token TEXT REFERENCES links (token) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'click')),
  at INTEGER NOT NULL,
  method TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  as_organization TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  class TEXT NOT NULL CHECK (class IN ('human', 'proxy', 'scanner', 'self', 'unknown')),
  reason TEXT NOT NULL,
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  duplicate INTEGER NOT NULL CHECK (duplicate IN (0, 1))
);

CREATE INDEX events_message_at ON events (message_token, at);
CREATE INDEX events_actor ON events (message_token, ip, user_agent, at);
