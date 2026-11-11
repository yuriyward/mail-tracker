import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  detailDataSchema,
  listDataSchema,
  peopleDataSchema,
  personDataSchema,
  personPath,
  personSchema,
} from "../dashboard-data";
import { createHarness, HOUR, minted } from "./harness";
import type { Harness } from "./harness";

const MINUTE = 60_000;
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

const mintedSets = minted.extend({
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.string(),
      links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
    })
  ),
});
type MintedSets = z.infer<typeof mintedSets>;

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const register = async (
  draftId: string,
  recipients: string[],
  extra: { links?: string[]; linkText?: Record<string, string> } = {}
): Promise<MintedSets> => {
  const response = await h.mint(
    JSON.stringify({
      draftId,
      linkText: extra.linkText ?? {},
      links: extra.links ?? ["https://cal.com/someone/30min"],
      recipient: recipients.join(", "),
      recipients,
      subject: `Subject ${draftId}`,
    })
  );
  expect(response.status).toBeOneOf([200, 201]);
  return mintedSets.parse(await response.json());
};

/** Registers, marks sent at the current clock and moves past the prefetch windows. */
const sendTo = async (
  draftId: string,
  recipients: string[]
): Promise<MintedSets & { sentAt: number }> => {
  const result = await register(draftId, recipients);
  const sentAt = h.state.clock;
  await h.markSent(result.token);
  h.state.clock += 10 * MINUTE;
  return { ...result, sentAt };
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
const app = async (route: string) =>
  await h.call(route, { headers: await owner() });
const appJson = async <S extends z.ZodType>(
  route: string,
  schema: S
): Promise<z.infer<S>> => {
  const response = await app(route);
  return schema.parse(await response.json());
};
const statusOf = async (response: Promise<Response>): Promise<number> => {
  const { status } = await response;
  return status;
};

describe("re-open signal", () => {
  test("a probable-human open an hour after the previous one marks the email, the recipient and the event", async () => {
    const email = await sendTo("<d1@example.test>", [
      "ann@example.com",
      "ben@example.net",
    ]);
    const ann = setOf(email, "ann@example.com");
    const ben = setOf(email, "ben@example.net");
    await h.hit(ann.imageUrl);
    h.state.clock += 30 * MINUTE;
    await h.hit(ann.imageUrl);
    // A Gmail proxy fetch after a gap does not resume anything.
    h.state.clock += 2 * HOUR;
    await h.hit(ann.imageUrl, { "User-Agent": GMAIL_PROXY });
    h.state.clock += HOUR;
    const reopenAt = h.state.clock;
    await h.hit(ann.imageUrl);
    // Ben opens once, after Ann's re-open: no re-open of his own.
    await h.hit(ben.imageUrl);

    const listed = await appJson("/app/data", listDataSchema);
    expect(listed.messages[0]).toMatchObject({
      addresses: ["ann@example.com", "ben@example.net"],
      lastReopen: reopenAt,
      reopens: 1,
    });
    const data = await appJson(
      `/app/messages/${email.token}/data`,
      detailDataSchema
    );
    expect(data.totals).toMatchObject({ lastReopen: reopenAt, reopens: 1 });
    expect(
      data.totals.recipients.map((r) => [r.address, r.reopens, r.lastReopen])
    ).toEqual([
      ["ann@example.com", 1, reopenAt],
      ["ben@example.net", 0, null],
    ]);
    expect(
      data.timeline.filter((e) => e.reopen).map((e) => [e.at, e.recipient])
    ).toEqual([[reopenAt, "ann@example.com"]]);

    const api = await h.read("/api/messages");
    expect(await api.json()).toMatchObject({
      messages: [{ last_reopen: reopenAt, reopens: 1, token: email.token }],
    });
  });

  test("opens less than an hour apart, or only one open, are no re-open", async () => {
    const email = await sendTo("<d2@example.test>", ["ann@example.com"]);
    const ann = setOf(email, "ann@example.com");
    for (const _ of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- hits happen in order.
      await h.hit(ann.imageUrl);
      h.state.clock += 59 * MINUTE;
    }
    const listed = await appJson("/app/data", listDataSchema);
    expect(listed.messages[0]).toMatchObject({ lastReopen: null, reopens: 0 });
  });
});

describe("people", () => {
  /** Ann gets two emails and opens both; Ben gets one and only clicks it. */
  const scenario = async () => {
    const first = await sendTo("<p1@example.test>", [
      "ann@example.com",
      "ben@example.net",
    ]);
    await h.hit(setOf(first, "ann@example.com").imageUrl);
    h.state.clock += 2 * HOUR;
    const annReopen = h.state.clock;
    await h.hit(setOf(first, "ann@example.com").imageUrl);
    h.state.clock += HOUR;
    const benClick = h.state.clock;
    await h.hit(setOf(first, "ben@example.net").links[0]?.redirectUrl);
    h.state.clock += HOUR;
    const second = await sendTo("<p2@example.test>", ["Ann@Example.com"]);
    h.state.clock += 20 * MINUTE;
    const annLastOpen = h.state.clock;
    await h.hit(setOf(second, "ann@example.com").imageUrl);
    // Registered but never sent and without events: not on any list.
    await register("<p3@example.test>", ["ann@example.com", "cy@example.org"]);
    return { annLastOpen, annReopen, benClick, first, second };
  };

  test("one row per address across emails, newest activity first", async () => {
    const s = await scenario();
    const { people } = await appJson("/app/people/data", peopleDataSchema);
    expect(people).toEqual([
      {
        address: "ann@example.com",
        emails: 2,
        lastActivity: s.annLastOpen,
        lastClick: null,
        lastOpen: s.annLastOpen,
        lastReopen: s.annReopen,
        lastSent: s.second.sentAt,
        // First opens 10 and 30 minutes after sending.
        medianFirstOpen: 20 * MINUTE,
        opened: 2,
        reopens: 1,
      },
      {
        address: "ben@example.net",
        emails: 1,
        lastActivity: s.benClick,
        lastClick: s.benClick,
        lastOpen: null,
        lastReopen: null,
        lastSent: s.first.sentAt,
        medianFirstOpen: null,
        opened: 1,
        reopens: 0,
      },
    ]);
    const api = await h.read("/api/people");
    expect(
      z.object({ people: z.array(personSchema) }).parse(await api.json())
    ).toEqual({ people });
  });

  test("a person's page lists their emails with their own figures", async () => {
    const s = await scenario();
    const data = await appJson(
      `${personPath("Ann@example.com")}/data`,
      personDataSchema
    );
    expect(data.person.address).toBe("ann@example.com");
    expect(data.emails.map((e) => [e.token, e.opens, e.reopens])).toEqual([
      [s.second.token, 1, 0],
      [s.first.token, 2, 1],
    ]);
    const api = await h.read("/api/people/ann%40example.com");
    expect(await api.json()).toMatchObject({
      emails: data.emails,
      person: data.person,
    });
  });

  test("unknown people, unlisted emails and non-addresses have no page", async () => {
    await scenario();
    for (const route of [
      `${personPath("nobody@example.com")}/data`,
      `${personPath("cy@example.org")}/data`,
      "/app/people/data/data",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      const response = await app(route);
      expect(response.status).toBe(404);
    }
    expect(await statusOf(h.read("/api/people/nobody"))).toBe(404);
  });

  test("the people pages need Access and the people API the read token", async () => {
    for (const route of [
      "/app/people",
      "/app/people/data",
      `${personPath("ann@example.com")}/data`,
      "/api/people",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      expect(await statusOf(h.call(route))).toBe(401);
    }
    expect(await statusOf(app("/app/people"))).toBe(200);
    expect(await statusOf(app(personPath("ann@example.com")))).toBe(200);
  });
});

describe("link names", () => {
  test("the link's text from registration names it; without text, the domain does", async () => {
    const links = [
      "https://cal.com/someone/30min",
      "https://www.linkedin.com/in/someone",
      "https://github.com/example",
    ] as const;
    const email = await register("<l1@example.test>", ["ann@example.com"], {
      linkText: {
        // A URL-like text is no name; text for a link not registered is dropped.
        "https://cal.com/someone/30min": "  Book\n a call ",
        "https://example.org/not-registered": "ignored",
        "https://github.com/example": "https://github.com/example",
      },
      links: [...links],
    });
    await h.markSent(email.token);
    h.state.clock += HOUR;
    await h.hit(setOf(email, "ann@example.com").links[0]?.redirectUrl);
    const data = await appJson(
      `/app/messages/${email.token}/data`,
      detailDataSchema
    );
    expect(data.totals.clicks.links.map((l) => [l.name, l.url])).toEqual([
      ["Book a call", links[0]],
      ["linkedin.com", links[1]],
      ["github.com", links[2]],
    ]);
    expect(data.timeline.map((e) => [e.linkName, e.url])).toEqual([
      ["Book a call", links[0]],
    ]);
    const api = await h.read(`/api/messages/${email.token}`);
    expect(await api.json()).toMatchObject({
      links: [
        { name: "Book a call", text: "Book a call" },
        { name: "linkedin.com", text: "" },
        { name: "github.com", text: "" },
      ],
    });
  });

  test("a later registration without text keeps the stored text; new text replaces it", async () => {
    const url = "https://cal.com/someone/30min";
    const texts = () =>
      h
        .rows("SELECT text FROM links")
        .map((r) => z.object({ text: z.string() }).parse(r).text);
    await register("<l2@example.test>", ["ann@example.com"], {
      linkText: { [url]: "Book a call" },
      links: [url],
    });
    await register("<l2@example.test>", ["ann@example.com"], { links: [url] });
    expect(texts()).toEqual(["Book a call"]);
    await register("<l2@example.test>", ["ann@example.com"], {
      linkText: { [url]: "Pick a time" },
      links: [url],
    });
    expect(texts()).toEqual(["Pick a time"]);
  });
});
