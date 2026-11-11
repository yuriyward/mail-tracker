import { cn } from "cn";
import type { ReactNode } from "react";

/** One large figure with what it counts. The scope note is never dropped. */
export function BigNumber({
  value,
  label,
  className,
  children,
}: {
  value: ReactNode;
  label: ReactNode;
  className?: string;
  /** Optional visual under the label (a small chart or illustration). */
  children?: ReactNode;
}) {
  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      <p className="font-serif text-[clamp(4rem,2.5rem+4vw,6.5rem)] tabular-nums leading-[1.05] tracking-[-0.02em]">
        {value}
      </p>
      <figcaption className="text-[1.0625rem]">{label}</figcaption>
      {children}
    </figure>
  );
}

export interface Stat {
  /** One cell may be highlighted on the blue field: the figure the page is about. */
  featured?: boolean;
  /** What the figure counts: its scope. Never dropped. */
  label: ReactNode;
  value: ReactNode;
}

/**
 * Figures with their scope (DESIGN.md › Charts, tables and diagrams): serif figures on the ruled ink grid, the scope
 * under each figure, the source note under the grid, at most one cell on the blue field. Three figures sit in one
 * row from tablet width; four two by two, then in one row, so the grid never leaves an empty cell.
 */
export function StatStrip({
  stats,
  note,
  className,
}: {
  stats: Stat[];
  note: ReactNode;
  className?: string;
}) {
  const columnClasses: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "md:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  };
  const columns = columnClasses[stats.length] ?? "";
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <dl className={cn("ink-grid grid-cols-1", columns)}>
        {stats.map((stat, i) => (
          <div
            className={cn(
              "flex flex-col gap-2.5 px-6 py-7",
              stat.featured
                ? "bg-field-blue text-field-blue-foreground"
                : "bg-background"
            )}
            key={i}
          >
            <dd
              className={cn(
                "order-first font-serif tabular-nums",
                stats.length > 3
                  ? "text-[clamp(2.5rem,2rem+1.4vw,3.25rem)]"
                  : "text-[clamp(3rem,2.4rem+2vw,4.25rem)]",
                // After the size: cn() drops a line height that comes before a font size.
                "leading-none"
              )}
            >
              {stat.value}
            </dd>
            <dt className="text-[0.9375rem] leading-normal">{stat.label}</dt>
          </div>
        ))}
      </dl>
      <p className="type-caption max-w-[90ch] text-muted-foreground">{note}</p>
    </div>
  );
}
