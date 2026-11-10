import { Hono } from "hono";

import { readAuth, writeAuth } from "./auth";
import { checkDestination } from "./destinations";
import type { AppEnv } from "./env";
import { mintRequest, sentRequest } from "./schema";
import type { MintRequest } from "./schema";
import {
  listMessages,
  markSent,
  messageDetail,
  registerMessage,
} from "./store";
import { isToken, newToken } from "./tokens";

const LIST_LIMIT = 500;

type Checked = { ok: true; links: string[] } | { ok: false; error: string };

/** Every submitted link must pass the redirect allow-list; one bad link rejects the request. */
const checkLinks = (request: MintRequest, ownHost: string): Checked => {
  const links: string[] = [];
  for (const [index, link] of request.links.entries()) {
    const check = checkDestination(link);
    if (!check.ok) {
      return { error: `links[${index}]: ${check.reason}`, ok: false };
    }
    if (new URL(check.url).host === ownHost) {
      return {
        error: `links[${index}]: points at the tracker itself`,
        ok: false,
      };
    }
    links.push(check.url);
  }
  return { links, ok: true };
};

/** The authenticated API: mint tracking for one outgoing email, and read engagement. */
export const apiRoutes = (now: () => number) => {
  const app = new Hono<AppEnv>();

  app.post("/messages", writeAuth, async (c) => {
    const { host, origin } = new URL(c.req.url);
    const body = mintRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const [issue] = body.error.issues;
      const where = issue?.path.join(".") ?? "";
      return c.json(
        {
          error: `${where === "" ? "body" : where}: ${issue?.message ?? "invalid"}`,
        },
        400
      );
    }
    const checked = checkLinks(body.data, host);
    if (!checked.ok) {
      return c.json({ error: checked.error }, 400);
    }
    const submitted = [...new Set(checked.links)];
    const registered = await registerMessage(c.env.DB, {
      at: now(),
      draftId: body.data.draftId,
      links: submitted,
      newToken,
      recipient: body.data.recipient,
      subject: body.data.subject,
    });
    const tokens = new Map(
      registered.links.map((link) => [link.url, link.token])
    );
    const { token } = registered.message;
    return c.json(
      {
        imageUrl: `${origin}/i/${token}`,
        links: submitted.flatMap((url) => {
          const linkToken = tokens.get(url);
          return linkToken === undefined
            ? []
            : [{ redirectUrl: `${origin}/l/${linkToken}`, url }];
        }),
        token,
      },
      registered.created ? 201 : 200
    );
  });

  /** Called after Mailspring reports delivery (retried on failure); the first call wins. */
  app.post("/messages/:token/sent", writeAuth, async (c) => {
    const token = c.req.param("token");
    const body = sentRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: "sentAt must be an integer (ms since epoch)" },
        400
      );
    }
    const found =
      isToken(token) &&
      (await markSent(c.env.DB, token, {
        now: now(),
        reported: body.data.sentAt ?? null,
      }));
    return found ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  app.get("/messages", readAuth, async (c) =>
    c.json({ messages: await listMessages(c.env.DB, LIST_LIMIT) })
  );

  app.get("/messages/:token", readAuth, async (c) => {
    const token = c.req.param("token");
    const detail = isToken(token) ? await messageDetail(c.env.DB, token) : null;
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  return app;
};
