import { describe, expect, test } from "bun:test";

import { createTable } from "@tanstack/react-table";
import type {
  ColumnFiltersState,
  SortingState,
  TableState,
} from "@tanstack/react-table";

import type {
  ListMessage,
  Person,
  PersonEmail,
  TimelineEvent,
} from "../../src/dashboard-data";
import { duration } from "../src/lib/dates";
import {
  LIST_COLUMNS,
  LIST_SORTING,
  PEOPLE_COLUMNS,
  PEOPLE_SORTING,
  PERSON_EMAIL_COLUMNS,
  PERSON_EMAIL_SORTING,
  TIMELINE_COLUMNS,
  TIMELINE_SORTING,
  byLatestOpen,
  latestActivityOf,
  openStatesOf,
  openedByOf,
  personEmailActivityOf,
  personStatesOf,
  rowModels,
} from "../src/lib/tables";
import type { ColumnLogic } from "../src/lib/tables";

/** The state is fixed per table; nothing changes it. */
const ignore = (): void => {
  // A headless table never needs to update.
};

interface View {
  filters?: ColumnFiltersState;
  search?: string;
  sorting?: SortingState;
}

/** A headless table with the pages' columns, row models and global filter. */
const tableOf = <T>(
  data: T[],
  columns: Record<string, ColumnLogic<T>>,
  view: View
) => {
  const state: Partial<TableState> = {
    columnFilters: view.filters ?? [],
    columnPinning: { left: [], right: [] },
    columnVisibility: {},
    globalFilter: view.search ?? "",
    sorting: view.sorting ?? [],
  };
  return createTable<T>({
    ...rowModels<T>(),
    columns: Object.values(columns),
    data,
    globalFilterFn: "includesString",
    onStateChange: ignore,
    renderFallbackValue: null,
    state,
  });
};

const message = (token: string, m: Partial<ListMessage>): ListMessage => ({
  addresses: [`${token}@example.test`],
  clicks: 0,
  firstOpen: null,
  lastOpen: null,
  lastReopen: null,
  openedBy: 0,
  opens: 0,
  recipient: `${token}@example.test`,
  recipientUnknown: false,
  recipients: 1,
  reopens: 0,
  sentAt: null,
  shared: false,
  subject: `Subject ${token}`,
  token,
  ...m,
});

const MESSAGES = [
  message("a", {
    clicks: 2,
    firstOpen: 3000,
    lastOpen: 9000,
    opens: 4,
    recipient: "ada@example.test",
    sentAt: 1000,
    subject: "Quarterly figures",
  }),
  message("b", {
    opens: 0,
    recipient: "bob@example.test",
    sentAt: 5000,
    subject: "lunch on friday",
  }),
  message("c", {
    firstOpen: 7000,
    lastOpen: 7000,
    opens: 1,
    recipient: "cleo@example.test",
    sentAt: null,
    subject: "Älteste Rechnung",
  }),
  message("d", {
    clicks: 1,
    opens: 0,
    recipient: "dan@example.test",
    sentAt: 3000,
    subject: "Invoice 10",
  }),
];

const listTokens = (view: View): string[] =>
  tableOf(MESSAGES, LIST_COLUMNS, view)
    .getRowModel()
    .rows.map((row) => row.original.token);

