import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

import { createHarness, ORIGIN } from "../../__tests__/harness";
import type { Harness } from "../../__tests__/harness";
import { addressOf, compose, DEFAULT_TEMPLATE } from "../compose";
import { composeWith, FRAGMENT } from "./worker";

let h: Harness;

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");
const images = (html: string) =>
  [...parse(html).querySelectorAll("img")].map((img) =>
    img.getAttribute("src")
  );
const hrefs = (html: string) =>
  [...parse(html).querySelectorAll("a")].map((a) => a.getAttribute("href"));

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  h = await createHarness();
});

describe("bun run compose", () => {
  test("one recipient: that recipient's own token set, the draft marked as carrying tracking", async () => {
    const { html, receipt, text } = await composeWith(h);
    expect(receipt.status).toBe("tracked");
    expect(receipt.shared).toBe(false);
    expect(h.rows("SELECT address, current FROM recipients")).toEqual([
      { address: "alex@example.com", current: 1 },
    ]);
    const [recipient] = z
      .array(z.object({ token: z.string() }))
      .parse(h.rows("SELECT token FROM recipients"));
    expect(receipt.imageUrl).toBe(`${ORIGIN}/i/${recipient?.token ?? ""}.png`);
    expect(
      h.rows("SELECT token, draft_tracked, shared, sent_at FROM messages")
    ).toEqual([
      { draft_tracked: 1, sent_at: null, shared: 0, token: receipt.token },
    ]);
    // One image, Mailspring's markup; bare URLs became tracked links.
    expect(images(html)).toEqual([receipt.imageUrl]);
    expect(html).toContain(`<img alt="" src="${receipt.imageUrl ?? ""}">`);
    expect(receipt.links.map((link) => link.url)).toEqual([
      "https://example.org/deck",
      "https://example.org/pricing",
    ]);
    expect(hrefs(html)).toEqual(receipt.links.map((link) => link.redirectUrl));
    // Each redirect is that recipient's own token.
    for (const link of receipt.links) {
      const token = new URL(link.redirectUrl).pathname.slice(3);
      expect(
        h.rows(
          `SELECT recipient_token FROM recipient_links WHERE token = '${token}'`
        )
      ).toEqual([{ recipient_token: recipient?.token }]);
    }
    // The text alternative names destinations, never tracking URLs.
    expect(text).toBe(
      "Hi Alex,\n\nThe deck: https://example.org/deck\nPricing: https://example.org/pricing.\n"
    );
    expect(text).not.toContain(ORIGIN);
  });

  test("several recipients: one shared token set (recipient unknown)", async () => {
    const { html, receipt } = await composeWith(h, {
      bcc: ["Boss Example <boss@example.net>"],
      cc: ["sam@example.net"],
      to: ["alex@example.com", "ALEX@example.com"],
    });
    expect(receipt.shared).toBe(true);
    expect(h.rows("SELECT address FROM recipients")).toEqual([{ address: "" }]);
    expect(h.rows("SELECT shared, recipient FROM messages")).toEqual([
      {
        recipient:
          "alex@example.com, ALEX@example.com, sam@example.net, Boss Example <boss@example.net>",
        shared: 1,
      },
    ]);
    expect(images(html)).toEqual([receipt.imageUrl]);
    expect(hrefs(html)).toEqual(receipt.links.map((link) => link.redirectUrl));
  });

  test("--no-track: rendered and autolinked, but nothing registered and no image", async () => {
    const { html, receipt, text } = await compose(
      {
        bcc: [],
        body: "See https://example.org/deck",
        cc: [],
        markdown: false,
        subject: "Proposal",
        template: FRAGMENT,
        to: ["alex@example.com"],
        track: false,
      },
      {
        client: null,
        draftId: () => {
          throw new Error("an untracked email needs no draft id");
        },
      }
    );
    expect(receipt).toMatchObject({
      draftId: null,
      imageUrl: null,
      links: [],
      status: "untracked",
      token: null,
    });
    expect(images(html)).toEqual([]);
    expect(hrefs(html)).toEqual(["https://example.org/deck"]);
    expect(text).toBe("See https://example.org/deck\n");
    expect(h.rows("SELECT token FROM messages")).toEqual([]);
  });

  test("autolinks bare https URLs as the plugin does, leaving code, quotes and other schemes", async () => {
    const body = [
      "# Update",
      "",
      "Slides: https://example.org/slides. And [the deck](https://example.org/deck).",
      "",
      "`https://example.org/code` and http://example.org/plain",
      "",
      "> https://example.org/quoted",
    ].join("\n");
    const { html, receipt, text } = await composeWith(h, {
      body,
      markdown: true,
    });
    expect(receipt.links.map((link) => link.url)).toEqual([
      "https://example.org/slides",
      "https://example.org/deck",
    ]);
    const redirect = (url: string): string =>
      receipt.links.find((link) => link.url === url)?.redirectUrl ?? "";
    expect(html).toContain("<h1>Update</h1>");
    expect(html).toContain(
      `<a href="${redirect("https://example.org/slides")}">https://example.org/slides</a>.`
    );
    expect(html).toContain(
      `<a href="${redirect("https://example.org/deck")}">the deck</a>`
    );
    expect(html).toContain("<code>https://example.org/code</code>");
    expect(html).toContain("http://example.org/plain");
    expect(html).toContain("https://example.org/quoted");
    // Link text reaches the Worker for the dashboard; a bare URL has none.
    expect(h.rows("SELECT url, text FROM links ORDER BY position")).toEqual([
      { text: "", url: "https://example.org/slides" },
      { text: "the deck", url: "https://example.org/deck" },
    ]);
    expect(text).toContain("the deck (https://example.org/deck)");
  });

  test("Markdown keeps the lines as written: a newline is a line break in both parts", async () => {
    // The live body from 2026-11-12 that rendered its two lines as one.
    const body =
      "Calendar: [my calendar](https://cal.com/example)\nBare link: https://example.com";
    const { html, receipt, text } = await composeWith(h, {
      body,
      markdown: true,
    });
    const [calendar, bare] = receipt.links.map((link) => link.redirectUrl);
    expect(html).toContain(
      `<p>Calendar: <a href="${calendar ?? ""}">my calendar</a><br>\nBare link: <a href="${bare ?? ""}">https://example.com</a></p>`
    );
    expect(text).toBe(
      [
        "Calendar: my calendar (https://cal.com/example)",
        "Bare link: https://example.com",
        "",
      ].join("\n")
    );
  });

  test("Markdown breaks mode: paragraphs, lists, emphasis and code still work", async () => {
    const body = [
      "Hi *Alex*,",
      "see **this**",
      "",
      "- one",
      "  more",
      "- two",
      "",
      "```",
      "a [x](https://example.org/x)",
      "b",
      "```",
      "",
      "`[y](https://example.org/y)` and [z](https://example.org/z)",
    ].join("\n");
    const { html, text } = await composeWith(h, { body, markdown: true });
    expect(html).toContain(
      "<p>Hi <em>Alex</em>,<br>\nsee <strong>this</strong></p>"
    );
    expect(html).toContain("<li>one<br>\nmore</li>\n<li>two</li>");
    expect(html).toContain(
      "<pre><code>a [x](https://example.org/x)\nb\n</code></pre>"
    );
    expect(html).not.toContain("</li><br>");
    expect(text).toStartWith(
      [
        "Hi *Alex*,",
        "see **this**",
        "",
        "- one",
        "  more",
        "- two",
        "",
        "```",
        "a [x](https://example.org/x)",
        "b",
        "```",
        "",
        "`[y](https://example.org/y)` and z (https://example.org/z)",
        "",
      ].join("\n")
    );
  });

  test("the template's {{body}} slot holds the body; its signature links are tracked too", async () => {
    const template = [
      "<!doctype html><html><head><style>p { margin: 0 }</style></head><body>",
      '<div class="note">{{body}}</div>',
      '<p>Sam Example<br><a href="https://example.org/about">About</a></p>',
      "</body></html>",
    ].join("");
    const { html, receipt, text } = await composeWith(h, {
      body: "Hi <Alex> & co",
      template,
    });
    expect(html).toStartWith("<!doctype html>\n<html><head><style>");
    expect(html).toContain(
      '<div class="note"><p>Hi &lt;Alex&gt; &amp; co</p></div>'
    );
    expect(receipt.links.map((link) => link.url)).toEqual([
      "https://example.org/about",
    ]);
    // The image goes after the signature, at the end of the body.
    expect(html).toContain(
      `</p><img alt="" src="${receipt.imageUrl ?? ""}"></body>`
    );
    expect(text).toBe(
      "Hi <Alex> & co\n\nSam Example\nAbout (https://example.org/about)\n"
    );
  });

  test("a template without exactly one slot is refused before anything is registered", async () => {
    const refusal = async (template: string): Promise<string> =>
      await composeWith(h, { template }).then(() => "composed", String);
    expect(await refusal("<p>no slot</p>")).toContain("exactly once (found 0)");
    expect(await refusal("{{body}}{{body}}")).toContain(
      "exactly once (found 2)"
    );
    expect(h.rows("SELECT token FROM messages")).toEqual([]);
  });

  test("the default template is a whole document with one slot", async () => {
    const template = readFileSync(DEFAULT_TEMPLATE, "utf-8");
    const { html, receipt } = await composeWith(h, { template });
    expect(template.split("{{body}}")).toHaveLength(2);
    expect(html).toStartWith("<!doctype html>");
    expect(images(html)).toEqual([receipt.imageUrl]);
  });

  test("addresses are read from display forms", () => {
    expect(addressOf("Alex Example <alex@example.com>")).toBe(
      "alex@example.com"
    );
    expect(addressOf(" sam@example.net ")).toBe("sam@example.net");
  });
});
