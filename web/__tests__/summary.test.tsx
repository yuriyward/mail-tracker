import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { Summary } from "../src/summary";

const SENT = Date.parse("2026-11-04T09:00:00Z");
const FIRST = Date.parse("2026-11-04T10:00:00Z");
const LAST = Date.parse("2026-11-05T10:00:00Z");

const text = (html: string) => html.replaceAll(/<[^>]+>/gu, "");

describe("Summary", () => {
  test("recipient, sent and the open range on one line, full dates on hover", () => {
    const html = renderToStaticMarkup(
      <Summary
        message={{ recipient: "ann@example.com", sentAt: SENT, shared: false }}
        totals={{ firstOpen: FIRST, lastOpen: LAST }}
      />
    );
    expect(html.match(/<p /gu)).toHaveLength(1);
    expect(text(html)).toMatch(/^ann@example\.com·sent .+·opened .+–.+$/u);
    expect(html.match(/<time /gu)).toHaveLength(3);
    expect(html.match(/ title="/gu)).toHaveLength(3);
  });

  test("one open shows one time; unsent and unopened say so", () => {
    const once = renderToStaticMarkup(
      <Summary
        message={{ recipient: "ann@example.com", sentAt: SENT, shared: false }}
        totals={{ firstOpen: FIRST, lastOpen: FIRST }}
      />
    );
    expect(text(once)).not.toContain("–");
    const none = renderToStaticMarkup(
      <Summary
        message={{ recipient: "", sentAt: null, shared: true }}
        totals={{ firstOpen: null, lastOpen: null }}
      />
    );
    expect(text(none)).toBe("shared copy·not sent·not opened");
  });
});
