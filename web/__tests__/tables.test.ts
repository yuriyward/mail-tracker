import { describe, expect, test } from "bun:test";

import { createTable } from "@tanstack/react-table";
import type {
  ColumnFiltersState,
  SortingState,
  TableState,
} from "@tanstack/react-table";

import type { ListMessage, TimelineEvent } from "../../src/dashboard-data";
import {
  LIST_COLUMNS,
  LIST_SORTING,
  TIMELINE_COLUMNS,
  TIMELINE_SORTING,
  byLatestOpen,
  latestActivityOf,
  openStatesOf,
  openedByOf,
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
  clicks: 0,
  firstOpen: null,
  lastOpen: null,
  openedBy: 0,
  opens: 0,
  recipient: `${token}@example.test`,
  recipientUnknown: false,
  recipients: 1,
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
  network: "",
  reason: "synthetic",
  recipient: null,
  url: null,
  userAgent: "",
  ...e,
});

const EVENTS = [
  event(1, { class: "proxy" }),
  event(2, { class: "scanner", kind: "click", url: "https://example.test/a" }),
  event(3, { class: "human" }),
  event(4, { class: "human", kind: "click", url: "https://example.test/b" }),
  event(5, { class: "self" }),
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

  test("filters by kind and by class, together", () => {
    expect(eventIds({ filters: [{ id: "kind", value: ["click"] }] })).toEqual([
      2, 4,
    ]);
    expect(
      eventIds({ filters: [{ id: "class", value: ["human", "self"] }] })
    ).toEqual([3, 4, 5]);
    expect(
      eventIds({
        filters: [
          { id: "kind", value: ["open"] },
          { id: "class", value: ["human"] },
        ],
      })
    ).toEqual([3]);
  });

  test("an empty choice filters nothing", () => {
    expect(eventIds({ filters: [{ id: "kind", value: [] }] })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("counts each class for the filter menu", () => {
    const counts = tableOf(EVENTS, TIMELINE_COLUMNS, {})
      .getColumn("class")
      ?.getFacetedUniqueValues();
    expect(Object.fromEntries(counts ?? [])).toEqual({
      human: 2,
      proxy: 1,
      scanner: 1,
      self: 1,
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
