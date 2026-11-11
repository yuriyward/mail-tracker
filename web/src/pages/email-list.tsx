import type { ColumnDef } from "@tanstack/react-table";

import { listDataSchema } from "../../../src/dashboard-data";
import type { ListMessage } from "../../../src/dashboard-data";
import { RecipientLinks } from "../badges";
import { Hint } from "../hint";
import { linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import {
  LIST_COLUMNS,
  LIST_SORTING,
  latestActivityOf,
  openedByOf,
} from "../lib/tables";
import { ListTable } from "../list-table";
import { Nothing, Polled } from "../polled";
import { sortHeader } from "../table-parts";

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
      <RecipientLinks
        addresses={row.original.addresses}
        fallback={row.original.recipient}
      />
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
    ...LIST_COLUMNS.lastReopen,
    cell: ({ row }) => <When ms={row.original.lastReopen} none="—" />,
    header: sortHeader<ListMessage>("Re-opened"),
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

const Messages = ({ messages }: { messages: ListMessage[] }) =>
  messages.length === 0 ? (
    <Nothing title="No sent emails yet" />
  ) : (
    <ListTable
      caption="Emails"
      columns={COLUMNS}
      data={messages}
      hidden={{ status: false }}
      noMatch="No emails match"
      noun={["email", "emails"]}
      rowId={(m) => m.token}
      search={{
        label: "Search emails by subject or recipient",
        placeholder: "Search subject or recipient",
      }}
      sorting={LIST_SORTING}
    />
  );

export const EmailList = () => (
  <section className="flex flex-col gap-6">
    <h1 className="type-section">Emails</h1>
    <Polled
      loading="Loading emails"
      missing="No sent emails yet"
      schema={listDataSchema}
      url="/app/data"
    >
      {(data) => <Messages messages={data.messages} />}
    </Polled>
  </section>
);
