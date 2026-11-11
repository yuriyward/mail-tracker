/**
 * The re-open signal. Within one recipient's token set, a counted open (a probable human,
 * or an on-open image proxy such as Gmail's) that comes REOPEN_GAP_MS or more after that
 * set's previous counted open is a re-open: the recipient came back to the email. An
 * on-open proxy fetches only when the recipient opens, so Gmail recipients can re-open
 * (owner, 2026-11-11). Prefetches (Apple Mail Privacy Protection, Private Relay),
 * scanners, own hits and repeats are not counted, so they neither start nor resume a
 * run. Worked out when the data is read; it changes no count. Kept free of Worker-only
 * imports so the dashboard app can bundle it.
 */
import type { EventRow } from "./schema";

/** A new open at least this long after the previous one is a re-open. */
export const REOPEN_GAP_MS = 60 * 60 * 1000;

/** A counted open, keyed by the token set (or email, for old tokens) it came through. */
export interface CountedOpen {
  id: number;
  at: number;
  /** Opens are compared within a group only: one recipient's token set. */
  group: string;
}

export interface Reopens {
  reopens: number;
  /** The latest re-open; null when there is none. */
  lastReopen: number | null;
}

export const NO_REOPENS: Reopens = { lastReopen: null, reopens: 0 };

/** The classes whose counted opens take part: prefetch proxies are never counted. */
export const OPEN_SIGNAL_CLASSES: ReadonlySet<EventRow["class"]> = new Set([
  "human",
  "proxy",
]);

/** Counted, not a repeat, and a probable human or an on-open image proxy. */
export const isCountedOpen = (e: EventRow): boolean =>
  e.kind === "open" &&
  OPEN_SIGNAL_CLASSES.has(e.class) &&
  e.counted === 1 &&
  e.duplicate === 0;

/** The group of an event: its token set, or its email for message-level tokens. */
export const openGroup = (
  recipientToken: string | null,
  messageToken: string
): string => recipientToken ?? `message:${messageToken}`;

export const countedOpensOf = (events: readonly EventRow[]): CountedOpen[] =>
  events.filter(isCountedOpen).map((e) => ({
    at: e.at,
    group: openGroup(e.recipient_token, e.message_token),
    id: e.id,
  }));

/** The opens that are re-opens, oldest first. */
export const findReopens = (opens: readonly CountedOpen[]): CountedOpen[] => {
  const sorted = opens.toSorted((a, b) => a.at - b.at || a.id - b.id);
  const previous = new Map<string, number>();
  const found: CountedOpen[] = [];
  for (const open of sorted) {
    const before = previous.get(open.group);
    if (before !== undefined && open.at - before >= REOPEN_GAP_MS) {
      found.push(open);
    }
    previous.set(open.group, open.at);
  }
  return found;
};

/** How many re-opens and the latest one. */
export const summarise = (reopens: readonly CountedOpen[]): Reopens =>
  reopens.length === 0
    ? NO_REOPENS
    : {
        lastReopen: Math.max(...reopens.map((o) => o.at)),
        reopens: reopens.length,
      };

/** Re-opens per group. */
export const reopensByGroup = (
  reopens: readonly CountedOpen[]
): Map<string, Reopens> => {
  const groups = new Map<string, CountedOpen[]>();
  for (const open of reopens) {
    groups.set(open.group, [...(groups.get(open.group) ?? []), open]);
  }
  return new Map(
    [...groups].map(([group, own]) => [group, summarise(own)] as const)
  );
};
