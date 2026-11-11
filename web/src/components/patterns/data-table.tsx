import {
  type Column,
  flexRender,
  type RowData,
  type Table as TanstackTable,
} from "@tanstack/react-table";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/*
 * Data table pieces for TanStack Table v8 (DESIGN.md › Tables, a data table). The table logic (columns, state,
 * row models) stays in the screen that owns the data; these pieces only render it.
 */

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** "end" for numbers and dates: header, sort arrow and cells align right. */
    align?: "start" | "end";
    /** Applied to body cells only, e.g. type-meta for numbers. */
    cellClassName?: string;
    /** Applied to the header cell and every body cell of the column. */
    className?: string;
    /**
     * Keeps the column in place while the table scrolls sideways, at this left offset
     * ("0", then the width of the columns before it). Pin the columns that name the row.
     */
    pin?: string;
    /** The last pinned column draws a rule on its right edge while the table scrolls. */
    pinEdge?: boolean;
  }
}

const sortDirections = { asc: "ascending", desc: "descending" } as const;

function alignClass(align?: "start" | "end") {
  return align === "end" ? "text-right" : undefined;
}

/* A pinned cell needs its own opaque fill, so it repeats the row's hover and selected fills. */
// transition-colors matches the row's own fade, so the pinned cells do not light up ahead of the rest.
const PINNED =
  "sticky z-10 bg-surface-reading transition-colors group-hover/row:bg-row-hover group-data-[state=selected]/row:bg-row-selected";
const PIN_EDGE = "max-lg:shadow-[inset_-1px_0_0_var(--border)]";

function pinProps(meta?: { pin?: string; pinEdge?: boolean }) {
  if (meta?.pin === undefined) {
    return {};
  }
  return {
    className: cn(PINNED, meta.pinEdge && PIN_EDGE),
    style: { left: meta.pin },
  };
}

export function DataTable<TData>({
  table,
  caption,
  empty,
  className,
}: {
  table: TanstackTable<TData>;
  /** Read by screen readers; the visible title lives outside the table. */
  caption: string;
  /** Shown in one full-width row when no row matches. */
  empty?: ReactNode;
  className?: string;
}) {
  const { rows } = table.getRowModel();
  return (
    <Table className={cn("min-w-[52rem]", className)}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader className="[&_tr]:border-rule-strong">
        {table.getHeaderGroups().map((group) => (
          <TableRow className="group/row hover:bg-transparent" key={group.id}>
            {group.headers.map((header) => {
              const { meta } = header.column.columnDef;
              const sorted = header.column.getIsSorted();
              const pin = pinProps(meta);
              return (
                <TableHead
                  // Only the sorted column carries aria-sort (WAI-ARIA APG, sortable table).
                  aria-sort={sorted ? sortDirections[sorted] : undefined}
                  className={cn(
                    alignClass(meta?.align),
                    meta?.className,
                    pin.className,
                    "group-hover/row:bg-surface-reading"
                  )}
                  key={header.id}
                  style={pin.style}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length > 0 ? (
          rows.map((row) => (
            <TableRow
              className="group/row"
              data-state={row.getIsSelected() ? "selected" : undefined}
              key={row.id}
            >
              {row.getVisibleCells().map((cell) => {
                const { meta } = cell.column.columnDef;
                const pin = pinProps(meta);
                return (
                  <TableCell
                    className={cn(
                      alignClass(meta?.align),
                      meta?.className,
                      meta?.cellClassName,
                      pin.className
                    )}
                    key={cell.id}
                    style={pin.style}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))
        ) : (
          <TableRow className="hover:bg-transparent">
            <TableCell
              className="whitespace-normal p-0"
              colSpan={table.getVisibleLeafColumns().length}
            >
              {empty}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** The header label is the sort button. Unsorted columns show a quiet double arrow. */
export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
}: {
  column: Column<TData, TValue>;
  title: string;
}) {
  if (!column.getCanSort()) {
    return <>{title}</>;
  }
  const sorted = column.getIsSorted();
  const end = column.columnDef.meta?.align === "end";
  let Icon = ChevronsUpDownIcon;
  if (sorted) {
    Icon = sorted === "asc" ? ArrowUpIcon : ArrowDownIcon;
  }
  return (
    <Button
      className={cn(
        "font-semibold text-sm",
        // The label keeps the column's alignment; the arrow sits on the inner side.
        end ? "-mr-3 flex-row-reverse" : "-ml-3"
      )}
      onClick={column.getToggleSortingHandler()}
      size="xs"
      variant="ghost"
    >
      {title}
      <Icon
        aria-hidden
        className={cn(
          "size-3.5!",
          sorted ? "text-foreground" : "text-muted-foreground"
        )}
      />
    </Button>
  );
}
