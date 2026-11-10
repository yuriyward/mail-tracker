import { beforeEach, describe, expect, test } from "bun:test";

import { Jwt } from "hono/utils/jwt";

import { FORCED_REFRESH_MS } from "../auth";
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
