/**
 * Regenerates src/networks.json from the official lists. Run with `bun run refresh:networks`,
 * review the diff, commit and deploy.
 *
 * Sources (also listed with their meaning in src/networks.ts):
 * - Apple iCloud Private Relay egress: https://mask-api.icloud.com/egress-ip-ranges.csv
 *   (documented at https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay/)
 * - Google: https://www.gstatic.com/ipranges/goog.json minus https://www.gstatic.com/ipranges/cloud.json
 *   (documented at https://support.google.com/a/answer/10026322)
 * - Microsoft 365 endpoints, service area Exchange: https://endpoints.office.com/endpoints/worldwide
 *   (documented at https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges)
 * - Mimecast: the SPF records under _netblocks.mimecast.com, which Mimecast publishes for its
 *   regions (https://mimecastsupport.zendesk.com/hc/en-us/articles/34000362728979-Administration-Data-Centers-URLs)
 * - Proofpoint Essentials: the static ranges below, copied from
 *   https://help.proofpoint.com/Proofpoint_Essentials/Email_Security/Administrator_Topics/000_gettingstarted/020_connectiondetails
 *   (the page is not machine-readable and now asks for a sign-in; recheck it by hand).
 */

import { resolveTxt } from "node:dns/promises";

import { z } from "zod";

import {
  mergeRanges,
  parseCidr,
  rangeToCidrs,
  subtractRanges,
} from "../src/ip";
import type { IpRange } from "../src/ip";
import { PUBLISHED_NETWORKS } from "../src/networks";

const OUTPUT = new URL("../src/networks.json", import.meta.url);

/** Proofpoint Essentials US and EU ranges, as listed on the connection details page. */
const PROOFPOINT_ESSENTIALS = [
  "67.231.144.0/22",
  "67.231.148.0/23",
  "67.231.152.0/22",
  "67.231.156.0/24",
  "148.163.128.0/19",
  "208.56.1.0/25",
  "91.207.212.0/23",
  "91.209.104.0/24",
  "185.132.180.0/22",
  "185.183.28.0/22",
];

const toRanges = (cidrs: Iterable<string>, source: string): IpRange[] => {
  const ranges: IpRange[] = [];
  for (const cidr of cidrs) {
    const range = parseCidr(cidr);
    if (range === null) {
      throw new Error(`${source}: not a CIDR block: ${cidr}`);
    }
    ranges.push(range);
  }
  return ranges;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return await response.text();
};

const apple = async (): Promise<IpRange[]> => {
  const url = "https://mask-api.icloud.com/egress-ip-ranges.csv";
  const csv = await fetchText(url);
  // Each line: prefix,country,region,city,
  const prefixes = csv
    .split("\n")
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((prefix) => prefix !== "");
  return toRanges(prefixes, url);
};

const GooglePrefixes = z.object({
  prefixes: z.array(
    z.object({
      ipv4Prefix: z.string().optional(),
      ipv6Prefix: z.string().optional(),
    })
  ),
});

const googlePrefixes = async (url: string): Promise<IpRange[]> => {
  const data = GooglePrefixes.parse(JSON.parse(await fetchText(url)));
  const cidrs = data.prefixes.flatMap(
    (p) => p.ipv4Prefix ?? p.ipv6Prefix ?? []
  );
  return toRanges(cidrs, url);
};

const google = async (): Promise<IpRange[]> => {
  const [all, cloud] = await Promise.all([
    googlePrefixes("https://www.gstatic.com/ipranges/goog.json"),
    googlePrefixes("https://www.gstatic.com/ipranges/cloud.json"),
  ]);
  return subtractRanges(all, cloud);
};

const MicrosoftEndpoints = z.array(
  z.object({ ips: z.array(z.string()).optional(), serviceArea: z.string() })
);

const microsoft = async (): Promise<IpRange[]> => {
  const url = `https://endpoints.office.com/endpoints/worldwide?clientrequestid=${crypto.randomUUID()}`;
  const endpoints = MicrosoftEndpoints.parse(JSON.parse(await fetchText(url)));
  const cidrs = endpoints
    .filter((endpoint) => endpoint.serviceArea === "Exchange")
    .flatMap((endpoint) => endpoint.ips ?? []);
  return toRanges(cidrs, url);
};

const SPF_MECHANISM = /^(?<mechanism>[a-z\d]+):(?<value>.+)$/u;
const MAX_SPF_RECORDS = 20;

/** Collects the ip4:/ip6: mechanisms of an SPF record and of the records it includes. */
const spfCidrs = async (
  domain: string,
  seen: Set<string>
): Promise<string[]> => {
  if (seen.has(domain) || seen.size >= MAX_SPF_RECORDS) {
    return [];
  }
  seen.add(domain);
  // Mimecast splits its record over several TXT strings and records, so take every token.
  const records = await resolveTxt(domain);
  const mechanisms = records
    .flat()
    .join(" ")
    .split(/\s+/u)
    .map((token) => SPF_MECHANISM.exec(token)?.groups ?? {});
  const direct = mechanisms
    .filter(({ mechanism }) => mechanism === "ip4" || mechanism === "ip6")
    .map(({ value = "" }) => value);
  const included = await Promise.all(
    mechanisms
      .filter(({ mechanism }) => mechanism === "include")
      .map(async ({ value = "" }) => await spfCidrs(value, seen))
  );
  return [...direct, ...included.flat()];
};

const mimecast = async (): Promise<IpRange[]> =>
  toRanges(
    await spfCidrs("_netblocks.mimecast.com", new Set()),
    "_netblocks.mimecast.com"
  );

const SOURCES = {
  "apple-private-relay": apple,
  "google-services": google,
  "microsoft-exchange-online": microsoft,
  mimecast,
  "proofpoint-essentials": () =>
    toRanges(PROOFPOINT_ESSENTIALS, "Proofpoint Essentials"),
} satisfies Record<string, () => IpRange[] | Promise<IpRange[]>>;

const isSourceId = (id: string): id is keyof typeof SOURCES =>
  Object.hasOwn(SOURCES, id);

const entries = await Promise.all(
  PUBLISHED_NETWORKS.map(async ({ id }) => {
    if (!isSourceId(id)) {
      throw new Error(`no source for network ${id}`);
    }
    const cidrs = mergeRanges(await SOURCES[id]()).flatMap(rangeToCidrs);
    if (cidrs.length === 0) {
      throw new Error(`${id}: the source returned no ranges`);
    }
    console.log(`${id}: ${cidrs.length} blocks`);
    return [id, cidrs] as const;
  })
);
const ranges = Object.fromEntries(entries);

await Bun.write(
  OUTPUT,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), ranges }, null, 2)}\n`
);
console.log(`wrote ${OUTPUT.pathname}`);
