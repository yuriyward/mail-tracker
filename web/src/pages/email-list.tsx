import { useReactTable } from "@tanstack/react-table";
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import { useState } from "react";

import {
  DataTableFacetedFilter,
  DataTableSearch,
} from "@/components/patterns/data-table-filters";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import { listDataSchema } from "../../../src/dashboard-data";
import type { ListMessage } from "../../../src/dashboard-data";
import { Hint } from "../hint";
import { LoadFailed, StaleAlert, Updated, linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import { usePoll } from "../lib/poll";
import {
  LIST_COLUMNS,
  LIST_SORTING,
  OPEN_STATES,
  latestActivityOf,
  openedByOf,
  rowModels,
} from "../lib/tables";
import { FilteredTable, sortHeader } from "../table-parts";

const END = { align: "end", cellClassName: "type-meta" } as const;

const COLUMNS: ColumnDef<ListMessage>[] = [
  {
    ...LIST_COLUMNS.subject,
    cell: ({ row }) => {
      const subject = subjectOf(row.original.subject);
      return (
        <Hint label={subject}>
          <a
            className={`${linkClass} block max-w-[36ch] truncate`}
            href={`/app/messages/${row.original.token}`}
          >
            {subject}
          </a>
        </Hint>
      );
    },
    header: sortHeader<ListMessage>("Subject"),
    meta: { pin: "0", pinEdge: true },
  },
  {
    ...LIST_COLUMNS.recipient,
    cell: ({ row }) => (
      <Hint label={row.original.recipient}>
        <span className="block max-w-[28ch] truncate">
          {row.original.recipient}
        </span>
      </Hint>
    ),
    header: sortHeader<ListMessage>("Recipient"),
  },
  {
    ...LIST_COLUMNS.lastActivity,
    cell: ({ row }) => <When ms={latestActivityOf(row.original)} none="—" />,
    header: sortHeader<ListMessage>("Last activity"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.sent,
    cell: ({ row }) => <When ms={row.original.sentAt} none="Not sent" />,
    header: sortHeader<ListMessage>("Sent"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.firstOpen,
    cell: ({ row }) => <When ms={row.original.firstOpen} none="—" />,
    header: sortHeader<ListMessage>("First open"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.lastOpen,
    cell: ({ row }) => <When ms={row.original.lastOpen} none="—" />,
    header: sortHeader<ListMessage>("Last open"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.opens,
    header: sortHeader<ListMessage>("Opens"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.clicks,
    header: sortHeader<ListMessage>("Clicks"),
    meta: END,
  },
  {
    ...LIST_COLUMNS.openedBy,
    cell: ({ row }) => openedByOf(row.original),
    header: sortHeader<ListMessage>("Opened by"),
    meta: END,
  },
  LIST_COLUMNS.status,
];

const MODELS = rowModels<ListMessage>();

const Messages = ({ messages }: { messages: ListMessage[] }) => {
  const [sorting, setSorting] = useState(LIST_SORTING);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const table = useReactTable({
    ...MODELS,
    columns: COLUMNS,
    data: messages,
    getRowId: (m) => m.token,
    globalFilterFn: "includesString",
    initialState: { columnVisibility: { status: false } },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    state: { columnFilters, globalFilter, sorting },
  });
  const status = table.getColumn("status");
  if (messages.length === 0) {
    return (
      <Empty className="border p-8">
        <EmptyHeader>
          <EmptyTitle>No sent emails yet</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <FilteredTable
      caption="Emails"
      noMatch="No emails match"
      noun={["email", "emails"]}
      table={table}
      toolbar={
        <>
          <DataTableSearch
            label="Search emails by subject or recipient"
            onChange={setGlobalFilter}
            placeholder="Search subject or recipient"
            value={globalFilter}
          />
          {status && (
            <DataTableFacetedFilter
              column={status}
              options={OPEN_STATES}
              title="Status"
            />
          )}
        </>
      }
    />
  );
};

const Loading = () => (
  <div
    aria-label="Loading emails"
    className="flex flex-col gap-2"
    role="status"
  >
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
  </div>
);

const Body = () => {
  const poll = usePoll("/app/data", listDataSchema);
  if (poll.kind === "loading") {
    return <Loading />;
  }
  if (poll.kind !== "ready") {
    return <LoadFailed />;
  }
  const { data, stale } = poll;
  return (
    <>
      <Updated ms={data.updated} />
      {stale && <StaleAlert ms={data.updated} />}
      <Messages messages={data.messages} />
    </>
  );
};

export const EmailList = () => (
  <section className="flex flex-col gap-6">
    <h1 className="type-section">Emails</h1>
    <Body />
  </section>
);
