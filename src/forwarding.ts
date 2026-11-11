/**
 * The forwarding hint (ADR-0003). Each recipient has their own token set, so a probable
 * human event on it normally comes from that recipient. When a later one comes from a
 * different network, country or kind of device than that recipient's first one, the email
 * was possibly forwarded, or opened by someone else. It is a hint, not a fact: the same
 * person on mobile data, travelling or on a second device looks the same.
 *
 * Computed when read, from the stored events, so it never changes how events are counted.
 * Kept free of Worker-only imports so the dashboard app can bundle it.
 */
import type { EventRow, RecipientRow } from "./schema";

export type DeviceClass = "phone" | "tablet" | "computer";

const TABLET_UA = /\bipad\b|\btablet\b|android(?!.*\bmobile\b)/iu;
const PHONE_UA = /\biphone\b|\bipod\b|\bmobile\b|\bandroid\b/iu;

/** The kind of device a user agent names; null when there is no user agent to tell. */
export const deviceClass = (userAgent: string): DeviceClass | null => {
  if (userAgent.trim() === "") {
    return null;
  }
  if (TABLET_UA.test(userAgent)) {
    return "tablet";
  }
  return PHONE_UA.test(userAgent) ? "phone" : "computer";
};

interface Actor {
  network: string;
  country: string;
  device: DeviceClass | null;
}

const actorOf = (e: EventRow): Actor => ({
  country: e.country,
  device: deviceClass(e.user_agent),
  network: e.as_organization,
});

/** A fact counts as different only when both sides are known. */
const differs = <T>(a: T | null, b: T | null): boolean =>
  a !== null && b !== null && a !== "" && b !== "" && a !== b;

/** Why `later` looks like a different actor from `first`; empty when it does not. */
export const actorChanges = (first: Actor, later: Actor): string[] => {
  const changes: string[] = [];
  if (differs(first.network, later.network)) {
    changes.push(`network ${later.network} (first: ${first.network})`);
  }
  if (differs(first.country, later.country)) {
    changes.push(`country ${later.country} (first: ${first.country})`);
  }
  if (differs(first.device, later.device)) {
    changes.push(`device ${later.device ?? ""} (first: ${first.device ?? ""})`);
  }
  return changes;
};

export const HINT_PREFIX = "possibly forwarded or opened by someone else";

/** Probable human events (no repeats) per token set of a known recipient, oldest first. */
const humanEventsBySet = (
  recipients: readonly RecipientRow[],
  events: readonly EventRow[]
): EventRow[][] => {
  const bySet = new Map(
    recipients
      .filter((r) => r.address !== "")
      .map((r): [string, EventRow[]] => [r.token, []])
  );
  for (const e of events) {
    const own = bySet.get(e.recipient_token ?? "");
    if (own && e.class === "human" && e.duplicate === 0) {
      own.push(e);
    }
  }
  return [...bySet.values()].map((own) =>
    own.toSorted((a, b) => a.at - b.at || a.id - b.id)
  );
};

/**
 * Event id to hint text, for each probable human event (not a repeat) of a recipient that
 * differs from that recipient's first one. Proxy events say nothing about who opened, and
 * sets shared by several recipients (address '') or from before per-recipient tokens have
 * no single owner, so neither is compared.
 */
export const forwardingHints = (
  recipients: readonly RecipientRow[],
  events: readonly EventRow[]
): Map<number, string> => {
  const hints = new Map<number, string>();
  for (const [first, ...later] of humanEventsBySet(recipients, events)) {
    const baseline = first ? actorOf(first) : null;
    for (const e of baseline ? later : []) {
      const changes = actorChanges(baseline ?? actorOf(e), actorOf(e));
      if (changes.length > 0) {
        hints.set(e.id, `${HINT_PREFIX}: ${changes.join("; ")}`);
      }
    }
  }
  return hints;
};
