import { Hono } from "hono";

import { readAuth, writeAuth } from "./auth";
import { recipientTotals } from "./dashboard-data";
import { checkDestination } from "./destinations";
import type { AppEnv } from "./env";
import { forwardingHints } from "./forwarding";
import { tokenSetAddresses } from "./recipients";
import { mintRequest, sentRequest } from "./schema";
import type { MintRequest } from "./schema";
import {
  listMessages,
  markSent,
  messageDetail,
  registerMessage,
} from "./store";
import type { RecipientSet } from "./store";
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

interface MintedLink {
  url: string;
  redirectUrl: string;
}

/** Redirect URLs for the submitted destinations, in their order, from url-to-token pairs. */
const redirects = (
  origin: string,
  submitted: string[],
  tokens: ReadonlyMap<string, string>
): MintedLink[] =>
  submitted.flatMap((url) => {
    const token = tokens.get(url);
    return token === undefined
      ? []
      : [{ redirectUrl: `${origin}/l/${token}`, url }];
  });

/** One recipient's image and links; `address` is '' for a shared copy to several people. */
const mintedSet = (
  origin: string,
  submitted: string[],
  urlOf: ReadonlyMap<string, string>,
  set: RecipientSet
) => ({
  address: set.recipient.address,
  imageUrl: `${origin}/i/${set.recipient.token}.png`,
  links: redirects(
    origin,
    submitted,
    new Map(
      set.links.flatMap((rl) => {
        const url = urlOf.get(rl.link_token);
        return url === undefined ? [] : [[url, rl.token] as const];
      })
    )
  ),
});

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
      recipients: tokenSetAddresses(body.data.recipients, body.data.shared),
      shared: body.data.shared,
      subject: body.data.subject,
    });
    const { token } = registered.message;
    const urlOf = new Map(
      registered.links.map((link) => [link.token, link.url])
    );
    return c.json(
      {
        // Message-level tokens, for callers that do not send `recipients`.
        imageUrl: `${origin}/i/${token}.png`,
        links: redirects(
          origin,
          submitted,
          new Map(registered.links.map((link) => [link.url, link.token]))
        ),
        recipients: registered.recipients.map((set) =>
          mintedSet(origin, submitted, urlOf, set)
        ),
        shared: registered.message.shared === 1,
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

  /**
   * The raw rows, plus per-recipient figures and, on each event, `hint`: the forwarding
   * hint with its reason, or null (src/forwarding.ts).
   */
  app.get("/messages/:token", readAuth, async (c) => {
    const token = c.req.param("token");
    const detail = isToken(token) ? await messageDetail(c.env.DB, token) : null;
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const hints = forwardingHints(detail.recipients, detail.events);
    return c.json({
      events: detail.events.map((e) => ({
        ...e,
        hint: hints.get(e.id) ?? null,
      })),
      links: detail.links,
      message: detail.message,
      recipients: recipientTotals(detail.recipients, detail.events, hints),
    });
  });

  return app;
};
