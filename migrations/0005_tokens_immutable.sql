-- A token's meaning is fixed when it is minted. The split-send gate (ward-access) checks
-- each redirect in a recipient's copy against its destination through
-- GET /api/tokens/<token> before the copy goes out, so pointing a token elsewhere later
-- would defeat that check. Inserts and deletes (cascades) are unaffected; a link's text
-- and a token set's `current` flag may still change.
CREATE TRIGGER links_token_immutable
BEFORE UPDATE OF token, message_token, url, position ON links
BEGIN
  SELECT RAISE(ABORT, 'links: a token, its message, url and position never change');
END;

CREATE TRIGGER recipient_links_immutable
BEFORE UPDATE ON recipient_links
BEGIN
  SELECT RAISE(ABORT, 'recipient_links: rows never change once minted');
END;

CREATE TRIGGER recipients_token_immutable
BEFORE UPDATE OF token, message_token, address, position ON recipients
BEGIN
  SELECT RAISE(ABORT, 'recipients: a token, its message, address and position never change');
END;
