import type { Message } from "mailspring-exports";
import { z } from "zod";

import { autolink } from "./autolink";
import { lookup, pending, save, setPending } from "./registry";
import type { ConfigStore, PendingSent, Registration } from "./registry";
import { skipReason, trackerOrigin } from "./settings";
import type { Settings } from "./settings";
import { fingerprint, snapshot } from "./snapshot";
import type { Transport } from "./transport";

/** Wait this long after the last edit in a composer before registering the draft. */
export const DEBOUNCE_MS = 2000;

/** Delays between attempts to report a delivery; then the notice is dropped and logged. */
export const SENT_RETRY_MS = [
  10_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

export interface TrackerDeps {
  settings: () => Settings;
  /** The draft's account sends one body to all recipients (Microsoft Graph). */
  sendsViaGraph: (draft: Message) => boolean;
  config: ConfigStore;
  transport: Transport;
  now: () => number;
  setTimer: (run: () => void, ms: number) => () => void;
  log: (message: string) => void;
}

const httpsUrl = /^https$/u;

const mintedLinks = z.array(
  z.object({ redirectUrl: z.url({ protocol: httpsUrl }), url: z.string() })
);

/**
 * The Worker's answer; only the per-recipient sets are used (ADR-0003), plus the set an
 * agent's composed draft already carried (ADR-0004).
 */
const mintedSchema = z.object({
  carried: z
    .object({ imageUrl: z.url({ protocol: httpsUrl }), links: mintedLinks })
    .nullish(),
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.url({ protocol: httpsUrl }),
      links: mintedLinks,
    })
  ),
  shared: z.boolean(),
  token: z.string(),
});

const parseBody = (html: string): HTMLElement => {
  // An inert document, as Mailspring uses for sending, so images in the body are not fetched.
  const root = document.implementation
    .createHTMLDocument("")
    .createElement("root");
  root.innerHTML = html;
  return root;
};

const fromWorker = (url: string, origin: string, kind: "i" | "l"): boolean =>
  url.startsWith(`${origin}/${kind}/`);

/**
 * Registers drafts open in a composer with the Worker and remembers the tokens, so the
 * synchronous send hook can use tokens that already exist server-side; and, in the main
 * window, reports confirmed deliveries, retrying until the Worker has the send time.
 */
