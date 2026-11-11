/**
 * The JSON the dashboard app (web/) reads from /app/data and /app/messages/:token/data.
 * The app parses responses with these schemas; keep this file free of Worker-only imports
 * so it bundles into the browser.
 */
import { z } from "zod";

import { EVENT_CLASSES } from "./classify";
import { linkName } from "./link-names";
import {
  NO_REOPENS,
  findReopens,
  countedOpensOf,
  openGroup,
  reopensByGroup,
  summarise,
} from "./reopen";
import type { Reopens } from "./reopen";
import type {
  EventRow,
  CountedOpenRow,
  LinkRow,
  MessageSummary,
  RecipientRow,
} from "./schema";

/** How often an open, visible dashboard tab asks for fresh data. */
export const REFRESH_MS = 15_000;

const at = z.number().nullable();

/** The re-open signal (src/reopen.ts): how many, and the latest. */
const reopenFields = {
  lastReopen: at,
  reopens: z.number(),
};

export const listMessageSchema = z.object({
  /** Current recipients with a known address, in draft order: each links to their page. */
  addresses: z.array(z.string()),
  /** Counted clicks, on any link. */
  clicks: z.number(),
  firstOpen: at,
  lastOpen: at,
  /** Recipients with a counted open or click, of `recipients` token sets. */
  openedBy: z.number(),
  /** Counted opens: probable humans and on-open proxies, repeats left out. */
  opens: z.number(),
  recipient: z.string(),
  /** A shared copy (Graph) went to several recipients, so who opened is unknown. */
  recipientUnknown: z.boolean(),
  /** Current token sets: one per recipient, or one when `shared`. */
  recipients: z.number(),
  sentAt: at,
  /** One body went to every recipient (Microsoft Graph); see recipientLabel. */
  shared: z.boolean(),
  subject: z.string(),
  token: z.string(),
  ...reopenFields,
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
  /** The link's text in the email, else its domain (src/link-names.ts). */
  name: z.string(),
  notCounted: z.number(),
  token: z.string(),
  url: z.string(),
});
export type LinkTotals = z.infer<typeof linkTotalsSchema>;

const recipientTotalsSchema = z.object({
  /** The address; '' for a shared copy sent to several recipients (recipient unknown). */
  address: z.string(),
  clicks: z.number(),
  /** False for a recipient removed from the draft before it was sent. */
  current: z.boolean(),
  firstOpen: at,
  /** Events flagged as possibly from someone the email was forwarded to. */
  hints: z.number(),
  lastOpen: at,
  opens: z.number(),
  token: z.string(),
  ...reopenFields,
});
export type RecipientTotals = z.infer<typeof recipientTotalsSchema>;

const totalsSchema = z.object({
  clicks: z.object({
    counted: z.number(),
    links: z.array(linkTotalsSchema),
    notCounted: z.number(),
  }),
  firstOpen: at,
  lastOpen: at,
  opens: openTotals,
  recipients: z.array(recipientTotalsSchema),
  ...reopenFields,
});
export type Totals = z.infer<typeof totalsSchema>;

