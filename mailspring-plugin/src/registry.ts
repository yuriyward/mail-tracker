import type { JsonValue } from "mailspring-exports";
import { z } from "zod";

/**
 * Config subtrees, one key per draft: `<root>.<draft key>`. Mailspring's config applies a
 * key path as a single write in the main process, so windows writing different drafts
 * never overwrite each other (no read-modify-write of a shared map).
 */
export const REGISTRATIONS_KEY = "mail-tracker-registrations";
export const PENDING_SENT_KEY = "mail-tracker-pending-sent";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Mailspring's AppEnv.config, reduced to what the plugin uses. */
export interface ConfigStore {
  get: (keyPath: string) => JsonValue | undefined;
  set: (keyPath: string, value: JsonValue | undefined) => void;
}

const registration = z.object({
  draftId: z.string(),
  /** What was registered (subject, recipients, URLs); see snapshot.ts. */
  fingerprint: z.string(),
  imageUrl: z.string(),
  /** Normalised destination URL to its redirect URL. */
  links: z.record(z.string(), z.string()),
  savedAt: z.number(),
  token: z.string(),
});
export type Registration = z.infer<typeof registration>;

const pendingSent = z.object({
  attempts: z.number(),
  draftId: z.string(),
  sentAt: z.number(),
  token: z.string(),
});
export type PendingSent = z.infer<typeof pendingSent>;

/** A config-safe key for a draft id: base64url, so no dots split the key path. */
export const draftKey = (draftId: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(draftId)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

const readOne = <S extends z.ZodType>(
  config: ConfigStore,
  root: string,
  draftId: string,
  schema: S
): z.infer<S> | null => {
  const parsed = schema.safeParse(config.get(`${root}.${draftKey(draftId)}`));
  return parsed.success ? parsed.data : null;
};

const readAll = <S extends z.ZodType>(
  config: ConfigStore,
  root: string,
  schema: S
): z.infer<S>[] => {
  const parsed = z.record(z.string(), z.json()).safeParse(config.get(root));
  const values = parsed.success ? Object.values(parsed.data) : [];
  return values.flatMap((value) => {
    const entry = schema.safeParse(value);
    return entry.success ? [entry.data] : [];
  });
};

/** The tokens registered for a draft, read synchronously at send time. */
export const lookup = (
  config: ConfigStore,
  draftId: string
): Registration | null =>
  readOne(config, REGISTRATIONS_KEY, draftId, registration);

export const save = (config: ConfigStore, entry: Registration): void => {
  config.set(`${REGISTRATIONS_KEY}.${draftKey(entry.draftId)}`, { ...entry });
};

/** Drops registrations older than 30 days; run by the main window only. */
export const prune = (config: ConfigStore, now: number): void => {
  for (const entry of readAll(config, REGISTRATIONS_KEY, registration)) {
    if (now - entry.savedAt >= KEEP_MS) {
      config.set(`${REGISTRATIONS_KEY}.${draftKey(entry.draftId)}`, undefined);
    }
  }
};

export const pending = (config: ConfigStore): PendingSent[] =>
  readAll(config, PENDING_SENT_KEY, pendingSent);

export const setPending = (
  config: ConfigStore,
  entry: PendingSent | null,
  draftId: string
): void => {
  config.set(
    `${PENDING_SENT_KEY}.${draftKey(draftId)}`,
    entry === null ? undefined : { ...entry }
  );
};
