import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { detailDataSchema, listDataSchema } from "../dashboard-data";
import { HINT_PREFIX } from "../forwarding";
import { createHarness, HOUR, minted } from "./harness";
import type { Harness } from "./harness";

const DRAFT = "<draft-r@example.test>";
const PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const HOME = { asOrganization: "Example Broadband", country: "DE" };

const mintedSets = minted.extend({
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.string(),
      links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
    })
  ),
  shared: z.boolean(),
});
type MintedSets = z.infer<typeof mintedSets>;

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const register = async (
  recipients: string[],
  options: { shared?: boolean; links?: string[] } = {}
): Promise<MintedSets> => {
  const response = await h.mint(
    JSON.stringify({
      draftId: DRAFT,
      links: options.links ?? ["https://example.org/a"],
      recipient: recipients.join(", "),
      recipients,
      shared: options.shared ?? false,
      subject: "Proposal",
    })
  );
  expect(response.status).toBeOneOf([200, 201]);
  return mintedSets.parse(await response.json());
};

const setOf = (result: MintedSets, address: string) => {
  const set = result.recipients.find((r) => r.address === address);
  if (!set) {
    throw new Error(`no set for ${address}`);
  }
  return set;
};

const owner = async () => ({
  "Cf-Access-Jwt-Assertion": await h.accessJwt(),
});

const detail = async (token: string) => {
  const response = await h.call(`/app/messages/${token}/data`, {
    headers: await owner(),
  });
  return detailDataSchema.parse(await response.json());
};

/** Registers, marks sent, and moves the clock past every prefetch window. */
const sentTo = async (
  recipients: string[],
  shared = false
): Promise<MintedSets> => {
  const result = await register(recipients, { shared });
  await h.markSent(result.token);
  h.state.clock += HOUR;
  return result;
};

describe("POST /api/messages with recipients", () => {
  test("mints one token set per distinct address, with no address in any URL", async () => {
    const result = await register([
      "alex@example.com",
      "Sam@Example.net",
      "ALEX@example.com",
    ]);
    expect(result.shared).toBe(false);
    expect(result.recipients.map((r) => r.address)).toEqual([
      "alex@example.com",
      "sam@example.net",
    ]);
    const urls = result.recipients.flatMap((r) => [
      r.imageUrl,
      ...r.links.map((l) => l.redirectUrl),
    ]);
    expect(new Set(urls).size).toBe(4);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/track\.example\.test\/[il]\/[\w-]{22}(?:\.png)?$/u
      );
      expect(url.toLowerCase()).not.toMatch(
        /alex|sam|example\.(?:com|net|org)\//u
      );
    }
    expect(setOf(result, "alex@example.com").imageUrl).toEndWith(".png");
  });

  test("re-registering keeps each recipient's tokens, adds new links and retires removed recipients", async () => {
    const first = await register(["alex@example.com", "sam@example.net"]);
    const second = await register(["alex@example.com", "kim@example.org"], {
      links: ["https://example.org/a", "https://example.org/b"],
    });
    expect(second.token).toBe(first.token);
    const alexBefore = setOf(first, "alex@example.com");
    const alexAfter = setOf(second, "alex@example.com");
    expect(alexAfter.imageUrl).toBe(alexBefore.imageUrl);
    expect(alexAfter.links[0]).toEqual(alexBefore.links[0]);
    expect(alexAfter.links.map((l) => l.url)).toEqual([
      "https://example.org/a",
      "https://example.org/b",
    ]);
    expect(second.recipients.map((r) => r.address)).toEqual([
      "alex@example.com",
      "kim@example.org",
    ]);
    expect(
      h.rows("SELECT address, current FROM recipients ORDER BY position")
    ).toEqual([
      { address: "alex@example.com", current: 1 },
      { address: "sam@example.net", current: 0 },
      { address: "kim@example.org", current: 1 },
    ]);
  });

  test("a shared body (Graph) gets one set: unknown recipient for several, the address for one", async () => {
    const several = await register(["alex@example.com", "sam@example.net"], {
      shared: true,
    });
    expect(several.shared).toBe(true);
    expect(several.recipients.map((r) => r.address)).toEqual([""]);
    expect(h.rows("SELECT shared FROM messages")).toEqual([{ shared: 1 }]);
    const response = await h.mint(
      JSON.stringify({
        draftId: "<one@example.test>",
        recipients: ["alex@example.com"],
        shared: true,
      })
    );
    const one = mintedSets.parse(await response.json());
    expect(one.recipients.map((r) => r.address)).toEqual(["alex@example.com"]);
  });

  test("rejects too many or overlong recipients", async () => {
    const tooMany = await h.mint(
      JSON.stringify({
        draftId: DRAFT,
        recipients: Array.from({ length: 101 }, (_, i) => `r${i}@example.com`),
      })
    );
    expect(tooMany.status).toBe(400);
    const tooLong = await h.mint(
      JSON.stringify({ draftId: DRAFT, recipients: [`${"a".repeat(320)}@x`] })
    );
    expect(tooLong.status).toBe(400);
  });
});

