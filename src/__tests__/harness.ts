import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { z } from "zod";

import { createApp } from "../app";
import type { JwksSource } from "../auth";
import type { Bindings, Db } from "../env";
import { eventRow } from "../schema";
import { testDb } from "./d1";

export const ORIGIN = "https://track.example.test";
export const API_TOKEN = "test-api-token";
export const READ_TOKEN = "test-read-token";
export const TEAM = "example-team.cloudflareaccess.com";
export const AUD = "test-audience-tag";
export const KID = "test-kid";
export const OWNER_IP = "203.0.113.9";
export const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";
export const UNKNOWN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
export const HOUR = 3_600_000;
export const START = 1_800_000_000_000;

/** Files of the built app by URL path, as the ASSETS binding serves them. */
export type AppFiles = Record<string, string>;

/** A stand-in for the built app in the ASSETS binding (the real build is tested separately). */
export const APP_FILES = {
  "/app/assets/index-test.js": "console.log('app');",
  "/app/favicon.svg": "<svg></svg>",
  "/app/index.html":
    '<!doctype html><script type="module" src="/app/assets/index-test.js"></script>',
} satisfies AppFiles;

export const minted = z.object({
  imageUrl: z.string(),
  links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
  token: z.string(),
});
export type Minted = z.infer<typeof minted>;

interface KeyPair {
  public: HonoJsonWebKey;
  private: HonoJsonWebKey;
}

const keyPair = async (kid: string): Promise<KeyPair> => {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    private: await crypto.subtle.exportKey("jwk", pair.privateKey),
    public: { ...publicJwk, alg: "RS256", kid },
  };
};

interface AccessPayload {
  aud: string;
  email?: string;
  exp?: number;
  iat: number;
  iss: string;
  sub: string;
}

export interface Claims {
  aud?: string;
  email?: string;
  exp?: number | null;
  iss?: string;
}

/** One isolated Worker with an in-memory D1, a settable clock and Access keys. */
export const createHarness = async () => {
  const keys = await keyPair(KID);
  const jwksCalls: boolean[] = [];
  const state = {
    clock: START,
    /** Keys the JWKS source serves; `rotated` is what a refresh returns. */
    jwks: [keys.public],
    jwksCalls,
    rotated: [keys.public],
  };
  const db = testDb();
  /** Every path the Worker asked the ASSETS binding for. */
  const assetCalls: string[] = [];
  let files = new Map(Object.entries(APP_FILES));
  const env: Bindings & { DB: Db } = {
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: TEAM,
    API_READ_TOKEN: READ_TOKEN,
    API_TOKEN,
    ASSETS: {
      fetch: async (request) => {
        await Promise.resolve();
        const { pathname } = new URL(request.url);
        assetCalls.push(pathname);
        const body = files.get(pathname);
        return body === undefined
          ? new Response("missing", { status: 404 })
          : new Response(body, { headers: { "Content-Type": "text/plain" } });
      },
    },
    DB: db,
    SELF_IPS: OWNER_IP,
  };
  const source: JwksSource = async (_team, refresh) => {
    await Promise.resolve();
    state.jwksCalls.push(refresh);
    return refresh ? state.rotated : state.jwks;
  };
  const app = createApp({ jwks: source, now: () => state.clock });
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    passThroughOnException: () => {
      // Not used by the Worker.
    },
    props: {},
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };

  /**
   * Sends a request and waits for its background work (event recording). `cf` stands in
   * for the facts Cloudflare attaches to a request (network, country).
   */
  const call = async (
    route: string,
    init: RequestInit = {},
    cf?: Request["cf"]
  ): Promise<Response> => {
    const request = new Request(`${ORIGIN}${route}`, init);
    if (cf) {
      Object.defineProperty(request, "cf", { value: cf });
    }
    const response = await app.request(request, undefined, env, executionCtx);
    await Promise.all(pending.splice(0));
    return response;
  };

  const mint = async (body: string, token = API_TOKEN): Promise<Response> =>
    await call("/api/messages", {
      body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

  const mintOk = async (
    links = ["https://example.org/a", "https://example.org/b"],
    draftId = "<draft-1@example.test>"
  ): Promise<Minted> => {
    const response = await mint(
      JSON.stringify({
        draftId,
        links,
        recipient: "alex@example.com",
        subject: "Proposal",
      })
    );
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`mint failed with ${response.status}`);
    }
    return minted.parse(await response.json());
  };

  const markSent = async (token: string, sentAt?: number): Promise<Response> =>
    await call(`/api/messages/${token}/sent`, {
      body: JSON.stringify(sentAt === undefined ? {} : { sentAt }),
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

  const hit = async (
    url: string | undefined,
    headers: Record<string, string> = {},
    cf?: Request["cf"]
  ): Promise<Response> =>
    await call(
      new URL(url ?? "", ORIGIN).pathname,
      { headers: { "User-Agent": BROWSER, ...headers } },
      cf
    );

  const rows = (sql: string): unknown[] => db.sqlite.query(sql).all();

  const events = () =>
    z.array(eventRow).parse(rows("SELECT * FROM events ORDER BY id"));

  const accessJwt = async (
    claims: Claims = {},
    kid = KID,
    signer = keys
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const { exp = now + 600 } = claims;
    const payload: AccessPayload = {
      aud: claims.aud ?? AUD,
      iat: now,
      iss: claims.iss ?? `https://${TEAM}`,
      sub: "owner",
    };
    if (claims.email !== undefined) {
      payload.email = claims.email;
    }
    if (exp !== null) {
      payload.exp = exp;
    }
    return await Jwt.sign(
      { ...payload },
      { ...signer.private, alg: "RS256", kid },
      "RS256"
    );
  };

  /** GETs from /api with the read-only token. */
  const read = async (route: string, token = READ_TOKEN): Promise<Response> =>
    await call(route, { headers: { Authorization: `Bearer ${token}` } });

  /** Serves these files from ASSETS instead of APP_FILES. */
  const serveFiles = (next: AppFiles) => {
    files = new Map(Object.entries(next));
  };

  return {
    accessJwt,
    assetCalls,
    call,
    db,
    env,
    events,
    hit,
    keyPair,
    markSent,
    mint,
    mintOk,
    read,
    rows,
    serveFiles,
    state,
  };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;
