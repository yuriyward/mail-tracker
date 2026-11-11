import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ListData } from "../../src/dashboard-data";

/**
 * Runs the built bundle (web/dist, from `bun run build:web`) in happy-dom and records
 * everything the strict CSP (`style-src 'self'`) would block: a created <style> element
 * or a style attribute set as text. Style changes through the CSSOM are allowed.
 */
const DIST = new URL("../dist/", import.meta.url).pathname;

const NOW = Date.now();
const DATA: ListData = {
  messages: [
    {
      addresses: ["ann@example.com"],
      clicks: 0,
      firstOpen: NOW - 3 * 3_600_000,
      lastOpen: NOW - 2 * 3_600_000,
      lastReopen: null,
      openedBy: 1,
      opens: 1,
      recipient: "ann@example.com",
      recipientUnknown: false,
      recipients: 1,
      reopens: 0,
      sentAt: NOW - 4 * 3_600_000,
      shared: false,
      subject: "Quarterly plan",
      token: "tok-synthetic-1",
    },
  ],
  updated: NOW,
};

/** Style elements inserted anywhere in the document. */
const inserted: string[] = [];
/** Style attributes set as text (blocked by the CSP), not through element.style. */
const directStyles: string[] = [];
let originalSetAttribute: Element["setAttribute"] | undefined;

const until = async (found: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!found()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polling the DOM.
    await Bun.sleep(20);
  }
};

beforeAll(async () => {
  const html = await Bun.file(`${DIST}app/index.html`).text();
  const src = /<script\b[^>]*\bsrc="\/(?<path>app\/assets\/[\w.-]+\.js)"/u.exec(
    html
  )?.groups?.path;
  if (src === undefined) {
    throw new Error(
      "web/dist/app/index.html has no script: run bun run build:web"
    );
  }
  GlobalRegistrator.register({ url: "https://tracker.example/app" });
  document.body.innerHTML = '<div id="root"></div>';

  // oxlint-disable-next-line typescript/unbound-method -- re-bound with call() below.
  const original = Element.prototype.setAttribute;
  originalSetAttribute = original;
  // happy-dom applies CSSOM writes through setAttribute too; only direct calls count.
  Element.prototype.setAttribute = function setAttribute(name, value) {
    if (
      name.toLowerCase() === "style" &&
      !(new Error("caller").stack ?? "").includes("CSSStyleDeclaration")
    ) {
      directStyles.push(value);
    }
    original.call(this, name, value);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (
          node instanceof Element &&
          (node.matches("style") || node.querySelector("style") !== null)
        ) {
          inserted.push(node.outerHTML);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  const reply = async () => await Promise.resolve(Response.json(DATA));
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(reply, { preconnect: fetch.preconnect })
  );
  await import(`${DIST}${src}`);
});

afterAll(async () => {
  // Close the tooltip and let React settle before the DOM globals go away.
  document
    .querySelector(`[data-slot="tooltip-trigger"]`)
    ?.dispatchEvent(new MouseEvent("mouseleave"));
  await Bun.sleep(300);
  if (originalSetAttribute) {
    Element.prototype.setAttribute = originalSetAttribute;
  }
  await GlobalRegistrator.unregister();
});

describe("the built bundle under the strict CSP", () => {
  test("a date tooltip opens, is positioned by script and no <style> is created", async () => {
    const sent = new Date(DATA.messages[0]?.sentAt ?? 0).toISOString();
    const selector = `time[datetime="${sent}"]`;
    await until(() => document.querySelector(selector) !== null, "the list");
    // The hover listeners attach in effects, after the first paint.
    await Bun.sleep(100);
    const trigger = document.querySelector<HTMLElement>(selector);
    expect(trigger?.dataset.slot).toBe("tooltip-trigger");
    // React reads pointerover for onPointerEnter; Floating UI listens for mouseenter.
    trigger?.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })
    );
    trigger?.dispatchEvent(new MouseEvent("mouseenter"));
    trigger?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await until(
      () => document.querySelector('[data-slot="tooltip-content"]') !== null,
      "the tooltip"
    );
    const content = document.querySelector('[data-slot="tooltip-content"]');
    expect(content?.textContent).toMatch(/^.+ · 4 hours ago$/u);
    // Floating UI places the positioner through element.style (CSSOM), not markup.
    const positioner = content?.parentElement;
    expect(positioner?.style.position).not.toBe("");

    expect(document.querySelectorAll("style")).toHaveLength(0);
    expect(inserted).toEqual([]);
    expect(directStyles).toEqual([]);
    expect(document.querySelector("[title]")).toBeNull();
  });

  test("the recipient cell links to the person's page", () => {
    const link = document.querySelector(
      'a[href="/app/people/ann%40example.com"]'
    );
    expect(link?.textContent).toBe("ann@example.com");
  });
});
