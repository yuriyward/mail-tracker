ALTER TABLE messages ADD COLUMN message_id TEXT;
CREATE INDEX messages_message_id ON messages(message_id COLLATE BINARY);

CREATE TRIGGER messages_message_id_immutable
BEFORE UPDATE OF message_id ON messages
WHEN OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id
BEGIN
  SELECT RAISE(ABORT, 'message_id is immutable');
END;
