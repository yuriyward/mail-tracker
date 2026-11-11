import type { Column } from "@tanstack/react-table";
import { cn } from "cn";
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { type ChangeEvent, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

export function DataTableSearch({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  const clear = useCallback(() => onChange(""), [onChange]);
  return (
    <InputGroup className={cn("w-full sm:w-72", className)}>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        // The field has its own clear button; hide the browser's.
        className="[&::-webkit-search-cancel-button]:appearance-none"
        onChange={change}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label="Clear search"
            onClick={clear}
            size="icon-sm"
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** A menu of checkboxes for one column, each with the number of rows it would match. */
export function DataTableFacetedFilter<TData, TValue>({
  column,
  title,
  options,
}: {
  column: Column<TData, TValue>;
  title: string;
  options: readonly { value: string; label: string }[];
}) {
  const counts = column.getFacetedUniqueValues();
  const selected = new Set((column.getFilterValue() as string[]) ?? []);
  let summary: string | null | undefined = null;
  if (selected.size === 1) {
    summary = options.find((option) => selected.has(option.value))?.label;
  } else if (selected.size > 1) {
    summary = `${selected.size} selected`;
  }
  const clear = useCallback(() => column.setFilterValue(undefined), [column]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="has-data-[icon=inline-end]:pr-3"
            variant="outline"
          />
        }
      >
        {title}
        {summary && (
          <>
            <span aria-hidden className="h-4 w-px bg-border" />
            <span className="font-normal">{summary}</span>
          </>
        )}
        <ChevronDownIcon aria-hidden data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Show rows with {title.toLowerCase()}
          </DropdownMenuLabel>
          {options.map((option) => (
            <DataTableFilterOption
              checked={selected.has(option.value)}
              column={column}
              count={counts.get(option.value) ?? 0}
              key={option.value}
              option={option}
            />
          ))}
        </DropdownMenuGroup>
        {selected.size > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={clear}>
              Clear {title.toLowerCase()} filter
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DataTableFilterOption<TData, TValue>({
  column,
  option,
  checked,
  count,
}: {
  column: Column<TData, TValue>;
  option: { value: string; label: string };
  checked: boolean;
  count: number;
}) {
  const toggle = useCallback(
    (nextChecked: boolean) => {
      const selected = new Set((column.getFilterValue() as string[]) ?? []);
      if (nextChecked) {
        selected.add(option.value);
      } else {
        selected.delete(option.value);
      }
      column.setFilterValue(selected.size ? [...selected] : undefined);
    },
    [column, option.value]
  );
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      closeOnClick={false}
      onCheckedChange={toggle}
    >
      {option.label}
      <span className="type-meta ml-auto text-muted-foreground">{count}</span>
    </DropdownMenuCheckboxItem>
  );
}
