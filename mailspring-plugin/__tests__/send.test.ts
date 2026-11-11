import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

import { BROWSER, ORIGIN, READ_TOKEN } from "../../src/__tests__/harness";
import { lookup } from "../src/registry";
import type { TokenSet } from "../src/registry";
import {
  BODY,
  createFixture,
  draft,
  DRAFT_ID,
  hrefs,
  images,
  parse,
  paths,
} from "./fixture";
import type { Fixture } from "./fixture";
import { forSending } from "./send-draft-task";

const RECIPIENTS = ["alex@example.com", "sam@example.net", "boss@example.net"];

let f: Fixture;

const knownTokens = (table: "recipient_links" | "messages"): string[] =>
  f.h
    .rows(`SELECT token FROM ${table}`)
    .map((row) => String(Object.values(row ?? {})[0]));

/** The token set registered for `address` ('' for a shared one). */
const setFor = (address: string): TokenSet => {
  const set = lookup(f.config, DRAFT_ID)?.recipients[address];
  if (!set) {
    throw new Error(`no token set for ${address || "the shared copy"}`);
  }
  return set;
};

const detailSchema = z.object({
  message: z.object({ shared: z.number(), token: z.string() }),
  recipients: z.array(
    z.object({ address: z.string(), clicks: z.number(), opens: z.number() })
  ),
});

/** The read API's per-recipient figures for the draft's message. */
const recipientFigures = async () => {
  const token = lookup(f.config, DRAFT_ID)?.token ?? "";
  const response = await f.h.call(`/api/messages/${token}`, {
    headers: { Authorization: `Bearer ${READ_TOKEN}` },
  });
  return detailSchema.parse(await response.json());
};

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  f = await createFixture();
});

