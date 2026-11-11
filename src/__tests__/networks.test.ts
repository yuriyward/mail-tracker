import { describe, expect, test } from "bun:test";

import { classify } from "../classify";
import type { Classification, Hit } from "../classify";
import {
  formatIp,
  mergeRanges,
  parseCidr,
  rangeToCidrs,
  subtractRanges,
} from "../ip";
import { cidrKeyRange, ipKey } from "../ip-key";
import { networkLookup, publishedNetworkLookup } from "../networks";
import generated from "../networks.json";

/** Fixture ranges: a few blocks from each published list, not the generated file. */
const FIXTURE = networkLookup({
  "apple-private-relay": ["172.224.226.0/27", "2a02:26f7:b3c0:4000::/64"],
  "google-services": ["66.249.80.0/20"],
  "microsoft-exchange-online": ["40.92.0.0/15", "40.107.0.0/16"],
  mimecast: ["205.139.110.0/24"],
  "proofpoint-essentials": ["148.163.128.0/19"],
});

const APPLE_RELAY_IP = "172.224.226.5";
const GOOGLE_PROXY_IP = "66.249.84.10";
const SAFE_LINKS_IP = "40.107.22.5";
const RESIDENTIAL_IP = "198.51.100.7";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const hit = (overrides: Partial<Hit>): Hit => ({
  ageMs: 3_600_000,
  asOrganization: "Example Broadband",
  ip: RESIDENTIAL_IP,
  kind: "open",
  method: "GET",
  otherLinksInBurst: 0,
  ownerVerified: false,
  selfIps: [],
  userAgent: BROWSER,
  ...overrides,
});

const HUMAN: Classification = {
  class: "human",
  counted: true,
  reason: "browser or mail-client user agent",
};

describe("classification by published network", () => {
  test.each<[string, Partial<Hit>, Classification]>([
    [
      "Apple relay open is a prefetch",
      { ip: APPLE_RELAY_IP },
      {
        class: "proxy",
        counted: false,
        reason: "prefetch: IP in the Apple iCloud Private Relay egress list",
      },
    ],
    [
      "Apple relay over IPv6",
      { ip: "2a02:26f7:b3c0:4000::1" },
      {
        class: "proxy",
        counted: false,
        reason: "prefetch: IP in the Apple iCloud Private Relay egress list",
      },
    ],
    [
      "Apple relay click is left to the other rules (Safari with Private Relay)",
      { ip: APPLE_RELAY_IP, kind: "click" },
      HUMAN,
    ],
    [
      "Google proxy open counts as an on-open proxy",
      { ip: GOOGLE_PROXY_IP },
      {
        class: "proxy",
        counted: true,
        reason:
          "on-open image proxy: IP in the Google service IP list (goog.json minus cloud.json)",
      },
    ],
    [
      "Google network click is a scanner",
      { ip: GOOGLE_PROXY_IP, kind: "click" },
      {
        class: "scanner",
        counted: false,
        reason: "IP in the Google service IP list (goog.json minus cloud.json)",
      },
    ],
    [
      "Safe Links click is a scanner",
      { ip: SAFE_LINKS_IP, kind: "click" },
      {
        class: "scanner",
        counted: false,
        reason: "IP in the Microsoft 365 Exchange Online endpoint list",
      },
    ],
    [
      "Exchange Online open is a prefetch",
      { ip: SAFE_LINKS_IP },
      {
        class: "proxy",
        counted: false,
        reason:
          "prefetch: IP in the Microsoft 365 Exchange Online endpoint list",
      },
    ],
    [
      "Outlook's on-open image proxy is still recognised by its user agent",
      { ip: SAFE_LINKS_IP, userAgent: "Mozilla/5.0 Outlook-ImageProxy" },
      {
        class: "proxy",
        counted: true,
        reason: "on-open image proxy (Outlook-ImageProxy)",
      },
    ],
    [
      "Mimecast open is a scanner",
      { ip: "205.139.110.12" },
      {
        class: "scanner",
        counted: false,
        reason: "IP in the Mimecast netblocks",
      },
    ],
    [
      "Proofpoint click is a scanner",
      { ip: "148.163.130.1", kind: "click" },
      {
        class: "scanner",
        counted: false,
        reason: "IP in the Proofpoint Essentials connection details",
      },
    ],
    ["residential open is unchanged", {}, HUMAN],
    ["residential click is unchanged", { kind: "click" }, HUMAN],
  ])("%s", (_name, overrides, expected) => {
    expect(classify(hit(overrides), FIXTURE)).toEqual(expected);
  });

  test("self still wins over a published network", () => {
    const result = classify(
      hit({ ip: SAFE_LINKS_IP, kind: "click", selfIps: [SAFE_LINKS_IP] }),
      FIXTURE
    );
    expect(result.class).toBe("self");
  });

  test("the committed ranges hold one sample address of each list", () => {
    expect(
      [
        APPLE_RELAY_IP,
        GOOGLE_PROXY_IP,
        SAFE_LINKS_IP,
        "205.139.110.12",
        "148.163.130.1",
        RESIDENTIAL_IP,
      ].map((ip) => publishedNetworkLookup(ip)?.id ?? null)
    ).toEqual([
      "apple-private-relay",
      "google-services",
      "microsoft-exchange-online",
      "mimecast",
      "proofpoint-essentials",
      null,
    ]);
  });
});

