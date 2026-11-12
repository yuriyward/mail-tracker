import type { z } from "zod";

import { BURST_WINDOW_MS } from "./classify";
import type { Db, Row, Statement } from "./env";
import type { MailHost } from "./mail-host";
import {
  count,
  eventRow,
  countedOpenRow,
  linkRow,
  linkWithSentAt,
  messageRow,
  recipientActivityRow,
  messageSummary,
  pixelTarget,
  recipientLinkRow,
  recipientRow,
  tokenTargetRow,
} from "./schema";
import type {
  EventRow,
  CountedOpenRow,
  LinkRow,
  LinkWithSentAt,
  MessageRow,
  MessageSummary,
  PixelTarget,
  RecipientActivityRow,
  RecipientLinkRow,
  RecipientRow,
  TokenTargetRow,
} from "./schema";

/** A repeat by the same actor on the same image or link within this window is not counted again. */
export const DEDUPE_WINDOW_MS = 30_000;

const one = async <S extends z.ZodType>(
  statement: Statement,
  schema: S
): Promise<z.infer<S> | null> => {
  const row: Row | null = await statement.first();
  return row === null ? null : schema.parse(row);
};

const many = async <S extends z.ZodType>(
  statement: Statement,
  schema: S
): Promise<z.infer<S>[]> => {
  const { results } = await statement.all();
  return results.map((row) => schema.parse(row));
};

export interface Registration {
  draftId: string;
  /** The draft itself carries tracking (ADR-0004); never cleared once set. */
  draftTracked: boolean;
  subject: string;
  recipient: string;
  /** Destinations with their own text in the email ('' when none). */
  links: { url: string; text: string }[];
  /** Addresses that get their own token set (see tokenSetAddresses). */
  recipients: string[];
  mailHosts?: ReadonlyMap<string, MailHost>;
  shared: boolean;
  at: number;
  newToken: () => string;
}

export interface RecipientSet {
  recipient: RecipientRow;
  /** Redirect tokens of this set, one per link of the message. */
  links: RecipientLinkRow[];
}

export interface Registered {
  message: MessageRow;
  created: boolean;
  links: LinkRow[];
  /** The sets of the latest registration, in registration order. */
  recipients: RecipientSet[];
}

const OF_DRAFT = "(SELECT token FROM messages WHERE draft_id = ?)";

/** Marks the draft's sets current exactly when they are in this registration. */
const recipientStatements = (db: Db, r: Registration): Statement[] => [
  db
    .prepare(
      `UPDATE recipients SET current = 0 WHERE message_token = ${OF_DRAFT}`
    )
    .bind(r.draftId),
  ...r.recipients.map((address) =>
    db
      .prepare(
        `INSERT INTO recipients (token, message_token, address, position, current, mail_host)
         SELECT ?, m.token, ?,
           (SELECT COALESCE(MAX(position) + 1, 0) FROM recipients WHERE message_token = m.token), 1, ?
         FROM messages m WHERE m.draft_id = ?
         ON CONFLICT (message_token, address) DO UPDATE SET current = 1, mail_host = excluded.mail_host`
      )
      .bind(
        r.newToken(),
        address,
        r.mailHosts?.get(address) ?? "unknown",
        r.draftId
      )
  ),
];

const recipientSets = async (
  db: Db,
  messageToken: string
): Promise<{ recipients: RecipientRow[]; links: RecipientLinkRow[] }> => {
  const [recipients, links] = await Promise.all([
    many(
      db
        .prepare(
          "SELECT * FROM recipients WHERE message_token = ? ORDER BY position"
        )
        .bind(messageToken),
      recipientRow
    ),
    many(
      db
        .prepare(
          `SELECT rl.* FROM recipient_links rl JOIN recipients r ON r.token = rl.recipient_token
           WHERE r.message_token = ?`
        )
        .bind(messageToken),
      recipientLinkRow
    ),
  ]);
  return { links, recipients };
};

