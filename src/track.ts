import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { verifyAccess } from "./auth";
import type { JwksSource } from "./auth";
import { classify } from "./classify";
import type { Hit } from "./classify";
import { checkDestination } from "./destinations";
import type { AppEnv } from "./env";
import {
  countOtherLinksInBurst,
  findLink,
  findPixel,
  insertEvent,
} from "./store";
import { isToken } from "./tokens";

/** A transparent 1x1 PNG, served at `/i/<token>.png` like Mailspring's own image (ADR-0003). */
const PIXEL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
  ),
  (ch) => ch.codePointAt(0) ?? 0
);

const NO_STORE = "no-store, no-cache, must-revalidate, private, max-age=0";

const requestFacts = (c: Context<AppEnv>) => {
  const { cf } = c.req.raw;
  return {
    asOrganization: cf?.asOrganization ?? "",
    country: cf?.country ?? "",
    ip: c.req.header("CF-Connecting-IP") ?? "",
    method: c.req.method,
    userAgent: c.req.header("User-Agent") ?? "",
  };
};

const selfIps = (c: Context<AppEnv>): string[] =>
  (c.env.SELF_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip !== "");

/** The owner's own Access token, from the header or Access's cookie, verified like /app. */
const ownerVerified = async (
  c: Context<AppEnv>,
  jwks: JwksSource
): Promise<boolean> => {
  const assertion =
    c.req.header("Cf-Access-Jwt-Assertion") ??
    getCookie(c, "CF_Authorization") ??
    "";
  return await verifyAccess(assertion, c.env, jwks);
};

interface Target {
  messageToken: string;
  linkToken: string | null;
  recipientToken: string | null;
  sentAt: number;
}

const record = async (
  c: Context<AppEnv>,
  jwks: JwksSource,
  at: number,
  target: Target
): Promise<void> => {
  const facts = requestFacts(c);
  const { linkToken, messageToken } = target;
  const kind = linkToken === null ? "open" : "click";
  const otherLinksInBurst =
    linkToken === null
      ? 0
      : await countOtherLinksInBurst(c.env.DB, {
          at,
          ip: facts.ip,
          linkToken,
          messageToken,
          userAgent: facts.userAgent,
        });
  const hit: Hit = {
    ...facts,
    ageMs: at - target.sentAt,
    kind,
    otherLinksInBurst,
    ownerVerified: await ownerVerified(c, jwks),
    selfIps: selfIps(c),
  };
  const result = classify(hit);
  await insertEvent(c.env.DB, {
    as_organization: facts.asOrganization,
    at,
    class: result.class,
    counted: result.counted ? 1 : 0,
    country: facts.country,
    ip: facts.ip,
    kind,
    link_token: linkToken,
    message_token: messageToken,
    method: facts.method,
    reason: result.reason,
    recipient_token: target.recipientToken,
    user_agent: facts.userAgent,
  });
};

/**
 * Runs analytics after the response, so a failing D1 write never breaks the image or
 * the redirect. Errors are logged, not thrown.
 */
const inBackground = (c: Context<AppEnv>, work: () => Promise<void>): void => {
  const task = (async () => {
    try {
      await work();
    } catch (error) {
      console.error("mail-tracker: recording failed", error);
    }
  })();
  c.executionCtx.waitUntil(task);
};

/** The only public routes: the tracking image and the link redirect. */
export const trackRoutes = (now: () => number, jwks: JwksSource) => {
  const app = new Hono<AppEnv>();

  app.get("/i/:token", (c) => {
    // `.png` is what the plugin writes; bare and `.gif` tokens come from older emails.
    const token = c.req.param("token").replace(/\.(?:png|gif)$/u, "");
    const at = now();
    if (isToken(token)) {
      inBackground(c, async () => {
        const pixel = await findPixel(c.env.DB, token);
        if (pixel) {
          await record(c, jwks, at, {
            linkToken: null,
            messageToken: pixel.message_token,
            recipientToken: pixel.recipient_token,
            sentAt: pixel.sent_at,
          });
        }
      });
    }
    // Unknown tokens get the same image, so the route reveals nothing about which exist.
    return c.body(PIXEL, 200, {
      "Cache-Control": NO_STORE,
      "Content-Type": "image/png",
      Expires: "0",
      Pragma: "no-cache",
    });
  });

  app.get("/l/:token", async (c) => {
    const token = c.req.param("token");
    const at = now();
    const link = isToken(token) ? await findLink(c.env.DB, token) : null;
    const destination = link ? checkDestination(link.url) : null;
    if (!link || destination?.ok !== true) {
      return c.text("Not found", 404, { "Cache-Control": NO_STORE });
    }
    inBackground(c, async () => {
      await record(c, jwks, at, {
        linkToken: link.token,
        messageToken: link.message_token,
        recipientToken: link.recipient_token,
        sentAt: link.sent_at,
      });
    });
    return c.body(null, 302, {
      "Cache-Control": NO_STORE,
      Location: destination.url,
      "Referrer-Policy": "no-referrer",
    });
  });

  return app;
};
