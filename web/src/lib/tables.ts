/**
 * Sorting and filtering for the email list and the timeline, kept apart from rendering so
 * the tests can drive them through a headless TanStack table. The pages add each
 * column's header, cell and meta.
 */
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import type {
  AccessorFnColumnDefBase,
  Row,
  SortingState,
} from "@tanstack/react-table";

import type { ListMessage, TimelineEvent } from "../../../src/dashboard-data";

/** How a column reads, sorts and filters its value; the page adds header, cell and meta. */
export type ColumnLogic<T> = AccessorFnColumnDefBase<T> & {
  id: string;
};

/** The row models both tables use: sorted, filtered, with per-value counts for the menus. */
export const rowModels = <T>() => ({
  getCoreRowModel: getCoreRowModel<T>(),
  getFacetedRowModel: getFacetedRowModel<T>(),
  getFacetedUniqueValues: getFacetedUniqueValues<T>(),
  getFilteredRowModel: getFilteredRowModel<T>(),
  getSortedRowModel: getSortedRowModel<T>(),
});

/**
 * Keeps a row whose value, or any of its values (the facet columns hold strings or string
 * arrays), is among the chosen ones; none chosen keeps every row.
 */
const inChosen = <T>(row: Row<T>, columnId: string, chosen: string[]) =>
  chosen.length === 0 ||
  [row.getValue<string | string[]>(columnId)]
    .flat()
    .some((value) => chosen.includes(value));

/** Case- and accent-insensitive order for text columns. */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Moments sort newest first on the first click; missing ones stay last either way. */
const moment = <T>(
  id: string,
  of: (row: T) => number | null
): ColumnLogic<T> => ({
  accessorFn: (row) => of(row) ?? undefined,
  enableGlobalFilter: false,
  id,
  sortDescFirst: true,
  sortUndefined: "last",
  sortingFn: "basic",
});

const count = <T>(id: string, of: (row: T) => number): ColumnLogic<T> => ({
  accessorFn: of,
  enableGlobalFilter: false,
  id,
  sortDescFirst: true,
  sortingFn: "basic",
});

/** Searched by the toolbar's text field (with `includesString`) and sorted by text. */
const text = <T>(id: string, of: (row: T) => string): ColumnLogic<T> => ({
  accessorFn: of,
  id,
  sortingFn: (a, b, columnId) =>
    collator.compare(
      a.getValue<string>(columnId),
      b.getValue<string>(columnId)
    ),
});

export const OPEN_STATES = [
  { label: "Opened", value: "opened" },
  { label: "Not opened", value: "not-opened" },
  { label: "Clicked", value: "clicked" },
] as const;

/** Counted opens and clicks only, like the list's figures; a clicked email may be unopened. */
export const openStatesOf = (m: ListMessage): string[] => {
  const states = [m.opens > 0 ? "opened" : "not-opened"];
  if (m.clicks > 0) {
    states.push("clicked");
  }
  return states;
};

/** Hidden: it carries the "opened / not opened / clicked" filter. */
const status: ColumnLogic<ListMessage> = {
  accessorFn: openStatesOf,
  enableGlobalFilter: false,
  enableSorting: false,
  filterFn: inChosen,
  getUniqueValues: openStatesOf,
  id: "status",
};

export const LIST_COLUMNS = {
  clicks: count<ListMessage>("clicks", (m) => m.clicks),
  firstOpen: moment<ListMessage>("firstOpen", (m) => m.firstOpen),
  lastOpen: moment<ListMessage>("lastOpen", (m) => m.lastOpen),
  opens: count<ListMessage>("opens", (m) => m.opens),
  recipient: text<ListMessage>("recipient", (m) => m.recipient),
  sent: moment<ListMessage>("sent", (m) => m.sentAt),
  status,
  subject: text<ListMessage>("subject", (m) => m.subject),
};

export const LIST_SORTING: SortingState = [{ desc: true, id: "sent" }];

export const KIND_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Click", value: "click" },
] as const;

const facet = (
  id: string,
  of: (e: TimelineEvent) => string
): ColumnLogic<TimelineEvent> => ({
  accessorFn: of,
  enableSorting: false,
  filterFn: inChosen,
  id,
});

export const TIMELINE_COLUMNS = {
  at: moment<TimelineEvent>("at", (e) => e.at),
  class: facet("class", (e) => e.class),
  kind: facet("kind", (e) => e.kind),
};

/** Oldest first, as the events happened. */
export const TIMELINE_SORTING: SortingState = [{ desc: false, id: "at" }];