const timelineEventSchema = z.object({
  at: z.number(),
  class: z.enum(EVENT_CLASSES),
  counted: z.boolean(),
  country: z.string(),
  duplicate: z.boolean(),
  /** The forwarding hint with its reason (src/forwarding.ts); null when none. */
  hint: z.string().nullable(),
  id: z.number(),
  kind: z.enum(["open", "click"]),
  /** The clicked link's name (its text, else its domain); null for opens. */
  linkName: z.string().nullable(),
  network: z.string(),
  reason: z.string(),
  /** The token set's address ('' when shared); null for message-level tokens. */
  recipient: z.string().nullable(),
  /** A counted open (human or on-open proxy) after a gap of an hour or more (src/reopen.ts). */
  reopen: z.boolean(),
  /** The clicked link's destination; null for opens. */
  url: z.string().nullable(),
  userAgent: z.string(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const detailDataSchema = z.object({
  message: z.object({
    recipient: z.string(),
    sentAt: at,
    shared: z.boolean(),
    subject: z.string(),
    token: z.string(),
  }),
  timeline: z.array(timelineEventSchema),
  totals: totalsSchema,
  updated: z.number(),
});
export type DetailData = z.infer<typeof detailDataSchema>;

/** One recipient address across every listed email (src/people.ts). */
export const personSchema = z.object({
  address: z.string(),
  /** Listed emails with this address as a current recipient. */
  emails: z.number(),
  /** The newest of last sent, last open and last click. */
  lastActivity: at,
  lastClick: at,
  lastOpen: at,
  lastSent: at,
  /** Median delay from sending to the first counted open (ms; human or on-open proxy). */
  medianFirstOpen: at,
  /** Of `emails`, those with a counted open or click by this person. */
  opened: z.number(),
  ...reopenFields,
});
export type Person = z.infer<typeof personSchema>;

/** One email as one person saw it: their own token set's figures. */
export const personEmailSchema = z.object({
  clicks: z.number(),
  firstOpen: at,
  lastClick: at,
  lastOpen: at,
  opens: z.number(),
  sentAt: at,
  subject: z.string(),
  token: z.string(),
  ...reopenFields,
});
export type PersonEmail = z.infer<typeof personEmailSchema>;

export const peopleDataSchema = z.object({
  people: z.array(personSchema),
  updated: z.number(),
});
export type PeopleData = z.infer<typeof peopleDataSchema>;

export const personDataSchema = z.object({
  emails: z.array(personEmailSchema),
  person: personSchema,
  updated: z.number(),
});
export type PersonData = z.infer<typeof personDataSchema>;

/** The app's path of a person's page. */
export const personPath = (address: string): string =>
  `/app/people/${encodeURIComponent(address)}`;

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
    name: linkName(link.url, link.text),
    notCounted: clicks.length - counted,
    token: link.token,
    url: link.url,
  };
};

/** How the dashboard names a token set; '' is the Graph case with several recipients. */
export const recipientLabel = (address: string): string =>
  address === "" ? "Shared copy, recipient unknown" : address;

/**
 * Per-recipient figures with the same counting rule. Lists current recipients, and
 * removed ones only if they have events.
 */
export const recipientTotals = (
  recipients: RecipientRow[],
  events: EventRow[],
  hints: ReadonlyMap<number, string>
): RecipientTotals[] => {
  const reopens = reopensByGroup(findReopens(countedOpensOf(events)));
  return recipients.flatMap((r) => {
    const own = events.filter((e) => e.recipient_token === r.token);
    if (r.current === 0 && own.length === 0) {
      return [];
    }
    const opens = own.filter((e) => e.kind === "open" && counts(e));
    return [
      {
        address: r.address,
        clicks: own.filter((e) => e.kind === "click" && counts(e)).length,
        current: r.current === 1,
        hints: own.filter((e) => hints.has(e.id)).length,
        opens: opens.length,
        token: r.token,
        ...range(opens.map((e) => e.at)),
        ...(reopens.get(r.token) ?? NO_REOPENS),
      },
    ];
  });
};

/**
 * The email's re-opens: through current recipients' token sets and message-level tokens,
 * as the email list counts them.
 */
const emailReopens = (
  recipients: RecipientRow[],
  reopenEvents: ReturnType<typeof findReopens>
): Reopens => {
  const removed = new Set(
    recipients.filter((r) => r.current === 0).map((r) => r.token)
  );
  return summarise(reopenEvents.filter((o) => !removed.has(o.group)));
};

export interface TotalsInput {
  links: LinkRow[];
  recipients: RecipientRow[];
  events: EventRow[];
  hints: ReadonlyMap<number, string>;
}

/** Per-email totals from its raw events, using the same counting rule as the email list. */
export const messageTotals = ({
  links,
  recipients,
  events,
  hints,
}: TotalsInput): Totals => {
  const opens = events.filter((e) => e.kind === "open");
  const countedOpens = opens.filter(counts);
  const clicks = events.filter((e) => e.kind === "click");
  const countedClicks = clicks.filter(counts).length;
  const reopenEvents = findReopens(countedOpensOf(events));
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
    recipients: recipientTotals(recipients, events, hints),
    ...range(countedOpens.map((e) => e.at)),
    ...emailReopens(recipients, reopenEvents),
  };
};