/** Adds a redirect token for every (current set, link) pair that has none yet. */
const fillRecipientLinks = async (
  db: Db,
  messageToken: string,
  links: LinkRow[],
  newToken: () => string
): Promise<RecipientSet[]> => {
  const before = await recipientSets(db, messageToken);
  const current = before.recipients.filter((row) => row.current === 1);
  const have = new Set(
    before.links.map((rl) => `${rl.recipient_token} ${rl.link_token}`)
  );
  const missing = current.flatMap((recipient) =>
    links
      .filter((link) => !have.has(`${recipient.token} ${link.token}`))
      .map((link) =>
        db
          .prepare(
            `INSERT INTO recipient_links (token, recipient_token, link_token) VALUES (?, ?, ?)
             ON CONFLICT (recipient_token, link_token) DO NOTHING`
          )
          .bind(newToken(), recipient.token, link.token)
      )
  );
  let after = before;
  if (missing.length > 0) {
    await db.batch(missing);
    after = await recipientSets(db, messageToken);
  }
  return current.map((recipient) => ({
    links: after.links.filter((rl) => rl.recipient_token === recipient.token),
    recipient,
  }));
};

const messageLinks = async (db: Db, messageToken: string): Promise<LinkRow[]> =>
  await many(
    db
      .prepare("SELECT * FROM links WHERE message_token = ? ORDER BY position")
      .bind(messageToken),
    linkRow
  );

/**
 * A token's destination, set and message are fixed when it is minted and never change
 * (migration 0005 refuses such an UPDATE): the split-send gate checks a redirect against
 * its destination before it lets a copy out, so a token pointed elsewhere afterwards would
 * defeat it. Throws if a registration changed one anyway.
 */
export const assertTokensKept = (
  before: readonly LinkRow[],
  after: readonly LinkRow[]
): void => {
  const now = new Map(after.map((link) => [link.token, link]));
  for (const link of before) {
    const kept = now.get(link.token);
    if (
      kept?.url !== link.url ||
      kept.position !== link.position ||
      kept.message_token !== link.message_token
    ) {
      throw new Error(`link token ${link.token} changed after it was minted`);
    }
  }
};

/**
 * Creates the message for a draft, or updates its subject and recipient, and adds a token for
 * every URL not yet registered. Idempotent per draft and URL, so repeated registration while
 * the email is composed (from any window) converges on one message row.
 */
