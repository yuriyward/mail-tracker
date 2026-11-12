import type { JsonValue } from "mailspring-exports";
import { z } from "zod";

import { lookup } from "./registry";
import type { ConfigStore } from "./registry";
import { trackerOrigin } from "./settings";
import type { Settings } from "./settings";
import type { Transport } from "./transport";

export const READ_REFRESH_MS = 60_000;
const event = z.object({
  at: z.number(),
  class: z.string(),
  counted: z.number(),
  country: z.string(),
  duplicate: z.number(),
  hint: z.string().nullable(),
  kind: z.enum(["open", "click"]),
  label: z.string(),
  link_token: z.string().nullable(),
  preloadHint: z.string().nullable(),
  recipient_token: z.string().nullable(),
  user_agent: z.string(),
  via: z.string().nullable(),
});
export const readDetail = z.object({
  events: z.array(event),
  links: z.array(
    z.object({ name: z.string(), token: z.string(), url: z.string() })
  ),
  message: z.object({ shared: z.number(), token: z.string() }),
  recipients: z.array(
    z.object({
      address: z.string(),
      clicks: z.number(),
      current: z.boolean(),
      opens: z.number(),
      token: z.string(),
    })
  ),
});
export type ReadDetail = z.infer<typeof readDetail>;

export interface ReadMessage {
  id?: string;
  headerMessageId: string;
  draft: boolean;
  body?: string;
  categories?: () => { role: string }[];
}

/** Only our origin and top-level markup: never resolve a quoted correspondent's tracker. */
export const bodyToken = (body: string, origin: string): string | null => {
  const root = new DOMParser().parseFromString(body, "text/html");
  for (const node of root.querySelectorAll("img[src], a[href]")) {
    if (node.closest("blockquote, .gmail_quote")) {
      continue;
    }
    const raw =
      node.getAttribute(node.tagName === "IMG" ? "src" : "href") ?? "";
    if (!URL.canParse(raw)) {
      continue;
    }
    const url = new URL(raw);
    if (url.origin !== origin) {
      continue;
    }
    const match =
      /^\/(?:i\/(?<image>[\w-]{22})\.png|l\/(?<link>[\w-]{22}))$/u.exec(
        url.pathname
      );
    if (match) {
      return match.groups?.image ?? match.groups?.link ?? null;
    }
  }
  return null;
};

/** Each endpoint caches successes and failures, coalescing concurrent requests. */
export const createReadClient = (options: {
  settings: () => Settings;
  config: ConfigStore;
  transport: Transport;
  now: () => number;
  loadBody: (message: ReadMessage) => Promise<string>;
}) => {
  const cache = new Map<
    string,
    { at: number; result: Promise<JsonValue | null> }
  >();
  const get = async (path: string): Promise<JsonValue | null> => {
    const settings = options.settings();
    const origin = trackerOrigin(settings);
    const token = settings.readToken ?? "";
    if (origin === null || token === "") {
      return null;
    }
    const key = `${origin}:${token}:${path}`;
    const existing = cache.get(key);
    if (existing && options.now() - existing.at < READ_REFRESH_MS) {
      return await existing.result;
    }
    const result = (async () => {
      try {
        const response = await options.transport({
          method: "GET",
          token,
          url: `${origin}/api/${path}`,
        });
        return response.status === 200
          ? z.json().parse(JSON.parse(response.body))
          : null;
      } catch {
        return null;
      }
    })();
    cache.set(key, { at: options.now(), result });
    return await result;
  };
  const resolveBody = async (message: ReadMessage): Promise<string | null> => {
    if (
      message.categories?.().some((category) => category.role === "sent") !==
      true
    ) {
      return null;
    }
    const origin = trackerOrigin(options.settings());
    if (origin === null || (options.settings().readToken ?? "") === "") {
      return null;
    }
    const carried = bodyToken(
      message.body ?? (await options.loadBody(message)),
      origin
    );
    if (carried === null) {
      return null;
    }
    const target = z
      .object({ message: z.string() })
      .safeParse(await get(`tokens/${carried}`));
    if (!target.success) {
      return null;
    }
    return target.data.message;
  };
  return {
    clear: () => {
      cache.clear();
    },
    list: async () => {
      const parsed = z
        .object({
          messages: z.array(
            z.object({
              clicks: z.number(),
              opens: z.number(),
              token: z.string(),
            })
          ),
        })
        .safeParse(await get("messages"));
      return parsed.success ? parsed.data.messages : [];
    },
    read: async (message: ReadMessage): Promise<ReadDetail | null> => {
      try {
        if (message.draft) {
          return null;
        }
        const token =
          lookup(options.config, message.headerMessageId)?.token ??
          (await resolveBody(message));
        if (token === null) {
          return null;
        }
        const detail = readDetail.safeParse(
          await get(`messages/${encodeURIComponent(token)}`)
        );
        return detail.success ? detail.data : null;
      } catch {
        return null;
      }
    },
  };
};
