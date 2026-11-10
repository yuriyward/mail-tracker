import type { JsonValue } from "mailspring-exports";
import { z } from "zod";

export const CONFIG_KEY = "mail-tracker";

const record = z.record(z.string(), z.json());
const text = z.string();
const flag = z.boolean();

export interface Settings {
  enabled: boolean;
  apiUrl: string;
  apiToken: string;
}

/** Settings as stored in Mailspring's config; anything missing or malformed takes its default. */
export const readSettings = (stored: JsonValue | undefined): Settings => {
  const parsed = record.safeParse(stored);
  const value = parsed.success ? parsed.data : {};
  const apiToken = text.safeParse(value.apiToken);
  const apiUrl = text.safeParse(value.apiUrl);
  const enabled = flag.safeParse(value.enabled);
  return {
    apiToken: apiToken.success ? apiToken.data.trim() : "",
    /** Base URL of the Worker, e.g. https://track.example.com */
    apiUrl: apiUrl.success ? apiUrl.data.trim().replace(/\/+$/u, "") : "",
    enabled: enabled.success ? enabled.data : true,
  };
};

export const toStored = (settings: Settings): JsonValue => ({ ...settings });

/** The Worker's origin, or null unless the setting is a parseable https URL with a host. */
export const trackerOrigin = (settings: Settings): string | null => {
  if (!URL.canParse(settings.apiUrl)) {
    return null;
  }
  const url = new URL(settings.apiUrl);
  return url.protocol === "https:" && url.hostname !== "" ? url.origin : null;
};

/** Why tracking is skipped for these settings, or null when it should run. */
export const skipReason = (settings: Settings): string | null => {
  if (!settings.enabled) {
    return "disabled";
  }
  if (trackerOrigin(settings) === null || settings.apiToken === "") {
    return "Worker URL (https) or API token not set";
  }
  return null;
};