describe("send through Mailspring's synchronous caller", () => {
  test("each recipient gets a body with their own tokens, and the Sent copy is clean", async () => {
    await f.compose();
    const task = f.send();
    expect(task.returned.every((value) => value === undefined)).toBe(true);
    const bodies = task.perRecipientBodies ?? {};
    expect(Object.keys(bodies)).toEqual(["self", ...RECIPIENTS]);
    // The owner's Sent copy is the draft as written.
    expect(bodies.self).toBe(BODY);
    const entry = lookup(f.config, DRAFT_ID);
    expect(entry?.shared).toBe(false);
    expect(Object.keys(entry?.recipients ?? {}).toSorted()).toEqual(
      RECIPIENTS.toSorted()
    );
    for (const email of RECIPIENTS) {
      const html = bodies[email] ?? "";
      const set = setFor(email);
      expect(hrefs(html)).toEqual([
        set.links["https://example.org/deck"] ?? null,
        set.links["https://example.org/pricing?plan=a&b=1"] ?? null,
        "mailto:me@example.com",
        "http://example.org/old",
        "/relative",
        "https://127.0.0.1/",
        null,
        "https://example.org/quoted",
      ]);
      // The quoted old pixel is gone; the new one sits before the quote.
      expect(images(html)).toEqual([
        set.imageUrl,
        "https://example.org/logo.png",
      ]);
      expect(html).not.toContain("data-mail-tracker");
    }
    // No two recipients share an image or a redirect token.
    const urls = RECIPIENTS.flatMap((email) => [
      setFor(email).imageUrl,
      ...Object.values(setFor(email).links),
    ]);
    expect(new Set(urls).size).toBe(RECIPIENTS.length * 3);
    // One message row for the draft; nothing marked sent yet.
    expect(knownTokens("messages")).toEqual([entry?.token ?? ""]);
    expect(paths(f.requests)).toEqual(["/api/messages"]);
    expect(f.logs).toEqual([]);
  });

  test("every rewritten link points at a token the Worker knows; late links stay as written", async () => {
    await f.compose();
    const edited = draft({
      body: `${BODY}<p><a href="https://example.org/late">late</a></p>`,
    });
    const task = f.send(edited);
    const html = task.perRecipientBodies?.["alex@example.com"] ?? "";
    const tracked = hrefs(html).filter(
      (href) => href?.startsWith(`${ORIGIN}/l/`) === true
    );
    expect(tracked).toHaveLength(2);
    for (const href of tracked) {
      expect(knownTokens("recipient_links")).toContain(
        new URL(href ?? "").pathname.slice(3)
      );
    }
    expect(hrefs(html)).toContain("https://example.org/late");
  });

  test("a bare URL typed as text is registered and tracked; the Sent copy keeps the text", async () => {
    const typed = draft({
      body: "<p>Slides: https://example.org/slides.</p><blockquote>https://example.org/old</blockquote>",
    });
    await f.compose(typed);
    const set = setFor("alex@example.com");
    expect(Object.keys(set.links)).toEqual(["https://example.org/slides"]);
    const task = f.send(typed);
    const html = task.perRecipientBodies?.["alex@example.com"] ?? "";
    const redirect = set.links["https://example.org/slides"] ?? "";
    expect(redirect).toStartWith(`${ORIGIN}/l/`);
    expect(html).toContain(
      `<a href="${redirect}">https://example.org/slides</a>.`
    );
    expect(html).toContain("<blockquote>https://example.org/old</blockquote>");
    expect(task.perRecipientBodies?.self).toBe(typed.body ?? "");
    expect(f.logs).toEqual([]);
  });

  test("warns once when the registration does not match the draft as sent", async () => {
    await f.compose();
    f.send(
      draft({
        body: `${BODY}<p><a href="https://example.org/late">late</a></p>`,
        subject: "Proposal (final)",
      })
    );
    expect(f.logs).toEqual([
      "sending with an older registration: 1 link(s) added after registration stay untracked; subject changed after registration; the Worker keeps the registered one",
    ]);
  });

  test("a draft never registered is sent as written, with no separate bodies", () => {
    const task = f.send();
    expect(task.perRecipientBodies).toBeNull();
    expect(task.body).toBe(parse(BODY).innerHTML);
    expect(f.requests).toHaveLength(0);
  });

  test("the pixel is marked up like Mailspring's: empty alt, .png, no size or class, before the quote", async () => {
    await f.compose();
    const html = f.send().perRecipientBodies?.["sam@example.net"] ?? "";
    const { imageUrl } = setFor("sam@example.net");
    expect(imageUrl).toMatch(new RegExp(`^${ORIGIN}/i/[\\w-]{22}\\.png$`, "u"));
    expect(html).toContain(
      `<img alt="" src="${imageUrl}"><div class="gmail_quote">`
    );
    const [img] = parse(html).querySelectorAll("img");
    expect(img?.getAttributeNames()).toEqual(["alt", "src"]);
    const response = await f.h.hit(imageUrl);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  test("no address appears in any URL; the Worker maps tokens to recipients", async () => {
    await f.compose();
    const task = f.send();
    for (const html of Object.values(task.perRecipientBodies ?? {})) {
      const urls = [...hrefs(html), ...images(html)].join(" ").toLowerCase();
      for (const email of RECIPIENTS) {
        expect(urls).not.toContain(email);
        expect(urls).not.toContain(encodeURIComponent(email));
      }
    }
    expect(
      f.h.rows("SELECT address, current FROM recipients ORDER BY position")
    ).toEqual(RECIPIENTS.map((address) => ({ address, current: 1 })));
  });

  test("opens and clicks are credited to the recipient whose body carried them", async () => {
    await f.compose();
    f.send();
    f.main.tracker.delivered(DRAFT_ID);
    await f.main.tick();
    f.h.state.clock += 60 * 60 * 1000;
    await f.h.hit(setFor("alex@example.com").imageUrl, {
      "User-Agent": BROWSER,
    });
    await f.h.hit(setFor("sam@example.net").links["https://example.org/deck"]);
    const figures = await recipientFigures();
    expect(figures.message.shared).toBe(0);
    // The schema keeps only these fields of each recipient's figures.
    expect(figures.recipients).toEqual([
      { address: "alex@example.com", clicks: 0, opens: 1 },
      { address: "sam@example.net", clicks: 1, opens: 0 },
      { address: "boss@example.net", clicks: 0, opens: 0 },
    ]);
  });
});

describe("which tokens each body gets", () => {
  test("addresses match case-insensitively and in any order", async () => {
    await f.compose();
    const reordered = draft({
      bcc: [{ email: "Alex@Example.com" }],
      to: [{ email: "BOSS@example.net" }],
    });
    const task = f.send(reordered);
    const bodies = task.perRecipientBodies ?? {};
    expect(images(bodies["Alex@Example.com"] ?? "")[0]).toBe(
      setFor("alex@example.com").imageUrl
    );
    expect(images(bodies["BOSS@example.net"] ?? "")[0]).toBe(
      setFor("boss@example.net").imageUrl
    );
    expect(f.logs).toEqual([]);
  });

  test("recipients changed after registration: the whole email goes untracked, logged once", async () => {
    await f.compose();
    const later = draft({
      to: [{ email: "alex@example.com" }, { email: "new@example.org" }],
    });
    const task = f.send(later);
    // No separate bodies, so no recipient gets anyone's tokens.
    expect(task.perRecipientBodies).toBeNull();
    expect(task.body).toBe(parse(BODY).innerHTML);
    expect(f.logs).toEqual([
      "recipients changed after registration; sent untracked",
    ]);
  });

  // The review's reproduction: a Graph draft registered to Alex alone, then readdressed.
  test("a shared set registered for one person is never sent to others", async () => {
    f.state.graph = true;
    const toAlex = draft({ bcc: [], cc: [] });
    await f.compose(toAlex);
    expect(Object.keys(lookup(f.config, DRAFT_ID)?.recipients ?? {})).toEqual([
      "alex@example.com",
    ]);
    const alexTokens = [
      setFor("alex@example.com").imageUrl,
      ...Object.values(setFor("alex@example.com").links),
    ];
    const readdressed = [
      draft({ bcc: [], cc: [{ email: "sam@example.net" }] }),
      draft({ bcc: [], cc: [], to: [{ email: "kim@example.org" }] }),
    ];
    const graphBodies = readdressed.map((message) => f.send(message).body);
    // The same draft moved to an SMTP account: one body per recipient.
    f.state.graph = false;
    const smtp = f.send(draft({ bcc: [], cc: [{ email: "sam@example.net" }] }));
    const smtpAlone = f.send(toAlex);
    const sent = [
      ...graphBodies,
      ...Object.values(smtp.perRecipientBodies ?? {}),
      smtp.body,
      ...Object.values(smtpAlone.perRecipientBodies ?? {}),
      smtpAlone.body,
    ].join("\n");
    for (const url of alexTokens) {
      expect(sent).not.toContain(url);
    }
    expect(f.logs).toEqual([
      "recipients changed after registration; sent untracked",
      "delivery mode (shared Graph body or one body each) changed after registration; sent untracked",
    ]);
  });

  test("Graph accounts register one shared set, marked recipient unknown", async () => {
    f.state.graph = true;
    await f.compose();
    const entry = lookup(f.config, DRAFT_ID);
    expect(entry?.shared).toBe(true);
    expect(Object.keys(entry?.recipients ?? {})).toEqual([""]);
    const task = f.send();
    // Mailspring sends one body to all and files the untracked `self` body.
    expect(task.perRecipientBodies).toEqual({ self: BODY });
    expect(images(task.body)[0]).toBe(setFor("").imageUrl);
    expect(hrefs(task.body)[0]).toBe(
      setFor("").links["https://example.org/deck"] ?? null
    );
    expect(f.logs).toEqual([]);
    const figures = await recipientFigures();
    expect(figures.message.shared).toBe(1);
    expect(figures.recipients.map((r) => r.address)).toEqual([""]);
  });

  test("a Graph email to one person keeps that recipient known", async () => {
    f.state.graph = true;
    const single = draft({ bcc: [], cc: [] });
    await f.compose(single);
    expect(Object.keys(lookup(f.config, DRAFT_ID)?.recipients ?? {})).toEqual([
      "alex@example.com",
    ]);
    const task = f.send(single);
    expect(images(task.body)[0]).toBe(setFor("alex@example.com").imageUrl);
  });

  test("switching to a Graph account re-registers as shared; a stale per-recipient one is not sent shared", async () => {
    await f.compose();
    // Graph only at send: one body for all would credit one person, so it goes untracked.
    f.state.graph = true;
    const task = f.send();
    expect(task.perRecipientBodies).toBeNull();
    expect(task.body).toBe(parse(BODY).innerHTML);
    expect(f.logs).toEqual([
      "delivery mode (shared Graph body or one body each) changed after registration; sent untracked",
    ]);
    await f.compose();
    expect(lookup(f.config, DRAFT_ID)?.shared).toBe(true);
    expect(
      f.h.rows("SELECT address, current FROM recipients ORDER BY position")
    ).toEqual([
      ...RECIPIENTS.map((address) => ({ address, current: 0 })),
      { address: "", current: 1 },
    ]);
  });

  test("plaintext drafts are skipped without error", async () => {
    const plain = draft({
      body: "Hi Alex, https://example.org/deck",
      plaintext: true,
    });
    await f.compose(plain);
    const task = f.send(plain);
    expect(task.body).toBe("Hi Alex, https://example.org/deck");
    expect(task.perRecipientBodies).toBeNull();
    expect(f.requests).toHaveLength(0);
    expect(f.logs).toEqual([]);
  });

  test("a disabled plugin leaves registered drafts untouched", async () => {
    await f.compose();
    f.state.settings = { ...f.state.settings, enabled: false };
    const task = f.send();
    expect(task.perRecipientBodies).toBeNull();
    expect(task.body).toBe(parse(BODY).innerHTML);
  });

  test("an exception inside the hook is caught and the mail still goes out", async () => {
    await f.compose();
    const broken = draft();
    Object.defineProperty(broken, "headerMessageId", {
      get: () => {
        throw new Error("simulated failure");
      },
    });
    expect(() => forSending([f.main.extension], broken)).not.toThrow();
    expect(f.logs.some((line) => line.includes("simulated failure"))).toBe(
      true
    );
  });
});

describe("marking sent", () => {
  test("only after Mailspring reports delivery, with the delivery time", async () => {
    await f.compose();
    f.send();
    await f.main.tick();
    // Building the task (and a failed delivery) does not mark it sent.
    expect(f.sentAt()).toEqual([{ sent_at: null }]);
    const deliveredAt = f.h.state.clock;
    f.main.tracker.delivered(DRAFT_ID);
    await f.main.tick();
    expect(f.sentAt()).toEqual([{ sent_at: deliveredAt }]);
    expect(f.config.get("mail-tracker-pending-sent")).toEqual({});
  });

  test("retries a failed notice and keeps the delivery time", async () => {
    await f.compose();
    const deliveredAt = f.h.state.clock;
    f.state.transport = async () => await Promise.reject(new Error("offline"));
    f.main.tracker.delivered(DRAFT_ID);
    await f.main.tracker.settle();
    expect(f.sentAt()).toEqual([{ sent_at: null }]);
    f.state.transport = async () =>
      await Promise.resolve({ body: "", status: 503 });
    await f.main.tick();
    f.state.transport = null;
    f.h.state.clock += 60_000;
    await f.main.tick();
    expect(f.sentAt()).toEqual([{ sent_at: deliveredAt }]);
    expect(
      f.logs.filter((line) => line.startsWith("marking sent failed"))
    ).toHaveLength(1);
  });

  test("a notice pending before a restart is sent on start-up", async () => {
    await f.compose();
    const deliveredAt = f.h.state.clock;
    f.state.transport = async () => await Promise.reject(new Error("offline"));
    f.main.tracker.delivered(DRAFT_ID);
    await f.main.tracker.settle();
    f.state.transport = null;
    const restarted = f.openWindow();
    restarted.tracker.resume();
    await restarted.tracker.settle();
    expect(f.sentAt()).toEqual([{ sent_at: deliveredAt }]);
  });

  test("gives up after the last retry", async () => {
    await f.compose();
    f.state.transport = async () =>
      await Promise.resolve({ body: "", status: 500 });
    f.main.tracker.delivered(DRAFT_ID);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each retry is scheduled by the previous one.
      await f.main.tick();
    }
    expect(f.logs.at(-1)).toBe("marking sent gave up after 6 attempts");
    expect(f.config.get("mail-tracker-pending-sent")).toEqual({});
  });
});
