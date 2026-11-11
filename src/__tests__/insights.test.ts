import { describe, expect, test } from "bun:test";

import {
  MAX_LINK_TEXT,
  cleanLinkText,
  domainName,
  linkName,
} from "../link-names";
import { median, peopleOf, personOf } from "../people";
import { PRELOAD_HINT, PRELOAD_WINDOW_MS, preloadHints } from "../preload";
import type { PreloadCandidate } from "../preload";
import {
  NO_REOPENS,
  PROXY_REOPEN_GAP_MS,
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
  preloaded: false,
  proxy: false,
});

const NONE = new Set<number>();

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
  preview: 0,
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
    expect(findReopens(countedOpensOf(events, NONE))).toEqual([]);
    const later = [...events, event(7, T0 + 7 * HOUR, {})];
    expect(findReopens(countedOpensOf(later, NONE)).map((o) => o.id)).toEqual([
      7,
    ]);
  });

  test("Gmail's on-open proxy re-opens after six hours: counted proxy opens take part", () => {
    const gmail = { class: "proxy", counted: 1 } as const;
    const events = [
      event(1, T0, gmail),
      event(2, T0 + 20 * MINUTE, gmail),
      // Two hours after the previous open: a human would re-open, a proxy hit does not.
      event(3, T0 + 2 * HOUR + 20 * MINUTE, gmail),
      event(4, T0 + 2 * HOUR + 20 * MINUTE + PROXY_REOPEN_GAP_MS, gmail),
      // A probable human after a proxy open is measured from the proxy open, with the hour.
      event(5, T0 + 8 * HOUR + 20 * MINUTE + 59 * MINUTE, {}),
      event(6, T0 + 8 * HOUR + 20 * MINUTE + 59 * MINUTE + HOUR, {}),
    ];
    expect(findReopens(countedOpensOf(events, NONE)).map((o) => o.id)).toEqual([
      4, 6,
    ]);
  });

  test("a proxy open one minute short of six hours is no re-open", () => {
    const gmail = { class: "proxy", counted: 1 } as const;
    const events = [
      event(1, T0, gmail),
      event(2, T0 + PROXY_REOPEN_GAP_MS - MINUTE, gmail),
    ];
    expect(findReopens(countedOpensOf(events, NONE))).toEqual([]);
  });

  test("a hit marked as a possible Gmail preload is never a re-open, but is the previous open", () => {
    const gmail = { class: "proxy", counted: 1 } as const;
    const events = [
      event(1, T0, gmail),
      event(2, T0 + 7 * HOUR, gmail),
      // Two hours after the preload: measured from it, so no re-open either.
      event(3, T0 + 9 * HOUR, gmail),
    ];
    expect(
      findReopens(countedOpensOf(events, new Set([2]))).map((o) => o.id)
    ).toEqual([]);
    expect(findReopens(countedOpensOf(events, NONE)).map((o) => o.id)).toEqual([
      2,
    ]);
  });

  test("message-level tokens group by email", () => {
    const events = [
      event(1, T0, { recipient_token: null }),
      event(2, T0 + 2 * HOUR, { recipient_token: null }),
    ];
    expect(findReopens(countedOpensOf(events, NONE))).toEqual([
      {
        at: T0 + 2 * HOUR,
        group: "message:msg",
        id: 2,
        preloaded: false,
        proxy: false,
      },
    ]);
  });
});

/** Live finding, 2026-11-11 (owner's local time): tests 4 and 5 to one Gmail address. */
const LIVE = (time: string): number => Date.parse(`2026-11-11T${time}Z`);
const GMAIL_REASON = "on-open image proxy (GoogleImageProxy)";

const hit = (
  id: number,
  at: number,
  c: Partial<PreloadCandidate> = {}
): PreloadCandidate => ({
  address: "ann@example.com",
  at,
  class: "proxy",
  id,
  message_token: "test-4",
  reason: GMAIL_REASON,
  ...c,
});
const test5 = { message_token: "test-5" };

describe("Gmail preload hint", () => {
  test("the live pairs: the later hit of each pair is a possible preload", () => {
    const hits = [
      hit(1, LIVE("23:31:57")),
      hit(2, LIVE("23:31:57"), test5),
      hit(3, LIVE("23:33:01")),
      hit(4, LIVE("23:33:02"), test5),
      hit(5, LIVE("23:33:19")),
      hit(6, LIVE("23:33:31"), test5),
    ];
    const hints = preloadHints(hits);
    expect([...hints.keys()].toSorted((a, b) => a - b)).toEqual([2, 4, 6]);
    expect(hints.get(4)).toStartWith(`${PRELOAD_HINT}: fetched 1 s after`);
    expect(hints.get(6)).toStartWith(`${PRELOAD_HINT}: fetched 12 s after`);
  });

  test("the hint is only a hint: every live hit still counts as an open, none re-opens", () => {
    const events = [
      ["23:31:57", "test-4"],
      ["23:31:57", "test-5"],
      ["23:33:01", "test-4"],
      ["23:33:02", "test-5"],
      ["23:33:19", "test-4"],
      ["23:33:31", "test-5"],
    ].map(([time = "", message = ""], index) =>
      event(index + 1, LIVE(time), {
        class: "proxy",
        message_token: message,
        reason: GMAIL_REASON,
        recipient_token: `set-${message}`,
      })
    );
    const preloads = preloadHints(
      events.map((e) => ({ ...e, address: "ann@example.com" }))
    );
    const opens = countedOpensOf(events, preloads);
    expect(opens).toHaveLength(6);
    expect(opens.filter((o) => o.preloaded).map((o) => o.id)).toEqual([
      2, 4, 6,
    ]);
    expect(findReopens(opens)).toEqual([]);
  });

  test("further apart than the window, the same email, or another person: no hint", () => {
    const hints = preloadHints([
      hit(1, T0),
      hit(2, T0 + PRELOAD_WINDOW_MS + 1000, test5),
      // The same email fetched twice is a repeat, not a neighbour.
      hit(3, T0 + 2 * HOUR),
      hit(4, T0 + 2 * HOUR + 1000),
      // Another person's email.
      hit(5, T0 + 4 * HOUR),
      hit(6, T0 + 4 * HOUR + 1000, { address: "bob@example.com", ...test5 }),
    ]);
    expect(hints).toEqual(new Map());
  });

  test("exactly at the window still counts; within it, any order of input", () => {
    const hints = preloadHints([
      hit(2, T0 + PRELOAD_WINDOW_MS, test5),
      hit(1, T0),
    ]);
    expect([...hints.keys()]).toEqual([2]);
  });

  test("only on-open Gmail proxy hits of a known address are compared", () => {
    const hints = preloadHints([
      hit(1, T0),
      // A probable human, Yahoo's proxy, a shared copy and a message-level token.
      hit(2, T0 + 1000, { class: "human", reason: "browser", ...test5 }),
      hit(3, T0 + 2000, {
        message_token: "test-6",
        reason: "on-open image proxy (YahooMailProxy)",
      }),
      hit(4, T0 + 3000, { address: "", message_token: "test-7" }),
      hit(5, T0 + 4000, { address: null, message_token: "test-8" }),
    ]);
    expect(hints).toEqual(new Map());
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
