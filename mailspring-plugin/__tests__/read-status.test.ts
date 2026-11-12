/* oxlint-disable no-await-in-loop -- exercise each failure and token route independently against the same fixture. */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ORIGIN, READ_TOKEN } from "../../src/__tests__/harness";
import { bodyToken, createReadClient } from "../src/read-client";
import type { ReadDetail } from "../src/read-client";
import { lookup } from "../src/registry";
import { createStatusComponents } from "../src/status";
import { httpsOptions } from "../src/transport";
import { createFixture, draft, DRAFT_ID } from "./fixture";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await Bun.sleep(30);
  await GlobalRegistrator.unregister();
});

const DETAIL: ReadDetail = {
  events: [],
  links: [
    { name: "Project", token: "link", url: "https://example.org/project" },
  ],
  message: { shared: 0, token: "message" },
  recipients: [
    {
      address: "alex@example.com",
      clicks: 0,
      current: true,
      opens: 0,
      token: "person",
    },
  ],
};
const OPEN: ReadDetail["events"][number] = {
  at: 1_800_000_000_000,
  class: "human",
  counted: 1,
  country: "DE",
  duplicate: 0,
  hint: "Possibly forwarded: device changed",
  kind: "open",
  label: "Opened",
  link_token: null,
  preloadHint: "possibly preloaded by Gmail",
  recipient_token: "person",
  user_agent: "Synthetic phone",
  via: null,
};

test("HTTPS GET uses the read credential in the Authorization header", () => {
  const options = httpsOptions({
    method: "GET",
    token: READ_TOKEN,
    url: `${ORIGIN}/api/messages`,
  });
  expect(options.method).toBe("GET");
  expect(options.headers).toEqual({
    Authorization: `Bearer ${READ_TOKEN}`,
    "Content-Length": 0,
    "Content-Type": "application/json",
  });
  expect(
    httpsOptions({
      token: "synthetic-write-token",
      url: `${ORIGIN}/api/messages`,
    }).method
  ).toBe("POST");
});

test("read auth, shared endpoint cache, expiry, and real Worker detail contract", async () => {
  const f = await createFixture();
  await f.compose();
  const calls: string[] = [];
  let clock = 0;
  const client = createReadClient({
    config: f.config,
    loadBody: async () => await Promise.resolve(""),
    now: () => clock,
    settings: () => ({ ...f.state.settings, readToken: READ_TOKEN }),
    transport: async (call) => {
      expect(call.method).toBe("GET");
      expect(call.token).toBe(READ_TOKEN);
      expect(call.token).not.toBe(f.state.settings.apiToken);
      calls.push(call.url);
      const response = await f.h.call(new URL(call.url).pathname, {
        headers: { Authorization: `Bearer ${call.token}` },
      });
      return { body: await response.text(), status: response.status };
    },
  });
  const message = draft({ draft: false });
  const [first, second] = await Promise.all([
    client.read(message),
    client.read(message),
  ]);
  expect(first?.message.token).toBe(lookup(f.config, DRAFT_ID)?.token);
  expect(first).toEqual(second);
  expect(calls).toHaveLength(1);
  await client.list();
  await client.list();
  expect(calls).toHaveLength(2);
  clock = 59_999;
  await client.read(message);
  expect(calls).toHaveLength(2);
  clock = 60_000;
  await client.read(message);
  expect(calls).toHaveLength(3);
});

test("HTTP, network and malformed failures show nothing and are cached", async () => {
  const f = await createFixture();
  await f.compose();
  for (const failure of ["http", "network", "json", "schema"]) {
    let calls = 0;
    const client = createReadClient({
      config: f.config,
      loadBody: async () => await Promise.resolve(""),
      now: () => 0,
      settings: () => ({ ...f.state.settings, readToken: READ_TOKEN }),
      transport: async () => {
        calls += 1;
        if (failure === "network") {
          throw new Error("synthetic offline");
        }
        return await Promise.resolve({
          body: failure === "json" ? "{" : "{}",
          status: failure === "http" ? 401 : 200,
        });
      },
    });
    expect(await client.read(draft({ draft: false }))).toBeNull();
    expect(await client.read(draft({ draft: false }))).toBeNull();
    expect(calls).toBe(1);
  }
});

