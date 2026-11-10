import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { linkRow, messageSummary } from "../schema";
import {
  API_TOKEN,
  READ_TOKEN,
  createHarness,
  minted,
  ORIGIN,
  UNKNOWN_TOKEN,
} from "./harness";
import type { Harness } from "./harness";

// Built at runtime so the linter does not read it as a script URL in our own code.
const NO_SCRIPT = ["javascript", "alert(1)"].join(":");
const DRAFT = "<draft-1@example.test>";

let h: Harness;

const messageCount = (): number =>
  z
    .object({ n: z.number() })
    .parse(h.rows("SELECT COUNT(*) AS n FROM messages")[0]).n;

beforeEach(async () => {
  h = await createHarness();
});

describe("POST /api/messages", () => {
  test("mints a message token, an image URL and one redirect per distinct link", async () => {
    const result = await h.mintOk([
      "https://example.org/a",
      "https://example.org/a",
      "https://example.net/",
    ]);
    expect(result.imageUrl).toBe(`${ORIGIN}/i/${result.token}`);
    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.org/a",
      "https://example.net/",
    ]);
    const redirects = new Set(result.links.map((l) => l.redirectUrl));
    expect(redirects.size).toBe(2);
    for (const url of [result.imageUrl, ...redirects]) {
      // N2: neither the destination nor the recipient appears in a tracking URL.
      expect(url).not.toContain("example.org/a");
      expect(url).not.toContain("alex");
      expect(url.startsWith(ORIGIN)).toBe(true);
    }
  });

  test("is idempotent per draft: one message row, tokens reused, new links added", async () => {
    const first = await h.mintOk(["https://example.org/a"]);
    const again = await h.mint(
      JSON.stringify({
        draftId: DRAFT,
        links: ["https://example.org/b", "https://example.org/a"],
        recipient: "alex@example.com, sam@example.net",
        subject: "Proposal v2",
      })
    );
    expect(again.status).toBe(200);
    const second = minted.parse(await again.json());
    expect(second.token).toBe(first.token);
    expect(second.imageUrl).toBe(first.imageUrl);
    expect(second.links[1]).toEqual(first.links[0]);
    expect(second.links[0]?.redirectUrl).not.toBe(first.links[0]?.redirectUrl);
    expect(messageCount()).toBe(1);
    expect(h.rows("SELECT subject, recipient FROM messages")).toEqual([
      {
        recipient: "alex@example.com, sam@example.net",
        subject: "Proposal v2",
      },
    ]);
    const other = await h.mintOk(
      ["https://example.org/a"],
      "<draft-2@example.test>"
    );
    expect(other.token).not.toBe(first.token);
  });

  test.each([
    [{ draftId: DRAFT, links: ["http://example.org/"] }, "links[0]: not https"],
    [
      { draftId: DRAFT, links: ["https://example.org/", NO_SCRIPT] },
      "links[1]: not https",
    ],
    [
      { draftId: DRAFT, links: [`${ORIGIN}/l/abc`] },
      "links[0]: points at the tracker itself",
    ],
    [
      { draftId: DRAFT, links: "https://example.org/" },
      "links: Invalid input: expected array, received string",
    ],
    [
      { draftId: DRAFT, links: [42] },
      "links.0: Invalid input: expected string, received number",
    ],
    [
      { links: [] },
      "draftId: Invalid input: expected string, received undefined",
    ],
    [
      { draftId: DRAFT, subject: 7 },
      "subject: Invalid input: expected string, received number",
    ],
    [null, "body: Invalid input: expected object, received null"],
  ])("rejects %j", async (body, error) => {
    const response = await h.mint(JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(messageCount()).toBe(0);
  });

  test("rejects a body that is not JSON", async () => {
    const response = await h.mint("{");
    expect(response.status).toBe(400);
  });
});

