import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { eventDisplay } from "../classify";
import { detailDataSchema, listDataSchema } from "../dashboard-data";
import { createHarness, HOUR, minted, START } from "./harness";
import type { Harness } from "./harness";

const PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const HOME = { asOrganization: "Example Broadband", country: "DE" };
const OFFICE = { asOrganization: "Example Office Net", country: "FR" };

const registered = minted.extend({
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.string(),
      links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
    })
  ),
});

const apiDetail = z.object({
  events: z.array(
    z.object({
      counted: z.number(),
      hint: z.string().nullable(),
      label: z.string(),
      preview: z.number(),
    })
  ),
  recipients: z.array(z.object({ clicks: z.number(), opens: z.number() })),
});

const peopleSchema = z.object({
  people: z.array(z.object({ address: z.string(), opened: z.number() })),
});

const apiList = z.object({
  messages: z.array(
    z.object({ clicks: z.number(), opened_by: z.number(), opens: z.number() })
  ),
});

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

/** Registers a draft that carries tracking (as `bun run compose` does), or one that does not. */
const register = async (draftTracked = true) => {
  const response = await h.mint(
    JSON.stringify({
      draftId: "<compose-1@example.test>",
      draftTracked,
      links: ["https://example.org/deck"],
      recipient: "alex@example.com",
      recipients: ["alex@example.com"],
      subject: "Proposal",
    })
  );
  const result = registered.parse(await response.json());
  const [set] = result.recipients;
  if (!set) {
    throw new Error("no token set");
  }
  return { set, token: result.token };
};

/** The JSON body of a response, parsed with `schema`. */
const json = async <S extends z.ZodType>(
  schema: S,
  pending: Promise<Response>
): Promise<z.infer<S>> => {
  const response = await pending;
  return schema.parse(await response.json());
};

const readDetail = async (token: string) =>
  await json(apiDetail, h.read(`/api/messages/${token}`));

/** Labels and `counted` of the read API's events, in order. */
const labels = async (token: string) => {
  const detail = await readDetail(token);
  return detail.events.map((e) => [e.label, e.counted]);
};

/** Opens, clicks and opened-by of each listed email. */
const listed = async () => {
  const list = await json(apiList, h.read("/api/messages"));
  return list.messages.map((m) => [m.opens, m.clicks, m.opened_by]);
};

const owner = async () => ({
  "Cf-Access-Jwt-Assertion": await h.accessJwt(),
});

const dashboardDetail = async (token: string) =>
  await json(
    detailDataSchema,
    h.call(`/app/messages/${token}/data`, { headers: await owner() })
  );

describe("draft preview: hits on a draft that carries tracking, before it is sent", () => {
  test("while unsent: kept raw, labelled Draft preview, never counted", async () => {
    const { set, token } = await register();
    h.state.clock = START + HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    await h.hit(set.links[0]?.redirectUrl, { "User-Agent": PHONE }, HOME);
    // The raw rows are as classified.
    expect(h.events().map((e) => [e.kind, e.class, e.counted])).toEqual([
      ["open", "human", 1],
      ["click", "human", 1],
    ]);
    const detail = await readDetail(token);
    expect(detail.events.map((e) => [e.label, e.counted, e.preview])).toEqual([
      ["Draft preview", 0, 1],
      ["Draft preview", 0, 1],
    ]);
    expect(detail.recipients.map((r) => [r.opens, r.clicks])).toEqual([[0, 0]]);
    // Listed (it has events), with nothing counted.
    expect(await listed()).toEqual([[0, 0, 0]]);
    const data = await dashboardDetail(token);
    expect(data.timeline.map((e) => [e.label, e.counted])).toEqual([
      ["Draft preview", false],
      ["Draft preview", false],
    ]);
    expect(data.totals.opens.counted).toBe(0);
    expect(data.totals.clicks.counted).toBe(0);
    const people = await json(peopleSchema, h.read("/api/people"));
    expect(people.people.map((p) => [p.address, p.opened])).toEqual([
      ["alex@example.com", 0],
    ]);
  });

  test("after sent_at is set, earlier hits stay Draft preview and later ones count", async () => {
    const { set, token } = await register();
    h.state.clock = START + HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    h.state.clock = START + 2 * HOUR;
    const marked = await h.markSent(token, START + 2 * HOUR);
    expect(marked.status).toBe(204);
    h.state.clock = START + 3 * HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    expect(await labels(token)).toEqual([
      ["Draft preview", 0],
      ["Opened", 1],
    ]);
    expect(await listed()).toEqual([[1, 0, 1]]);
    const data = await dashboardDetail(token);
    expect(data.totals.firstOpen).toBe(START + 3 * HOUR);
  });

  test("a recipient's open while the email was not marked sent yet counts once sync-sent reports the earlier send", async () => {
    const { set, token } = await register();
    // Sent from the phone at +1h; the recipient opens at +2h; sync-sent runs at +3h.
    h.state.clock = START + 2 * HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    expect(await labels(token)).toEqual([["Draft preview", 0]]);
    h.state.clock = START + 3 * HOUR;
    await h.markSent(token, START + HOUR);
    expect(await labels(token)).toEqual([["Opened", 1]]);
  });

  test("a draft preview from another network does not make the recipient's opens look forwarded", async () => {
    const { set, token } = await register();
    h.state.clock = START + HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, OFFICE);
    h.state.clock = START + 2 * HOUR;
    await h.markSent(token, START + 2 * HOUR);
    h.state.clock = START + 3 * HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    h.state.clock = START + 5 * HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    const detail = await readDetail(token);
    expect(detail.events.map((e) => e.hint)).toEqual([null, null, null]);
    // The second open after send, two hours on, is a re-open; the preview is not part of it.
    const list = await json(
      listDataSchema,
      h.call("/app/data", { headers: await owner() })
    );
    expect(list.messages[0]?.reopens).toBe(1);
  });

  test("a draft written in Mailspring (the image only added at send) keeps counting while unsent", async () => {
    const { set, token } = await register(false);
    h.state.clock = START + HOUR;
    await h.hit(set.imageUrl, { "User-Agent": PHONE }, HOME);
    expect(await labels(token)).toEqual([["Opened", 1]]);
  });

  test("the flag stays set when a later registration (the plugin's) does not send it", async () => {
    const { token } = await register(true);
    await register(false);
    expect(h.rows("SELECT token, draft_tracked FROM messages")).toEqual([
      { draft_tracked: 1, token },
    ]);
  });

  test("the label wins over every class", () => {
    for (const eventClass of ["human", "proxy", "scanner", "self"] as const) {
      expect(
        eventDisplay({
          class: eventClass,
          kind: "open",
          preview: 1,
          reason: "x",
        })
      ).toEqual({ label: "Draft preview", via: null });
    }
  });
});