describe("events per recipient", () => {
  test("opens and clicks are recorded against the recipient's token set", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"]);
    const alex = setOf(result, "alex@example.com");
    const sam = setOf(result, "sam@example.net");
    await h.hit(alex.imageUrl);
    await h.hit(sam.links[0]?.redirectUrl);
    const redirect = await h.hit(sam.links[0]?.redirectUrl);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("https://example.org/a");
    const recipientOf = new Map(
      z
        .array(z.object({ address: z.string(), token: z.string() }))
        .parse(h.rows("SELECT address, token FROM recipients"))
        .map((r) => [r.token, r.address])
    );
    expect(
      h.events().map((e) => [e.kind, recipientOf.get(e.recipient_token ?? "")])
    ).toEqual([
      ["open", "alex@example.com"],
      ["click", "sam@example.net"],
      ["click", "sam@example.net"],
    ]);
    // Every click still names the destination link, for the per-link figures.
    const linkTokens = h.rows("SELECT token FROM links");
    expect(linkTokens).toHaveLength(1);
    expect(h.events()[1]?.link_token).toBe(
      String(Object.values(linkTokens[0] ?? {})[0])
    );
  });

  test("the same client on two recipients' images within 30 s is not a repeat", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"]);
    await h.hit(setOf(result, "alex@example.com").imageUrl);
    await h.hit(setOf(result, "sam@example.net").imageUrl);
    expect(h.events().map((e) => e.duplicate)).toEqual([0, 0]);
  });

  test("message-level image URLs from before still record, with and without a suffix", async () => {
    const result = await sentTo(["alex@example.com"]);
    await h.hit(`/i/${result.token}`);
    h.state.clock += HOUR;
    await h.hit(`/i/${result.token}.gif`);
    expect(h.events().map((e) => [e.kind, e.recipient_token])).toEqual([
      ["open", null],
      ["open", null],
    ]);
  });

  test("the dashboard and the read API show figures per recipient", async () => {
    const result = await sentTo([
      "alex@example.com",
      "sam@example.net",
      "kim@example.org",
    ]);
    await h.hit(setOf(result, "alex@example.com").imageUrl);
    h.state.clock += HOUR;
    const alexOpen = h.state.clock;
    await h.hit(setOf(result, "alex@example.com").imageUrl);
    await h.hit(setOf(result, "sam@example.net").links[0]?.redirectUrl);
    const data = await detail(result.token);
    expect(
      data.totals.recipients.map((r) => [
        r.address,
        r.opens,
        r.clicks,
        r.lastOpen,
      ])
    ).toEqual([
      ["alex@example.com", 2, 0, alexOpen],
      ["sam@example.net", 0, 1, null],
      ["kim@example.org", 0, 0, null],
    ]);
    expect(data.timeline.map((e) => e.recipient)).toEqual([
      "alex@example.com",
      "alex@example.com",
      "sam@example.net",
    ]);
    const listResponse = await h.call("/app/data", { headers: await owner() });
    const listed = listDataSchema.parse(await listResponse.json());
    expect(listed.messages[0]).toMatchObject({
      openedBy: 2,
      recipients: 3,
      shared: false,
    });
    const api = await h.read(`/api/messages/${result.token}`);
    const body = z
      .object({
        events: z.array(z.object({ hint: z.string().nullable() })),
        recipients: z.array(
          z.object({ address: z.string(), opens: z.number() })
        ),
      })
      .parse(await api.json());
    expect(body.recipients.map((r) => [r.address, r.opens])).toEqual([
      ["alex@example.com", 2],
      ["sam@example.net", 0],
      ["kim@example.org", 0],
    ]);
    expect(body.events.map((e) => e.hint)).toEqual([null, null, null]);
  });

  test("'Opened by' counts only current recipients; removed ones with activity stay on the email page", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"]);
    await h.hit(setOf(result, "alex@example.com").imageUrl);
    await h.hit(setOf(result, "sam@example.net").imageUrl);
    // Sam is removed from the draft and it is registered again.
    await register(["alex@example.com"]);
    const listResponse = await h.call("/app/data", { headers: await owner() });
    const listed = listDataSchema.parse(await listResponse.json());
    expect(listed.messages[0]).toMatchObject({ openedBy: 1, recipients: 1 });
    const data = await detail(result.token);
    expect(
      data.totals.recipients.map((r) => [r.address, r.current, r.opens])
    ).toEqual([
      ["alex@example.com", true, 1],
      ["sam@example.net", false, 1],
    ]);
  });

  test("a shared copy is shown as recipient unknown", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"], true);
    await h.hit(setOf(result, "").imageUrl);
    const data = await detail(result.token);
    expect(data.message.shared).toBe(true);
    expect(data.totals.recipients.map((r) => [r.address, r.opens])).toEqual([
      ["", 1],
    ]);
  });
});

