/**
 * The Gmail preload hint. Opening one email can make Gmail's image proxy fetch the image
 * of a neighbouring email to the same person too (live, 2026-11-11: two emails to one
 * Gmail address, fetched in pairs 0-12 s apart). The proxy request of a preload is the
 * same as of an open, and a person searching their mail can really open several emails
 * in a row, so nothing is dropped: when two different emails to the same address get
 * on-open Gmail proxy hits within PRELOAD_WINDOW_MS of each other, the later hit is marked
 * "possibly preloaded by Gmail". It still counts as an open, and its email as opened, but
 * never as a re-open (src/reopen.ts). Owner decisions, 2026-11-12.
 *
 * Worked out when read, from the stored rows. Kept free of Worker-only imports so the
 * dashboard app can bundle it.
 */
import { eventDisplay } from "./classify";
import type { EventClass } from "./classify";

/** A later hit on another email this close to an earlier one may be a preload. */
export const PRELOAD_WINDOW_MS = 15_000;

/** The badge; the hint text starts with it. */
export const PRELOAD_HINT = "possibly preloaded by Gmail";

/** A counted open with what the hint needs: who it went to, and how it was fetched. */
export interface PreloadCandidate {
  id: number;
  at: number;
  message_token: string;
  /** The token set's address; '' (shared copy) or null (message-level token) is no one. */
  address: string | null;
  class: EventClass;
  reason: string;
}

const isGmailOpen = (o: PreloadCandidate): boolean =>
  o.class === "proxy" &&
  eventDisplay({ class: o.class, kind: "open", reason: o.reason }).via ===
    "Gmail";

const hintText = (gapMs: number): string =>
  `${PRELOAD_HINT}: fetched ${Math.round(gapMs / 1000)} s after another email to this ` +
  "recipient was opened in Gmail, which can fetch neighbouring emails' images. " +
  "Counted as an open, never as a re-open.";

/** The latest hit before sorted[index], on another email, within the window. */
const nearestOtherEmail = (
  sorted: readonly PreloadCandidate[],
  index: number
): PreloadCandidate | null => {
  const later = sorted[index];
  if (!later) {
    return null;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const o = sorted[i];
    if (!o || later.at - o.at > PRELOAD_WINDOW_MS) {
      return null;
    }
    if (o.message_token !== later.message_token) {
      return o;
    }
  }
  return null;
};

/**
 * Event id to hint text for each on-open Gmail proxy hit that comes within
 * PRELOAD_WINDOW_MS after a Gmail proxy hit on a different email to the same address.
 * Pass counted, non-repeat opens (store.countedOpens); other rows are never compared.
 */
export const preloadHints = (
  opens: readonly PreloadCandidate[]
): Map<number, string> => {
  const byAddress = new Map<string, PreloadCandidate[]>();
  for (const o of opens) {
    if (o.address !== null && o.address !== "" && isGmailOpen(o)) {
      byAddress.set(o.address, [...(byAddress.get(o.address) ?? []), o]);
    }
  }
  const hints = new Map<number, string>();
  for (const own of byAddress.values()) {
    const sorted = own.toSorted((a, b) => a.at - b.at || a.id - b.id);
    for (const [index, later] of sorted.entries()) {
      const earlier = nearestOtherEmail(sorted, index);
      if (earlier) {
        hints.set(later.id, hintText(later.at - earlier.at));
      }
    }
  }
  return hints;
};
