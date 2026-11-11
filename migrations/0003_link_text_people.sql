-- The link's own text in the email, sent by the plugin at registration; '' when it has
-- none (a bare URL, an image) or the registration came from an older plugin. The
-- dashboard then names the link by its domain (src/link-names.ts).
ALTER TABLE links ADD COLUMN text TEXT NOT NULL DEFAULT '';

-- The people view groups token sets by address across emails.
CREATE INDEX recipients_address ON recipients (address, current);
