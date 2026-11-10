import { z } from "zod";

import { EVENT_CLASSES } from "./classify";

export const messageRow = z.object({
  created_at: z.number(),
  draft_id: z.string(),
  recipient: z.string(),
  sent_at: z.number().nullable(),
  subject: z.string(),
  token: z.string(),
});
export type MessageRow = z.infer<typeof messageRow>;

export const linkRow = z.object({
  message_token: z.string(),
  position: z.number(),
  token: z.string(),
  url: z.string(),
});
export type LinkRow = z.infer<typeof linkRow>;

/** A link with the time its message was sent (or registered, if not marked sent). */
export const linkWithSentAt = linkRow.extend({ sent_at: z.number() });
export type LinkWithSentAt = z.infer<typeof linkWithSentAt>;

export const eventRow = z.object({
  as_organization: z.string(),
  at: z.number(),
  class: z.enum(EVENT_CLASSES),
  counted: z.number(),
  country: z.string(),
  duplicate: z.number(),
  id: z.number(),
  ip: z.string(),
  kind: z.enum(["open", "click"]),
  link_token: z.string().nullable(),
  message_token: z.string(),
  method: z.string(),
  reason: z.string(),
  user_agent: z.string(),
});
export type EventRow = z.infer<typeof eventRow>;

export const messageSummary = messageRow.extend({
  clicks: z.number(),
  events: z.number(),
  first_open: z.number().nullable(),
  last_open: z.number().nullable(),
  opens: z.number(),
});
export type MessageSummary = z.infer<typeof messageSummary>;

export const count = z.object({ n: z.number() });

/** The body of POST /api/messages, before each link passes the redirect allow-list. */
export const mintRequest = z.object({
  /** The draft's headerMessageId; registering the same draft again reuses its tokens. */
  draftId: z.string().min(1).max(998),
  links: z.array(z.string()).max(500).default([]),
  recipient: z.string().max(2000).default(""),
  subject: z.string().max(2000).default(""),
});
export type MintRequest = z.infer<typeof mintRequest>;

/** The body of POST /api/messages/:token/sent: when Mailspring reported delivery. */
export const sentRequest = z.object({ sentAt: z.number().int().optional() });