describe("email list sorting", () => {
  test("defaults to latest activity, newest first", () => {
    // a: opened at 9000, c: opened at 7000 though unsent, b: sent at 5000, d: sent at 3000.
    expect(listTokens({ sorting: LIST_SORTING })).toEqual(["a", "c", "b", "d"]);
  });

  test("latest activity is the newer of sent and last open, none last", () => {
    expect(
      latestActivityOf(message("x", { lastOpen: 2000, sentAt: 4000 }))
    ).toBe(4000);
    expect(
      latestActivityOf(message("x", { lastOpen: 6000, sentAt: 4000 }))
    ).toBe(6000);
    expect(latestActivityOf(message("x", {}))).toBeNull();
    const rows = tableOf([message("x", {}), ...MESSAGES], LIST_COLUMNS, {
      sorting: LIST_SORTING,
    })
      .getRowModel()
      .rows.map((row) => row.original.token);
    expect(rows).toEqual(["a", "c", "b", "d", "x"]);
  });

  test("sorts by sent, newest first, with unsent emails last", () => {
    expect(listTokens({ sorting: [{ desc: true, id: "sent" }] })).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  test("keeps missing moments last in either direction", () => {
    expect(listTokens({ sorting: [{ desc: false, id: "sent" }] })).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(listTokens({ sorting: [{ desc: true, id: "firstOpen" }] })).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(listTokens({ sorting: [{ desc: false, id: "lastOpen" }] })).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  test("sorts counts and text", () => {
    expect(listTokens({ sorting: [{ desc: true, id: "opens" }] })).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
    expect(listTokens({ sorting: [{ desc: true, id: "clicks" }] })).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    // Case- and accent-insensitive: "Älteste" sorts with the a's, "lunch" among the l's.
    expect(listTokens({ sorting: [{ desc: false, id: "subject" }] })).toEqual([
      "c",
      "d",
      "b",
      "a",
    ]);
    expect(listTokens({ sorting: [{ desc: true, id: "recipient" }] })).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  test("dates and counts sort descending on the first click, text ascending", () => {
    const table = tableOf(MESSAGES, LIST_COLUMNS, {});
    const first = (id: string) => table.getColumn(id)?.getFirstSortDir();
    expect(first("sent")).toBe("desc");
    expect(first("lastActivity")).toBe("desc");
    expect(first("opens")).toBe("desc");
    expect(first("subject")).toBe("asc");
    expect(table.getColumn("status")?.getCanSort()).toBe(false);
  });
});

describe("email list filtering", () => {
  test("searches subject and recipient, ignoring case", () => {
    expect(listTokens({ search: "INVOICE" })).toEqual(["d"]);
    expect(listTokens({ search: "bob@" })).toEqual(["b"]);
    expect(listTokens({ search: "example.test" })).toHaveLength(4);
  });

  test("does not search dates or counts", () => {
    expect(listTokens({ search: "3000" })).toEqual([]);
  });

  test("filters by opened, not opened and clicked, any of the chosen", () => {
    const by = (value: string[]) =>
      listTokens({ filters: [{ id: "status", value }] });
    expect(by(["opened"])).toEqual(["a", "c"]);
    expect(by(["not-opened"])).toEqual(["b", "d"]);
    expect(by(["clicked"])).toEqual(["a", "d"]);
    expect(by(["not-opened", "clicked"])).toEqual(["a", "b", "d"]);
  });

  test("combines the search and the status filter", () => {
    expect(
      listTokens({
        filters: [{ id: "status", value: ["clicked"] }],
        search: "ada",
      })
    ).toEqual(["a"]);
  });

  test("counts each state for the filter menu", () => {
    const counts = tableOf(MESSAGES, LIST_COLUMNS, {})
      .getColumn("status")
      ?.getFacetedUniqueValues();
    expect(Object.fromEntries(counts ?? [])).toEqual({
      clicked: 2,
      "not-opened": 2,
      opened: 2,
    });
  });

  test("an email clicked but not opened is both", () => {
    expect(openStatesOf(message("x", { clicks: 1 }))).toEqual([
      "not-opened",
      "clicked",
    ]);
  });
});

const event = (id: number, e: Partial<TimelineEvent>): TimelineEvent => ({
  at: id * 1000,
  class: "human",
  counted: true,
  country: "",
  duplicate: false,
  hint: null,
  id,
  kind: "open",
  label: "Opened",
  linkName: null,
  network: "",
  reason: "synthetic",
  recipient: null,
  reopen: false,
  url: null,
  userAgent: "",
  via: null,
  ...e,
});

const EVENTS = [
  event(1, { class: "proxy", label: "Prefetch" }),
  event(2, {
    class: "scanner",
    kind: "click",
    label: "Scanner",
    url: "https://example.test/a",
  }),
  event(3, { class: "proxy", label: "Opened", via: "Gmail" }),
  event(4, {
    class: "human",
    kind: "click",
    label: "Clicked",
    url: "https://example.test/b",
  }),
  event(5, { class: "self", label: "You" }),
];

const eventIds = (view: View): number[] =>
  tableOf(EVENTS, TIMELINE_COLUMNS, view)
    .getRowModel()
    .rows.map((row) => row.original.id);

describe("timeline", () => {
  test("shows events newest first by default, and can reverse", () => {
    expect(eventIds({ sorting: TIMELINE_SORTING })).toEqual([5, 4, 3, 2, 1]);
    expect(eventIds({ sorting: [{ desc: false, id: "at" }] })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("filters by kind and by label, together", () => {
    expect(eventIds({ filters: [{ id: "kind", value: ["click"] }] })).toEqual([
      2, 4,
    ]);
    expect(
      eventIds({ filters: [{ id: "class", value: ["Opened", "You"] }] })
    ).toEqual([3, 5]);
    expect(
      eventIds({
        filters: [
          { id: "kind", value: ["open"] },
          { id: "class", value: ["Opened", "Clicked"] },
        ],
      })
    ).toEqual([3]);
  });

  test("an empty choice filters nothing", () => {
    expect(eventIds({ filters: [{ id: "kind", value: [] }] })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("counts each label for the filter menu", () => {
    const counts = tableOf(EVENTS, TIMELINE_COLUMNS, {})
      .getColumn("class")
      ?.getFacetedUniqueValues();
    expect(Object.fromEntries(counts ?? [])).toEqual({
      Clicked: 1,
      Opened: 1,
      Prefetch: 1,
      Scanner: 1,
      You: 1,
    });
  });
});

describe("opened by", () => {
  test("counts recipients, and says when a shared copy hides who opened", () => {
    expect(openedByOf(message("x", { openedBy: 2, recipients: 3 }))).toBe(
      "2 of 3"
    );
    expect(openedByOf(message("x", { recipients: 0 }))).toBe("—");
    expect(
      openedByOf(message("x", { openedBy: 1, recipientUnknown: true }))
    ).toBe("opened, recipient unknown");
    expect(openedByOf(message("x", { recipientUnknown: true }))).toBe(
      "shared copy"
    );
  });
});

describe("recipients", () => {
  test("latest open first, never opened last in their given order", () => {
    const rows = [
      { lastOpen: null, token: "p" },
      { lastOpen: 2000, token: "q" },
      { lastOpen: null, token: "r" },
      { lastOpen: 8000, token: "s" },
    ];
    expect(byLatestOpen(rows).map((r) => r.token)).toEqual([
      "s",
      "q",
      "p",
      "r",
    ]);
  });
});

describe("re-opened emails", () => {
  const REOPENED = [
    ...MESSAGES,
    message("e", { lastReopen: 8000, opens: 3, reopens: 1, sentAt: 500 }),
    message("f", { lastReopen: 6000, opens: 2, reopens: 2, sentAt: 400 }),
  ];
  const tokens = (view: View): string[] =>
    tableOf(REOPENED, LIST_COLUMNS, view)
      .getRowModel()
      .rows.map((row) => row.original.token);

  test("the status filter picks re-opened emails", () => {
    expect(
      tokens({ filters: [{ id: "status", value: ["reopened"] }] })
    ).toEqual(["e", "f"]);
    expect(openStatesOf(REOPENED[4] ?? message("x", {}))).toEqual([
      "opened",
      "reopened",
    ]);
  });

  test("sorts by last re-open, newest first, never re-opened last", () => {
    const table = tableOf(REOPENED, LIST_COLUMNS, {});
    expect(table.getColumn("lastReopen")?.getFirstSortDir()).toBe("desc");
    expect(
      tokens({ sorting: [{ desc: true, id: "lastReopen" }] }).slice(0, 2)
    ).toEqual(["e", "f"]);
  });
});

const person = (address: string, p: Partial<Person>): Person => ({
  address,
  emails: 1,
  lastActivity: null,
  lastClick: null,
  lastOpen: null,
  lastReopen: null,
  lastSent: null,
  medianFirstOpen: null,
  opened: 0,
  reopens: 0,
  ...p,
});

const PEOPLE = [
  person("ann@example.test", {
    lastActivity: 5000,
    lastOpen: 5000,
    medianFirstOpen: 3 * 60_000,
    opened: 2,
  }),
  person("ben@example.test", { lastActivity: 9000, lastSent: 9000 }),
  person("cy@example.test", {
    lastActivity: 7000,
    lastClick: 7000,
    lastReopen: 6500,
    medianFirstOpen: 60_000,
    opened: 1,
    reopens: 1,
  }),
  person("dee@example.test", {}),
];

const peopleBy = (view: View): string[] =>
  tableOf(PEOPLE, PEOPLE_COLUMNS, view)
    .getRowModel()
    .rows.map((row) => row.original.address.split("@")[0] ?? "");

describe("people list", () => {
  test("defaults to latest activity, newest first, none last", () => {
    expect(peopleBy({ sorting: PEOPLE_SORTING })).toEqual([
      "ben",
      "cy",
      "ann",
      "dee",
    ]);
  });

  test("the median first open sorts shortest first, none last", () => {
    expect(
      peopleBy({ sorting: [{ desc: false, id: "medianFirstOpen" }] })
    ).toEqual(["cy", "ann", "ben", "dee"]);
  });

  test("searches the address and filters by status", () => {
    expect(peopleBy({ search: "CY@" })).toEqual(["cy"]);
    const by = (value: string[]) =>
      peopleBy({ filters: [{ id: "status", value }] });
    expect(by(["opened"])).toEqual(["ann", "cy"]);
    expect(by(["not-opened"])).toEqual(["ben", "dee"]);
    expect(by(["clicked"])).toEqual(["cy"]);
    expect(by(["reopened"])).toEqual(["cy"]);
  });

  test("statuses of a person", () => {
    expect(personStatesOf(PEOPLE[2] ?? person("x", {}))).toEqual([
      "opened",
      "clicked",
      "reopened",
    ]);
  });
});

const personEmail = (token: string, e: Partial<PersonEmail>): PersonEmail => ({
  clicks: 0,
  firstOpen: null,
  lastClick: null,
  lastOpen: null,
  lastReopen: null,
  opens: 0,
  reopens: 0,
  sentAt: null,
  subject: `Subject ${token}`,
  token,
  ...e,
});

describe("a person's emails", () => {
  test("default to latest activity, a click included, newest first", () => {
    const emails = [
      personEmail("a", { lastOpen: 4000, sentAt: 1000 }),
      personEmail("b", { lastClick: 6000, sentAt: 2000 }),
      personEmail("c", { sentAt: 5000 }),
      personEmail("d", {}),
    ];
    expect(personEmailActivityOf(emails[1] ?? personEmail("x", {}))).toBe(6000);
    expect(
      tableOf(emails, PERSON_EMAIL_COLUMNS, { sorting: PERSON_EMAIL_SORTING })
        .getRowModel()
        .rows.map((row) => row.original.token)
    ).toEqual(["b", "c", "a", "d"]);
  });
});

describe("durations", () => {
  test.each([
    [20_000, "under a minute"],
    [12 * 60_000, "12 min"],
    [3_600_000, "1 h"],
    [3 * 3_600_000 + 5 * 60_000, "3 h 5 min"],
    [2 * 86_400_000, "2 d"],
    [2 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000, "2 d 4 h"],
  ])("%d ms reads %s", (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});
