ALTER TABLE recipients ADD COLUMN mail_host TEXT NOT NULL DEFAULT 'unknown'
  CHECK (mail_host IN ('google', 'other', 'unknown'));
