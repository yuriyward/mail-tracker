-- The draft itself carries the tracking image and redirects (composed by an agent with
-- `bun run compose`, ADR-0004), so opening the draft hits the Worker before it is sent.
-- Events on such a message before its sent_at, or while it is unsent, are draft previews:
-- kept raw, worked out when read, never counted. Plugin-tracked drafts (0) only get the
-- image at send, so their events always count as before.
ALTER TABLE messages ADD COLUMN draft_tracked INTEGER NOT NULL DEFAULT 0 CHECK (draft_tracked IN (0, 1));