const cidrs = (...blocks: string[]) =>
  blocks.map(parseCidr).filter((range) => range !== null);

const keyOf = (version: 4 | 6, value: bigint) =>
  value.toString(16).padStart(version === 4 ? 8 : 32, "0");

describe("IP ranges", () => {
  test.each<[string, string | null]>([
    ["192.0.2.1", "c0000201"],
    ["2001:db8::1", "20010db8000000000000000000000001"],
    ["2001:DB8:0:0:1:0:0:1", "20010db8000000000001000000000001"],
    ["::ffff:192.0.2.1", "c0000201"],
    ["::", "0".repeat(32)],
    ["192.0.2.256", null],
    ["2001:db8:::1", null],
    ["1:2:3:4:5:6:7:8:9", null],
    ["1:2:3:4:5:6:7::8", null],
    ["", null],
  ])("key of %s", (text, expected) => {
    expect(ipKey(text)?.key ?? null).toBe(expected);
  });

  test.each<[string, string, string]>([
    ["192.0.2.77/24", "c0000200", "c00002ff"],
    ["192.0.2.77/26", "c0000240", "c000027f"],
    ["192.0.2.77", "c000024d", "c000024d"],
    [
      "2001:db8::/33",
      `20010db8${"0".repeat(24)}`,
      `20010db87${"f".repeat(23)}`,
    ],
  ])("key range of %s", (cidr, start, end) => {
    expect(cidrKeyRange(cidr)).toMatchObject({ end, start });
  });

  test("each committed list is sorted, IPv4 first, without overlaps", () => {
    for (const [id, blocks] of Object.entries(generated.ranges)) {
      const ranges = blocks.map(parseCidr);
      expect({ id, valid: ranges.every((range) => range !== null) }).toEqual({
        id,
        valid: true,
      });
      const sorted = ranges.every((range, index) => {
        const previous = ranges[index - 1];
        return (
          index === 0 ||
          range === null ||
          previous === null ||
          previous === undefined ||
          previous.version < range.version ||
          (previous.version === range.version && previous.end < range.start)
        );
      });
      expect({ id, sorted }).toEqual({ id, sorted: true });
    }
  });

  test("the key and integer forms agree on every block of the committed lists", () => {
    const blocks = [
      "0.0.0.0/0",
      "::/0",
      ...Object.values(generated.ranges).flat(),
    ];
    for (const block of blocks) {
      const range = parseCidr(block);
      expect(range).not.toBeNull();
      if (range !== null) {
        expect(cidrKeyRange(block)).toEqual({
          end: keyOf(range.version, range.end),
          start: keyOf(range.version, range.start),
          version: range.version,
        });
      }
    }
  });

  test("CIDR parsing ignores host bits and rejects bad lengths", () => {
    const range = parseCidr("192.0.2.77/24");
    expect(range && formatIp(4, range.start)).toBe("192.0.2.0");
    expect(range && formatIp(4, range.end)).toBe("192.0.2.255");
    expect(parseCidr("192.0.2.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(cidrKeyRange("192.0.2.0/33")).toBeNull();
    expect(cidrKeyRange("2001:db8::/1x")).toBeNull();
  });

  test("merging joins adjacent blocks into the fewest CIDRs", () => {
    const merged = mergeRanges(
      cidrs(
        "192.0.2.128/25",
        "192.0.2.0/25",
        "2001:db8::/33",
        "2001:db8:8000::/33"
      )
    );
    expect(merged.flatMap(rangeToCidrs)).toEqual([
      "192.0.2.0/24",
      "2001:db8::/32",
    ]);
  });

  test("subtraction cuts holes", () => {
    const left = subtractRanges(cidrs("192.0.2.0/24"), cidrs("192.0.2.64/26"));
    expect(left.flatMap(rangeToCidrs)).toEqual([
      "192.0.2.0/26",
      "192.0.2.128/25",
    ]);
  });
});