describe("POST /api/messages/:token/sent", () => {
  const listed = async () => {
    const response = await h.read("/api/messages");
    return z
      .object({ messages: z.array(messageSummary) })
      .parse(await response.json()).messages;
  };

  test("sets the send time once and shows the email in the list", async () => {
    const result = await h.mintOk();
    // Registered while composing, not yet sent: not listed.
    expect(await listed()).toHaveLength(0);
    h.state.clock += 1000;
    const sent = await h.markSent(result.token);
    expect(sent.status).toBe(204);
    const sentAt = h.state.clock;
    h.state.clock += 5000;
    await h.markSent(result.token);
    const [message] = await listed();
    expect(message?.sent_at).toBe(sentAt);
    const missing = await h.markSent(UNKNOWN_TOKEN);
    expect(missing.status).toBe(404);
  });

  test("a retry later keeps the delivery time the plugin reports", async () => {
    const result = await h.mintOk();
    const deliveredAt = h.state.clock + 1000;
    h.state.clock += 2 * 60 * 60 * 1000;
    await h.markSent(result.token, deliveredAt);
    const [message] = await listed();
    expect(message?.sent_at).toBe(deliveredAt);
  });

  test.each([
    ["before registration", -1000],
    ["far in the future", 60 * 60 * 1000],
  ])(
    "replaces a reported time %s with the Worker's clock",
    async (_name, offset) => {
      const result = await h.mintOk();
      h.state.clock += 1000;
      await h.markSent(result.token, h.state.clock - 1000 + offset);
      const [message] = await listed();
      expect(message?.sent_at).toBe(h.state.clock);
    }
  );
});

describe("/api auth", () => {
  const routes = [
    ["GET", "/api/messages"],
    ["POST", "/api/messages"],
    ["GET", `/api/messages/${UNKNOWN_TOKEN}`],
    ["POST", `/api/messages/${UNKNOWN_TOKEN}/sent`],
  ] as const;

  test("the write token cannot read and the read token cannot write", async () => {
    const result = await h.mintOk();
    const readWithWrite = await h.read("/api/messages", API_TOKEN);
    expect(readWithWrite.status).toBe(401);
    const detailWithWrite = await h.read(
      `/api/messages/${result.token}`,
      API_TOKEN
    );
    expect(detailWithWrite.status).toBe(401);
    const mintWithRead = await h.mint(
      JSON.stringify({ draftId: "<other@example.test>", links: [] }),
      READ_TOKEN
    );
    expect(mintWithRead.status).toBe(401);
    const sentWithRead = await h.call(`/api/messages/${result.token}/sent`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
      method: "POST",
    });
    expect(sentWithRead.status).toBe(401);
    expect(messageCount()).toBe(1);
  });

  test.each([
    ["no header", {}],
    ["wrong token", { Authorization: "Bearer nope" }],
    ["basic scheme", { Authorization: `Basic ${API_TOKEN}` }],
  ])("refuses %s", async (_name, headers) => {
    const statuses = await Promise.all(
      routes.map(async ([method, route]) => {
        const response = await h.call(route, { headers, method });
        return response.status;
      })
    );
    // Hono answers 400 to a malformed Authorization header, 401 to a wrong token.
    for (const status of statuses) {
      expect(status).toBeOneOf([400, 401]);
    }
    expect(messageCount()).toBe(0);
  });

  test("does not answer CORS preflight; the plugin calls from Node, not a browser", async () => {
    const response = await h.call("/api/messages", {
      headers: {
        "Access-Control-Request-Headers": "authorization,content-type",
        "Access-Control-Request-Method": "POST",
        Origin: "https://evil.example",
      },
      method: "OPTIONS",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("refuses every token when the tokens are not configured", async () => {
    h.env.API_TOKEN = "";
    const empty = await h.mint("{}", "");
    expect(empty.status).toBeOneOf([400, 401]);
    delete h.env.API_TOKEN;
    const unset = await h.mint("{}", "anything");
    expect(unset.status).toBe(401);
    delete h.env.API_READ_TOKEN;
    const unread = await h.read("/api/messages", "anything");
    expect(unread.status).toBe(401);
  });

  test("GET /api/messages/:token details a message read-only", async () => {
    const result = await h.mintOk();
    const headers = { Authorization: `Bearer ${READ_TOKEN}` };
    const detail = await h.read(`/api/messages/${result.token}`);
    expect(detail.status).toBe(200);
    expect(
      z.object({ links: z.array(linkRow) }).parse(await detail.json()).links
    ).toHaveLength(2);
    const missing = await h.read(`/api/messages/${UNKNOWN_TOKEN}`);
    expect(missing.status).toBe(404);
    const deleted = await h.call("/api/messages", {
      headers,
      method: "DELETE",
    });
    expect(deleted.status).toBe(404);
  });
});
