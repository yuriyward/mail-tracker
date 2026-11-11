import type { ReactNode } from "react";
import type { z } from "zod";

import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import { LoadFailed, StaleAlert, Updated } from "./layout";
import { usePoll } from "./lib/poll";

/** Placeholder rows while the first read is on its way. */
export const Loading = ({ label }: { label: string }) => (
  <div aria-label={label} className="flex flex-col gap-2" role="status">
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
  </div>
);

/** A bordered empty state with one title. */
export const Nothing = ({ title }: { title: string }) => (
  <Empty className="border p-8">
    <EmptyHeader>
      <EmptyTitle>{title}</EmptyTitle>
    </EmptyHeader>
  </Empty>
);

/**
 * Polls `url`, then renders the data with when it was read, and a stale alert when the
 * last refresh failed. 404 shows `missing`.
 */
export const Polled = <T extends { updated: number }>({
  children,
  loading,
  missing,
  schema,
  url,
}: {
  children: (data: T) => ReactNode;
  loading: string;
  missing: string;
  schema: z.ZodType<T>;
  url: string;
}) => {
  const poll = usePoll(url, schema);
  if (poll.kind === "loading") {
    return <Loading label={loading} />;
  }
  if (poll.kind === "missing") {
    return <Nothing title={missing} />;
  }
  if (poll.kind === "failed") {
    return <LoadFailed />;
  }
  return (
    <>
      <Updated ms={poll.data.updated} />
      {poll.stale && <StaleAlert ms={poll.data.updated} />}
      {children(poll.data)}
    </>
  );
};
