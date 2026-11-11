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

import { HOUR, ORIGIN } from "../../src/__tests__/harness";
import { composeWith } from "../../src/cli/__tests__/worker";
import type { Composed } from "../../src/cli/compose";
import { lookup } from "../src/registry";
import type { TokenSet } from "../src/registry";
import { parseSnapshot } from "../src/snapshot";
import {
  createFixture,
  draft,
  DRAFT_ID,
  hrefs,
  images,
  OLD_PIXEL,
  paths,
} from "./fixture";
import type { Fixture } from "./fixture";

const RECIPIENTS = ["alex@example.com", "sam@example.net", "boss@example.net"];
const DECK = "https://example.org/deck";
const PRICING = "https://example.org/pricing";

let f: Fixture;

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  f = await createFixture();
});

/** The agent's draft as it arrives in Mailspring: its composed HTML, synced, not typed. */
const agentDraft = (composed: Composed, recipients: string[]) =>
  draft({
    bcc: recipients.slice(2).map((email) => ({ email })),
    body: composed.html,
    cc: recipients.slice(1, 2).map((email) => ({ email })),
    to: recipients.slice(0, 1).map((email) => ({ email })),
  });

const redirectOf = (composed: Composed, url: string): string =>
  composed.receipt.links.find((link) => link.url === url)?.redirectUrl ?? "";

const lastRegistration = () => parseSnapshot(f.requests.at(-1)?.body ?? "");

const recipientRows = () =>
  z
    .array(z.object({ address: z.string(), current: z.number() }))
    .parse(
      f.h.rows("SELECT address, current FROM recipients ORDER BY position")
    );

/**
 * Checks one recipient's body: exactly one image, this recipient's, and their own
 * redirects in place of the agent's shared ones. Returns the URLs it used.
 */
const expectOwnTokens = (
  html: string,
  set: TokenSet | undefined,
  composed: Composed
): string[] => {
  const own = [
    set?.imageUrl ?? "",
    set?.links[DECK] ?? "",
    set?.links[PRICING] ?? "",
  ];
  expect(images(html)).toEqual(own.slice(0, 1));
  expect(hrefs(html)).toEqual(own.slice(1));
  for (const url of own) {
    expect(url).toStartWith(ORIGIN);
  }
  expect(html).not.toContain(composed.receipt.imageUrl ?? "");
  expect(html).not.toContain(redirectOf(composed, DECK));
  return own;
};

describe("a draft composed with tracking by an agent, sent from Mailspring", () => {
  test("several recipients: each body gets that recipient's own tokens in place of the shared ones, one image each", async () => {
    const composed = await composeWith(f.h, {
      bcc: RECIPIENTS.slice(2),
      cc: RECIPIENTS.slice(1, 2),
      to: RECIPIENTS.slice(0, 1),
    });
    expect(composed.receipt.shared).toBe(true);
    const message = agentDraft(composed, RECIPIENTS);
    await f.compose(message);
    // Registered under the agent's message, by its image token, not as a new one.
    const sharedImage = new URL(composed.receipt.imageUrl ?? "").pathname
      .slice(3)
      .replace(".png", "");
    expect(lastRegistration()?.pixelToken).toBe(sharedImage);
    expect(f.h.rows("SELECT token FROM messages")).toEqual([
      { token: composed.receipt.token },
    ]);
    expect(recipientRows()).toEqual([
      { address: "", current: 0 },
      ...RECIPIENTS.map((address) => ({ address, current: 1 })),
    ]);
    const entry = lookup(f.config, DRAFT_ID);
    expect(entry?.token).toBe(composed.receipt.token ?? "");
    expect(entry?.shared).toBe(false);

    const task = f.send(message);
    expect(task.returned.every((value) => value === undefined)).toBe(true);
    const bodies = task.perRecipientBodies ?? {};
    expect(Object.keys(bodies)).toEqual(["self", ...RECIPIENTS]);
    const used = RECIPIENTS.flatMap((email) =>
      expectOwnTokens(bodies[email] ?? "", entry?.recipients[email], composed)
    );
    // No two recipients share an image or a redirect.
    expect(new Set(used).size).toBe(RECIPIENTS.length * 3);
    // The Sent copy is the draft as it was, with the agent's shared image (see README).
    expect(bodies.self).toBe(composed.html);
    expect(f.logs).toEqual([]);

    // Marked sent on delivery, as today, on the agent's message.
    f.h.state.clock += HOUR;
    f.main.tracker.delivered(DRAFT_ID);
    await f.main.tick();
    expect(f.sentAt()).toEqual([{ sent_at: f.h.state.clock }]);
    expect(paths(f.requests).at(-1)).toBe(
      `/api/messages/${composed.receipt.token ?? ""}/sent`
    );
  });

  test("one recipient: the agent's tokens are kept, and no second image is added", async () => {
    const composed = await composeWith(f.h);
    const message = agentDraft(composed, ["alex@example.com"]);
    await f.compose(message);
    expect(f.h.rows("SELECT token FROM messages")).toEqual([
      { token: composed.receipt.token },
    ]);
    expect(recipientRows()).toEqual([
      { address: "alex@example.com", current: 1 },
    ]);
    const task = f.send(message);
    const html = task.perRecipientBodies?.["alex@example.com"] ?? "";
    expect(images(html)).toEqual([composed.receipt.imageUrl]);
    expect(hrefs(html)).toEqual([
      redirectOf(composed, DECK),
      redirectOf(composed, PRICING),
    ]);
    expect(f.logs).toEqual([]);
  });

  test("a link the owner adds in Mailspring is registered and tracked like the agent's", async () => {
    const composed = await composeWith(f.h);
    const message = agentDraft(composed, ["alex@example.com"]);
    message.body = `${composed.html}<p><a href="https://example.org/extra">extra</a></p>`;
    await f.compose(message);
    const set = lookup(f.config, DRAFT_ID)?.recipients["alex@example.com"];
    const html = f.send(message).perRecipientBodies?.["alex@example.com"] ?? "";
    expect(hrefs(html)).toEqual([
      redirectOf(composed, DECK),
      redirectOf(composed, PRICING),
      set?.links["https://example.org/extra"] ?? "",
    ]);
    expect(images(html)).toEqual([composed.receipt.imageUrl]);
  });

  test("never registered in a composer: the draft goes out as the agent wrote it", async () => {
    const composed = await composeWith(f.h, {
      cc: ["sam@example.net"],
    });
    const message = agentDraft(composed, [
      "alex@example.com",
      "sam@example.net",
    ]);
    const task = f.send(message);
    expect(task.perRecipientBodies).toBeNull();
    expect(images(task.body)).toEqual([composed.receipt.imageUrl]);
  });

  test("an image only in quoted text is an earlier email's, not this draft's tracking", async () => {
    await f.compose();
    expect(lastRegistration()?.pixelToken).toBeNull();
    const body = `<p>Reply</p><blockquote><img src="${OLD_PIXEL}.png"></blockquote>`;
    await f.compose(draft({ body }));
    expect(lastRegistration()?.pixelToken).toBeNull();
  });
});
