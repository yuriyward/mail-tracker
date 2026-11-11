/**
 * The re-open signal. Within one recipient's token set, a counted open that comes long
 * enough after that set's previous counted open is a re-open: the recipient came back to
 * the email. For a probable human that is REOPEN_GAP_MS; for an on-open image proxy such
 * as Gmail's it is PROXY_REOPEN_GAP_MS (owner, 2026-11-12). An on-open proxy fetches only
 * when the recipient opens, so Gmail recipients can re-open (owner, 2026-11-11), but a hit
 * marked "possibly preloaded by Gmail" (src/preload.ts) is never a re-open; it still
 * counts as the set's previous open for the next one. Prefetches (Apple Mail Privacy
 * Protection, Private Relay), scanners, own hits and repeats are not counted, so they
 * neither start nor resume a run. Worked out when the data is read; it changes no count. Kept free of Worker-only
 * imports so the dashboard app can bundle it.
 */
import type { EventRow } from "./schema";

const HOUR = 60 * 60 * 1000;

/** A probable human's open at least this long after the previous one is a re-open. */
export const REOPEN_GAP_MS = HOUR;

/** An on-open proxy's open at least this long after the previous one is a re-open. */
export const PROXY_REOPEN_GAP_MS = 6 * HOUR;

/** A counted open, keyed by the token set (or email, for old tokens) it came through. */
export interface CountedOpen {
  id: number;
  at: number;
  /** Opens are compared within a group only: one recipient's token set. */
  group: string;
  /** Fetched by an on-open image proxy (class 'proxy'), not a probable human. */
  proxy: boolean;
  /** Marked "possibly preloaded by Gmail" (src/preload.ts): never a re-open. */
  preloaded: boolean;
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

/** `preloaded`: ids of the hits marked as possible Gmail preloads (src/preload.ts). */
export const countedOpensOf = (
  events: readonly EventRow[],
  preloaded: ReadonlySet<number> | ReadonlyMap<number, unknown>
): CountedOpen[] =>
  events.filter(isCountedOpen).map((e) => ({
    at: e.at,
    group: openGroup(e.recipient_token, e.message_token),
    id: e.id,
    preloaded: preloaded.has(e.id),
    proxy: e.class === "proxy",
  }));

/** The gap an open needs after the set's previous one to be a re-open. */
export const reopenGap = (open: CountedOpen): number =>
  open.proxy ? PROXY_REOPEN_GAP_MS : REOPEN_GAP_MS;

/** The opens that are re-opens, oldest first. */
export const findReopens = (opens: readonly CountedOpen[]): CountedOpen[] => {
  const sorted = opens.toSorted((a, b) => a.at - b.at || a.id - b.id);
  const previous = new Map<string, number>();
  const found: CountedOpen[] = [];
  for (const open of sorted) {
    const before = previous.get(open.group);
    if (
      before !== undefined &&
      !open.preloaded &&
      open.at - before >= reopenGap(open)
    ) {
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
