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
} from "./schema";
import type {
  EventRow,
  LinkRow,
  LinkWithSentAt,
  MessageRow,
  MessageSummary,
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
  at: number;
  newToken: () => string;
}

export interface Registered {
  message: MessageRow;
  created: boolean;
  links: LinkRow[];
}

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
        `INSERT INTO messages (token, draft_id, subject, recipient, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (draft_id) DO UPDATE SET subject = excluded.subject, recipient = excluded.recipient`
      )
      .bind(r.newToken(), r.draftId, r.subject, r.recipient, r.at),
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
  return { created: existing === null, links, message };
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

export const findMessage = async (
  db: Db,
  token: string
): Promise<MessageRow | null> =>
  await one(
    db.prepare("SELECT * FROM messages WHERE token = ?").bind(token),
    messageRow
  );

export const findLink = async (
  db: Db,
  token: string
): Promise<LinkWithSentAt | null> =>
  await one(
    db
      .prepare(
        `SELECT links.*, COALESCE(messages.sent_at, messages.created_at) AS sent_at FROM links
         JOIN messages ON messages.token = links.message_token WHERE links.token = ?`
      )
      .bind(token),
    linkWithSentAt
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
 * agent and HTTP method) on the same image or link within DEDUPE_WINDOW_MS is flagged
 * `duplicate` so summaries skip it. A HEAD followed by a GET is not a repeat.
 */
export const insertEvent = async (
  db: Db,
  event: Omit<EventRow, "id" | "duplicate">
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO events (message_token, link_token, kind, at, method, ip, user_agent,
         as_organization, country, class, reason, counted, duplicate)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, EXISTS (
         SELECT 1 FROM events WHERE message_token = ?1 AND link_token IS ?2 AND ip = ?6
           AND user_agent = ?7 AND method = ?5 AND at BETWEEN ?4 - ?13 AND ?4
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
      DEDUPE_WINDOW_MS
    )
    .run();
};

const OF_MESSAGE = "FROM events e WHERE e.message_token = m.token";

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
           (SELECT MIN(at) ${OF_MESSAGE} AND kind = 'open' AND counted = 1 AND duplicate = 0) AS first_open,
           (SELECT MAX(at) ${OF_MESSAGE} AND kind = 'open' AND counted = 1 AND duplicate = 0) AS last_open,
           (SELECT COUNT(*) ${OF_MESSAGE} AND kind = 'open' AND counted = 1 AND duplicate = 0) AS opens,
           (SELECT COUNT(*) ${OF_MESSAGE} AND kind = 'click' AND counted = 1 AND duplicate = 0) AS clicks,
           (SELECT COUNT(*) ${OF_MESSAGE}) AS events
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
  const [links, events] = await Promise.all([
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
  ]);
  return { events, links, message };
};
