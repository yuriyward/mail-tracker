import { publishedNetworkLookup } from "./networks";
import type {
  NetworkLookup,
  NetworkVerdict,
  PublishedNetwork,
} from "./networks";

export const EVENT_CLASSES = [
  "human",
  "proxy",
  "scanner",
  "self",
  "unknown",
] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

/**
 * What the dashboard calls an event. The stored class 'proxy' splits by its stored reason:
 * an on-open image proxy fetches when the recipient opens the email, so it reads as an open
 * ("Opened", via its client); everything else in 'proxy' is a prefetch.
 */
export const EVENT_LABELS = [
  "Opened",
  "Clicked",
  "Draft preview",
  "Prefetch",
  "Scanner",
  "You",
  "You (Gmail)",
  "Unknown",
] as const;
export type EventLabel = (typeof EVENT_LABELS)[number];

/** Labels shown like a recipient's own action; the rest are muted. */
export const ACTION_LABELS: ReadonlySet<EventLabel> = new Set([
  "Opened",
  "Clicked",
]);

/** Every on-open proxy reason starts with this (PROXY_RULES below). */
const ON_OPEN_PREFIX = "on-open image proxy";

/** The mail client behind an on-open proxy, from the stored reason. */
const PROXY_CLIENTS: readonly [RegExp, string][] = [
  [/googleimageproxy|ggpht\.com|\bGoogle\b/iu, "Gmail"],
  [/yahoomailproxy/iu, "Yahoo Mail"],
  [/outlook-imageproxy/iu, "Outlook"],
];

export interface EventDisplay {
  label: EventLabel;
  /** The client of an on-open proxy ("Gmail"), else null. */
  via: string | null;
}

/** The label of each stored class but 'proxy', which splits by reason. */
const FIXED_LABELS: Record<
  Exclude<EventClass, "human" | "proxy">,
  EventLabel
> = { scanner: "Scanner", self: "You", unknown: "Unknown" };

/**
 * The plain label of a stored event (class, kind and reason are as stored). A draft preview
 * (a hit on a draft that carries tracking before it was sent, ADR-0004) is "Draft preview"
 * whatever its class.
 */
export const eventDisplay = (e: {
  class: EventClass;
  kind: "open" | "click";
  reason: string;
  preview?: number;
  gmail_self?: number | undefined;
}): EventDisplay => {
  if (e.preview === 1) {
    return { label: "Draft preview", via: null };
  }
  if (e.gmail_self === 1) {
    return { label: "You (Gmail)", via: null };
  }
  const action: EventLabel = e.kind === "open" ? "Opened" : "Clicked";
  if (e.class === "human") {
    return { label: action, via: null };
  }
  if (e.class !== "proxy") {
    return { label: FIXED_LABELS[e.class], via: null };
  }
  if (!e.reason.startsWith(ON_OPEN_PREFIX)) {
    return { label: "Prefetch", via: null };
  }
  const client = PROXY_CLIENTS.find(([pattern]) => pattern.test(e.reason));
  return { label: action, via: client ? client[1] : "image proxy" };
};

export interface Hit {
  kind: "open" | "click";
  method: string;
  userAgent: string;
  asOrganization: string;
  ip: string;
  /** The request carried a valid Cloudflare Access token of the owner. */
  ownerVerified: boolean;
  /** Milliseconds between the email being sent and this hit. */
  ageMs: number;
  /**
   * Distinct other links of the same message clicked by the same actor (IP and user agent)
   * within BURST_WINDOW_MS before this hit, leaving out self events.
   */
  otherLinksInBurst: number;
  selfIps: readonly string[];
}

export interface Classification {
  class: EventClass;
  reason: string;
  /**
   * Whether the event counts as an open or click in summaries: probable humans, and
   * proxies that fetch only when the recipient opens (e.g. Gmail's image proxy).
   * Prefetches, scanners, self and unknown events stay in the timeline only.
   */
  counted: boolean;
}

const SECOND = 1000;
/** Clicks this soon after sending come from gateways that follow every link on delivery. */
export const EARLY_CLICK_MS = 10 * SECOND;
/** Opens this soon after sending are prefetches (e.g. Apple Mail Privacy Protection). */
export const EARLY_OPEN_MS = 30 * SECOND;
/** One actor clicking two different links this close together is a scanner walking the message. */
export const BURST_WINDOW_MS = 3 * SECOND;

const SCANNER_UA =
  /bot\b|crawler|spider|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|headlesschrome|phantomjs|barracuda|proofpoint|mimecast|symantec|forcepoint|trendmicro|safelinks|scanner|preview/iu;
/** Proxies that fetch the image when the recipient opens the email. */
const ON_OPEN_PROXY_UA =
  /googleimageproxy|ggpht\.com|yahoomailproxy|outlook-imageproxy/iu;
