import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { autolink } from "../src/autolink";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const linked = (html: string): string => {
  const root = document.implementation
    .createHTMLDocument("")
    .createElement("root");
  root.innerHTML = html;
  autolink(root);
  return root.innerHTML;
};

describe("autolink", () => {
  test("turns a bare https URL into a link", () => {
    expect(linked("<p>Deck: https://example.org/deck?v=2 thanks</p>")).toBe(
      '<p>Deck: <a href="https://example.org/deck?v=2">https://example.org/deck?v=2</a> thanks</p>'
    );
  });

  test.each([
    ["See https://example.org/a.", "https://example.org/a", "."],
    ["(https://example.org/a)", "https://example.org/a", ")"],
    ["[https://example.org/a]", "https://example.org/a", "]"],
    ["Is it https://example.org/a?!", "https://example.org/a", "?!"],
    ['"https://example.org/a"', "https://example.org/a", '"'],
    ["“https://example.org/a”", "https://example.org/a", "”"],
    ["https://example.org/a;", "https://example.org/a", ";"],
    ["https://example.org/a:", "https://example.org/a", ":"],
    ["https://example.org/a,", "https://example.org/a", ","],
  ])("keeps trailing punctuation out: %s", (text, url, after) => {
    const html = linked(`<p>${text}</p>`);
    expect(html).toContain(`<a href="${url}">${url}</a>${after}`);
  });

  test("links several URLs in one text node and keeps the text between", () => {
    expect(
      linked("<p>https://example.org/a and https://example.net/b</p>")
    ).toBe(
      '<p><a href="https://example.org/a">https://example.org/a</a> and <a href="https://example.net/b">https://example.net/b</a></p>'
    );
  });

  test.each([
    [
      "an existing link",
      '<p><a href="https://example.org/x">https://example.org/a</a></p>',
    ],
    [
      "Gmail-style quoted text",
      '<div class="gmail_quote"><p>https://example.org/a</p></div>',
    ],
    ["a blockquote", "<blockquote><p>https://example.org/a</p></blockquote>"],
    ["code", "<p><code>https://example.org/a</code></p>"],
    ["pre", "<pre>curl https://example.org/a</pre>"],
    ["plain http", "<p>http://example.org/a</p>"],
    ["a host the allow-list refuses", "<p>https://127.0.0.1/admin</p>"],
    ["text without URLs", "<p>No links here.</p>"],
  ])("leaves %s alone", (_name, html) => {
    expect(linked(html)).toBe(html);
  });
});
