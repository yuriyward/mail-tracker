-- Per-recipient tracking (ADR-0003). The plugin registers one token set per recipient of a
-- draft: an image token here and one redirect token per link in recipient_links. Tracking
-- URLs carry only these random tokens; the address stays in this table (N2).
-- `shared`: the account sends one body to every recipient (Microsoft Graph), so the
-- message has a single token set; with several recipients its address is '' (unknown).
ALTER TABLE messages ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));

-- `current`: the set was in the latest registration; a recipient removed while composing
-- keeps its row (and any events) but is no longer listed as a recipient.
CREATE TABLE recipients (
  token TEXT PRIMARY KEY,
  message_token TEXT NOT NULL REFERENCES messages (token) ON DELETE CASCADE,
  address TEXT NOT NULL,
  position INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  UNIQUE (message_token, address)
);

-- A recipient's redirect token for one destination of the message (links.token).
CREATE TABLE recipient_links (
  token TEXT PRIMARY KEY,
  recipient_token TEXT NOT NULL REFERENCES recipients (token) ON DELETE CASCADE,
  link_token TEXT NOT NULL REFERENCES links (token) ON DELETE CASCADE,
  UNIQUE (recipient_token, link_token)
);

-- The token set an event came through; NULL for message-level tokens (before 0002).
ALTER TABLE events ADD COLUMN recipient_token TEXT REFERENCES recipients (token) ON DELETE CASCADE;

CREATE INDEX events_recipient_at ON events (recipient_token, at);
