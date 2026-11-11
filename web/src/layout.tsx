import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { clockOf } from "./lib/format";

const icon = `${import.meta.env.BASE_URL}favicon.svg`;

export const Layout = ({
  children,
  home,
}: {
  children: ReactNode;
  /** The email list is the current page. */
  home: boolean;
}) => (
  <div className="min-h-svh">
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
        <img alt="" className="size-6" height={24} src={icon} width={24} />
        <a
          aria-current={home ? "page" : undefined}
          className="type-wordmark text-lg hover:underline aria-[current=page]:no-underline"
          href="/app"
        >
          mail-tracker
        </a>
      </div>
    </header>
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-10">
      {children}
    </main>
  </div>
);

/** When the data on screen was read; announced politely as it changes. */
export const Updated = ({ ms }: { ms: number }) => (
  <p aria-live="polite" className="type-meta text-muted-foreground">
    Updated {clockOf(ms)}, refreshes every 15 s while open
  </p>
);

/** A refresh failed: the last data stays on screen. */
export const StaleAlert = ({ ms }: { ms: number }) => (
  <Alert variant="destructive">
    <AlertTitle>Refresh failed</AlertTitle>
    <AlertDescription>
      Showing data from {clockOf(ms)}. Retrying every 15 s; reload the page if
      this persists (your Access session may have expired).
    </AlertDescription>
  </Alert>
);

export const LoadFailed = () => (
  <Alert variant="destructive">
    <AlertTitle>Could not load the data</AlertTitle>
    <AlertDescription>
      Retrying every 15 s; reload the page if this persists (your Access session
      may have expired).
    </AlertDescription>
  </Alert>
);

export const linkClass =
  "text-emphasis underline underline-offset-4 hover:decoration-2";
