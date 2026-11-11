import { StatStrip } from "@/components/patterns/figures";
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

import { CLASS_LABELS } from "../../../src/classify";
import type { EventClass } from "../../../src/classify";
import { detailDataSchema } from "../../../src/dashboard-data";
import type {
  DetailData,
  TimelineEvent,
  Totals,
} from "../../../src/dashboard-data";
import { LoadFailed, StaleAlert, Updated, linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import { usePoll } from "../lib/poll";

const CLASS_BADGE: Record<EventClass, "default" | "secondary" | "outline"> = {
  human: "default",
  proxy: "secondary",
  scanner: "outline",
  self: "outline",
  unknown: "outline",
};

const TotalsStrip = ({ totals }: { totals: Totals }) => {
  const { opens, clicks } = totals;
  return (
    <StatStrip
      note={`Counts leave out prefetches, scanners, your own hits, unknown clients and repeats by the same client within 30 s (${opens.notCounted} opens and ${clicks.notCounted} clicks here); the timeline shows every event.`}
      stats={[
        { featured: true, label: "Opens", value: opens.counted },
        { label: "by a probable human", value: opens.human },
        {
          label: "through an on-open image proxy (e.g. Gmail)",
          value: opens.proxy,
        },
        { label: "Clicks, all links", value: clicks.counted },
      ]}
    />
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

const clientOf = (e: TimelineEvent): string =>
  [e.userAgent, e.network, e.country].filter((part) => part !== "").join(" · ");

const EventRow = ({ event }: { event: TimelineEvent }) => {
  const client = clientOf(event);
  return (
    <TableRow>
      <TableCell>
        <When ms={event.at} none="—" />
      </TableCell>
      <TableCell
        className="max-w-[40ch] truncate"
        title={event.url ?? undefined}
      >
        {event.kind === "open" ? "Open" : "Click"}
        {event.url !== null && (
          <span className="ml-2 font-mono text-sm">{event.url}</span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          <Badge variant={CLASS_BADGE[event.class]}>
            {CLASS_LABELS[event.class]}
          </Badge>
          {event.duplicate && <Badge variant="ghost">repeat</Badge>}
        </span>
      </TableCell>
      <TableCell className="max-w-[40ch] truncate" title={event.reason}>
        {event.reason}
      </TableCell>
      <TableCell
        className="text-muted-foreground max-w-[40ch] truncate"
        title={client}
      >
        {client}
      </TableCell>
    </TableRow>
  );
};

const Timeline = ({ events }: { events: TimelineEvent[] }) => {
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Client</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <EventRow event={event} key={event.id} />
        ))}
      </TableBody>
    </Table>
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
        <KeyValueRow term="To">{message.recipient}</KeyValueRow>
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
      <TotalsStrip totals={totals} />
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
