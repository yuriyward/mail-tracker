import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

import { createHarness, ORIGIN } from "../../__tests__/harness";
import type { Harness } from "../../__tests__/harness";
import { composePerRecipient } from "../compose";
import type { ComposeOptions, SplitComposed } from "../compose";
import { FRAGMENT, workerClient } from "./worker";

let h: Harness;

const target = z.object({
  kind: z.enum(["image", "link"]),
  message: z.string(),
  position: z.number().nullable(),
  recipient: z.string().nullable(),
  recipients: z.number(),
  url: z.string().nullable(),
});

const lookup = async (token: string) => {
  const response = await h.read(`/api/tokens/${token}`);
  expect(response.status).toBe(200);
  return target.parse(await response.json());
};

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const BODY = [
  "Hi all,",
  "",
  "The deck: https://example.org/deck and [pricing](https://Example.org/pricing).",
  "The deck again: https://example.org/deck",
].join("\n");

const TEMPLATE =
  '<!doctype html><html><body>{{body}}<p><a href="https://example.org/about">About</a> <a href="mailto:sam@example.net">mail</a></p></body></html>';

const split = async (
  options: Partial<ComposeOptions> = {}
): Promise<SplitComposed> =>
  await composePerRecipient(
    {
      bcc: ["Boss Example <boss@example.net>"],
      body: BODY,
      cc: ["sam@example.net"],
      markdown: true,
      subject: "Proposal",
      template: TEMPLATE,
      to: ["Alex Example <Alex@example.com>"],
      track: true,
      ...options,
    },
    {
      client: workerClient(h),
      draftId: () => "<compose-split@example.test>",
    }
  );

/**
 * What the split-send gate does with a recipient's copy: drop our images, and map each
 * redirect back through the read API, checking it belongs to this message and recipient.
 */
const untracked = async (
  html: string,
  message: string,
  address: string
): Promise<string> => {
  const doc = parse(html);
  const images = [...doc.querySelectorAll(`img[src^="${ORIGIN}/i/"]`)];
  const anchors = [...doc.querySelectorAll(`a[href^="${ORIGIN}/l/"]`)];
  const [imageTargets, linkTargets] = await Promise.all([
    Promise.all(
      images.map(
        async (img) =>
          await lookup(
            new URL(img.getAttribute("src") ?? "").pathname.slice(3, -4)
          )
      )
    ),
    Promise.all(
      anchors.map(
        async (a) =>
          await lookup(new URL(a.getAttribute("href") ?? "").pathname.slice(3))
      )
    ),
  ]);
  for (const found of imageTargets) {
    expect(found).toMatchObject({ kind: "image", message, recipient: address });
  }
  for (const img of images) {
    img.remove();
  }
  for (const [k, a] of anchors.entries()) {
    const found = linkTargets[k];
    expect(found).toMatchObject({ kind: "link", message, recipient: address });
    a.setAttribute("href", found?.url ?? "");
  }
  return doc.documentElement.outerHTML;
};

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  h = await createHarness();
});

describe("bun run compose --per-recipient", () => {
  test("one message row, one token set per address, a receipt naming each copy's tokens", async () => {
    const { receipt, recipients } = await split();
    expect(h.rows("SELECT token, shared, draft_tracked FROM messages")).toEqual(
      [{ draft_tracked: 1, shared: 0, token: receipt.token }]
    );
    expect(h.rows("SELECT address FROM recipients ORDER BY position")).toEqual([
      { address: "alex@example.com" },
      { address: "sam@example.net" },
      { address: "boss@example.net" },
    ]);
    expect(receipt.links).toEqual([
      "https://example.org/deck",
      "https://example.org/pricing",
      "https://example.org/about",
    ]);
    expect(
      receipt.items.map(({ address, i, role }) => ({ address, i, role }))
    ).toEqual([
      { address: "alex@example.com", i: 0, role: "to" },
      { address: "sam@example.net", i: 1, role: "cc" },
      { address: "boss@example.net", i: 2, role: "bcc" },
    ]);
    expect(recipients).toHaveLength(3);
    const tokens = receipt.items.flatMap((item) => [
      item.imageToken,
      ...item.linkTokens,
    ]);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const [i, item] of receipt.items.entries()) {
      const doc = parse(recipients[i]?.html ?? "");
      expect(
        [...doc.querySelectorAll("img")].map((img) => img.getAttribute("src"))
      ).toEqual([`${ORIGIN}/i/${item.imageToken}.png`]);
      const redirect = (k: number): string =>
        `${ORIGIN}/l/${item.linkTokens[k] ?? ""}`;
      // Document order: deck, pricing, deck again, about; mailto is left alone.
      expect(
        [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))
      ).toEqual([
        redirect(0),
        redirect(1),
        redirect(0),
        redirect(2),
        "mailto:sam@example.net",
      ]);
    }
    const looked = await Promise.all(
      receipt.items.map(
        async (item) =>
          await Promise.all([item.imageToken, ...item.linkTokens].map(lookup))
      )
    );
    expect(looked).toEqual(
      receipt.items.map((item) => [
        {
          kind: "image" as const,
          message: receipt.token,
          position: null,
          recipient: item.address,
          recipients: 3,
          url: null,
        },
        ...item.linkTokens.map((_, position) => ({
          kind: "link" as const,
          message: receipt.token,
          position,
          recipient: item.address,
          recipients: 3,
          url: receipt.links[position] ?? null,
        })),
      ])
    );
  });

  test("the owner's copy has no image and the same links, in the same order, at their destinations", async () => {
    const { recipients, self } = await split();
    const doc = parse(self.html);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(self.html).not.toContain(ORIGIN);
    expect(
      [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual([
      "https://example.org/deck",
      "https://example.org/pricing",
      "https://example.org/deck",
      "https://example.org/about",
      "mailto:sam@example.net",
    ]);
    // The text alternative carries no tracking, so it is the same in every copy.
    expect(self.text).not.toContain(ORIGIN);
    expect(recipients.map((copy) => copy.text)).toEqual(
      recipients.map(() => self.text)
    );
  });

  test("each copy equals the owner's once its own tokens are resolved through the read API", async () => {
    const { receipt, recipients, self } = await split();
    const expected = parse(self.html).documentElement.outerHTML;
    const resolved = await Promise.all(
      receipt.items.map(
        async (item) =>
          await untracked(
            recipients[item.i]?.html ?? "",
            receipt.token,
            item.address
          )
      )
    );
    expect(resolved).toEqual(receipt.items.map(() => expected));
  });

  test("an address given twice, in any header or case, is refused before anything is registered", async () => {
    const refusal = await split({
      bcc: [],
      cc: ["ALEX@example.com"],
    }).then(() => "composed", String);
    expect(refusal).toContain("alex@example.com is given twice");
    expect(h.rows("SELECT token FROM messages")).toEqual([]);
  });

  test("a body without links: one image each, no redirects", async () => {
    const { receipt, recipients, self } = await split({
      body: "Lunch on Friday?",
      template: FRAGMENT,
    });
    expect(receipt.links).toEqual([]);
    expect(receipt.items.map((item) => item.linkTokens)).toEqual([[], [], []]);
    // Each copy is the owner's plus its own image, and nothing else.
    expect(recipients.map((copy) => copy.html)).toEqual(
      receipt.items.map((item) =>
        self.html.replace(
          "</p>\n\n",
          `</p>\n\n<img alt="" src="${ORIGIN}/i/${item.imageToken}.png">`
        )
      )
    );
    expect(self.html).toStartWith("<p>Lunch on Friday?</p>");
  });
});
