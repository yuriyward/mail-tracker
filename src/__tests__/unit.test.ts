import { describe, expect, test } from "bun:test";

import { classify } from "../classify";
import type { EventClass, Hit } from "../classify";
import { checkDestination } from "../destinations";
import {
  actorChanges,
  deviceClass,
  forwardingHints,
  HINT_PREFIX,
} from "../forwarding";
import type { DeviceClass } from "../forwarding";
import { normaliseAddress, tokenSetAddresses } from "../recipients";
import type { EventRow, RecipientRow } from "../schema";
import { isToken, newToken } from "../tokens";

describe("tokens", () => {
  test("are 22 url-safe characters and unique", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newToken()));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) {
      expect(isToken(token)).toBe(true);
    }
  });

  test("reject anything else", () => {
    for (const bad of [
      "",
      "short",
      "a".repeat(23),
      `${"a".repeat(21)}/`,
      `${"a".repeat(21)}.`,
    ]) {
      expect(isToken(bad)).toBe(false);
    }
  });
});

describe("redirect allow-list", () => {
  test("accepts public https URLs and normalises them", () => {
    expect(checkDestination("https://Example.org/path?q=1#top")).toEqual({
      ok: true,
      url: "https://example.org/path?q=1#top",
    });
  });

  test.each([
    ["http://example.org/", "not https"],
    [["javascript", "alert(1)"].join(":"), "not https"],
    ["data:text/html,hi", "not https"],
    ["//example.org/", "not an absolute URL"],
    ["/relative", "not an absolute URL"],
    ["https://user:pw@example.org/", "contains credentials"],
    ["https://127.0.0.1/", "host is not a public domain name"],
    ["https://[::1]/", "host is not a public domain name"],
    ["https://intranet/", "host is not a public domain name"],
    ["https://printer.local/", "host is local"],
    [`https://example.org/${"a".repeat(5000)}`, "too long"],
  ])("rejects %s", (url, reason) => {
    expect(checkDestination(url)).toEqual({ ok: false, reason });
  });
});

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

const hit = (overrides: Partial<Hit>): Hit => ({
  ageMs: 3_600_000,
  asOrganization: "Example Broadband",
  ip: "198.51.100.7",
  kind: "open",
  method: "GET",
  otherLinksInBurst: 0,
  ownerVerified: false,
  selfIps: [],
  userAgent: BROWSER,
  ...overrides,
});

const GMAIL =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

describe("classification", () => {
  test.each<[string, Partial<Hit>, EventClass, string, boolean]>([
    ["browser open", {}, "human", "browser or mail-client user agent", true],
    [
      "browser click",
      { kind: "click" },
      "human",
      "browser or mail-client user agent",
      true,
    ],
    [
      "own IP",
      { selfIps: ["198.51.100.7"] },
      "self",
      "IP is listed in SELF_IPS",
      false,
    ],
    [
      "verified owner",
      { ownerVerified: true },
      "self",
      "verified Cloudflare Access token",
      false,
    ],
    [
      "Mailspring recipient",
      { userAgent: "Mozilla/5.0 (Macintosh) Mailspring/1.16" },
      "human",
      "browser or mail-client user agent",
      true,
    ],
    [
      "Gmail proxy",
      { userAgent: GMAIL },
      "proxy",
      "on-open image proxy (ggpht.com)",
      true,
    ],
    [
      "Apple MPP",
      { userAgent: "Mozilla/5.0" },
      "proxy",
      "prefetch: bare Mozilla/5.0 user agent (Apple Mail Privacy Protection)",
      false,
    ],
    [
      "provider network",
      { asOrganization: "Apple Inc." },
      "proxy",
      "prefetch: fetched from a mail provider network (Apple Inc.)",
      false,
    ],
    [
      "early open",
      { ageMs: 4000 },
      "proxy",
      "prefetch: opened 4s after send",
      false,
    ],
    [
      "HEAD",
      { kind: "click", method: "HEAD" },
      "scanner",
      "HEAD request",
      false,
    ],
    [
      "bot UA",
      { userAgent: "python-requests/2.32" },
      "scanner",
      "scanner user agent (python-requests)",
      false,
    ],
    [
      "early click",
      { ageMs: 2000, kind: "click" },
      "scanner",
      "clicked 2s after send",
      false,
    ],
    [
      "burst",
      { kind: "click", otherLinksInBurst: 2 },
      "scanner",
      "burst: 3 links clicked within 3s",
      false,
    ],
    [
      "data-centre click",
      { asOrganization: "Microsoft Corporation", kind: "click" },
      "scanner",
      "click from a data-centre network (Microsoft Corporation)",
      false,
    ],
    ["no UA", { userAgent: "" }, "unknown", "no user agent", false],
    [
      "odd UA",
      { userAgent: "SomethingElse/1.0" },
      "unknown",
      "no recognised signal",
      false,
    ],
  ])("%s", (_name, overrides, eventClass, reason, counted) => {
    expect(classify(hit(overrides))).toEqual({
      class: eventClass,
      counted,
      reason,
    });
  });

  test("self wins over scanner signals", () => {
    const result = classify(
      hit({ ageMs: 0, kind: "click", selfIps: ["198.51.100.7"] })
    );
    expect(result.class).toBe("self");
  });
});

