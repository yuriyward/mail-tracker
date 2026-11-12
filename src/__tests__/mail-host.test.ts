import { expect, test } from "bun:test";

import { z } from "zod";

import { eventDisplay } from "../classify";
import { detailDataSchema } from "../dashboard-data";
import { resolveMailHost, tokenSetHosts } from "../mail-host";
import {
  countedOpens,
  messageDetail,
  listMessages,
  recipientActivity,
} from "../store";
import { createHarness, HOUR, START } from "./harness";

const dnsFetch = (
  body: { Status?: number; Answer?: readonly { data: string; type: number }[] },
  status = 200
): typeof fetch =>
  Object.assign(
    async () => await Promise.resolve(Response.json(body, { status })),
    { preconnect: () => {} }
  );

test.each([
  ["10 aspmx.l.google.com.", "google"],
  ["1 smtp.google.com.", "google"],
  ["10 alt1.aspmx.l.googlemail.com.", "google"],
  ["10 mx.example.test.", "other"],
  ["10 notgoogle.com.", "other"],
  ["0 .", "unknown"],
  ["invalid", "unknown"],
] as const)("MX %s is %s", async (data, expected) => {
  expect(
    await resolveMailHost(
      "example.test",
      dnsFetch({ Answer: [{ data, type: 15 }], Status: 0 })
    )
  ).toBe(expected);
});

test.each([
  { Status: 0 },
  { Status: 2 },
  {},
  { Answer: [{ data: "alias.test", type: 5 }], Status: 0 },
])("unknown MX response %j", async (body) => {
  expect(await resolveMailHost("example.test", dnsFetch(body))).toBe("unknown");
});

test("HTTP failure", async () => {
  expect(await resolveMailHost("example.test", dnsFetch({}, 503))).toBe(
    "unknown"
  );
});

test("DoH request and timeout fail unknown", async () => {
  const fetcher: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(input instanceof URL ? input.href : input).toBe(
        "https://cloudflare-dns.com/dns-query?name=example.test&type=MX"
      );
      expect(init?.headers).toEqual({ Accept: "application/dns-json" });
      // The mock waits for the real request timeout signal.
      // oxlint-disable-next-line promise/avoid-new
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("timeout"));
        });
      });
      return new Response();
    },
    { preconnect: () => {} }
  );
  expect(await resolveMailHost("example.test", fetcher, 5)).toBe("unknown");
});

test.each(["other", "google", "unknown"] as const)(
  "shared sets: %s; resolve each domain once",
  async (host) => {
    const calls: string[] = [];
    const result = await tokenSetHosts(
      ["a@one.test", "b@one.test", "c@two.test"],
      true,
      async (domain) => {
        calls.push(domain);
        return await Promise.resolve(domain === "one.test" ? "other" : host);
      }
    );
    expect(calls).toEqual(["one.test", "two.test"]);
    expect(result.get("")).toBe(host);
  }
);

const registered = z.object({
  recipients: z.array(z.object({ imageUrl: z.string() })),
  token: z.string(),
});

test.each([
  [false, "other"],
  [false, "google"],
  [false, "unknown"],
  [true, "other"],
  [true, "google"],
  [true, "unknown"],
] as const)("read-time Gmail self: shared %s host %s", async (shared, host) => {
  const h = await createHarness(
    async (domain) =>
      await Promise.resolve(domain === "one.test" ? "other" : host)
  );
  const response = await h.mint(
    JSON.stringify({
      draftId: "synthetic-draft",
      draftTracked: true,
      recipients: shared ? ["a@one.test", "b@two.test"] : ["b@two.test"],
      shared,
    })
  );
  const result = registered.parse(await response.json());
  const image = result.recipients[0]?.imageUrl;
  const headers = {
    "User-Agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
  };
  h.state.clock = START + HOUR;
  await h.hit(image, headers);
  h.state.clock = START + 2 * HOUR;
  await h.markSent(result.token, START + 2 * HOUR);
  h.state.clock = START + 3 * HOUR;
  await h.hit(image, headers);
  const detail = await messageDetail(h.env.DB, result.token);
  expect(detail?.events.map(eventDisplay).map((e) => e.label)).toEqual([
    "Draft preview",
    host === "other" ? "You (Gmail)" : "Opened",
  ]);
  const dashboardResponse = await h.call(`/app/messages/${result.token}/data`, {
    headers: { "Cf-Access-Jwt-Assertion": await h.accessJwt() },
  });
  const dashboard = detailDataSchema.parse(await dashboardResponse.json());
  expect(dashboard.timeline.map((e) => e.label)).toEqual(
    detail?.events.map(eventDisplay).map((e) => e.label) ?? []
  );
  expect(dashboard.totals.opens.counted).toBe(host === "other" ? 0 : 1);
  expect(dashboard.totals.reopens).toBe(0);
  expect(
    dashboard.timeline.every((e) => e.hint === null && e.preloadHint === null)
  ).toBe(true);
  expect(detail?.events[1]?.class).toBe(host === "other" ? "self" : "proxy");
  expect(h.events().map((e) => [e.class, e.counted])).toEqual([
    ["proxy", 1],
    ["proxy", 1],
  ]);
  const expected = host === "other" ? 0 : 1;
  const summaries = await listMessages(h.env.DB, 10);
  const opens = await countedOpens(h.env.DB);
  const activity = await recipientActivity(h.env.DB);
  expect(summaries[0]?.opens).toBe(expected);
  expect(summaries[0]?.first_open).toBe(expected ? START + 3 * HOUR : null);
  expect(opens.length).toBe(expected);
  if (!shared) {
    expect(activity[0]?.opens).toBe(expected);
  }
});