export const registerMessage = async (
  db: Db,
  r: Registration
): Promise<Registered> => {
  const existing = await one(
    db.prepare("SELECT * FROM messages WHERE draft_id = ?").bind(r.draftId),
    messageRow
  );
  const before = existing ? await messageLinks(db, existing.token) : [];
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (token, draft_id, subject, recipient, shared, draft_tracked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (draft_id) DO UPDATE SET subject = excluded.subject,
           recipient = excluded.recipient, shared = excluded.shared,
           draft_tracked = MAX(draft_tracked, excluded.draft_tracked)`
      )
      .bind(
        r.newToken(),
        r.draftId,
        r.subject,
        r.recipient,
        r.shared ? 1 : 0,
        r.draftTracked ? 1 : 0,
        r.at
      ),
    // A link's text follows the latest registration that has some for it.
    ...r.links.map(({ url, text }) =>
      db
        .prepare(
          `INSERT INTO links (token, message_token, position, url, text)
           SELECT ?, m.token,
             (SELECT COALESCE(MAX(position) + 1, 0) FROM links WHERE message_token = m.token), ?, ?
           FROM messages m WHERE m.draft_id = ?
           ON CONFLICT (message_token, url) DO UPDATE
             SET text = CASE WHEN excluded.text = '' THEN links.text ELSE excluded.text END`
        )
        .bind(r.newToken(), url, text, r.draftId)
    ),
    ...recipientStatements(db, r),
  ]);
  const message = await one(
    db.prepare("SELECT * FROM messages WHERE draft_id = ?").bind(r.draftId),
    messageRow
  );
  if (!message) {
    throw new Error("registered message not found");
  }
  const links = await messageLinks(db, message.token);
  assertTokensKept(before, links);
  const recipients = await fillRecipientLinks(
    db,
    message.token,
    links,
    r.newToken
  );
  return { created: existing === null, links, message, recipients };
};

/** Records the send time once; later calls (one per recipient, retries) keep the first. */
/** Accepted clock skew between the plugin's reported send time and the Worker's clock. */
const SKEW_MS = 5 * 60 * 1000;

/**
 * Records the delivery time once; later calls (retries) keep the first. The plugin reports
 * when Mailspring confirmed delivery, so a retry hours later still stores the real time;
 * a reported time before registration or in the future is replaced by the Worker's clock.
 */
export const markSent = async (
  db: Db,
  token: string,
  sent: { reported: number | null; now: number }
): Promise<boolean> => {
  const row = await one(
    db
      .prepare(
        `UPDATE messages SET sent_at = COALESCE(sent_at,
           CASE WHEN ?1 IS NOT NULL AND ?1 >= created_at AND ?1 <= ?2 + ?3 THEN ?1 ELSE ?2 END)
         WHERE token = ?4 RETURNING token`
      )
      .bind(sent.reported, sent.now, SKEW_MS, token),
    messageRow.pick({ token: true })
  );
  return row !== null;
};

const findMessage = async (db: Db, token: string): Promise<MessageRow | null> =>
  await one(
    db.prepare("SELECT * FROM messages WHERE token = ?").bind(token),
    messageRow
  );

/** A redirect token: a recipient's (ADR-0003) or, from before 0002, the message's own. */
export const findLink = async (
  db: Db,
  token: string
): Promise<LinkWithSentAt | null> =>
  await one(
    db
      .prepare(
        `SELECT l.*, rl.recipient_token, COALESCE(m.sent_at, m.created_at) AS sent_at
         FROM recipient_links rl JOIN links l ON l.token = rl.link_token
         JOIN messages m ON m.token = l.message_token WHERE rl.token = ?1
         UNION ALL
         SELECT l.*, NULL, COALESCE(m.sent_at, m.created_at) FROM links l
         JOIN messages m ON m.token = l.message_token WHERE l.token = ?1`
      )
      .bind(token),
    linkWithSentAt
  );

/** An image token: a recipient's (ADR-0003) or, from before 0002, the message's own. */
export const findPixel = async (
  db: Db,
  token: string
): Promise<PixelTarget | null> =>
  await one(
    db
      .prepare(
        `SELECT r.message_token, r.token AS recipient_token,
           COALESCE(m.sent_at, m.created_at) AS sent_at
         FROM recipients r JOIN messages m ON m.token = r.message_token WHERE r.token = ?1
         UNION ALL
         SELECT m.token, NULL, COALESCE(m.sent_at, m.created_at) FROM messages m
         WHERE m.token = ?1`
      )
      .bind(token),
    pixelTarget
  );

export interface Actor {
  messageToken: string;
  ip: string;
  userAgent: string;
}

/** Other links of the message the same actor clicked just before, leaving out self events. */
export const countOtherLinksInBurst = async (
  db: Db,
  actor: Actor & { linkToken: string; at: number }
): Promise<number> => {
  const row = await one(
    db
      .prepare(
        `SELECT COUNT(DISTINCT link_token) AS n FROM events
         WHERE message_token = ? AND ip = ? AND user_agent = ? AND kind = 'click'
           AND class != 'self' AND link_token != ? AND at BETWEEN ? AND ?`
      )
      .bind(
        actor.messageToken,
        actor.ip,
        actor.userAgent,
        actor.linkToken,
        actor.at - BURST_WINDOW_MS,
        actor.at
      ),
    count
  );
  return row?.n ?? 0;
};

/**
 * Inserts the event. Every hit is kept (ADR-0001); a repeat by the same actor (IP, user
 * agent and HTTP method) on the same image or link of the same recipient within
 * DEDUPE_WINDOW_MS is flagged `duplicate` so summaries skip it. A HEAD followed by a GET
 * is not a repeat.
 */
export const insertEvent = async (
  db: Db,
  event: Omit<EventRow, "id" | "duplicate" | "preview" | "gmail_self">
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO events (message_token, link_token, kind, at, method, ip, user_agent,
         as_organization, country, class, reason, counted, recipient_token, duplicate)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14, EXISTS (
         SELECT 1 FROM events WHERE message_token = ?1 AND link_token IS ?2 AND ip = ?6
           AND user_agent = ?7 AND method = ?5 AND recipient_token IS ?14
           AND at BETWEEN ?4 - ?13 AND ?4
       )`
    )
    .bind(
      event.message_token,
      event.link_token,
      event.kind,
      event.at,
      event.method,
      event.ip,
      event.user_agent,
      event.as_organization,
      event.country,
      event.class,
      event.reason,
      event.counted,
      DEDUPE_WINDOW_MS,
      event.recipient_token
    )
    .run();
};