export const listMessage = (
  m: MessageSummary,
  extra: { addresses: string[]; reopens: Reopens }
): ListMessage => ({
  addresses: extra.addresses,
  clicks: m.clicks,
  firstOpen: m.first_open,
  lastOpen: m.last_open,
  openedBy: m.opened_by,
  opens: m.opens,
  recipient: m.recipient,
  recipientUnknown: m.recipient_unknown === 1,
  recipients: m.recipients,
  sentAt: m.sent_at,
  shared: m.shared === 1,
  subject: m.subject,
  token: m.token,
  ...extra.reopens,
});

export interface TimelineContext {
  /** Link token to its row. */
  links: ReadonlyMap<string, LinkRow>;
  /** Recipient token to address. */
  addresses: ReadonlyMap<string, string>;
  hints: ReadonlyMap<number, string>;
  /** Ids of the events that are re-opens. */
  reopens: ReadonlySet<number>;
}

/** What the timeline needs to name each event's link and recipient. */
export const timelineContext = (
  links: readonly LinkRow[],
  recipients: readonly RecipientRow[],
  events: readonly EventRow[],
  hints: ReadonlyMap<number, string>
): TimelineContext => ({
  addresses: new Map(recipients.map((r) => [r.token, r.address])),
  hints,
  links: new Map(links.map((link) => [link.token, link])),
  reopens: new Set(findReopens(countedOpensOf(events)).map((o) => o.id)),
});

export const timelineEvent = (
  e: EventRow,
  { links, addresses, hints, reopens }: TimelineContext
): TimelineEvent => {
  const link = e.link_token === null ? undefined : links.get(e.link_token);
  return {
    at: e.at,
    class: e.class,
    counted: e.counted === 1,
    country: e.country,
    duplicate: e.duplicate === 1,
    hint: hints.get(e.id) ?? null,
    id: e.id,
    kind: e.kind,
    linkName: link ? linkName(link.url, link.text) : null,
    network: e.as_organization,
    reason: e.reason,
    recipient:
      e.recipient_token === null
        ? null
        : (addresses.get(e.recipient_token) ?? null),
    reopen: reopens.has(e.id),
    url: link?.url ?? null,
    userAgent: e.user_agent,
  };
};

/** Re-opens by email and by token set. */
export interface ReopenIndex {
  byEmail: Map<string, Reopens>;
  /** By recipient token; message-level tokens are under `message:<token>`. */
  bySet: Map<string, Reopens>;
}

/** Re-opens per email, from the counted opens of every listed email (store.countedOpens). */
export const reopensByEmail = (
  opens: readonly CountedOpenRow[]
): ReopenIndex => {
  const emailOf = new Map<string, string>();
  const counted = opens.map((o) => {
    const group = openGroup(o.recipient_token, o.message_token);
    emailOf.set(group, o.message_token);
    return { at: o.at, group, id: o.id };
  });
  const reopenEvents = findReopens(counted);
  const byEmail = new Map<string, ReturnType<typeof findReopens>>();
  for (const o of reopenEvents) {
    const email = emailOf.get(o.group) ?? "";
    byEmail.set(email, [...(byEmail.get(email) ?? []), o]);
  }
  return {
    byEmail: new Map(
      [...byEmail].map(([email, own]) => [email, summarise(own)] as const)
    ),
    bySet: reopensByGroup(reopenEvents),
  };
};
