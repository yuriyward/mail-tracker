/**
 * The Worker's API as the command-line tools call it (`bun run compose`, `bun run sync-sent`),
 * and where they find the Worker URL and tokens. Tests pass a `fetch` that calls the Worker
 * app in memory.
 */
import { readFileSync } from "node:fs";

import type { z } from "zod";

import type { mintRequest, sentRequest } from "../schema";

export type Fetch = (request: Request) => Promise<Response>;

/** What the tools send: a registration, or a send time. */
export type ApiBody = z.input<typeof mintRequest> | z.input<typeof sentRequest>;

export interface Client {
  origin: string;
  /** POSTs JSON with the write token; answers the status and the parsed body (or null). */
  post: (path: string, body: ApiBody) => Promise<ApiAnswer>;
  /** GETs with the read-only token. */
  get: (path: string) => Promise<ApiAnswer>;
}

export interface ApiAnswer {
  status: number;
  body: unknown;
}

const answer = async (response: Response): Promise<ApiAnswer> => ({
  body: await response.json().catch(() => null),
  status: response.status,
});

export const createClient = (options: {
  origin: string;
  writeToken: string;
  readToken: string;
  fetch: Fetch;
}): Client => ({
  get: async (path) =>
    await answer(
      await options.fetch(
        new Request(`${options.origin}${path}`, {
          headers: { Authorization: `Bearer ${options.readToken}` },
        })
      )
    ),
  origin: options.origin,
  post: async (path, body) =>
    await answer(
      await options.fetch(
        new Request(`${options.origin}${path}`, {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${options.writeToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      )
    ),
});

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** https, or plain http on this machine only (a local Worker, as in `wrangler dev`). */
const allowed = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && LOOPBACK.has(url.hostname));

/** The Worker's origin from a setting, or an error naming what is wrong. */
export const workerOrigin = (value: string | undefined): string => {
  const text = value?.trim() ?? "";
  if (!URL.canParse(text) || !allowed(new URL(text))) {
    throw new Error(
      "set the Worker URL (https) with --url or MAIL_TRACKER_URL"
    );
  }
  return new URL(text).origin;
};

/**
 * A token from the environment variable `name`, else from the file named by `--<flag>` or
 * by `<name>_FILE`. Never printed.
 */
export const readToken = (
  env: Record<string, string | undefined>,
  name: string,
  file: string | undefined
): string => {
  const direct = env[name]?.trim() ?? "";
  if (direct !== "") {
    return direct;
  }
  const path = file ?? env[`${name}_FILE`];
  const fromFile =
    path === undefined || path === "" ? "" : readFileSync(path, "utf-8").trim();
  if (fromFile === "") {
    throw new Error(`set ${name}, or ${name}_FILE to a file holding it`);
  }
  return fromFile;
};