const OF_MESSAGE = "FROM events e WHERE e.message_token = m.token";
/**
 * A draft preview: a hit on a draft that carries tracking, before it was sent or while it
 * is unsent (ADR-0004). Needs `e` (event) and `m` (its message) in scope.
 */
const PREVIEW =
  "(m.draft_tracked = 1 AND (m.sent_at IS NULL OR e.at < m.sent_at))";
/** Gmail on-open fetches for non-Google token sets (ADR-0005), applied only on read. */
const GMAIL_SELF = `(e.kind = 'open' AND e.class = 'proxy'
  AND e.reason LIKE 'on-open image proxy%'
  AND (e.reason LIKE '%ggpht.com%' OR e.reason LIKE '%GoogleImageProxy%')
  AND m.sent_at IS NOT NULL AND e.at >= m.sent_at
  AND EXISTS (SELECT 1 FROM recipients host WHERE host.token = e.recipient_token AND host.mail_host = 'other'))`;
const COUNTED = `e.counted = 1 AND e.duplicate = 0 AND NOT ${PREVIEW} AND NOT ${GMAIL_SELF}`;
/** The emails the list shows: sent, or with events (e.g. the sent notice was lost). */
const LISTED = `(m.sent_at IS NOT NULL OR EXISTS (SELECT 1 ${OF_MESSAGE}))`;

/** Which emails a list holds: the usual list, or every email not marked sent yet. */
export type Listed = "listed" | "unsent";

/**
 * Sent emails (or ones with events), or with `unsent` every email not marked sent, with
 * summaries. Opens and clicks count only events
 * marked counted (probable humans and on-open proxies) and not duplicate; the timeline
 * keeps every row.
 */
export const listMessages = async (
  db: Db,
  limit: number,
  listed: Listed = "listed"
): Promise<MessageSummary[]> =>
  await many(
    db
      .prepare(
        `SELECT m.*,
           (SELECT MIN(at) ${OF_MESSAGE} AND kind = 'open' AND ${COUNTED}) AS first_open,
           (SELECT MAX(at) ${OF_MESSAGE} AND kind = 'open' AND ${COUNTED}) AS last_open,
           (SELECT COUNT(*) ${OF_MESSAGE} AND kind = 'open' AND ${COUNTED}) AS opens,
           (SELECT COUNT(*) ${OF_MESSAGE} AND kind = 'click' AND ${COUNTED}) AS clicks,
           (SELECT COUNT(*) ${OF_MESSAGE}) AS events,
           (SELECT COUNT(*) FROM recipients r WHERE r.message_token = m.token AND r.current = 1) AS recipients,
           EXISTS (SELECT 1 FROM recipients r WHERE r.message_token = m.token AND r.current = 1
             AND r.address = '') AS recipient_unknown,
           (SELECT COUNT(DISTINCT e.recipient_token) FROM events e
             JOIN recipients r ON r.token = e.recipient_token
             WHERE e.message_token = m.token AND r.current = 1
               AND ${COUNTED}) AS opened_by
         FROM messages m
         WHERE ${listed === "unsent" ? "m.sent_at IS NULL" : LISTED}
         ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT ?`
      )
      .bind(limit),
    messageSummary
  );

