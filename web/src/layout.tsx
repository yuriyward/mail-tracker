import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { clockOf } from "./lib/format";

const icon = `${import.meta.env.BASE_URL}favicon.svg`;

export type Section = "emails" | "people";

const NAV: { href: string; label: string; section: Section }[] = [
  { href: "/app", label: "Emails", section: "emails" },
  { href: "/app/people", label: "People", section: "people" },
];

/** A section's own list is the page; one of its emails or people is within it. */
const currentOf = (
  section: Section,
  current: Section,
  home: boolean
): "page" | "true" | undefined => {
  if (section !== current) {
    return undefined;
  }
  return home ? "page" : "true";
};

const navClass =
  "type-meta hover:underline aria-[current=page]:font-medium aria-[current=page]:no-underline";

export const Layout = ({
  children,
  current,
  home,
}: {
  children: ReactNode;
  /** The section the page belongs to. */
  current: Section;
  /** The section's list is the current page (not one email or person). */
  home: boolean;
}) => (
  <div className="min-h-svh">
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
        <img alt="" className="size-6" height={24} src={icon} width={24} />
        <a
          aria-current={home && current === "emails" ? "page" : undefined}
          className="type-wordmark text-lg hover:underline aria-[current=page]:no-underline"
          href="/app"
        >
          mail-tracker
        </a>
        <nav aria-label="Sections" className="ml-auto flex gap-6">
          {NAV.map((item) => (
            <a
              aria-current={currentOf(item.section, current, home)}
              className={navClass}
              href={item.href}
              key={item.section}
            >
              {item.label}
            </a>
          ))}
        </nav>
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
    Updated {clockOf(ms)}
  </p>
);

/** A refresh failed: the last data stays on screen. */
export const StaleAlert = ({ ms }: { ms: number }) => (
  <Alert variant="destructive">
    <AlertTitle>Refresh failed</AlertTitle>
    <AlertDescription>
      Showing data from {clockOf(ms)}. Reload the page if this persists.
    </AlertDescription>
  </Alert>
);

export const LoadFailed = () => (
  <Alert variant="destructive">
    <AlertTitle>Could not load the data</AlertTitle>
    <AlertDescription>Reload the page if this persists.</AlertDescription>
  </Alert>
);

export const linkClass =
  "text-emphasis underline underline-offset-4 hover:decoration-2";
