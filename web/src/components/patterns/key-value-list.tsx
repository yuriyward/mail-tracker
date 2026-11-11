import { cn } from "cn";
import type { CSSProperties, ReactNode } from "react";

/**
 * Ruled key-value list (DESIGN.md › Composition and spacing): the default for paired facts. It responds to its own
 * width: from 28rem the key sits beside its value in a column shared by every row (up to `keyWidth`), on the
 * baseline of the value's first line; narrower, the key moves above its value.
 */
export function KeyValueList({
  rule = "border",
  keyWidth = "12rem",
  className,
  children,
}: {
  /** Rule above the first row: a 1px border rule, a 2px ink rule, or none. */
  rule?: "border" | "strong" | "none";
  /** The widest the key column may grow. It fits the longest key up to this. */
  keyWidth?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        "@container/kv grid grid-cols-[fit-content(var(--kv-key))_minmax(0,1fr)] gap-x-6",
        rule === "border" && "border-border border-t",
        rule === "strong" && "border-rule-strong border-t-2",
        className
      )}
      data-slot="key-value-list"
      style={{ "--kv-key": keyWidth } as CSSProperties}
    >
      {children}
    </dl>
  );
}

export function KeyValueRow({
  term,
  detail,
  variant = "label",
  className,
  children,
}: {
  term: ReactNode;
  /** Second line under a title-style key (e.g. a role under an organisation). */
  detail?: ReactNode;
  /** label: short mono key. title: sans key, optionally with a muted detail line. code: mono identifier. */
  variant?: "label" | "title" | "code";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "col-span-full grid @md/kv:grid-cols-subgrid grid-cols-1 @md/kv:items-baseline gap-y-1.5 border-border border-b py-3.5",
        className
      )}
      data-slot="key-value-row"
    >
      <dt
        className={cn(
          variant === "label" && "type-eyebrow text-muted-foreground",
          variant === "code" && "font-mono text-[0.875rem] text-emphasis",
          variant === "title" && "font-medium"
        )}
      >
        {term}
        {detail && (
          <span className="mt-0.5 block font-normal text-muted-foreground text-sm">
            {detail}
          </span>
        )}
      </dt>
      <dd className="min-w-0 text-pretty">{children}</dd>
    </div>
  );
}