export interface MessageDetail {
  message: MessageRow;
  links: LinkRow[];
  recipients: RecipientRow[];
  events: EventRow[];
}

export const messageDetail = async (
  db: Db,
  token: string
): Promise<MessageDetail | null> => {
  const message = await findMessage(db, token);
  if (!message) {
    return null;
  }
  const [links, events, sets] = await Promise.all([
    many(
      db
        .prepare(
          "SELECT * FROM links WHERE message_token = ? ORDER BY position"
        )
        .bind(token),
      linkRow
    ),
    many(
      db
        .prepare(
          `SELECT e.*, ${PREVIEW} AS preview, ${GMAIL_SELF} AS gmail_self FROM events e
           JOIN messages m ON m.token = e.message_token
           WHERE e.message_token = ? ORDER BY e.at, e.id`
        )
        .bind(token),
      eventRow
    ),
    recipientSets(db, token),
  ]);
  // Preview and Gmail self rules apply only on read; raw events stay intact.
  const read = events.map((e) => {
    if (e.preview === 1) {
      return { ...e, counted: 0 };
    }
    if (e.gmail_self === 1) {
      return { ...e, class: "self" as const, counted: 0, gmail_self: 1 };
    }
    return e;
  });
  return { events: read, links, message, recipients: sets.recipients };
};

/**
 * Every counted, non-repeat open (probable human or on-open image proxy) through a current recipient's token set
 * or a message-level token, oldest first: the input of the re-open signal (src/reopen.ts)
 * and of the Gmail preload hint (src/preload.ts), which compares emails to one address.
 */
export const countedOpens = async (db: Db): Promise<CountedOpenRow[]> =>
  await many(
    db.prepare(
      `SELECT e.id, e.at, e.message_token, e.recipient_token, e.class, e.reason,
         r.address FROM events e
       JOIN messages m ON m.token = e.message_token
       LEFT JOIN recipients r ON r.token = e.recipient_token
       WHERE e.kind = 'open' AND e.class IN ('human', 'proxy') AND ${COUNTED}
         AND (e.recipient_token IS NULL OR r.current = 1)
       ORDER BY e.at, e.id`
    ),
    countedOpenRow
  );

/** Current, known addresses per email, in draft order. */
export const currentAddresses = async (
  db: Db
): Promise<Map<string, string[]>> => {
  const rows = await many(
    db.prepare(
      `SELECT message_token, address FROM recipients
       WHERE current = 1 AND address != '' ORDER BY message_token, position`
    ),
    recipientRow.pick({ address: true, message_token: true })
  );
  const byMessage = new Map<string, string[]>();
  for (const row of rows) {
    byMessage.set(row.message_token, [
      ...(byMessage.get(row.message_token) ?? []),
      row.address,
    ]);
  }
  return byMessage;
};

const OF_SET = "FROM events e WHERE e.recipient_token = r.token";

/**
 * One row per current token set of a known address (one person on one listed email),
 * with that set's counted figures; for one address, or for everyone. Shared copies to
 * several people (address '') and message-level tokens belong to no person.
 */