test("Sent-only image/link fallback resolves recipient tokens through /tokens", async () => {
  const f = await createFixture();
  await f.compose();
  const registration = lookup(f.config, DRAFT_ID);
  const set = registration?.recipients["alex@example.com"];
  expect(set).toBeDefined();
  for (const url of [set?.imageUrl, ...Object.values(set?.links ?? {})]) {
    const paths: string[] = [];
    const client = createReadClient({
      config: f.config,
      loadBody: async () =>
        await Promise.resolve(`<img src="${url}"><a href="${url}">Project</a>`),
      now: () => 0,
      settings: () => ({ ...f.state.settings, readToken: READ_TOKEN }),
      transport: async (call) => {
        paths.push(new URL(call.url).pathname);
        const response = await f.h.call(new URL(call.url).pathname, {
          headers: { Authorization: `Bearer ${call.token}` },
        });
        return { body: await response.text(), status: response.status };
      },
    });
    const sent = draft({
      categories: () => [{ role: "sent" }],
      draft: false,
      headerMessageId: "external@example.test",
    });
    delete sent.body;
    const detail = await client.read(sent);
    expect(detail?.message.token).toBe(registration?.token);
    expect(paths[0]).toStartWith("/api/tokens/");
    expect(
      await client.read(
        Object.assign(sent, { categories: () => [{ role: "inbox" }] })
      )
    ).toBeNull();
    expect(await client.read(Object.assign(sent, { draft: true }))).toBeNull();
  }
  const token = "A".repeat(22);
  expect(
    bodyToken(
      `<blockquote><img src="${ORIGIN}/i/${token}.png"></blockquote>`,
      ORIGIN
    )
  ).toBeNull();
  expect(
    bodyToken(`<img src="https://other.example/i/${token}.png">`, ORIGIN)
  ).toBeNull();
  expect(bodyToken("<p>Clean Sent copy</p>", ORIGIN)).toBeNull();
});

test("components render unopened, opened, shared copy, server labels and clicked links", async () => {
  let current: ReadDetail | null = DETAIL;
  const panels: string[] = [];
  const components = createStatusComponents({
    React,
    openPanel: (element) => {
      panels.push(renderToStaticMarkup(element));
    },
    read: async () => await Promise.resolve(current),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    root.render(
      React.createElement(components.MessageStatus, {
        message: draft({ draft: false }),
      })
    );
    await Bun.sleep(30);
  };
  await render();
  expect(host.textContent).toContain("No opens");
  current = {
    ...DETAIL,
    events: [
      OPEN,
      { ...OPEN, class: "proxy", via: "Gmail" },
      { ...OPEN, kind: "click", label: "Clicked", link_token: "link" },
      { ...OPEN, duplicate: 1 },
    ],
  };
  window.dispatchEvent(new Event("focus"));
  await Bun.sleep(30);
  expect(host.textContent).toContain(
    "Opened · 1 human opens · 1 proxy opens · 1 clicks"
  );
  host.querySelector("button")?.click();
  expect(panels[0]).toContain("alex@example.com");
  expect(panels[0]).toContain("Possibly forwarded: device changed");
  expect(panels[0]).toContain("possibly preloaded by Gmail");
  expect(panels[0]).toContain("Gmail");
  expect(panels[0]).toContain("Synthetic phone");
  expect(panels[0]).toContain("DE");
  expect(panels[0]).toContain("https://example.org/project");
  const shared = renderToStaticMarkup(
    React.createElement(components.Panel, {
      detail: {
        ...DETAIL,
        message: { shared: 1, token: "message" },
        recipients: [
          { address: "", clicks: 0, current: true, opens: 0, token: "shared" },
        ],
      },
    })
  );
  expect(shared).toContain("Shared copy, recipient unknown");
  root.render(
    React.createElement(components.ThreadIcon, {
      thread: { __messages: [draft({ draft: false })] },
    })
  );
  await Bun.sleep(30);
  expect(host.textContent).toContain("◉ 2 ↗ 1");
  current = null;
  await render();
  expect(host.textContent).toBe("");
  root.unmount();
  host.remove();
});
