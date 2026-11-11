import { useReactTable } from "@tanstack/react-table";
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import { useState } from "react";

import { DataTableFacetedFilter } from "@/components/patterns/data-table-filters";
import {
  KeyValueList,
  KeyValueRow,
} from "@/components/patterns/key-value-list";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { CLASS_LABELS, EVENT_CLASSES } from "../../../src/classify";
import type { EventClass } from "../../../src/classify";
import { detailDataSchema, recipientLabel } from "../../../src/dashboard-data";
import type {
  DetailData,
  RecipientTotals,
  TimelineEvent,
  Totals,
} from "../../../src/dashboard-data";
import { LoadFailed, StaleAlert, Updated, linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import { usePoll } from "../lib/poll";
import {
  KIND_OPTIONS,
  TIMELINE_COLUMNS,
  TIMELINE_SORTING,
  rowModels,
} from "../lib/tables";
import { FilteredTable, sortHeader } from "../table-parts";

const CLASS_BADGE: Record<EventClass, "default" | "secondary" | "outline"> = {
  human: "default",
  proxy: "secondary",
  scanner: "outline",
  self: "outline",
  unknown: "outline",
};

/** The per-email figures in one compact row, with the counting rule under it. */
const TotalsRow = ({ totals }: { totals: Totals }) => {
  const { opens, clicks } = totals;
  const figures = [
    { label: "Opens", value: opens.counted },
    { label: "Probable human", value: opens.human },
    { label: "Image proxy", value: opens.proxy },
    { label: "Clicks", value: clicks.counted },
    { label: "Not counted", value: opens.notCounted + clicks.notCounted },
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="border-border flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y py-3">
        {figures.map((figure) => (
          <div className="flex items-baseline gap-2" key={figure.label}>
            <dt className="type-meta text-muted-foreground">{figure.label}</dt>
            <dd className="font-medium tabular-nums">{figure.value}</dd>
          </div>
        ))}
      </dl>
      <p className="type-caption text-muted-foreground max-w-[90ch]">
        Counts leave out prefetches, scanners, your own hits, unknown clients
        and repeats by the same client within 30 s ({opens.notCounted} opens and{" "}
        {clicks.notCounted} clicks here); the timeline shows every event. Image
        proxies (e.g. Gmail) fetch when the recipient opens.
      </p>
    </div>
  );
};

const LinkClicks = ({ totals }: { totals: Totals }) => {
  const { links } = totals.clicks;
  if (links.length === 0) {
    return (
      <Empty className="border p-8">
        <EmptyHeader>
          <EmptyTitle>No tracked links</EmptyTitle>
          <EmptyDescription>
            This email went out without https links, so only opens are tracked.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Link</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
          <TableHead className="text-right">Not counted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {links.map((link) => (
          <TableRow key={link.token}>
            <TableCell
              className="max-w-[60ch] truncate font-mono text-sm"
              title={link.url}
            >
              {link.url}
            </TableCell>
            <TableCell className="text-right">{link.clicks}</TableCell>
            <TableCell className="text-muted-foreground text-right">
              {link.notCounted}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/** One row per recipient's token set: opens, clicks, open times and forwarding hints. */
const RecipientTable = ({ rows }: { rows: RecipientTotals[] }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Recipient</TableHead>
        <TableHead className="text-right">Opens</TableHead>
        <TableHead className="text-right">Clicks</TableHead>
        <TableHead className="text-right">First open</TableHead>
        <TableHead className="text-right">Last open</TableHead>
        <TableHead>Forwarding</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={r.token}>
          <TableCell className="max-w-[40ch] truncate">
            {recipientLabel(r.address)}
          </TableCell>
          <TableCell className="text-right">{r.opens}</TableCell>
          <TableCell className="text-right">{r.clicks}</TableCell>
          <TableCell className="type-meta text-right">
            <When ms={r.firstOpen} none="—" />
          </TableCell>
          <TableCell className="type-meta text-right">
            <When ms={r.lastOpen} none="—" />
          </TableCell>
          <TableCell>
            {r.hints > 0 ? (
              <Badge variant="secondary">
                {r.hints === 1
                  ? "1 event possibly forwarded"
                  : `${r.hints} events possibly forwarded`}
              </Badge>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

/**
 * Who opened and clicked. Current recipients come first and are what the email list
 * counts; recipients removed from the draft that still have activity are listed apart.
 */
const Recipients = ({ recipients }: { recipients: RecipientTotals[] }) => {
  if (recipients.length === 0) {
    return (
      <Empty className="border p-8">
        <EmptyHeader>
          <EmptyTitle>No per-recipient tracking</EmptyTitle>
          <EmptyDescription>
            This email was tracked with one image and one set of links for
            everyone, so opens and clicks cannot be told apart by recipient.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const current = recipients.filter((r) => r.current);
  const removed = recipients.filter((r) => !r.current);
  return (
    <>
      <RecipientTable rows={current} />
      {removed.length > 0 && (
        <>
          <h3 className="type-meta">Removed recipients with activity</h3>
          <p className="type-caption text-muted-foreground max-w-[90ch]">
            These addresses were on an earlier version of the draft. Their
            tokens still recorded events, which are not counted in the email
            list&apos;s &ldquo;Opened by&rdquo;.
          </p>
          <RecipientTable rows={removed} />
        </>
      )}
    </>
  );
};

const clientOf = (e: TimelineEvent): string =>
  [e.userAgent, e.network, e.country].filter((part) => part !== "").join(" · ");

const CLASS_OPTIONS = EVENT_CLASSES.map((value) => ({
  label: CLASS_LABELS[value],
  value,
}));

const TRUNCATE = "block max-w-[40ch] truncate";

const COLUMNS: ColumnDef<TimelineEvent>[] = [
  {
    ...TIMELINE_COLUMNS.at,
    cell: ({ row }) => <When ms={row.original.at} none="—" />,
    header: sortHeader<TimelineEvent>("When"),
    meta: { cellClassName: "type-meta" },
  },
  {
    ...TIMELINE_COLUMNS.kind,
    cell: ({ row }) => {
      const { kind, url } = row.original;
      return (
        <span className={TRUNCATE} title={url ?? undefined}>
          {kind === "open" ? "Open" : "Click"}
          {url !== null && (
            <span className="ml-2 font-mono text-sm">{url}</span>
          )}
        </span>
      );
    },
    header: "Event",
  },
  {
    ...TIMELINE_COLUMNS.class,
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <Badge variant={CLASS_BADGE[row.original.class]}>
          {CLASS_LABELS[row.original.class]}
        </Badge>
        {row.original.duplicate && <Badge variant="ghost">repeat</Badge>}
        {row.original.hint !== null && (
          <Badge title={row.original.hint} variant="secondary">
            possibly forwarded
          </Badge>
        )}
      </span>
    ),
    header: "Class",
  },
  {
    cell: ({ row }) => {
      const { recipient } = row.original;
      const label = recipient === null ? "—" : recipientLabel(recipient);
      return (
        <span className={TRUNCATE} title={label}>
          {label}
        </span>
      );
    },
    header: "Recipient",
    id: "recipient",
  },
  {
    cell: ({ row }) => {
      const reason = [row.original.reason, row.original.hint]
        .filter((part) => part !== null)
        .join("; ");
      return (
        <span className={TRUNCATE} title={reason}>
          {reason}
        </span>
      );
    },
    header: "Reason",
    id: "reason",
  },
  {
    cell: ({ row }) => {
      const client = clientOf(row.original);
      return (
        <span className={`${TRUNCATE} text-muted-foreground`} title={client}>
          {client}
        </span>
      );
    },
    header: "Client",
    id: "client",
  },
];

const MODELS = rowModels<TimelineEvent>();

const Timeline = ({ events }: { events: TimelineEvent[] }) => {
  const [sorting, setSorting] = useState(TIMELINE_SORTING);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const table = useReactTable({
    ...MODELS,
    columns: COLUMNS,
    data: events,
    getRowId: (e) => String(e.id),
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    state: { columnFilters, sorting },
  });
  const kind = table.getColumn("kind");
  const eventClass = table.getColumn("class");
  if (events.length === 0) {
    return (
      <Empty className="border p-8">
        <EmptyHeader>
          <EmptyTitle>No opens or clicks yet</EmptyTitle>
          <EmptyDescription>
            Every hit on the image or a link appears here, classified, within 15
            s while this page is open.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <FilteredTable
      caption="Every open and click of this email. The When header sorts the rows."
      noMatch="No events match"
      noun={["event", "events"]}
      table={table}
      toolbar={
        <>
          {kind && (
            <DataTableFacetedFilter
              column={kind}
              options={KIND_OPTIONS}
              title="Kind"
            />
          )}
          {eventClass && (
            <DataTableFacetedFilter
              column={eventClass}
              options={CLASS_OPTIONS}
              title="Class"
            />
          )}
        </>
      }
    />
  );
};

const Detail = ({ data, stale }: { data: DetailData; stale: boolean }) => {
  const { message, totals, timeline } = data;
  return (
    <>
      <h1 className="type-section break-words">{subjectOf(message.subject)}</h1>
      <Updated ms={data.updated} />
      {stale && <StaleAlert ms={data.updated} />}
      <KeyValueList>
        <KeyValueRow term="To">
          {message.recipient}
          {message.shared && (
            <Badge className="ml-2" variant="outline">
              one shared copy (Microsoft Graph)
            </Badge>
          )}
        </KeyValueRow>
        <KeyValueRow term="Sent">
          <When ms={message.sentAt} none="Not marked sent" />
        </KeyValueRow>
        <KeyValueRow term="First open">
          <When ms={totals.firstOpen} none="Not opened" />
        </KeyValueRow>
        <KeyValueRow term="Last open">
          <When ms={totals.lastOpen} none="Not opened" />
        </KeyValueRow>
      </KeyValueList>
      <TotalsRow totals={totals} />
      <section className="flex flex-col gap-4">
        <h2 className="type-article-h3">Recipients</h2>
        <Recipients recipients={totals.recipients} />
        <p className="type-caption text-muted-foreground max-w-[90ch]">
          Each recipient gets their own image and links. &ldquo;Possibly
          forwarded&rdquo; marks a later probable-human event from another
          network, country or kind of device than that recipient&apos;s first
          one: a hint, not proof, since the same person may switch networks or
          devices.
        </p>
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="type-article-h3">Clicks per link</h2>
        <LinkClicks totals={totals} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="type-article-h3">Timeline</h2>
        <Timeline events={timeline} />
      </section>
    </>
  );
};

const NotFound = () => (
  <Empty className="border p-8">
    <EmptyHeader>
      <EmptyTitle>Email not found</EmptyTitle>
      <EmptyDescription>
        No email has this address; it may come from another deployment.{" "}
        <a href="/app">Back to all emails</a>
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

const Loading = () => (
  <div
    aria-label="Loading the email"
    className="flex flex-col gap-4"
    role="status"
  >
    <Skeleton className="h-14 w-2/3" />
    <Skeleton className="h-40 w-full" />
    <Skeleton className="h-40 w-full" />
  </div>
);

const Body = ({ token }: { token: string }) => {
  const poll = usePoll(
    `/app/messages/${encodeURIComponent(token)}/data`,
    detailDataSchema
  );
  switch (poll.kind) {
    case "loading": {
      return <Loading />;
    }
    case "missing": {
      return <NotFound />;
    }
    case "failed": {
      return <LoadFailed />;
    }
    case "ready": {
      return <Detail data={poll.data} stale={poll.stale} />;
    }
    default: {
      return null;
    }
  }
};

export const EmailDetail = ({ token }: { token: string }) => (
  <article className="flex flex-col gap-8">
    <p>
      <a className={linkClass} href="/app">
        ← All emails
      </a>
    </p>
    <Body token={token} />
  </article>
);
