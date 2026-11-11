import { Hono } from "hono";
import type { Context } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";

import { accessAuth } from "./auth";
import type { JwksSource } from "./auth";
import {
  messageTotals,
  timelineContext,
  timelineEvent,
} from "./dashboard-data";
import type {
  DetailData,
  ListData,
  PeopleData,
  PersonData,
} from "./dashboard-data";
import type { AppEnv, Db } from "./env";
import { forwardingHints } from "./forwarding";
import { messageDetail } from "./store";
import type { MessageDetail } from "./store";
import { isToken } from "./tokens";
import { listView, peopleView, personView } from "./views";

export { REFRESH_MS } from "./dashboard-data";

const LIST_LIMIT = 200;

/**
 * The built app (web/) loads its script, styles, fonts and icon from this origin only; no
 * inline script or style element, no third-party origin.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY = {
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const HEADERS = { ...SECURITY, "Cache-Control": "no-store" };
/** Vite names files under /app/assets/ by content hash, so they never change. */
const IMMUTABLE = "private, max-age=31536000, immutable";

/** The app's shell; it routes /app, /app/messages/:token and /app/people… in the browser. */
const INDEX = "/app/index.html";

const listData = async (db: Db, now: number): Promise<ListData> => {
  const { messages } = await listView(db, LIST_LIMIT);
  return { messages, updated: now };
};

const peopleData = async (db: Db, now: number): Promise<PeopleData> => ({
  people: await peopleView(db),
  updated: now,
});

const personData = async (
  db: Db,
  address: string,
  now: number
): Promise<PersonData | null> => {
  const view = await personView(db, address);
  return view ? { ...view, updated: now } : null;
};

const detailData = (detail: MessageDetail, now: number): DetailData => {
  const { message, links, recipients, events } = detail;
  const hints = forwardingHints(recipients, events);
  const context = timelineContext(links, recipients, events, hints);
  return {
    message: {
      recipient: message.recipient,
      sentAt: message.sent_at,
      shared: message.shared === 1,
      subject: message.subject,
      token: message.token,
    },
    timeline: events.map((e) => timelineEvent(e, context)),
    totals: messageTotals({ events, hints, links, recipients }),
    updated: now,
  };
};

const findDetail = async (
  db: Db,
  token: string
): Promise<MessageDetail | null> =>
  isToken(token) ? await messageDetail(db, token) : null;

/**
 * Reads one file of the built app from the Workers Assets binding. Only reached after
 * accessAuth; wrangler.toml runs the Worker first, so Cloudflare never serves these directly.
 */
const serveAsset = async (
  c: Context<AppEnv>,
  path: string,
  cacheControl: string
): Promise<Response> => {
  const assets = c.env.ASSETS;
  if (!assets) {
    return c.text("The app is not built or not bound (ASSETS)", 500, HEADERS);
  }
  const response = await assets.fetch(new Request(new URL(path, c.req.url)));
  if (!response.ok) {
    return c.text("Not found", 404, HEADERS);
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY)) {
    headers.set(name, value);
  }
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { headers, status: 200 });
};

/** The per-email dashboard; Cloudflare Access authenticates, the Worker verifies. */
export const dashboardRoutes = (now: () => number, jwks: JwksSource) => {
  const app = new Hono<AppEnv>();
  app.use("*", accessAuth(jwks));
  // After Access: /app/ and /app/messages/:token/ redirect to the path without the slash.
  app.use("*", trimTrailingSlash());

  const shell = async (c: Context<AppEnv>) =>
    await serveAsset(c, INDEX, "no-store");
  app.get("/", shell);
  app.get("/messages/:token", shell);
  app.get("/people", shell);
  // Data routes first: an address always has an "@", so it never reads as "data".
  app.get("/people/data", async (c) =>
    c.json(await peopleData(c.env.DB, now()), 200, HEADERS)
  );
  app.get("/people/:address", shell);

  app.get(
    "/assets/:file",
    async (c) =>
      await serveAsset(c, `/app/assets/${c.req.param("file")}`, IMMUTABLE)
  );
  app.get(
    "/favicon.svg",
    async (c) => await serveAsset(c, "/app/favicon.svg", "no-store")
  );

  app.get("/data", async (c) =>
    c.json(await listData(c.env.DB, now()), 200, HEADERS)
  );

  app.get("/messages/:token/data", async (c) => {
    const detail = await findDetail(c.env.DB, c.req.param("token"));
    return detail
      ? c.json(detailData(detail, now()), 200, HEADERS)
      : c.json({ error: "not found" }, 404, HEADERS);
  });

  app.get("/people/:address/data", async (c) => {
    const data = await personData(c.env.DB, c.req.param("address"), now());
    return data
      ? c.json(data, 200, HEADERS)
      : c.json({ error: "not found" }, 404, HEADERS);
  });

  return app;
};
