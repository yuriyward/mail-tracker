import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { ORIGIN } from "../../src/__tests__/harness";
import { draftKey, lookup, prune, REGISTRATIONS_KEY } from "../src/registry";
import { readSettings, skipReason } from "../src/settings";
import { DEBOUNCE_MS } from "../src/tracker";
import { BODY, createFixture, draft, DRAFT_ID, paths } from "./fixture";
import type { Fixture } from "./fixture";

let f: Fixture;

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  f = await createFixture();
});

describe("registration while composing", () => {
  test("is debounced: several edits make one request", async () => {
    f.main.tracker.draftChanged(draft());
    f.main.tracker.draftChanged(draft({ subject: "Proposal v2" }));
    f.main.tracker.draftChanged(draft({ subject: "Proposal v3" }));
    await f.main.tick();
    expect(paths(f.requests)).toEqual(["/api/messages"]);
    expect(f.h.rows("SELECT subject FROM messages")).toEqual([
      { subject: "Proposal v3" },
    ]);
    expect(DEBOUNCE_MS).toBeGreaterThan(0);
  });

  test("skips an unchanged draft and re-registers an edited one under the same message", async () => {
    await f.compose();
    await f.compose();
    expect(f.requests).toHaveLength(1);
    await f.compose(
      draft({ body: `${BODY}<a href="https://example.org/new">new</a>` })
    );
    expect(f.requests).toHaveLength(2);
    expect(f.h.rows("SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 1 }]);
    expect(
      lookup(f.config, DRAFT_ID)?.links["https://example.org/new"]
    ).toStartWith(`${ORIGIN}/l/`);
  });

  test("flush registers immediately when Send is pressed", async () => {
    f.main.tracker.draftChanged(draft());
    f.main.tracker.flush(DRAFT_ID);
    await f.main.tracker.settle();
    expect(lookup(f.config, DRAFT_ID)).not.toBeNull();
    // The cancelled debounce does not register a second time.
    await f.main.tick();
    expect(f.requests).toHaveLength(1);
  });

  test("only drafts shown in a composer are registered", async () => {
    f.main.tracker.flush("<synced-but-never-opened@example.test>");
    await f.main.tick();
    expect(f.requests).toHaveLength(0);
  });

  test("two windows registering different drafts keep both registrations", async () => {
    const popout = f.openWindow();
    f.main.tracker.draftChanged(draft());
    popout.tracker.draftChanged(
      draft({ headerMessageId: "<draft-2@example.test>" })
    );
    await Promise.all([f.main.tick(), popout.tick()]);
    expect(lookup(f.config, DRAFT_ID)).not.toBeNull();
    expect(lookup(f.config, "<draft-2@example.test>")).not.toBeNull();
    // One config key per draft, never a shared map rewritten as a whole.
    expect(Object.keys(f.config.data[REGISTRATIONS_KEY] ?? {})).toEqual([
      draftKey(DRAFT_ID),
      draftKey("<draft-2@example.test>"),
    ]);
  });

  test("keeps no registration when the Worker fails or answers oddly", async () => {
    f.state.transport = async () =>
      await Promise.resolve({ body: "{}", status: 500 });
    await f.compose();
    f.state.transport = async () =>
      await Promise.resolve({
        body: JSON.stringify({
          imageUrl: "https://elsewhere.example/i/x",
          links: [],
          token: "t",
        }),
        status: 201,
      });
    await f.compose(draft({ subject: "changed" }));
    f.state.transport = async () => await Promise.reject(new Error("offline"));
    await f.compose(draft({ subject: "changed again" }));
    expect(lookup(f.config, DRAFT_ID)).toBeNull();
    expect(f.logs).toHaveLength(3);
  });

  test("does nothing when disabled or unconfigured", async () => {
    f.state.settings = { ...f.state.settings, enabled: false };
    await f.compose();
    f.state.settings = {
      ...f.state.settings,
      apiUrl: "https://",
      enabled: true,
    };
    await f.compose();
    expect(f.requests).toHaveLength(0);
  });

  test("prune drops registrations older than 30 days", async () => {
    await f.compose();
    prune(f.config, f.h.state.clock + 29 * 24 * 60 * 60 * 1000);
    expect(lookup(f.config, DRAFT_ID)).not.toBeNull();
    prune(f.config, f.h.state.clock + 30 * 24 * 60 * 60 * 1000);
    expect(lookup(f.config, DRAFT_ID)).toBeNull();
  });
});

describe("settings", () => {
  test("defaults to enabled and trims values", () => {
    expect(readSettings(null)).toEqual({
      apiToken: "",
      apiUrl: "",
      enabled: true,
    });
    expect(
      readSettings({
        apiToken: " k ",
        apiUrl: " https://t.example.test/ ",
        enabled: false,
      })
    ).toEqual({
      apiToken: "k",
      apiUrl: "https://t.example.test",
      enabled: false,
    });
    expect(readSettings({ apiUrl: 5, enabled: "yes" })).toEqual({
      apiToken: "",
      apiUrl: "",
      enabled: true,
    });
  });

  test.each([
    ["https://", "Worker URL (https) or API token not set"],
    ["not a url", "Worker URL (https) or API token not set"],
    ["http://track.example.test", "Worker URL (https) or API token not set"],
    ["https://track.example.test", null],
  ])("Worker URL %s", (apiUrl, reason) => {
    expect(skipReason({ apiToken: "k", apiUrl, enabled: true })).toBe(reason);
  });
});