export const recipientActivity = async (
  db: Db,
  address: string | null = null
): Promise<RecipientActivityRow[]> =>
  await many(
    db
      .prepare(
        `SELECT r.address, r.token AS recipient_token, m.token AS message_token, m.subject,
           m.sent_at, m.created_at,
           (SELECT MIN(at) ${OF_SET} AND kind = 'open' AND ${COUNTED}) AS first_open,
           (SELECT MAX(at) ${OF_SET} AND kind = 'open' AND ${COUNTED}) AS last_open,
           (SELECT MAX(at) ${OF_SET} AND kind = 'click' AND ${COUNTED}) AS last_click,
           (SELECT COUNT(*) ${OF_SET} AND kind = 'open' AND ${COUNTED}) AS opens,
           (SELECT COUNT(*) ${OF_SET} AND kind = 'click' AND ${COUNTED}) AS clicks
         FROM recipients r JOIN messages m ON m.token = r.message_token
         WHERE r.current = 1 AND r.address != '' AND (?1 IS NULL OR r.address = ?1)
           AND ${LISTED}
         ORDER BY COALESCE(m.sent_at, m.created_at) DESC`
      )
      .bind(address),
    recipientActivityRow
  );

/** The message that owns an image token (a token set's or a message-level one). */
export const pixelOwner = async (
  db: Db,
  imageToken: string
): Promise<MessageRow | null> => {
  const pixel = await findPixel(db, imageToken);
  return pixel ? await findMessage(db, pixel.message_token) : null;
};

const setLinkRow = linkRow.pick({ token: true, url: true });

/**
 * The destinations and redirect tokens of the token set an image token belongs to: a
 * recipient's (or shared) set, or the message-level links for a message token.
 */
export const tokenSetLinks = async (
  db: Db,
  imageToken: string
): Promise<{ url: string; token: string }[]> =>
  await many(
    db
      .prepare(
        `SELECT l.url, rl.token FROM recipient_links rl JOIN links l ON l.token = rl.link_token
         WHERE rl.recipient_token = ?1
         UNION ALL
         SELECT url, token FROM links WHERE message_token = ?1`
      )
      .bind(imageToken),
    setLinkRow
  );

/**
 * Every image token of each email not marked sent: its token sets' (current or not) and
 * its own message-level one, so a sent copy can be matched by the image it carries.
 */
export const unsentImageTokens = async (
  db: Db
): Promise<Map<string, string[]>> => {
  const rows = await many(
    db.prepare(
      `SELECT r.message_token, r.token FROM recipients r
       JOIN messages m ON m.token = r.message_token WHERE m.sent_at IS NULL
       ORDER BY r.message_token, r.position`
    ),
    recipientRow.pick({ message_token: true, token: true })
  );
  const byMessage = new Map<string, string[]>();
  for (const row of rows) {
    byMessage.set(row.message_token, [
      ...(byMessage.get(row.message_token) ?? [row.message_token]),
      row.token,
    ]);
  }
  return byMessage;
};

/**
 * What a token stands for, for `GET /api/tokens/<token>`: a recipient's image or redirect
 * (ADR-0003), or a message-level one from before 0002. Tokens are random, so at most one
 * row matches.
 */
export const tokenTarget = async (
  db: Db,
  token: string
): Promise<TokenTargetRow | null> =>
  await one(
    db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM recipients r WHERE r.message_token = t.message_token
             AND r.current = 1 AND r.address != '') AS per_recipient
         FROM (
           SELECT 'image' AS kind, message_token, address, NULL AS url, NULL AS position
           FROM recipients WHERE token = ?1
           UNION ALL
           SELECT 'link', l.message_token, r.address, l.url, l.position FROM recipient_links rl
           JOIN links l ON l.token = rl.link_token
           JOIN recipients r ON r.token = rl.recipient_token WHERE rl.token = ?1
           UNION ALL
           SELECT 'image', token, NULL, NULL, NULL FROM messages WHERE token = ?1
           UNION ALL
           SELECT 'link', message_token, NULL, url, position FROM links WHERE token = ?1
         ) t LIMIT 1`
      )
      .bind(token),
    tokenTargetRow
  );
