import type {
  HeaderContext,
  Table as TanstackTable,
} from "@tanstack/react-table";
import { SearchXIcon } from "lucide-react";
import { useCallback } from "react";
import type { ReactNode } from "react";

import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/patterns/data-table";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** A column header that is its sort button. */
export const sortHeader =
  <T,>(title: string) =>
  ({ column }: HeaderContext<T, unknown>) => (
    <DataTableColumnHeader column={column} title={title} />
  );

/** True while the search or any column filter narrows the rows. */
export const isFiltered = <T,>(table: TanstackTable<T>): boolean => {
  const search: unknown = table.getState().globalFilter;
  return (
    table.getState().columnFilters.length > 0 ||
    (search !== undefined && search !== "")
  );
};

const useClear = <T,>(table: TanstackTable<T>) =>
  useCallback(() => {
    // "", not undefined: the search field stays a controlled input.
    table.setGlobalFilter("");
    table.resetColumnFilters(true);
  }, [table]);

/** "Clear filters" in the toolbar, while any filter is on. */
export const ClearFilters = <T,>({ table }: { table: TanstackTable<T> }) => {
  const clear = useClear(table);
  return isFiltered(table) ? (
    <Button onClick={clear} variant="ghost">
      Clear filters
    </Button>
  ) : null;
};

/**
 * The toolbar's filters, the table in its own sideways-scrolling frame, and the row count;
 * no matching row shows a no-results state with "Clear filters".
 */
export const FilteredTable = <T,>({
  table,
  caption,
  toolbar,
  noun,
  noMatch,
}: {
  table: TanstackTable<T>;
  caption: string;
  toolbar: ReactNode;
  /** Singular and plural, for the row count. */
  noun: readonly [string, string];
  noMatch: string;
}) => {
  const clear = useClear(table);
  const shown = table.getRowModel().rows.length;
  const all = table.getCoreRowModel().rows.length;
  const empty = (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>{noMatch}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={clear} variant="outline">
          Clear filters
        </Button>
      </EmptyContent>
    </Empty>
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {toolbar}
        <ClearFilters table={table} />
      </div>
      <div className="border-border bg-surface-reading overflow-x-auto border">
        <DataTable caption={caption} empty={empty} table={table} />
      </div>
      <p className="type-meta text-muted-foreground" role="status">
        {shown === all
          ? `${all} ${all === 1 ? noun[0] : noun[1]}`
          : `${shown} of ${all} ${noun[1]}`}
      </p>
    </div>
  );
};
