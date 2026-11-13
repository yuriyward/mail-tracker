import { z } from "zod";

import { EVENT_CLASSES } from "./classify";

export const messageRow = z.object({
  created_at: z.number(),
  draft_id: z.string(),
  /** 1 when the draft itself carries tracking (composed by an agent, ADR-0004). */
  draft_tracked: z.number(),
  recipient: z.string(),
  sent_at: z.number().nullable(),
  /** 1 when the account sends one body to every recipient (Microsoft Graph). */
  shared: z.number(),
  subject: z.string(),
  token: z.string(),
});
export type MessageRow = z.infer<typeof messageRow>;

export const linkRow = z.object({
  message_token: z.string(),
  position: z.number(),
  /** The link's own text in the email ('' when none was sent); see src/link-names.ts. */
  text: z.string(),
  token: z.string(),
  url: z.string(),
});
export type LinkRow = z.infer<typeof linkRow>;

/** One recipient's token set: its image token, and its address ('' when unknown). */
export const recipientRow = z.object({
  address: z.string(),
  current: z.number(),
  mail_host: z.enum(["google", "other", "unknown"]).default("unknown"),
  message_token: z.string(),
  position: z.number(),
  token: z.string(),
});
export type RecipientRow = z.infer<typeof recipientRow>;

export const recipientLinkRow = z.object({
  link_token: z.string(),
  recipient_token: z.string(),
  token: z.string(),
});
export type RecipientLinkRow = z.infer<typeof recipientLinkRow>;

/** A link with the time its message was sent (or registered, if not marked sent). */
export const linkWithSentAt = linkRow.extend({
  /** The recipient token set the redirect token belongs to; null for a message-level one. */
  recipient_token: z.string().nullable(),
  sent_at: z.number(),
});
export type LinkWithSentAt = z.infer<typeof linkWithSentAt>;

/** What any token resolves to, for the read API's token lookup (store.tokenTarget). */
export const tokenTargetRow = z.object({
  /** The token set's address; null for a message-level token, '' for a shared set. */
  address: z.string().nullable(),
  kind: z.enum(["image", "link"]),
  message_token: z.string(),
  /** Current token sets of the message with a known address. */
  per_recipient: z.number(),
  /** The destination's position among the message's links; null for an image. */
  position: z.number().nullable(),
  url: z.string().nullable(),
});
export type TokenTargetRow = z.infer<typeof tokenTargetRow>;

/** What an image token resolves to. */
export const pixelTarget = z.object({
  message_token: z.string(),
  recipient_token: z.string().nullable(),
  sent_at: z.number(),
});
export type PixelTarget = z.infer<typeof pixelTarget>;

export const eventRow = z.object({
  as_organization: z.string(),
  at: z.number(),
  class: z.enum(EVENT_CLASSES),
  counted: z.number(),
  country: z.string(),
  duplicate: z.number(),
  gmail_prefetch: z.number().optional(),
  gmail_self: z.number().optional(),
  id: z.number(),
  ip: z.string(),
  kind: z.enum(["open", "click"]),
  link_token: z.string().nullable(),
  message_token: z.string(),
  method: z.string(),
  /**
   * 1 for a draft preview: a hit on a draft that carries tracking, before it was sent
   * (ADR-0004). Worked out when read (store.messageDetail), never stored; such an event
   * is read with `counted` 0.
   */
  preview: z.number().default(0),
  reason: z.string(),
  recipient_token: z.string().nullable(),
  user_agent: z.string(),
});
export type EventRow = z.infer<typeof eventRow>;

export const messageSummary = messageRow.extend({
  clicks: z.number(),
  events: z.number(),
  first_open: z.number().nullable(),
  last_open: z.number().nullable(),
  /** Current recipients that opened (counted opens), and how many there are. */
  opened_by: z.number(),
  opens: z.number(),
  /** 1 when the current token set is a shared copy to several recipients. */
  recipient_unknown: z.number(),
  recipients: z.number(),
});
export type MessageSummary = z.infer<typeof messageSummary>;

export const count = z.object({ n: z.number() });

/** The body of POST /api/messages, before each link passes the redirect allow-list. */
export const mintRequest = z.object({
  /** The draft's headerMessageId; registering the same draft again reuses its tokens. */
  draftId: z.string().min(1).max(998),
  /**
   * The draft itself carries the image and redirects (an agent's composed draft): hits
   * before it is sent are draft previews (ADR-0004). Once set, it stays set.
   */
  draftTracked: z.boolean().default(false),
  /** Each link's own text in the email, by URL as in `links`; optional per link. */
  linkText: z.record(z.string().max(4096), z.string().max(2000)).default({}),
  links: z.array(z.string()).max(500).default([]),
  /**
   * The image token already in the draft (an agent's composed draft): register under the
   * message that owns it instead of `draftId`, so the plugin's per-recipient sets join the
   * same message (ADR-0004). Unknown tokens are ignored.
   */
  pixelToken: z.string().max(64).nullish(),
  /** Display text of every recipient, as the plugin shows it. */
  recipient: z.string().max(2000).default(""),
  /** One token set per address (To, Cc, Bcc), compared case-insensitively. */
  recipients: z.array(z.string().max(320)).max(100).default([]),
  /** The account sends one body to all (Microsoft Graph): one shared token set. */
  shared: z.boolean().default(false),
  subject: z.string().max(2000).default(""),
});
export type MintRequest = z.infer<typeof mintRequest>;

/** The body of POST /api/messages/:token/sent: when Mailspring reported delivery. */
export const sentRequest = z.object({ sentAt: z.number().int().optional() });

/** One token set of a known address on a listed email, with its figures (the people view). */
export const recipientActivityRow = z.object({
  address: z.string(),
  clicks: z.number(),
  created_at: z.number(),
  first_open: z.number().nullable(),
  last_click: z.number().nullable(),
  last_open: z.number().nullable(),
  message_token: z.string(),
  opens: z.number(),
  recipient_token: z.string(),
  sent_at: z.number().nullable(),
  subject: z.string(),
});
export type RecipientActivityRow = z.infer<typeof recipientActivityRow>;

/**
 * A counted, non-repeat open of a probable human or on-open proxy: the input of the
 * re-open signal (src/reopen.ts) and the Gmail preload hint (src/preload.ts).
 */
export const countedOpenRow = z.object({
  /** The token set's address; null for a message-level token. */
  address: z.string().nullable(),
  at: z.number(),
  class: z.enum(EVENT_CLASSES),
  id: z.number(),
  message_token: z.string(),
  reason: z.string(),
  recipient_token: z.string().nullable(),
});
export type CountedOpenRow = z.infer<typeof countedOpenRow>;
