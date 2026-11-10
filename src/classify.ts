export const EVENT_CLASSES = [
  "human",
  "proxy",
  "scanner",
  "self",
  "unknown",
] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export const CLASS_LABELS: Record<EventClass, string> = {
  human: "probable human",
  proxy: "proxy or prefetch",
  scanner: "scanner",
  self: "self",
  unknown: "unknown",
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
type Rule = (hit: Hit) => Verdict | null;

const counts = (reason: string): Verdict => ({ counted: true, reason });
const hidden = (reason: string): Verdict => ({ counted: false, reason });

const seconds = (ms: number): string => `${Math.round(ms / SECOND)}s`;

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
    return match ? counts(`on-open image proxy (${match[0]})`) : null;
  },
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

/** The first matching rule wins, in the order self, scanner, proxy, human. */
export const classify = (hit: Hit): Classification => {
  for (const [eventClass, rules] of ORDER) {
    for (const rule of rules) {
      const verdict = rule(hit);
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