const BARE_MOZILLA_UA = /^Mozilla\/5\.0$/u;
const HUMAN_UA = /^Mozilla\/5\.0 \(|thunderbird|outlook|mail\/\d/iu;
const IMAGE_PROXY_NETWORK = /\b(?:google|apple|microsoft|yahoo|oath)\b/iu;
const DATA_CENTRE_NETWORK =
  /\b(?:google|microsoft|amazon|digitalocean|ovh|hetzner|linode|akamai)\b/iu;

interface Verdict {
  reason: string;
  counted: boolean;
}
/** `network` is the published list holding the hit's IP, if any. */
type Rule = (hit: Hit, network: PublishedNetwork | null) => Verdict | null;

const counts = (reason: string): Verdict => ({ counted: true, reason });
const hidden = (reason: string): Verdict => ({ counted: false, reason });

const seconds = (ms: number): string => `${Math.round(ms / SECOND)}s`;

/** A rule for hits whose published network gives `verdict` for the hit's kind. */
const fromNetwork =
  (
    verdict: NetworkVerdict,
    make: (network: PublishedNetwork) => Verdict
  ): Rule =>
  (h, network) =>
    network !== null && network[h.kind] === verdict ? make(network) : null;

const SELF_RULES: Rule[] = [
  (h) =>
    h.ip !== "" && h.selfIps.includes(h.ip)
      ? hidden("IP is listed in SELF_IPS")
      : null,
  (h) => (h.ownerVerified ? hidden("verified Cloudflare Access token") : null),
];

const SCANNER_RULES: Rule[] = [
  (h) => (h.method === "HEAD" ? hidden("HEAD request") : null),
  (h) => {
    const match = SCANNER_UA.exec(h.userAgent);
    return match ? hidden(`scanner user agent (${match[0]})`) : null;
  },
  fromNetwork("scanner", (n) => hidden(`IP in the ${n.name}`)),
  (h) =>
    h.kind === "click" && h.ageMs < EARLY_CLICK_MS
      ? hidden(`clicked ${seconds(h.ageMs)} after send`)
      : null,
  (h) =>
    h.kind === "click" && h.otherLinksInBurst > 0
      ? hidden(
          `burst: ${h.otherLinksInBurst + 1} links clicked within ${seconds(BURST_WINDOW_MS)}`
        )
      : null,
  (h) => {
    const match =
      h.kind === "click" ? DATA_CENTRE_NETWORK.exec(h.asOrganization) : null;
    return match
      ? hidden(`click from a data-centre network (${h.asOrganization})`)
      : null;
  },
];

const PROXY_RULES: Rule[] = [
  (h) => {
    const match = ON_OPEN_PROXY_UA.exec(h.userAgent);
    return match ? counts(`${ON_OPEN_PREFIX} (${match[0]})`) : null;
  },
  fromNetwork("on-open", (n) =>
    counts(`${ON_OPEN_PREFIX}: IP in the ${n.name}`)
  ),
  fromNetwork("prefetch", (n) => hidden(`prefetch: IP in the ${n.name}`)),
  (h) =>
    h.kind === "open" && BARE_MOZILLA_UA.test(h.userAgent)
      ? hidden(
          "prefetch: bare Mozilla/5.0 user agent (Apple Mail Privacy Protection)"
        )
      : null,
  (h) =>
    h.kind === "open" && IMAGE_PROXY_NETWORK.test(h.asOrganization)
      ? hidden(
          `prefetch: fetched from a mail provider network (${h.asOrganization})`
        )
      : null,
  (h) =>
    h.kind === "open" && h.ageMs < EARLY_OPEN_MS
      ? hidden(`prefetch: opened ${seconds(h.ageMs)} after send`)
      : null,
];

const HUMAN_RULES: Rule[] = [
  (h) =>
    HUMAN_UA.test(h.userAgent)
      ? counts("browser or mail-client user agent")
      : null,
];

const ORDER: [EventClass, Rule[]][] = [
  ["self", SELF_RULES],
  ["scanner", SCANNER_RULES],
  ["proxy", PROXY_RULES],
  ["human", HUMAN_RULES],
];

/**
 * The first matching rule wins, in the order self, scanner, proxy, human. `networks` finds the
 * published network list (src/networks.ts) that holds the hit's IP.
 */
export const classify = (
  hit: Hit,
  networks: NetworkLookup = publishedNetworkLookup
): Classification => {
  const network = hit.ip === "" ? null : networks(hit.ip);
  for (const [eventClass, rules] of ORDER) {
    for (const rule of rules) {
      const verdict = rule(hit, network);
      if (verdict !== null) {
        return { class: eventClass, ...verdict };
      }
    }
  }
  return {
    class: "unknown",
    counted: false,
    reason: hit.userAgent === "" ? "no user agent" : "no recognised signal",
  };
};
