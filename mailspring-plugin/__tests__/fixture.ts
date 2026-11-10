import type { JsonValue, Message, SendTransformArgs } from "mailspring-exports";
import { z } from "zod";

import { createHarness, ORIGIN } from "../../src/__tests__/harness";
import type { Harness } from "../../src/__tests__/harness";
import { createExtension } from "../src/extension";
import type { ConfigStore } from "../src/registry";
import type { Settings } from "../src/settings";
import { createTracker } from "../src/tracker";
import type { Tracker } from "../src/tracker";
import type { ApiRequest, Transport } from "../src/transport";
import { forSending } from "./send-draft-task";
import type { SentTask, StandInExtension } from "./send-draft-task";

export const DRAFT_ID = "<draft-1@example.test>";
export const OLD_PIXEL = `${ORIGIN}/i/OOOOOOOOOOOOOOOOOOOOOO`;

export const BODY = [
  '<p>Hi Alex, see <a href="https://example.org/deck">the deck</a>',
  ' and <a href=" https://example.org/pricing?plan=a&amp;b=1 ">pricing</a>.</p>',
  '<p><a href="mailto:me@example.com">mail me</a> <a href="http://example.org/old">old</a>',
  ' <a href="/relative">rel</a> <a href="https://127.0.0.1/">ip</a> <a>no href</a></p>',
  `<div class="gmail_quote"><p>Earlier: <a href="https://example.org/quoted">q</a></p>`,
  `<img src="${OLD_PIXEL}"><img src="https://example.org/logo.png"></div>`,
].join("");

// oxlint-disable-next-line typescript/no-extraneous-class, unicorn/no-static-only-class -- stands in for Mailspring's static-only base class.
class StubComposerExtension {
  static applyTransformsForSending(_args: SendTransformArgs): void {
    // Mailspring's base class does nothing.
  }
}

const tree = z.record(z.string(), z.json());

/**
 * Mailspring's config semantics: dotted key paths address nested objects, a write touches
 * only its key path, and `undefined` removes the key. Shared by every "window" in a test.
 */
export const memoryConfig = (): ConfigStore & {
  data: Record<string, JsonValue>;
} => {
  const data: Record<string, JsonValue> = {};
  const parentOf = (
    keys: string[],
    create: boolean
  ): Record<string, JsonValue> | null => {
    let node = data;
    for (const key of keys) {
      const child = tree.safeParse(node[key]);
      if (!child.success) {
        if (!create) {
          return null;
        }
        node[key] = {};
      }
      const next = tree.parse(node[key]);
      node[key] = next;
      node = next;
    }
    return node;
  };
  return {
    data,
    get: (keyPath) => {
      const keys = keyPath.split(".");
      const last = keys.pop() ?? "";
      return parentOf(keys, false)?.[last];
    },
    set: (keyPath, value) => {
      const keys = keyPath.split(".");
      const last = keys.pop() ?? "";
      const parent = parentOf(keys, true);
      if (parent && value === undefined) {
        Reflect.deleteProperty(parent, last);
      } else if (parent && value !== undefined) {
        parent[last] = value;
      }
    },
  };
};

export const draft = (overrides: Partial<Message> = {}): Message => ({
  bcc: [{ email: "boss@example.net" }],
  body: BODY,
  cc: [{ email: "sam@example.net" }],
  draft: true,
  headerMessageId: DRAFT_ID,
  plaintext: false,
  subject: "Proposal",
  to: [{ email: "alex@example.com" }],
  ...overrides,
});

interface FixtureState {
  settings: Settings;
  /** Replaces the Worker for the next requests when set. */
  transport: Transport | null;
}

export interface Window {
  tracker: Tracker;
  extension: StandInExtension;
  /** Runs due timers (debounce, retries) and waits for the work they start. */
  tick: () => Promise<void>;
}

/** The Worker plus any number of Mailspring "windows" sharing one config. */
export const createFixture = async () => {
  const h: Harness = await createHarness();
  const config = memoryConfig();
  const requests: ApiRequest[] = [];
  const logs: string[] = [];
  const state: FixtureState = {
    settings: { apiToken: "test-api-token", apiUrl: ORIGIN, enabled: true },
    transport: null,
  };

  /** Sends plugin requests to the real Worker app (in-memory D1), as Node's https would. */
  const worker: Transport = async (request) => {
    requests.push(request);
    const response = await h.call(new URL(request.url).pathname, {
      body: request.body ?? null,
      headers: {
        Authorization: `Bearer ${request.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    return { body: await response.text(), status: response.status };
  };

  const openWindow = (): Window => {
    const timers: (() => void)[] = [];
    const log = (message: string): void => {
      logs.push(message);
    };
    const tracker = createTracker({
      config,
      log,
      now: () => h.state.clock,
      setTimer: (run) => {
        timers.push(run);
        return () => {
          const index = timers.indexOf(run);
          if (index !== -1) {
            timers.splice(index, 1);
          }
        };
      },
      settings: () => state.settings,
      transport: async (request) => await (state.transport ?? worker)(request),
    });
    const extension = createExtension(StubComposerExtension, {
      config,
      log,
      settings: () => state.settings,
    });
    const tick = async (): Promise<void> => {
      for (const run of timers.splice(0)) {
        run();
      }
      await tracker.settle();
    };
    return { extension, tick, tracker };
  };

  const main = openWindow();

  /** Shows the draft in a composer of `window` and lets the debounce fire. */
  const compose = async (
    message: Message = draft(),
    window?: Window
  ): Promise<void> => {
    const target = window ?? main;
    target.tracker.draftChanged(message);
    await target.tick();
  };

  const send = (
    message: Message = draft(),
    sendsViaGraph = false,
    window?: Window
  ): SentTask =>
    forSending([(window ?? main).extension], message, sendsViaGraph);

  const sentAt = (): unknown[] => h.rows("SELECT sent_at FROM messages");

  return {
    compose,
    config,
    h,
    logs,
    main,
    openWindow,
    requests,
    send,
    sentAt,
    state,
  };
};

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export const parse = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

export const hrefs = (html: string) =>
  [...parse(html).querySelectorAll("a")].map((a) => a.getAttribute("href"));

export const images = (html: string) =>
  [...parse(html).querySelectorAll("img")].map((img) =>
    img.getAttribute("src")
  );

export const paths = (requests: ApiRequest[]) =>
  requests.map((r) => new URL(r.url).pathname);
