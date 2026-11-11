import type { ReactNode } from "react";

export interface Figure {
  label: string;
  value: ReactNode;
}

/** Figures in one compact, ruled row: the label, then the value. */
export const FigureRow = ({ figures }: { figures: Figure[] }) => (
  <dl className="border-border flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y py-3">
    {figures.map((figure) => (
      <div className="flex items-baseline gap-2" key={figure.label}>
        <dt className="type-meta text-muted-foreground">{figure.label}</dt>
        <dd className="font-medium tabular-nums">{figure.value}</dd>
      </div>
    ))}
  </dl>
);
