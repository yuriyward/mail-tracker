import { useReactTable } from "@tanstack/react-table";
import type {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";

import {
  DataTableFacetedFilter,
  DataTableSearch,
} from "@/components/patterns/data-table-filters";

import { OPEN_STATES, rowModels } from "./lib/tables";
import { FilteredTable } from "./table-parts";

/**
 * A sortable list with a search field and the status filter (opened, not opened, clicked,
 * re-opened): the email list, the people list and a person's emails.
 */
export const ListTable = <T,>({
  caption,
  columns,
  data,
  hidden = {},
  noMatch,
  noun,
  rowId,
  search,
  sorting: initialSorting,
}: {
  caption: string;
  columns: ColumnDef<T>[];
  data: T[];
  /** Columns that only carry a filter, e.g. `{ status: false }`. */
  hidden?: VisibilityState;
  noMatch: string;
  noun: readonly [string, string];
  rowId: (row: T) => string;
  /** The search field's label and placeholder. */
  search: { label: string; placeholder: string };
  sorting: SortingState;
}) => {
  const [models] = useState(() => rowModels<T>());
  const [sorting, setSorting] = useState(initialSorting);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const table = useReactTable({
    ...models,
    columns,
    data,
    getRowId: rowId,
    globalFilterFn: "includesString",
    initialState: { columnVisibility: hidden },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    state: { columnFilters, globalFilter, sorting },
  });
  const status = table.getColumn("status");
  return (
    <FilteredTable
      caption={caption}
      noMatch={noMatch}
      noun={noun}
      table={table}
      toolbar={
        <>
          <DataTableSearch
            label={search.label}
            onChange={setGlobalFilter}
            placeholder={search.placeholder}
            value={globalFilter}
          />
          {status && (
            <DataTableFacetedFilter
              column={status}
              options={OPEN_STATES}
              title="Status"
            />
          )}
        </>
      }
    />
  );
};