describe("forwarding hint", () => {
  test("flags a later human event from another network, country or device, with the reason", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"]);
    const alex = setOf(result, "alex@example.com");
    await h.hit(alex.imageUrl, {}, HOME);
    h.state.clock += HOUR;
    // The same reader again: no hint.
    await h.hit(alex.links[0]?.redirectUrl, {}, HOME);
    h.state.clock += HOUR;
    await h.hit(
      alex.imageUrl,
      { "User-Agent": PHONE },
      { asOrganization: "Other Telecom", country: "FR" }
    );
    // Sam's first event is Sam's own baseline, whatever Alex's was.
    await h.hit(
      setOf(result, "sam@example.net").imageUrl,
      {},
      { asOrganization: "Other Telecom", country: "FR" }
    );
    const data = await detail(result.token);
    expect(data.timeline.map((e) => e.hint)).toEqual([
      null,
      null,
      `${HINT_PREFIX}: network Other Telecom (first: Example Broadband); country FR (first: DE); device phone (first: computer)`,
      null,
    ]);
    expect(data.totals.recipients.map((r) => [r.address, r.hints])).toEqual([
      ["alex@example.com", 1],
      ["sam@example.net", 0],
    ]);
    // A hint, not a fact: the event is still counted as the recipient's open.
    expect(data.totals.recipients[0]?.opens).toBe(2);
  });

  test("a shared copy to several recipients gets no hint", async () => {
    const result = await sentTo(["alex@example.com", "sam@example.net"], true);
    const shared = setOf(result, "");
    await h.hit(shared.imageUrl, {}, HOME);
    h.state.clock += HOUR;
    await h.hit(shared.imageUrl, { "User-Agent": PHONE }, { country: "FR" });
    const data = await detail(result.token);
    expect(data.timeline.map((e) => e.hint)).toEqual([null, null]);
  });
});
