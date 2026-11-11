import type { z } from "zod";

import { BURST_WINDOW_MS } from "./classify";
import type { Db, Row, Statement } from "./env";
import {
  count,
  eventRow,
  linkRow,
  linkWithSentAt,
  messageRow,
  messageSummary,
  pixelTarget,
  recipientLinkRow,
  recipientRow,
} from "./schema";
import type {
  EventRow,
  LinkRow,
  LinkWithSentAt,
  MessageRow,
  MessageSummary,
  PixelTarget,
  RecipientLinkRow,
  RecipientRow,
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
  subject: string;
  recipient: string;
  links: string[];
  /** Addresses that get their own token set (see tokenSetAddresses). */
  recipients: string[];
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
        `INSERT INTO recipients (token, message_token, address, position, current)
         SELECT ?, m.token, ?,
           (SELECT COALESCE(MAX(position) + 1, 0) FROM recipients WHERE message_token = m.token), 1
         FROM messages m WHERE m.draft_id = ?
         ON CONFLICT (message_token, address) DO UPDATE SET current = 1`
      )
      .bind(r.newToken(), address, r.draftId)
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
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (token, draft_id, subject, recipient, shared, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (draft_id) DO UPDATE SET subject = excluded.subject,
           recipient = excluded.recipient, shared = excluded.shared`
      )
      .bind(
        r.newToken(),
        r.draftId,
        r.subject,
        r.recipient,
        r.shared ? 1 : 0,
        r.at
      ),
    ...r.links.map((url) =>
      db
        .prepare(
          `INSERT INTO links (token, message_token, position, url)
           SELECT ?, m.token,
             (SELECT COALESCE(MAX(position) + 1, 0) FROM links WHERE message_token = m.token), ?
           FROM messages m WHERE m.draft_id = ?
           ON CONFLICT (message_token, url) DO NOTHING`
        )
        .bind(r.newToken(), url, r.draftId)
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
  const links = await many(
    db
      .prepare("SELECT * FROM links WHERE message_token = ? ORDER BY position")
      .bind(message.token),
    linkRow
  );
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
  event: Omit<EventRow, "id" | "duplicate">
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
const COUNTED = "counted = 1 AND duplicate = 0";

/**
 * Sent emails (or ones with events) with summaries. Opens and clicks count only events
 * marked counted (probable humans and on-open proxies) and not duplicate; the timeline
 * keeps every row.
 */
export const listMessages = async (
  db: Db,
  limit: number
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
           (SELECT COUNT(DISTINCT recipient_token) ${OF_MESSAGE} AND ${COUNTED}) AS opened_by
         FROM messages m
         WHERE m.sent_at IS NOT NULL OR EXISTS (SELECT 1 ${OF_MESSAGE})
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
        .prepare("SELECT * FROM events WHERE message_token = ? ORDER BY at, id")
        .bind(token),
      eventRow
    ),
    recipientSets(db, token),
  ]);
  return { events, links, message, recipients: sets.recipients };
};
