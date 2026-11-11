import { Hono } from "hono";

import { readAuth, writeAuth } from "./auth";
import { eventDisplay } from "./classify";
import { recipientTotals } from "./dashboard-data";
import { checkDestination } from "./destinations";
import type { AppEnv, Db } from "./env";
import { forwardingHints } from "./forwarding";
import { cleanLinkText, linkName } from "./link-names";
import { tokenSetAddresses } from "./recipients";
import { mintRequest, sentRequest } from "./schema";
import type { MintRequest } from "./schema";
import {
  markSent,
  pixelOwner,
  registerMessage,
  tokenSetLinks,
  unsentImageTokens,
} from "./store";
import type { RecipientSet } from "./store";
import { isToken, newToken } from "./tokens";
import { detailView, listView, peopleView, personView } from "./views";
import type { ListView } from "./views";

const LIST_LIMIT = 500;

type Checked =
  | { ok: true; links: string[]; text: Map<string, string> }
  | { ok: false; error: string };

/** Link text by normalised URL; keys that are not a valid destination are ignored. */
const linkTexts = (raw: Record<string, string>): Map<string, string> => {
  const texts = new Map<string, string>();
  for (const [url, text] of Object.entries(raw)) {
    const check = checkDestination(url);
    const clean = cleanLinkText(text);
    if (check.ok && clean !== "" && !texts.has(check.url)) {
      texts.set(check.url, clean);
    }
  }
  return texts;
};

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
  return { links, ok: true, text: linkTexts(request.linkText) };
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

/**
 * The message an agent's composed draft already carries tracking for (ADR-0004): the
 * owner of the draft's image token, and that token set's redirects, so the plugin can
 * swap them for each recipient's own. Null when there is no known image token.
 */
const adoption = async (
  db: Db,
  origin: string,
  pixelToken: string | null | undefined
) => {
  if (pixelToken === null || pixelToken === undefined || !isToken(pixelToken)) {
    return null;
  }
  const owner = await pixelOwner(db, pixelToken);
  if (!owner) {
    return null;
  }
  const links = await tokenSetLinks(db, pixelToken);
  return {
    carried: {
      imageUrl: `${origin}/i/${pixelToken}.png`,
      links: links.map((link) => ({
        redirectUrl: `${origin}/l/${link.token}`,
        url: link.url,
      })),
    },
    draftId: owner.draft_id,
  };
};

/** The list rows of the read API; with `unsent`, each email's image tokens too. */
const listRows = (view: ListView, imageTokens: Map<string, string[]> | null) =>
  view.summaries.map((m, index) => {
    const row = {
      ...m,
      addresses: view.messages[index]?.addresses ?? [],
      last_reopen: view.messages[index]?.lastReopen ?? null,
      reopens: view.messages[index]?.reopens ?? 0,
    };
    if (imageTokens === null) {
      return row;
    }
    return { ...row, image_tokens: imageTokens.get(m.token) ?? [m.token] };
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
    const adopted = await adoption(c.env.DB, origin, body.data.pixelToken);
    const registered = await registerMessage(c.env.DB, {
      at: now(),
      draftId: adopted?.draftId ?? body.data.draftId,
      draftTracked: body.data.draftTracked,
      links: [...new Set(checked.links)].map((url) => ({
        text: checked.text.get(url) ?? "",
        url,
      })),
      newToken,
      recipient: body.data.recipient,
      recipients: tokenSetAddresses(body.data.recipients, body.data.shared),
      shared: body.data.shared,
      subject: body.data.subject,
    });
    const { token } = registered.message;
    // An adopted draft's sets also cover the links it already carries as redirects.
    const submitted = [
      ...new Set([
        ...checked.links,
        ...(adopted?.carried.links.map((link) => link.url) ?? []),
      ]),
    ];
    const urlOf = new Map(
      registered.links.map((link) => [link.token, link.url])
    );
    return c.json(
      {
        // The token set the draft carried (null unless adopted by `pixelToken`).
        carried: adopted?.carried ?? null,
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

  /**
   * The rows, plus `addresses` (current recipients), `reopens` and `last_reopen` (the
   * re-open signal, src/reopen.ts) per email.
   */
  app.get("/messages", readAuth, async (c) => {
    const unsent = c.req.query("unsent") === "1";
    const [view, imageTokens] = await Promise.all([
      listView(c.env.DB, LIST_LIMIT, unsent ? "unsent" : "listed"),
      unsent ? unsentImageTokens(c.env.DB) : null,
    ]);
    return c.json({ messages: listRows(view, imageTokens) });
  });

  /** One row per recipient address across all emails (src/people.ts). */
  app.get("/people", readAuth, async (c) =>
    c.json({ people: await peopleView(c.env.DB) })
  );

  /** One person's figures and their emails; 404 for an address on no listed email. */
  app.get("/people/:address", readAuth, async (c) => {
    const view = await personView(c.env.DB, c.req.param("address"));
    return view ? c.json(view) : c.json({ error: "not found" }, 404);
  });

  /**
   * The raw rows, plus per-recipient figures and, on each event, `hint`: the forwarding
   * hint with its reason, or null (src/forwarding.ts), and `preloadHint`: "possibly
   * preloaded by Gmail" with why, or null (src/preload.ts).
   */
  app.get("/messages/:token", readAuth, async (c) => {
    const view = await detailView(c.env.DB, c.req.param("token"));
    if (!view) {
      return c.json({ error: "not found" }, 404);
    }
    const { detail, preloads } = view;
    const hints = forwardingHints(detail.recipients, detail.events);
    return c.json({
      // `label`, `via`: the plain label, "Draft preview" for a preview (ADR-0004).
      events: detail.events.map((e) => ({
        ...e,
        ...eventDisplay(e),
        hint: hints.get(e.id) ?? null,
        preloadHint: preloads.get(e.id) ?? null,
      })),
      // `name`: the link's text in the email, else its domain.
      links: detail.links.map((link) => ({
        ...link,
        name: linkName(link.url, link.text),
      })),
      message: detail.message,
      recipients: recipientTotals(
        detail.recipients,
        detail.events,
        hints,
        preloads
      ),
    });
  });

  return app;
};
