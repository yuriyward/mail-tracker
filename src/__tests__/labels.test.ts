import { describe, expect, test } from "bun:test";

import { ACTION_LABELS, classify, eventDisplay } from "../classify";
import type { EventDisplay, EventLabel, Hit } from "../classify";
import { networkLookup } from "../networks";

/** Synthetic ranges, one block per published list. */
const NETWORKS = networkLookup({
  "apple-private-relay": ["172.224.226.0/27"],
  "google-services": ["66.249.80.0/20"],
  "microsoft-exchange-online": ["40.107.0.0/16"],
  mimecast: ["205.139.110.0/24"],
  "proofpoint-essentials": ["148.163.128.0/19"],
});

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
/** The user agent Gmail's image proxy sends (seen live 2026-11-11). */
const GMAIL =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

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

const shown = (label: EventLabel, via: string | null = null): EventDisplay => ({
  label,
  via,
});

describe("event labels: each classified hit and its stored reason", () => {
  test.each<[string, Partial<Hit>, string, EventDisplay]>([
    [
      "live Gmail open: Google's image proxy from a Google LLC IP",
      {
        asOrganization: "Google LLC",
        ip: "66.249.84.10",
        userAgent: GMAIL,
      },
      "on-open image proxy (ggpht.com)",
      shown("Opened", "Gmail"),
    ],
    [
      "Gmail open recognised by Google's published range only",
      { ip: "66.249.84.10", userAgent: "Mozilla/5.0 (X11) Example" },
      "on-open image proxy: IP in the Google service IP list (goog.json minus cloud.json)",
      shown("Opened", "Gmail"),
    ],
    [
      "Yahoo's image proxy",
      {
        userAgent: "YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy",
      },
      "on-open image proxy (YahooMailProxy)",
      shown("Opened", "Yahoo Mail"),
    ],
    [
      "Outlook's image proxy",
      { ip: "40.107.22.5", userAgent: "Mozilla/5.0 Outlook-ImageProxy" },
      "on-open image proxy (Outlook-ImageProxy)",
      shown("Opened", "Outlook"),
    ],
    [
      "Apple Private Relay",
      { ip: "172.224.226.5" },
      "prefetch: IP in the Apple iCloud Private Relay egress list",
      shown("Prefetch"),
    ],
    [
      "Apple MPP bare user agent",
      { userAgent: "Mozilla/5.0" },
      "prefetch: bare Mozilla/5.0 user agent (Apple Mail Privacy Protection)",
      shown("Prefetch"),
    ],
    [
      "Exchange Online fetch",
      { ip: "40.107.22.5" },
      "prefetch: IP in the Microsoft 365 Exchange Online endpoint list",
      shown("Prefetch"),
    ],
    [
      "mail provider network",
      { asOrganization: "Apple Inc." },
      "prefetch: fetched from a mail provider network (Apple Inc.)",
      shown("Prefetch"),
    ],
    [
      "open seconds after send",
      { ageMs: 4000 },
      "prefetch: opened 4s after send",
      shown("Prefetch"),
    ],
    [
      "scanner user agent",
      { userAgent: "python-requests/2.32" },
      "scanner user agent (python-requests)",
      shown("Scanner"),
    ],
    [
      "scanner network",
      { ip: "205.139.110.12" },
      "IP in the Mimecast netblocks",
      shown("Scanner"),
    ],
    [
      "early click",
      { ageMs: 2000, kind: "click" },
      "clicked 2s after send",
      shown("Scanner"),
    ],
    [
      "own IP",
      { selfIps: ["198.51.100.7"] },
      "IP is listed in SELF_IPS",
      shown("You"),
    ],
    [
      "owner's Access token",
      { ownerVerified: true },
      "verified Cloudflare Access token",
      shown("You"),
    ],
    ["browser open", {}, "browser or mail-client user agent", shown("Opened")],
    [
      "browser click",
      { kind: "click" },
      "browser or mail-client user agent",
      shown("Clicked"),
    ],
    ["no user agent", { userAgent: "" }, "no user agent", shown("Unknown")],
    [
      "odd user agent",
      { userAgent: "SomethingElse/1.0" },
      "no recognised signal",
      shown("Unknown"),
    ],
  ])("%s", (_name, overrides, reason, expected) => {
    const h = hit(overrides);
    const classified = classify(h, NETWORKS);
    expect(classified.reason).toBe(reason);
    const display = eventDisplay({ ...classified, kind: h.kind });
    expect(display).toEqual(expected);
    // An action label is shown exactly for the events that are counted.
    expect(ACTION_LABELS.has(display.label)).toBe(classified.counted);
  });

  test("an on-open proxy reason from an unnamed client is still an open", () => {
    expect(
      eventDisplay({
        class: "proxy",
        kind: "open",
        reason: "on-open image proxy: IP in the Example proxy list",
      })
    ).toEqual(shown("Opened", "image proxy"));
  });
});
