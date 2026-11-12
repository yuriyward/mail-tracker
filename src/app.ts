import { Hono } from "hono";

import { apiRoutes } from "./api";
import { fetchAccessJwks, limitRefresh } from "./auth";
import type { JwksSource } from "./auth";
import { dashboardRoutes } from "./dashboard";
import type { AppEnv } from "./env";
import type { HostLookup } from "./mail-host";
import { trackRoutes } from "./track";

export interface AppOptions {
  now?: () => number;
  mailHost?: HostLookup;
  jwks?: JwksSource;
}

export const createApp = (options: AppOptions = {}) => {
  const now = options.now ?? Date.now;
  const app = new Hono<AppEnv>();
  const jwks = limitRefresh(options.jwks ?? fetchAccessJwks, now);
  app.route("/", trackRoutes(now, jwks));
  app.route("/api", apiRoutes(now, options.mailHost));
  app.route("/app", dashboardRoutes(now, jwks));
  app.notFound((c) => c.text("Not found", 404));
  return app;
};
