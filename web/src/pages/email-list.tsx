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

import { listDataSchema } from "../../../src/dashboard-data";
import type { ListMessage } from "../../../src/dashboard-data";
import { LoadFailed, StaleAlert, Updated, linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import { usePoll } from "../lib/poll";

const MessageRow = ({ message }: { message: ListMessage }) => {
  const subject = subjectOf(message.subject);
  return (
    <TableRow>
      <TableCell className="max-w-[36ch] truncate" title={subject}>
        <a className={linkClass} href={`/app/messages/${message.token}`}>
          {subject}
        </a>
      </TableCell>
      <TableCell className="max-w-[28ch] truncate">
        {message.recipient}
      </TableCell>
      <TableCell>
        <When ms={message.sentAt} none="Not marked sent" />
      </TableCell>
      <TableCell>
        <When ms={message.firstOpen} none="Not opened" />
      </TableCell>
      <TableCell>
        <When ms={message.lastOpen} none="—" />
      </TableCell>
      <TableCell className="text-right">{message.opens}</TableCell>
      <TableCell className="text-right">{message.clicks}</TableCell>
    </TableRow>
  );
};

const Messages = ({ messages }: { messages: ListMessage[] }) => {
  if (messages.length === 0) {
    return (
      <Empty className="border p-8">
        <EmptyHeader>
          <EmptyTitle>No sent emails yet</EmptyTitle>
          <EmptyDescription>
            An email appears here once the Mailspring plugin reports it
            delivered, or when its first open or click arrives.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Recipient</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>First open</TableHead>
          <TableHead>Last open</TableHead>
          <TableHead className="text-right">Opens</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {messages.map((message) => (
          <MessageRow key={message.token} message={message} />
        ))}
      </TableBody>
    </Table>
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
    <p className="type-caption text-muted-foreground max-w-[90ch]">
      Opens and clicks count probable humans and on-open image proxies;
      prefetches, scanners, your own hits and repeats appear only in each
      email&apos;s timeline.
    </p>
  </section>
);
