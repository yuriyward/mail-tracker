/**
 * The JSON the dashboard app (web/) reads from /app/data and /app/messages/:token/data.
 * The app parses responses with these schemas; keep this file free of Worker-only imports
 * so it bundles into the browser.
 */
import { z } from "zod";

import { EVENT_CLASSES } from "./classify";
import type { EventRow, LinkRow, MessageSummary } from "./schema";

/** How often an open, visible dashboard tab asks for fresh data. */
export const REFRESH_MS = 15_000;

const at = z.number().nullable();

export const listMessageSchema = z.object({
  /** Counted clicks, on any link. */
  clicks: z.number(),
  firstOpen: at,
  lastOpen: at,
  /** Counted opens: probable humans and on-open proxies, repeats left out. */
  opens: z.number(),
  recipient: z.string(),
  sentAt: at,
  subject: z.string(),
  token: z.string(),
});
export type ListMessage = z.infer<typeof listMessageSchema>;

export const listDataSchema = z.object({
  messages: z.array(listMessageSchema),
  /** When the server read the rows (ms since the epoch). */
  updated: z.number(),
});
export type ListData = z.infer<typeof listDataSchema>;

const openTotals = z.object({
  /** human + proxy: what the email list shows as opens. */
  counted: z.number(),
  human: z.number(),
  /** Prefetches, scanners, own hits, unknown and repeats: in the timeline only. */
  notCounted: z.number(),
  /** On-open image proxies (e.g. Gmail), which fetch when the recipient opens. */
  proxy: z.number(),
});
export type OpenTotals = z.infer<typeof openTotals>;

const linkTotalsSchema = z.object({
  clicks: z.number(),
  notCounted: z.number(),
  token: z.string(),
  url: z.string(),
});
export type LinkTotals = z.infer<typeof linkTotalsSchema>;

const totalsSchema = z.object({
  clicks: z.object({
    counted: z.number(),
    links: z.array(linkTotalsSchema),
    notCounted: z.number(),
  }),
  firstOpen: at,
  lastOpen: at,
  opens: openTotals,
});
export type Totals = z.infer<typeof totalsSchema>;

const timelineEventSchema = z.object({
  at: z.number(),
  class: z.enum(EVENT_CLASSES),
  counted: z.boolean(),
  country: z.string(),
  duplicate: z.boolean(),
  id: z.number(),
  kind: z.enum(["open", "click"]),
  network: z.string(),
  reason: z.string(),
  /** The clicked link's destination; null for opens. */
  url: z.string().nullable(),
  userAgent: z.string(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const detailDataSchema = z.object({
  message: z.object({
    recipient: z.string(),
    sentAt: at,
    subject: z.string(),
    token: z.string(),
  }),
  timeline: z.array(timelineEventSchema),
  totals: totalsSchema,
  updated: z.number(),
});
export type DetailData = z.infer<typeof detailDataSchema>;

/** The rule every summary uses: a counted class and not a repeat by the same actor. */
const counts = (e: EventRow): boolean => e.counted === 1 && e.duplicate === 0;

const range = (times: number[]) => ({
  firstOpen: times.length === 0 ? null : Math.min(...times),
  lastOpen: times.length === 0 ? null : Math.max(...times),
});

const linkTotals = (link: LinkRow, events: EventRow[]): LinkTotals => {
  const clicks = events.filter(
    (e) => e.kind === "click" && e.link_token === link.token
  );
  const counted = clicks.filter(counts).length;
  return {
    clicks: counted,
    notCounted: clicks.length - counted,
    token: link.token,
    url: link.url,
  };
};

/** Per-email totals from its raw events, using the same counting rule as the email list. */
export const messageTotals = (links: LinkRow[], events: EventRow[]): Totals => {
  const opens = events.filter((e) => e.kind === "open");
  const countedOpens = opens.filter(counts);
  const clicks = events.filter((e) => e.kind === "click");
  const countedClicks = clicks.filter(counts).length;
  return {
    clicks: {
      counted: countedClicks,
      links: links.map((link) => linkTotals(link, events)),
      notCounted: clicks.length - countedClicks,
    },
    opens: {
      counted: countedOpens.length,
      human: countedOpens.filter((e) => e.class === "human").length,
      notCounted: opens.length - countedOpens.length,
      proxy: countedOpens.filter((e) => e.class === "proxy").length,
    },
    ...range(countedOpens.map((e) => e.at)),
  };
};

export const listMessage = (m: MessageSummary): ListMessage => ({
  clicks: m.clicks,
  firstOpen: m.first_open,
  lastOpen: m.last_open,
  opens: m.opens,
  recipient: m.recipient,
  sentAt: m.sent_at,
  subject: m.subject,
  token: m.token,
});

export const timelineEvent = (
  e: EventRow,
  urls: ReadonlyMap<string, string>
): TimelineEvent => ({
  at: e.at,
  class: e.class,
  counted: e.counted === 1,
  country: e.country,
  duplicate: e.duplicate === 1,
  id: e.id,
  kind: e.kind,
  network: e.as_organization,
  reason: e.reason,
  url: e.link_token === null ? null : (urls.get(e.link_token) ?? null),
  userAgent: e.user_agent,
});
