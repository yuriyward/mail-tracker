import { beforeEach, describe, expect, test } from "bun:test";

import { Jwt } from "hono/utils/jwt";
import { z } from "zod";

import { FORCED_REFRESH_MS } from "../auth";
import { CSP, REFRESH_MS } from "../dashboard";
import {
  API_TOKEN,
  AUD,
  createHarness,
  HOUR,
  KID,
  TEAM,
  UNKNOWN_TOKEN,
} from "./harness";
import type { Harness } from "./harness";

let h: Harness;

const status = async (jwt: string, route = "/app"): Promise<number> => {
  const response = await h.call(route, {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
  return response.status;
};

beforeEach(async () => {
  h = await createHarness();
});

describe("/app auth", () => {
  test.each(["/app", "/app/", `/app/messages/${UNKNOWN_TOKEN}`])(
    "refuses %s without an Access assertion",
    async (route) => {
      const response = await h.call(route);
      expect(response.status).toBe(401);
    }
  );

  test("accepts a valid assertion", async () => {
    expect(await status(await h.accessJwt())).toBe(200);
  });

  test.each([
    ["wrong audience", { aud: "other" }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: 1 }],
    ["no expiry", { exp: null }],
  ])("refuses an assertion with %s", async (_name, claims) => {
    expect(await status(await h.accessJwt(claims))).toBe(401);
  });

  test("refuses an unknown key after refetching the keys once", async () => {
    expect(await status(await h.accessJwt({}, "other-kid"))).toBe(401);
    expect(h.state.jwksCalls).toEqual([false, true]);
  });

  test("forces a key refresh at most once a minute", async () => {
    expect(await status(await h.accessJwt({}, "made-up-1"))).toBe(401);
    expect(await status(await h.accessJwt({}, "made-up-2"))).toBe(401);
    h.state.clock += FORCED_REFRESH_MS;
    expect(await status(await h.accessJwt({}, "made-up-3"))).toBe(401);
    expect(h.state.jwksCalls).toEqual([false, true, false, false, false, true]);
  });

  test("random key ids on the public routes do not force fetches", async () => {
    const sent = await h.mintOk();
    const forged = await h.accessJwt({}, "made-up");
    await h.hit(sent.imageUrl, { "Cf-Access-Jwt-Assertion": forged });
    await h.hit(sent.imageUrl, { "Cf-Access-Jwt-Assertion": forged });
    expect(h.state.jwksCalls.filter(Boolean)).toHaveLength(1);
  });

  test("accepts a rotated key found on refetch", async () => {
    const rotated = await h.keyPair("rotated-kid");
    h.state.rotated = [rotated.public];
    expect(await status(await h.accessJwt({}, "rotated-kid", rotated))).toBe(
      200
    );
    expect(h.state.jwksCalls).toEqual([false, true]);
  });

  test("checks the email claim against ALLOWED_EMAILS when set", async () => {
    h.env.ALLOWED_EMAILS = "owner@example.com, second@example.com";
    expect(
      await status(await h.accessJwt({ email: "Owner@Example.com" }))
    ).toBe(200);
    expect(
      await status(await h.accessJwt({ email: "intruder@example.com" }))
    ).toBe(401);
    expect(await status(await h.accessJwt())).toBe(401);
  });

  test("refuses a symmetric (HS256) assertion", async () => {
    const jwt = await Jwt.sign(
      {
        aud: AUD,
        exp: Math.floor(Date.now() / 1000) + 600,
        iss: `https://${TEAM}`,
      },
      "secret",
      "HS256"
    );
    expect(await status(jwt)).toBe(401);
    expect(KID).toBe("test-kid");
  });

  test("refuses everything when Access is not configured", async () => {
    delete h.env.ACCESS_AUD;
    expect(await status(await h.accessJwt())).toBe(401);
  });

  test("the API token does not open the dashboard", async () => {
    const response = await h.call("/app", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });
});

describe("dashboard", () => {
  test("lists sent emails and shows a per-email timeline with event classes", async () => {
    const result = await h.mintOk();
    await h.markSent(result.token);
    await h.mintOk(["https://example.org/x"], "<unsent@example.test>");
    h.state.clock += HOUR;
    await h.hit(result.imageUrl, { "User-Agent": "Mozilla/5.0" });
    h.state.clock += HOUR;
    await h.hit(result.imageUrl);
    await h.hit(result.links[0]?.redirectUrl);
    h.db.sqlite.run("UPDATE messages SET subject = '<script>x</script>'");

    const headers = { "Cf-Access-Jwt-Assertion": await h.accessJwt() };
    const list = await h.call("/app", { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    const listHtml = await list.text();
    expect(listHtml).toContain("alex@example.com");
    expect(listHtml).toContain("&lt;script&gt;");
    expect(listHtml).not.toContain("<script>");
    // The unsent draft's registration is not listed.
    expect(listHtml.match(/<tr>/gu)).toHaveLength(2);
    // First open is the human's, not Apple's prefetch an hour earlier.
    const firstOpen = new Date(h.state.clock)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    expect(listHtml).toContain(`${firstOpen} UTC`);

    const detail = await h.call(`/app/messages/${result.token}`, { headers });
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("proxy or prefetch");
    expect(detailHtml).toContain("probable human");
    expect(detailHtml).toContain("click https://example.org/a");
  });
});

const rowCount = (rows: string): number => rows.match(/<tr>/gu)?.length ?? 0;

describe("dashboard auto-refresh", () => {
  const refreshRoutes = [
    "/app/refresh.js",
    "/app/data",
    `/app/messages/${UNKNOWN_TOKEN}/data`,
  ];
  const refreshed = z.object({ rows: z.string(), updated: z.string() });

  const owner = async () => ({
    "Cf-Access-Jwt-Assertion": await h.accessJwt(),
  });
  const text = async (route: string): Promise<string> => {
    const response = await h.call(route, { headers: await owner() });
    return await response.text();
  };
  const data = async (route: string) => {
    const response = await h.call(route, { headers: await owner() });
    return refreshed.parse(await response.json());
  };

  test.each(refreshRoutes)(
    "refuses %s without an Access assertion",
    async (route) => {
      const response = await h.call(route);
      expect(response.status).toBe(401);
    }
  );

  test.each(refreshRoutes)("refuses %s with the API token", async (route) => {
    const response = await h.call(route, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  test("refuses the data endpoint with a wrong-audience assertion", async () => {
    const jwt = await h.accessJwt({ aud: "other" });
    expect(await status(jwt, "/app/data")).toBe(401);
  });

  test("every /app response carries the strict CSP", async () => {
    const result = await h.mintOk();
    await h.markSent(result.token);
    const headers = await owner();
    const responses = await Promise.all(
      [
        "/app",
        `/app/messages/${result.token}`,
        "/app/data",
        `/app/messages/${result.token}/data`,
        "/app/refresh.js",
      ].map(async (route) => await h.call(route, { headers }))
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toBe(CSP);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    }
  });

  test("pages load only the same-origin script, no inline script or meta refresh", async () => {
    const result = await h.mintOk();
    await h.markSent(result.token);
    const listHtml = await text("/app");
    expect(listHtml.match(/<script\b[^>]*>/gu)).toEqual([
      '<script src="/app/refresh.js" defer>',
    ]);
    expect(listHtml).toContain('data-refresh="/app/data"');
    expect(listHtml).toContain('id="updated"');
    expect(listHtml).not.toContain("http-equiv");
    const detailHtml = await text(`/app/messages/${result.token}`);
    expect(detailHtml).toContain(
      `data-refresh="/app/messages/${result.token}/data"`
    );

    const script = await h.call("/app/refresh.js", { headers: await owner() });
    expect(script.headers.get("Content-Type")).toContain("text/javascript");
    expect(script.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const source = await script.text();
    expect(source).toContain(String(REFRESH_MS));
    expect(source).toContain("visibilitychange");
  });

  test("the data endpoints return fresh, escaped rows and the time", async () => {
    const result = await h.mintOk();
    await h.markSent(result.token);
    h.db.sqlite.run("UPDATE messages SET subject = '<script>x</script>'");
    h.state.clock += HOUR;
    await h.hit(result.imageUrl, { "User-Agent": "Mozilla/5.0" });

    const list = await data("/app/data");
    expect(rowCount(list.rows)).toBe(1);
    expect(list.rows).toContain("&lt;script&gt;");
    expect(list.rows).not.toContain("<script>");
    const clock = new Date(h.state.clock).toISOString().slice(11, 19);
    expect(list.updated).toBe(`${clock} UTC`);

    const route = `/app/messages/${result.token}/data`;
    const before = await data(route);
    await h.hit(result.links[0]?.redirectUrl);
    const after = await data(route);
    expect(rowCount(after.rows)).toBe(rowCount(before.rows) + 1);
    expect(after.rows).toContain("click https://example.org/a");

    const missing = await h.call(`/app/messages/${UNKNOWN_TOKEN}/data`, {
      headers: await owner(),
    });
    expect(missing.status).toBe(404);
  });
});
