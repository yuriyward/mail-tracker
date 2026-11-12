import { z } from "zod";

import { normaliseAddress, tokenSetAddresses } from "./recipients";

export type MailHost = "google" | "other" | "unknown";
export type HostLookup = (domain: string) => Promise<MailHost>;

const answer = z.object({
  Answer: z.array(z.object({ data: z.string(), type: z.number() })).optional(),
  Status: z.number(),
});

/** A bounded MX lookup; absent, malformed and failed answers remain unknown. */
export const resolveMailHost = async (
  domain: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2000
): Promise<MailHost> => {
  try {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", domain);
    url.searchParams.set("type", "MX");
    const response = await fetcher(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return "unknown";
    }
    const result = answer.parse(await response.json());
    const mx = (result.Answer ?? []).filter((row) => row.type === 15);
    if (result.Status !== 0 || mx.length === 0) {
      return "unknown";
    }
    const hosts = mx.map((row) =>
      /^\d+\s+(?<host>[a-z0-9.-]+)\.?$/iu
        .exec(row.data)
        ?.groups?.host?.toLowerCase()
        .replace(/\.$/u, "")
    );
    if (
      hosts.some((host) => host === undefined || host === "" || host === ".")
    ) {
      return "unknown";
    }
    return hosts.some((host) =>
      /(?:^|\.)(?:google\.com|googlemail\.com)$/u.test(host ?? "")
    )
      ? "google"
      : "other";
  } catch {
    return "unknown";
  }
};

/** Resolve each domain once, including all members of a shared copy. */
export const tokenSetHosts = async (
  recipients: readonly string[],
  shared: boolean,
  lookup: HostLookup
): Promise<Map<string, MailHost>> => {
  const addresses = [...new Set(recipients.map(normaliseAddress))].filter(
    Boolean
  );
  const domains = [
    ...new Set(addresses.map((address) => address.split("@")[1] ?? "")),
  ];
  const hosts = new Map(
    await Promise.all(
      domains.map(
        async (domain) =>
          [
            domain,
            domain === "" ? ("unknown" as const) : await lookup(domain),
          ] as const
      )
    )
  );
  const of = (address: string): MailHost =>
    hosts.get(address.split("@")[1] ?? "") ?? "unknown";
  const all = addresses.map(of);
  let combined: MailHost = "unknown";
  if (all.includes("google")) {
    combined = "google";
  } else if (all.length > 0 && all.every((host) => host === "other")) {
    combined = "other";
  }
  return new Map(
    tokenSetAddresses(recipients, shared).map((address) => [
      address,
      address === "" ? combined : of(address),
    ])
  );
};