export const createTracker = (deps: TrackerDeps) => {
  const timers = new Map<string, () => void>();
  const latest = new Map<string, Message>();
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();

  const post = async (path: string, body: string) => {
    const settings = deps.settings();
    return await deps.transport({
      body,
      token: settings.apiToken,
      url: `${trackerOrigin(settings) ?? ""}${path}`,
    });
  };

  const background = (task: Promise<void>): void => {
    inFlight.add(task);
  };

  const store = (
    draftId: string,
    origin: string,
    print: string,
    body: string
  ): Registration | null => {
    const minted = mintedSchema.safeParse(JSON.parse(body));
    const sets = minted.success
      ? [
          ...minted.data.recipients,
          ...(minted.data.carried ? [minted.data.carried] : []),
        ]
      : [];
    const valid =
      minted.success &&
      minted.data.recipients.length > 0 &&
      sets.every(
        (set) =>
          fromWorker(set.imageUrl, origin, "i") &&
          set.links.every((link) => fromWorker(link.redirectUrl, origin, "l"))
      );
    if (!valid) {
      return null;
    }
    const { carried } = minted.data;
    return {
      carried: carried
        ? Object.fromEntries(
            carried.links.map((link) => [link.redirectUrl, link.url])
          )
        : null,
      draftId,
      fingerprint: print,
      recipients: Object.fromEntries(
        minted.data.recipients.map((set) => [
          set.address,
          {
            imageUrl: set.imageUrl,
            links: Object.fromEntries(
              set.links.map((link) => [link.url, link.redirectUrl])
            ),
          },
        ])
      ),
      savedAt: deps.now(),
      shared: minted.data.shared,
      token: minted.data.token,
    };
  };

  const register = async (draftId: string): Promise<void> => {
    const settings = deps.settings();
    const origin = trackerOrigin(settings);
    const draft = latest.get(draftId);
    if (
      skipReason(settings) !== null ||
      origin === null ||
      !draft ||
      draft.plaintext
    ) {
      return;
    }
    const root = parseBody(draft.body ?? "");
    // The same autolinking as at send time, so bare URLs are registered too.
    autolink(root);
    const current = snapshot(draft, root, origin, deps.sendsViaGraph(draft));
    if (current.recipients.length === 0) {
      // Nobody to track for yet; registered once a recipient is added.
      return;
    }
    const print = fingerprint(current);
    if (lookup(deps.config, draftId)?.fingerprint === print) {
      return;
    }
    const response = await post("/api/messages", print);
    if (response.status !== 200 && response.status !== 201) {
      deps.log(`registration answered ${response.status}`);
      return;
    }
    const entry = store(draftId, origin, print, response.body);
    if (entry) {
      save(deps.config, entry);
    } else {
      deps.log("registration returned an unexpected response");
    }
  };

  /** One registration per draft at a time; failures are logged, never thrown. */
  const queue = async (draftId: string): Promise<void> => {
    const previous = chains.get(draftId);
    const next = (async () => {
      if (previous) {
        await previous;
      }
      try {
        await register(draftId);
      } catch (error) {
        deps.log(`registration failed: ${String(error)}`);
      }
    })();
    chains.set(draftId, next);
    await next;
  };

  /** A composer showed this draft (after an edit): register once edits pause. */
  const draftChanged = (draft: Message): void => {
    const draftId = draft.headerMessageId;
    latest.set(draftId, draft);
    timers.get(draftId)?.();
    timers.set(
      draftId,
      deps.setTimer(() => {
        timers.delete(draftId);
        background(queue(draftId));
      }, DEBOUNCE_MS)
    );
  };

  /** Send was pressed in this window: register now rather than after the debounce. */
  const flush = (draftId: string): void => {
    timers.get(draftId)?.();
    timers.delete(draftId);
    if (latest.has(draftId)) {
      background(queue(draftId));
    }
  };

  const attemptSent = async (notice: PendingSent): Promise<void> => {
    let status = 0;
    try {
      const response = await post(
        `/api/messages/${notice.token}/sent`,
        JSON.stringify({ sentAt: notice.sentAt })
      );
      ({ status } = response);
    } catch (error) {
      deps.log(`marking sent failed: ${String(error)}`);
    }
    if (status === 204 || status === 404) {
      if (status === 404) {
        deps.log("marking sent: the Worker does not know this message");
      }
      setPending(deps.config, null, notice.draftId);
      return;
    }
    const delay = SENT_RETRY_MS[notice.attempts];
    if (delay === undefined) {
      deps.log(`marking sent gave up after ${notice.attempts + 1} attempts`);
      setPending(deps.config, null, notice.draftId);
      return;
    }
    const next = { ...notice, attempts: notice.attempts + 1 };
    setPending(deps.config, next, notice.draftId);
    deps.setTimer(() => {
      background(attemptSent(next));
    }, delay);
  };

  /**
   * Mailspring reported delivery (main window only): remember the notice in config, so it
   * survives a restart, and send it to the Worker, retrying on failure.
   */
  const delivered = (draftId: string): void => {
    const entry = lookup(deps.config, draftId);
    if (!entry) {
      return;
    }
    const notice: PendingSent = {
      attempts: 0,
      draftId,
      sentAt: deps.now(),
      token: entry.token,
    };
    setPending(deps.config, notice, draftId);
    background(attemptSent(notice));
  };

  /** On start-up of the main window: send notices left over from before a restart. */
  const resume = (): void => {
    for (const notice of pending(deps.config)) {
      background(attemptSent(notice));
    }
  };

  /** Waits for background work; for tests. */
  const settle = async (): Promise<void> => {
    if (inFlight.size === 0) {
      return;
    }
    const tasks = [...inFlight];
    inFlight.clear();
    await Promise.all(tasks);
    await settle();
  };

  return { delivered, draftChanged, flush, resume, settle };
};

export type Tracker = ReturnType<typeof createTracker>;
