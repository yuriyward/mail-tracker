import type { MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { timingSafeEqual } from "hono/utils/buffer";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { z } from "zod";

import type { AppEnv, Bindings } from "./env";

const tokenAuth = (
  pick: (env: Bindings) => string | undefined
): MiddlewareHandler<AppEnv> =>
  bearerAuth<AppEnv>({
    verifyToken: async (token, c) => {
      const expected = pick(c.env) ?? "";
      return expected !== "" && (await timingSafeEqual(token, expected));
    },
  });

/** Writes to /api (the plugin): API_TOKEN, compared in constant time; unset means no access. */
export const writeAuth = tokenAuth((env) => env.API_TOKEN);

/** Reads from /api (the owner's agent): API_READ_TOKEN only; it cannot register or mark sent. */
export const readAuth = tokenAuth((env) => env.API_READ_TOKEN);

/** The team's signing keys; `refresh` bypasses any cache (used once on an unknown key id). */
export type JwksSource = (
  teamDomain: string,
  refresh: boolean
) => Promise<HonoJsonWebKey[]>;

const jwks = z.object({
  keys: z.array(z.looseObject({ kid: z.string(), kty: z.string() })),
});

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<
  string,
  { keys: HonoJsonWebKey[]; fetchedAt: number }
>();

/** Fetches the Access team's signing keys, cached per isolate for ten minutes. */
export const fetchAccessJwks: JwksSource = async (teamDomain, refresh) => {
  const cached = jwksCache.get(teamDomain);
  if (!refresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Access JWKS fetch failed with ${response.status}`);
  }
  const { keys } = jwks.parse(await response.json());
  jwksCache.set(teamDomain, { fetchedAt: Date.now(), keys });
  return keys;
};

/** A forced refresh (on an unknown key id) happens at most this often per team. */
export const FORCED_REFRESH_MS = 60_000;

/**
 * Limits forced JWKS refreshes, so made-up key ids on the public routes cannot make the
 * Worker fetch the team's keys on every hit. State is per isolate.
 */
export const limitRefresh = (
  source: JwksSource,
  now: () => number
): JwksSource => {
  const lastForced = new Map<string, number>();
  return async (teamDomain, refresh) => {
    const last = lastForced.get(teamDomain);
    const allowed =
      refresh && (last === undefined || now() - last >= FORCED_REFRESH_MS);
    if (allowed) {
      lastForced.set(teamDomain, now());
    }
    return await source(teamDomain, allowed);
  };
};

/** Claims Cloudflare Access always sets; `exp` must be present, not only valid when given. */
const accessClaims = z.object({
  email: z.string().optional(),
  exp: z.number(),
});

const keysFor = async (
  assertion: string,
  teamDomain: string,
  source: JwksSource
): Promise<HonoJsonWebKey[]> => {
  const { kid } = Jwt.decode(assertion).header;
  const keys = await source(teamDomain, false);
  // An unknown kid may mean the keys rotated; the source decides whether to refetch.
  return keys.some((key) => key.kid === kid)
    ? keys
    : await source(teamDomain, true);
};

const emailAllowed = (email: string | undefined, env: Bindings): boolean => {
  const allowed = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return (
    allowed.length === 0 ||
    (email !== undefined && allowed.includes(email.toLowerCase()))
  );
};

/**
 * Verifies a Cloudflare Access token: RS256 signature from the team's keys, issuer,
 * audience, a required expiry, and (if ALLOWED_EMAILS is set) the email claim.
 * Unconfigured or failing means false.
 */
export const verifyAccess = async (
  assertion: string,
  env: Bindings,
  source: JwksSource
): Promise<boolean> => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
  const audience = env.ACCESS_AUD ?? "";
  if (teamDomain === "" || audience === "" || assertion === "") {
    return false;
  }
  try {
    const payload = await Jwt.verifyWithJwks(assertion, {
      allowedAlgorithms: ["RS256"],
      keys: await keysFor(assertion, teamDomain, source),
      verification: { aud: audience, exp: true, iss: `https://${teamDomain}` },
    });
    const claims = accessClaims.safeParse(payload);
    return claims.success && emailAllowed(claims.data.email, env);
  } catch {
    return false;
  }
};

/**
 * /app: Cloudflare Access sits in front and adds `Cf-Access-Jwt-Assertion`; the Worker
 * verifies it so a request that bypasses Access (for example via workers.dev) is refused.
 */
export const accessAuth = (source: JwksSource): MiddlewareHandler<AppEnv> =>
  bearerAuth<AppEnv>({
    headerName: "Cf-Access-Jwt-Assertion",
    prefix: "",
    verifyToken: async (assertion, c) =>
      await verifyAccess(assertion, c.env, source),
  });
