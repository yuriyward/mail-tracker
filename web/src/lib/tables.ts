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

import type {
  ListMessage,
  Person,
  PersonEmail,
  TimelineEvent,
} from "../../../src/dashboard-data";

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

/** Spans sort shortest first on the first click; missing ones stay last either way. */
const span = <T>(
  id: string,
  of: (row: T) => number | null
): ColumnLogic<T> => ({
  accessorFn: (row) => of(row) ?? undefined,
  enableGlobalFilter: false,
  id,
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
  { label: "Re-opened", value: "reopened" },
] as const;

export type OpenState = (typeof OPEN_STATES)[number]["value"];

/** What a status is worked out from: an email's, or one person's view of it. */
type Engagement = Pick<ListMessage, "clicks" | "opens" | "reopens">;

/**
 * Counted opens and clicks only, like the list's figures; a clicked email may be unopened.
 * Re-opened: a probable-human open an hour or more after the previous one (src/reopen.ts).
 */
export const openStatesOf = (m: Engagement): OpenState[] => {
  const states: OpenState[] = [m.opens > 0 ? "opened" : "not-opened"];
  if (m.clicks > 0) {
    states.push("clicked");
  }
  if (m.reopens > 0) {
    states.push("reopened");
  }
  return states;
};

/** The label of a status value. */
export const openStateLabel = (value: OpenState): string =>
  OPEN_STATES.find((state) => state.value === value)?.label ?? value;

/** People: opened (any email), never opened, clicked, re-opened. */
export const personStatesOf = (p: Person): OpenState[] =>
  openStatesOf({
    clicks: p.lastClick === null ? 0 : 1,
    opens: p.opened,
    reopens: p.reopens,
  });

/**
 * How many recipients opened or clicked, of how many: "2 of 3". A shared copy (Graph) to
 * several people cannot tell them apart; emails from before per-recipient tokens have none.
 */
export const openedByOf = (m: ListMessage): string => {
  if (m.recipients === 0) {
    return "—";
  }
  if (m.recipientUnknown) {
    return m.openedBy > 0 ? "opened, recipient unknown" : "shared copy";
  }
  return `${m.openedBy} of ${m.recipients}`;
};

/** Carries the "opened / not opened / clicked / re-opened" filter. */
const statusOf = <T>(of: (row: T) => OpenState[]): ColumnLogic<T> => ({
  accessorFn: of,
  enableGlobalFilter: false,
  enableSorting: false,
  filterFn: inChosen,
  getUniqueValues: of,
  id: "status",
});

/**
 * The newest of sent and last open. The list data carries no click times, so a click
 * after the last open does not move an email up.
 */
export const latestActivityOf = (m: ListMessage): number | null => {
  const moments = [m.sentAt, m.lastOpen].filter((ms) => ms !== null);
  return moments.length === 0 ? null : Math.max(...moments);
};

/** The newest of sent, last open and last click: one person's view of an email. */
export const personEmailActivityOf = (e: PersonEmail): number | null => {
  const moments = [e.sentAt, e.lastOpen, e.lastClick].filter(
    (ms) => ms !== null
  );
  return moments.length === 0 ? null : Math.max(...moments);
};

export const LIST_COLUMNS = {
  clicks: count<ListMessage>("clicks", (m) => m.clicks),
  firstOpen: moment<ListMessage>("firstOpen", (m) => m.firstOpen),
  lastActivity: moment<ListMessage>("lastActivity", latestActivityOf),
  lastOpen: moment<ListMessage>("lastOpen", (m) => m.lastOpen),
  lastReopen: moment<ListMessage>("lastReopen", (m) => m.lastReopen),
  openedBy: count<ListMessage>("openedBy", (m) => m.openedBy),
  opens: count<ListMessage>("opens", (m) => m.opens),
  recipient: text<ListMessage>("recipient", (m) => m.recipient),
  sent: moment<ListMessage>("sent", (m) => m.sentAt),
  status: statusOf<ListMessage>(openStatesOf),
  subject: text<ListMessage>("subject", (m) => m.subject),
};

/** Latest activity, newest first. */
export const LIST_SORTING: SortingState = [{ desc: true, id: "lastActivity" }];

export const PEOPLE_COLUMNS = {
  address: text<Person>("address", (p) => p.address),
  emails: count<Person>("emails", (p) => p.emails),
  lastActivity: moment<Person>("lastActivity", (p) => p.lastActivity),
  lastClick: moment<Person>("lastClick", (p) => p.lastClick),
  lastOpen: moment<Person>("lastOpen", (p) => p.lastOpen),
  lastReopen: moment<Person>("lastReopen", (p) => p.lastReopen),
  medianFirstOpen: span<Person>("medianFirstOpen", (p) => p.medianFirstOpen),
  opened: count<Person>("opened", (p) => p.opened),
  status: statusOf<Person>(personStatesOf),
};

/** Latest activity, newest first, as the email list. */
export const PEOPLE_SORTING: SortingState = [
  { desc: true, id: "lastActivity" },
];

export const PERSON_EMAIL_COLUMNS = {
  clicks: count<PersonEmail>("clicks", (e) => e.clicks),
  firstOpen: moment<PersonEmail>("firstOpen", (e) => e.firstOpen),
  lastActivity: moment<PersonEmail>("lastActivity", personEmailActivityOf),
  lastClick: moment<PersonEmail>("lastClick", (e) => e.lastClick),
  lastOpen: moment<PersonEmail>("lastOpen", (e) => e.lastOpen),
  lastReopen: moment<PersonEmail>("lastReopen", (e) => e.lastReopen),
  opens: count<PersonEmail>("opens", (e) => e.opens),
  sent: moment<PersonEmail>("sent", (e) => e.sentAt),
  status: statusOf<PersonEmail>(openStatesOf),
  subject: text<PersonEmail>("subject", (e) => e.subject),
};

/** Latest activity, newest first. */
export const PERSON_EMAIL_SORTING: SortingState = [
  { desc: true, id: "lastActivity" },
];

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
  class: facet("class", (e) => e.label),
  kind: facet("kind", (e) => e.kind),
};

/** Newest event first. */
export const TIMELINE_SORTING: SortingState = [{ desc: true, id: "at" }];

/**
 * Recipients by their last open, newest first; never opened last, in their given order.
 * The recipient tables are not sortable, so this is their only order.
 */
export const byLatestOpen = <T extends { lastOpen: number | null }>(
  rows: readonly T[]
): T[] =>
  rows.toSorted((a, b) => {
    if (a.lastOpen === b.lastOpen) {
      return 0;
    }
    if (a.lastOpen === null) {
      return 1;
    }
    if (b.lastOpen === null) {
      return -1;
    }
    return b.lastOpen - a.lastOpen;
  });
