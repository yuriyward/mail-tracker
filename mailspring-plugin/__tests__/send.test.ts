import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { ORIGIN } from "../../src/__tests__/harness";
import { lookup } from "../src/registry";
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

const knownTokens = (table: "links" | "messages"): string[] =>
  f.h
    .rows(`SELECT token FROM ${table}`)
    .map((row) => String(Object.values(row ?? {})[0]));

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
  test("a registered draft gets tracked per-recipient bodies and a clean Sent copy", async () => {
    await f.compose();
    const task = f.send();
    expect(task.returned.every((value) => value === undefined)).toBe(true);
    const bodies = task.perRecipientBodies ?? {};
    expect(Object.keys(bodies)).toEqual(["self", ...RECIPIENTS]);
    // The owner's Sent copy is the draft as written.
    expect(bodies.self).toBe(BODY);
    const entry = lookup(f.config, DRAFT_ID);
    for (const email of RECIPIENTS) {
      const html = bodies[email] ?? "";
      expect(hrefs(html)).toEqual([
        entry?.links["https://example.org/deck"] ?? null,
        entry?.links["https://example.org/pricing?plan=a&b=1"] ?? null,
        "mailto:me@example.com",
        "http://example.org/old",
        "/relative",
        "https://127.0.0.1/",
        null,
        "https://example.org/quoted",
      ]);
      // The quoted old pixel is gone; the new one sits before the quote.
      expect(images(html)).toEqual([
        entry?.imageUrl ?? null,
        "https://example.org/logo.png",
      ]);
      expect(html).not.toContain("data-mail-tracker");
    }
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
      expect(knownTokens("links")).toContain(
        new URL(href ?? "").pathname.slice(3)
      );
    }
    expect(hrefs(html)).toContain("https://example.org/late");
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
      "sending with an older registration: 1 link(s) added after registration stay untracked; subject or recipients changed after registration; the Worker keeps the registered ones",
    ]);
  });

  test("a draft never registered is sent as written, with no separate bodies", () => {
    const task = f.send();
    expect(task.perRecipientBodies).toBeNull();
    expect(task.body).toBe(parse(BODY).innerHTML);
    expect(f.requests).toHaveLength(0);
  });

  test("Graph accounts get one tracked body for all and an untracked self body", async () => {
    await f.compose();
    const task = f.send(draft(), true);
    expect(task.perRecipientBodies).toEqual({ self: BODY });
    expect(images(task.body)[0]).toBe(
      lookup(f.config, DRAFT_ID)?.imageUrl ?? null
    );
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
