import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { CSP } from "../dashboard";
import { detailDataSchema, listDataSchema } from "../dashboard-data";
import {
  API_TOKEN,
  APP_FILES,
  createHarness,
  HOUR,
  UNKNOWN_TOKEN,
} from "./harness";
import type { Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const owner = async () => ({
  "Cf-Access-Jwt-Assertion": await h.accessJwt(),
});
const get = async (route: string): Promise<Response> =>
  await h.call(route, { headers: await owner() });
const getAll = async (routes: string[]): Promise<Response[]> =>
  await Promise.all(routes.map(async (route) => await get(route)));
const statusOf = async (route: string): Promise<number> => {
  const response = await get(route);
  return response.status;
};
const detail = async (token: string) => {
  const response = await get(`/app/messages/${token}/data`);
  return detailDataSchema.parse(await response.json());
};
const list = async () => {
  const response = await get("/app/data");
  return listDataSchema.parse(await response.json());
};

/** Every route under /app: the app's pages, its files and its data. */
const APP_ROUTES = [
  "/app",
  "/app/",
  `/app/messages/${UNKNOWN_TOKEN}`,
  "/app/assets/index-test.js",
  "/app/favicon.svg",
  "/app/data",
  `/app/messages/${UNKNOWN_TOKEN}/data`,
];

const expectStrictHeaders = (response: Response) => {
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  expect(csp).toBe(CSP);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toMatch(/https?:/u);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
};

describe("the app and its assets require Access", () => {
  test.each(APP_ROUTES)(
    "refuses %s without an Access assertion, before reading any asset",
    async (route) => {
      const response = await h.call(route);
      expect(response.status).toBe(401);
      expect(h.assetCalls).toEqual([]);
    }
  );

  test.each(APP_ROUTES)("refuses %s with the API token", async (route) => {
    const response = await h.call(route, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(response.status).toBe(401);
    expect(h.assetCalls).toEqual([]);
  });

  test.each(APP_ROUTES)(
    "refuses %s with a wrong-audience assertion",
    async (route) => {
      const response = await h.call(route, {
        headers: { "Cf-Access-Jwt-Assertion": await h.accessJwt({ aud: "x" }) },
      });
      expect(response.status).toBe(401);
      expect(h.assetCalls).toEqual([]);
    }
  );

  test("wrangler.toml runs the Worker before static assets", async () => {
    const toml = await Bun.file(
      new URL("../../wrangler.toml", import.meta.url)
    ).text();
    const config = z
      .object({
        assets: z.object({
          binding: z.literal("ASSETS"),
          directory: z.literal("web/dist"),
          run_worker_first: z.literal(true),
        }),
      })
      .safeParse(Bun.TOML.parse(toml));
    expect(config.success).toBe(true);
  });
});

describe("serving the app to the owner", () => {
  test("serves the shell for the list and per-email pages, uncached", async () => {
    const sent = await h.mintOk();
    const responses = await getAll(["/app", `/app/messages/${sent.token}`]);
    const bodies = await Promise.all(
      responses.map(async (r) => await r.text())
    );
    expect(bodies).toEqual([
      APP_FILES["/app/index.html"],
      APP_FILES["/app/index.html"],
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expectStrictHeaders(response);
    }
    expect(h.assetCalls).toEqual(["/app/index.html", "/app/index.html"]);
  });

  test("a trailing slash redirects to the page without it", async () => {
    const response = await get("/app/");
    expect(response.status).toBe(301);
    expect(new URL(response.headers.get("Location") ?? "").pathname).toBe(
      "/app"
    );
  });

  test("serves hashed assets as immutable and the icon uncached", async () => {
    const script = await get("/app/assets/index-test.js");
    expect(script.status).toBe(200);
    expect(await script.text()).toBe("console.log('app');");
    expect(script.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, immutable"
    );
    expectStrictHeaders(script);
    const icon = await get("/app/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("Cache-Control")).toBe("no-store");
  });

  test("an unknown file is a 404; paths outside the app's routes never reach assets", async () => {
    expect(await statusOf("/app/assets/missing.js")).toBe(404);
    expect(h.assetCalls).toEqual(["/app/assets/missing.js"]);
    const outside = await getAll([
      "/app/index.html",
      "/app/assets/nested/x.js",
      "/app/other",
    ]);
    expect(outside.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(h.assetCalls).toHaveLength(1);
  });

  test("fails closed when the ASSETS binding is missing", async () => {
    delete h.env.ASSETS;
    const anonymous = await h.call("/app");
    expect(anonymous.status).toBe(401);
    expect(await statusOf("/app")).toBe(500);
  });

  test("the data endpoints carry the strict headers and are never cached", async () => {
    const sent = await h.mintOk();
    await h.markSent(sent.token);
    const responses = await getAll([
      "/app/data",
      `/app/messages/${sent.token}/data`,
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json"
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expectStrictHeaders(response);
    }
    expect(await statusOf(`/app/messages/${UNKNOWN_TOKEN}/data`)).toBe(404);
    expect(await statusOf("/app/messages/not-a-token/data")).toBe(404);
  });
});

/** Gmail's image proxy fetches when the recipient opens; it counts as a proxy open. */
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

describe("per-email totals", () => {
  test("splits opens into human and proxy, counts clicks per link and keeps the rest in the timeline", async () => {
    const sent = await h.mintOk();
    await h.markSent(sent.token);
    const [linkA, linkB] = sent.links;
    h.state.clock += HOUR;
    // Apple's prefetch: a proxy, not counted.
    await h.hit(sent.imageUrl, { "User-Agent": "Mozilla/5.0" });
    h.state.clock += HOUR;
    const firstOpen = h.state.clock;
    await h.hit(sent.imageUrl);
    // The same client again within 30 s: a repeat, not counted.
    await h.hit(sent.imageUrl);
    h.state.clock += HOUR;
    const lastOpen = h.state.clock;
    await h.hit(sent.imageUrl, { "User-Agent": GMAIL_PROXY });
    await h.hit(linkA?.redirectUrl);
    h.state.clock += HOUR;
    await h.hit(linkA?.redirectUrl);
    await h.hit(linkB?.redirectUrl, { "User-Agent": "curl/8.0" });

    const data = await detail(sent.token);
    const sentRow = z
      .object({ sent_at: z.number() })
      .parse(h.rows("SELECT sent_at FROM messages")[0]);
    const tokens = z
      .array(z.object({ token: z.string() }))
      .parse(h.rows("SELECT token FROM links ORDER BY position"))
      .map((row) => row.token);
    expect(data.totals).toEqual({
      clicks: {
        counted: 2,
        links: [
          {
            clicks: 2,
            name: "example.org",
            notCounted: 0,
            token: tokens[0] ?? "",
            url: "https://example.org/a",
          },
          {
            clicks: 0,
            name: "example.org",
            notCounted: 1,
            token: tokens[1] ?? "",
            url: "https://example.org/b",
          },
        ],
        notCounted: 1,
      },
      firstOpen,
      lastOpen,
      // A Gmail proxy open re-opens only six hours after the previous open, not one.
      lastReopen: null,
      opens: { counted: 2, human: 1, notCounted: 2, proxy: 1 },
      // Registered without recipients (message-level tokens), as before ADR-0003.
      recipients: [],
      reopens: 0,
    });
    expect(data.timeline.map((e) => [e.kind, e.class, e.duplicate])).toEqual([
      ["open", "proxy", false],
      ["open", "human", false],
      ["open", "human", true],
      ["open", "proxy", false],
      ["click", "human", false],
      ["click", "human", false],
      ["click", "scanner", false],
    ]);
    // The read API's display labels: Gmail's proxy reads as an open via Gmail.
    expect(data.timeline.map((e) => [e.label, e.via])).toEqual([
      ["Prefetch", null],
      ["Opened", null],
      ["Opened", null],
      ["Opened", "Gmail"],
      ["Clicked", null],
      ["Clicked", null],
      ["Scanner", null],
    ]);
    expect(data.timeline[4]?.url).toBe("https://example.org/a");
    expect(data.timeline[0]?.url).toBeNull();
    expect(data.message).toEqual({
      recipient: "alex@example.com",
      sentAt: sentRow.sent_at,
      shared: false,
      subject: "Proposal",
      token: sent.token,
    });

    // The email list counts the same way.
    const listed = await list();
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]).toMatchObject({
      clicks: data.totals.clicks.counted,
      firstOpen,
      lastOpen,
      opens: data.totals.opens.counted,
    });
  });

  test("an email without events has zero totals and no first open", async () => {
    const sent = await h.mintOk([]);
    await h.markSent(sent.token);
    const data = await detail(sent.token);
    expect(data.totals).toEqual({
      clicks: { counted: 0, links: [], notCounted: 0 },
      firstOpen: null,
      lastOpen: null,
      lastReopen: null,
      opens: { counted: 0, human: 0, notCounted: 0, proxy: 0 },
      recipients: [],
      reopens: 0,
    });
    expect(data.timeline).toEqual([]);
  });

  test("the list leaves out unsent drafts without events and reports when it was read", async () => {
    const sent = await h.mintOk();
    await h.markSent(sent.token);
    await h.mintOk(["https://example.org/x"], "<unsent@example.test>");
    h.state.clock += HOUR;
    const listed = await list();
    expect(listed.messages.map((m) => m.token)).toEqual([sent.token]);
    expect(listed.updated).toBe(h.state.clock);
  });

  test("a refresh sees new events", async () => {
    const sent = await h.mintOk();
    await h.markSent(sent.token);
    h.state.clock += HOUR;
    const before = await detail(sent.token);
    await h.hit(sent.links[0]?.redirectUrl);
    const after = await detail(sent.token);
    expect(after.timeline).toHaveLength(before.timeline.length + 1);
    expect(after.totals.clicks.counted).toBe(1);
  });
});