describe("forwarding hint", () => {
  const recipients: RecipientRow[] = [
    {
      address: "alex@example.com",
      current: 1,
      message_token: "m",
      position: 0,
      token: "ra",
    },
    { address: "", current: 1, message_token: "m", position: 1, token: "rs" },
  ];
  let id = 0;
  const event = (overrides: Partial<EventRow>): EventRow => {
    id += 1;
    return {
      as_organization: "Example Broadband",
      at: id * 1000,
      class: "human",
      counted: 1,
      country: "DE",
      duplicate: 0,
      id,
      ip: "198.51.100.1",
      kind: "open",
      link_token: null,
      message_token: "m",
      method: "GET",
      reason: "",
      recipient_token: "ra",
      user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
      ...overrides,
    };
  };

  test.each<[string, DeviceClass | null]>([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
      "phone",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile Safari/537.36",
      "phone",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Tab S9) Chrome/131.0 Safari/537.36",
      "tablet",
    ],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0", "computer"],
    ["Microsoft Outlook 16.0", "computer"],
    ["", null],
  ])("device class of %s is %s", (userAgent, expected) => {
    expect(deviceClass(userAgent)).toBe(expected);
  });

  test("compares each later human event with the recipient's first one", () => {
    const first = event({});
    const same = event({ kind: "click" });
    const away = event({ as_organization: "Other Telecom" });
    const hints = forwardingHints(recipients, [away, same, first]);
    expect([...hints]).toEqual([
      [
        away.id,
        `${HINT_PREFIX}: network Other Telecom (first: Example Broadband)`,
      ],
    ]);
  });

  test("ignores proxies, repeats, missing facts, shared sets and message-level tokens", () => {
    const events = [
      // A Gmail proxy open first says nothing about the reader; the human open is the baseline.
      event({ as_organization: "Google LLC", class: "proxy" }),
      event({}),
      event({ as_organization: "Other Telecom", duplicate: 1 }),
      event({ as_organization: "", country: "", user_agent: "" }),
      event({ class: "scanner", country: "US" }),
      event({ recipient_token: "rs" }),
      event({ country: "FR", recipient_token: "rs" }),
      event({ recipient_token: null }),
      event({ country: "FR", recipient_token: null }),
    ];
    expect(forwardingHints(recipients, events).size).toBe(0);
  });

  test("actorChanges lists only facts known on both sides", () => {
    expect(
      actorChanges(
        { country: "DE", device: "computer", network: "" },
        { country: "DE", device: "phone", network: "Other" }
      )
    ).toEqual(["device phone (first: computer)"]);
  });
});

describe("token set addresses", () => {
  test("one per distinct address, or one shared set", () => {
    expect(normaliseAddress(" Alex@Example.COM ")).toBe("alex@example.com");
    const all = [
      "alex@example.com",
      "Alex@example.com",
      "sam@example.net",
      " ",
    ];
    expect(tokenSetAddresses(all, false)).toEqual([
      "alex@example.com",
      "sam@example.net",
    ]);
    expect(tokenSetAddresses(all, true)).toEqual([""]);
    expect(tokenSetAddresses(["Alex@example.com"], true)).toEqual([
      "alex@example.com",
    ]);
  });
});
