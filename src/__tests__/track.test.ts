import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { z } from "zod";

import type { Db } from "../env";
import { messageSummary } from "../schema";
import { DEDUPE_WINDOW_MS } from "../store";
import { createHarness, HOUR, OWNER_IP, UNKNOWN_TOKEN } from "./harness";
import type { Harness, Minted } from "./harness";

const NO_SCRIPT = ["javascript", "alert(1)"].join(":");
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

let h: Harness;
let sent: Minted;

/** Makes every write to `events` fail, as when D1 is down or over its write limit. */
const failEventWrites = (db: Db): void => {
  const { prepare } = db;
  db.prepare = (sql) => {
    if (sql.includes("INSERT INTO events")) {
      throw new Error("D1_ERROR: simulated write failure");
    }
    return prepare(sql);
  };
};

beforeEach(async () => {
  h = await createHarness();
  sent = await h.mintOk();
  await h.markSent(sent.token);
  h.state.clock += HOUR;
});

describe("GET /i/:token", () => {
  test("returns an uncacheable GIF and records one classified open", async () => {
    const response = await h.hit(sent.imageUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/gif");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
    expect(h.events()).toMatchObject([
      {
        at: h.state.clock,
        class: "human",
        counted: 1,
        kind: "open",
        link_token: null,
      },
    ]);
  });

  test("serves the same image for unknown tokens without recording", async () => {
    const response = await h.hit(`/i/${UNKNOWN_TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/gif");
    const malformed = await h.hit("/i/not-a-token");
    expect(malformed.status).toBe(200);
    expect(h.events()).toHaveLength(0);
  });

  test("still serves the image when recording fails, and logs the error", async () => {
    failEventWrites(h.db);
    const logged = spyOn(console, "error").mockImplementation(() => {
      // Silenced for the test.
    });
    const response = await h.hit(sent.imageUrl);
    expect(response.status).toBe(200);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("keeps every hit and flags repeats by the same actor and method", async () => {
    await h.hit(sent.imageUrl);
    h.state.clock += DEDUPE_WINDOW_MS - 1;
    await h.hit(sent.imageUrl);
    await h.hit(sent.imageUrl, { "CF-Connecting-IP": "198.51.100.20" });
    h.state.clock += DEDUPE_WINDOW_MS + 1;
    await h.hit(sent.imageUrl);
    expect(h.events().map((e) => e.duplicate)).toEqual([0, 1, 0, 0]);
    const list = await h.read("/api/messages");
    const opens = z
      .object({ messages: z.array(messageSummary) })
      .parse(await list.json()).messages[0]?.opens;
    expect(opens).toBe(3);
  });

  test("a HEAD before a GET does not hide the GET", async () => {
    await h.call(new URL(sent.links[0]?.redirectUrl ?? "").pathname, {
      method: "HEAD",
    });
    h.state.clock += 1000;
    await h.hit(sent.links[0]?.redirectUrl);
    expect(h.events().map((e) => [e.method, e.class, e.duplicate])).toEqual([
      ["HEAD", "scanner", 0],
      ["GET", "human", 0],
    ]);
  });
});

describe("open classification and counting", () => {
  test.each([
    ["the owner's IP", { "CF-Connecting-IP": OWNER_IP }, "self", 0],
    ["Gmail's on-open proxy", { "User-Agent": GMAIL_PROXY }, "proxy", 1],
    ["Apple's prefetch", { "User-Agent": "Mozilla/5.0" }, "proxy", 0],
    [
      "a Mailspring recipient",
      { "User-Agent": "Mozilla/5.0 (X11) Mailspring/1.16" },
      "human",
      1,
    ],
    [
      "an unverified Access cookie",
      { Cookie: "CF_Authorization=forged" },
      "human",
      1,
    ],
  ])("%s", async (_name, headers, eventClass, counted) => {
    await h.hit(sent.imageUrl, headers);
    expect(h.events()).toMatchObject([{ class: eventClass, counted }]);
  });

  test("a verified Access token of the owner is self", async () => {
    const jwt = await h.accessJwt({ email: "owner@example.com" });
    await h.hit(sent.imageUrl, { Cookie: `CF_Authorization=${jwt}` });
    expect(h.events()).toMatchObject([
      { class: "self", reason: "verified Cloudflare Access token" },
    ]);
  });
});

describe("GET /l/:token", () => {
  test("redirects to the stored URL and records one click", async () => {
    const response = await h.hit(
      `${new URL(sent.links[1]?.redirectUrl ?? "").pathname}?url=https://evil.example/`
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.org/b");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(h.events()).toMatchObject([
      { class: "human", counted: 1, kind: "click" },
    ]);
  });

  test("still redirects when recording fails, and logs the error", async () => {
    failEventWrites(h.db);
    const logged = spyOn(console, "error").mockImplementation(() => {
      // Silenced for the test.
    });
    const response = await h.hit(sent.links[0]?.redirectUrl);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.org/a");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test.each([
    `/l/${UNKNOWN_TOKEN}`,
    "/l/https%3A%2F%2Fevil.example",
    "/l/",
    "/l//evil.example",
    "/l/?url=https://evil.example/",
  ])("never redirects for %s", async (route) => {
    const response = await h.hit(route);
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });

  test("refuses a stored destination that no longer passes the allow-list", async () => {
    h.db.sqlite.run("UPDATE links SET url = ? WHERE position = 0", [NO_SCRIPT]);
    const response = await h.hit(sent.links[0]?.redirectUrl);
    expect(response.status).toBe(404);
    expect(h.events()).toHaveLength(0);
  });

  test("marks one actor clicking two links within the burst window as scanner", async () => {
    await h.hit(sent.links[0]?.redirectUrl);
    h.state.clock += 500;
    await h.hit(sent.links[1]?.redirectUrl);
    expect(h.events().map((e) => [e.class, e.reason])).toEqual([
      ["human", "browser or mail-client user agent"],
      ["scanner", "burst: 2 links clicked within 3s"],
    ]);
  });

  test("does not mix actors or the owner into a burst", async () => {
    await h.hit(sent.links[0]?.redirectUrl, { "CF-Connecting-IP": OWNER_IP });
    h.state.clock += 300;
    await h.hit(sent.links[0]?.redirectUrl, {
      "CF-Connecting-IP": "198.51.100.30",
    });
    h.state.clock += 300;
    await h.hit(sent.links[1]?.redirectUrl, {
      "CF-Connecting-IP": "198.51.100.7",
    });
    expect(h.events().map((e) => e.class)).toEqual(["self", "human", "human"]);
  });

  test("marks a click right after sending as scanner", async () => {
    const fresh = await h.mintOk(
      ["https://example.org/c"],
      "<draft-3@example.test>"
    );
    await h.markSent(fresh.token);
    h.state.clock += 1000;
    await h.hit(fresh.links[0]?.redirectUrl);
    expect(h.events()).toMatchObject([
      { class: "scanner", reason: "clicked 1s after send" },
    ]);
  });
});
