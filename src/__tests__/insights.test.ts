import { describe, expect, test } from "bun:test";

import {
  MAX_LINK_TEXT,
  cleanLinkText,
  domainName,
  linkName,
} from "../link-names";
import { median, peopleOf, personOf } from "../people";
import {
  NO_REOPENS,
  REOPEN_GAP_MS,
  findReopens,
  countedOpensOf,
  reopensByGroup,
  summarise,
} from "../reopen";
import type { CountedOpen } from "../reopen";
import type { EventRow, RecipientActivityRow } from "../schema";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000;

describe("link names", () => {
  test.each([
    ["https://cal.com/someone/30min", "cal.com"],
    ["https://www.linkedin.com/in/someone", "linkedin.com"],
    ["https://github.com/example/repo", "github.com"],
    ["https://m.example.org/page", "example.org"],
    ["https://www2.example.org/", "example.org"],
    ["https://docs.example.org/a", "docs.example.org"],
    ["https://WWW.Example.ORG/", "example.org"],
  ])("%s is named %s by its domain", (url, name) => {
    expect(domainName(url)).toBe(name);
    expect(linkName(url, "")).toBe(name);
  });

  test("the link's own text wins over the domain", () => {
    expect(linkName("https://cal.com/someone", "Book a call")).toBe(
      "Book a call"
    );
  });

  test("text that only repeats a URL falls back to the domain", () => {
    expect(
      linkName("https://github.com/example", "https://github.com/example")
    ).toBe("github.com");
    expect(linkName("https://github.com/example", "www.github.com")).toBe(
      "github.com"
    );
  });

  test("text is trimmed, its whitespace collapsed and long text cut", () => {
    expect(cleanLinkText("  the\n\t deck  ")).toBe("the deck");
    expect(cleanLinkText("   ")).toBe("");
    const long = cleanLinkText("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(MAX_LINK_TEXT);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a URL that does not parse is shown as it is", () => {
    expect(domainName("not a url")).toBe("not a url");
  });
});

const open = (id: number, at: number, group = "set-a"): CountedOpen => ({
  at,
  group,
  id,
});

const event = (id: number, at: number, e: Partial<EventRow>): EventRow => ({
  as_organization: "",
  at,
  class: "human",
  counted: 1,
  country: "",
  duplicate: 0,
  id,
  ip: "198.51.100.7",
  kind: "open",
  link_token: null,
  message_token: "msg",
  method: "GET",
  reason: "synthetic",
  recipient_token: "set-a",
  user_agent: "",
  ...e,
});

describe("re-open detection", () => {
  test("an open an hour or more after the previous one is a re-open", () => {
    const opens = [
      open(1, T0),
      open(2, T0 + 10 * MINUTE),
      open(3, T0 + 10 * MINUTE + REOPEN_GAP_MS),
      open(4, T0 + 10 * MINUTE + REOPEN_GAP_MS + 59 * MINUTE),
      open(5, T0 + 3 * HOUR + 10 * MINUTE),
    ];
    expect(findReopens(opens).map((o) => o.id)).toEqual([3, 5]);
    expect(summarise(findReopens(opens))).toEqual({
      lastReopen: T0 + 3 * HOUR + 10 * MINUTE,
      reopens: 2,
    });
  });

  test("the gap is measured from the previous open, not the first one", () => {
    const opens = [0, 50, 100, 150].map((m, i) => open(i, T0 + m * MINUTE));
    expect(findReopens(opens)).toEqual([]);
  });

  test("a single open, or none, is no re-open", () => {
    expect(findReopens([open(1, T0)])).toEqual([]);
    expect(summarise([])).toEqual(NO_REOPENS);
  });

  test("each token set is its own run, in any input order", () => {
    const opens = [
      open(4, T0 + 2 * HOUR, "set-b"),
      open(1, T0, "set-a"),
      open(3, T0 + 2 * HOUR - 30 * MINUTE, "set-b"),
      open(2, T0 + 90 * MINUTE, "set-a"),
    ];
    const reopens = findReopens(opens);
    expect(reopens.map((o) => o.id)).toEqual([2]);
    expect(reopensByGroup(reopens)).toEqual(
      new Map([["set-a", { lastReopen: T0 + 90 * MINUTE, reopens: 1 }]])
    );
  });

  test("prefetches, scanners, own hits, repeats and clicks neither start nor resume a run", () => {
    const events = [
      event(1, T0, {}),
      // An Apple prefetch, a scanner, an own hit, a repeat and a click.
      event(2, T0 + 2 * HOUR, { class: "proxy", counted: 0 }),
      event(3, T0 + 3 * HOUR, { class: "scanner", counted: 0 }),
      event(4, T0 + 4 * HOUR, { class: "self", counted: 0 }),
      event(5, T0 + 5 * HOUR, { duplicate: 1 }),
      event(6, T0 + 6 * HOUR, { kind: "click" }),
    ];
    expect(findReopens(countedOpensOf(events))).toEqual([]);
    const later = [...events, event(7, T0 + 7 * HOUR, {})];
    expect(findReopens(countedOpensOf(later)).map((o) => o.id)).toEqual([7]);
  });

  test("Gmail's on-open proxy re-opens: counted proxy opens take part", () => {
    const gmail = { class: "proxy", counted: 1 } as const;
    const events = [
      event(1, T0, gmail),
      event(2, T0 + 20 * MINUTE, gmail),
      event(3, T0 + 2 * HOUR, gmail),
      // A probable human after a proxy open is measured from the proxy open.
      event(4, T0 + 2 * HOUR + 30 * MINUTE, {}),
    ];
    expect(findReopens(countedOpensOf(events)).map((o) => o.id)).toEqual([3]);
  });

  test("message-level tokens group by email", () => {
    const events = [
      event(1, T0, { recipient_token: null }),
      event(2, T0 + 2 * HOUR, { recipient_token: null }),
    ];
    expect(findReopens(countedOpensOf(events))).toEqual([
      { at: T0 + 2 * HOUR, group: "message:msg", id: 2 },
    ]);
  });
});

const row = (
  recipient: string,
  r: Partial<RecipientActivityRow>
): RecipientActivityRow => ({
  address: "ann@example.com",
  clicks: 0,
  created_at: T0,
  first_open: null,
  last_click: null,
  last_open: null,
  message_token: `msg-${recipient}`,
  opens: 0,
  recipient_token: recipient,
  sent_at: T0,
  subject: `Subject ${recipient}`,
  ...r,
});

describe("people aggregates", () => {
  test("median of odd and even counts, and of none", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("one person across emails: counts, latest moments, median first open, re-opens", () => {
    const rows = [
      row("r1", {
        first_open: T0 + 10 * MINUTE,
        last_open: T0 + 3 * HOUR,
        opens: 3,
        sent_at: T0,
      }),
      row("r2", {
        clicks: 1,
        // Gmail's on-open proxy fetched first, 30 minutes after sending: it counts.
        first_open: T0 + 1 * HOUR + 30 * MINUTE,
        last_click: T0 + 2 * HOUR,
        last_open: T0 + 1 * HOUR + 40 * MINUTE,
        opens: 2,
        sent_at: T0 + HOUR,
      }),
      // Sent later, never opened.
      row("r3", { sent_at: T0 + 5 * HOUR }),
      // Clicked without a counted open: opened, but no first-open delay.
      row("r4", { clicks: 1, last_click: T0 + 4 * HOUR, sent_at: T0 }),
    ];
    const reopens = new Map([
      ["r1", { lastReopen: T0 + 3 * HOUR, reopens: 1 }],
    ]);
    const person = personOf(
      "ann@example.com",
      rows,
      (token) => reopens.get(token) ?? NO_REOPENS
    );
    expect(person).toEqual({
      address: "ann@example.com",
      emails: 4,
      lastActivity: T0 + 5 * HOUR,
      lastClick: T0 + 4 * HOUR,
      lastOpen: T0 + 3 * HOUR,
      lastReopen: T0 + 3 * HOUR,
      lastSent: T0 + 5 * HOUR,
      // Delays of 10 and 30 minutes.
      medianFirstOpen: 20 * MINUTE,
      opened: 3,
      reopens: 1,
    });
  });

  test("an open before the reported send time counts as no delay", () => {
    const person = personOf(
      "ann@example.com",
      [row("r1", { first_open: T0 - MINUTE, opens: 1 })],
      () => NO_REOPENS
    );
    expect(person.medianFirstOpen).toBe(0);
  });

  test("one row per address, newest activity first, unsent and silent last", () => {
    const people = peopleOf(
      [
        row("r1", { address: "old@example.com", sent_at: T0 }),
        row("r2", { address: "new@example.com", sent_at: T0 + HOUR }),
        row("r3", { address: "old@example.com", last_open: T0 + 2 * HOUR }),
        row("r4", { address: "b-none@example.com", sent_at: null }),
        row("r5", { address: "a-none@example.com", sent_at: null }),
      ],
      new Map()
    );
    expect(people.map((p) => [p.address, p.emails])).toEqual([
      ["old@example.com", 2],
      ["new@example.com", 1],
      ["a-none@example.com", 1],
      ["b-none@example.com", 1],
    ]);
  });
});
