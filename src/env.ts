/** A value D1 binds or returns for the columns this Worker uses. */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** The subset of the D1 API this Worker uses; Cloudflare's D1Database satisfies it. */
export interface Statement {
  bind: (...values: SqlValue[]) => Statement;
  first: () => Promise<Row | null>;
  all: () => Promise<{ results: Row[] }>;
  run: () => Promise<object>;
}

export interface Db {
  prepare: (query: string) => Statement;
  batch: (statements: Statement[]) => Promise<object[]>;
}

export interface Bindings {
  DB: Db;
  /** Bearer token for writing to /api (the plugin): `wrangler secret put API_TOKEN`. */
  API_TOKEN?: string;
  /** Bearer token for reading /api (the owner's agent): `wrangler secret put API_READ_TOKEN`. */
  API_READ_TOKEN?: string;
  /** Cloudflare Access team domain, e.g. `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application protecting /app. */
  ACCESS_AUD?: string;
  /** Optional comma-separated emails; when set, an Access token must carry one of them. */
  ALLOWED_EMAILS?: string;
  /** Comma-separated IP addresses whose hits count as the sender's own. */
  SELF_IPS?: string;
}

export interface AppEnv {
  Bindings: Bindings;
}

declare global {
  /** Cloudflare adds `cf` to incoming requests; absent elsewhere (e.g. in tests). */
  interface Request {
    readonly cf?: { asOrganization?: string; country?: string };
  }
}
