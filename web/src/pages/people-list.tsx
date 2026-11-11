import type { ColumnDef } from "@tanstack/react-table";

import { peopleDataSchema } from "../../../src/dashboard-data";
import type { Person } from "../../../src/dashboard-data";
import { MedianFirstOpen, PersonLink } from "../badges";
import { When } from "../lib/format";
import { PEOPLE_COLUMNS, PEOPLE_SORTING } from "../lib/tables";
import { ListTable } from "../list-table";
import { Nothing, Polled } from "../polled";
import { sortHeader } from "../table-parts";

const END = { align: "end", cellClassName: "type-meta" } as const;

const moment = (
  column: (typeof PEOPLE_COLUMNS)["lastOpen"],
  title: string,
  of: (p: Person) => number | null
): ColumnDef<Person> => ({
  ...column,
  cell: ({ row }) => <When ms={of(row.original)} none="—" />,
  header: sortHeader<Person>(title),
  meta: END,
});

const COLUMNS: ColumnDef<Person>[] = [
  {
    ...PEOPLE_COLUMNS.address,
    cell: ({ row }) => (
      <PersonLink
        address={row.original.address}
        className="block max-w-[36ch] truncate"
      />
    ),
    header: sortHeader<Person>("Person"),
    meta: { pin: "0", pinEdge: true },
  },
  moment(PEOPLE_COLUMNS.lastActivity, "Last activity", (p) => p.lastActivity),
  moment(PEOPLE_COLUMNS.lastOpen, "Last open", (p) => p.lastOpen),
  moment(PEOPLE_COLUMNS.lastClick, "Last click", (p) => p.lastClick),
  moment(PEOPLE_COLUMNS.lastReopen, "Re-opened", (p) => p.lastReopen),
  {
    ...PEOPLE_COLUMNS.emails,
    header: sortHeader<Person>("Emails sent"),
    meta: END,
  },
  {
    ...PEOPLE_COLUMNS.opened,
    header: sortHeader<Person>("Emails opened"),
    meta: END,
  },
  {
    ...PEOPLE_COLUMNS.medianFirstOpen,
    cell: ({ row }) => <MedianFirstOpen ms={row.original.medianFirstOpen} />,
    header: sortHeader<Person>("Median to first open"),
    meta: END,
  },
  PEOPLE_COLUMNS.status,
];

const People = ({ people }: { people: Person[] }) =>
  people.length === 0 ? (
    <Nothing title="No recipients yet" />
  ) : (
    <ListTable
      caption="People"
      columns={COLUMNS}
      data={people}
      hidden={{ status: false }}
      noMatch="No people match"
      noun={["person", "people"]}
      rowId={(p) => p.address}
      search={{
        label: "Search people by address",
        placeholder: "Search address",
      }}
      sorting={PEOPLE_SORTING}
    />
  );

export const PeopleList = () => (
  <section className="flex flex-col gap-6">
    <h1 className="type-section">People</h1>
    <Polled
      loading="Loading people"
      missing="No recipients yet"
      schema={peopleDataSchema}
      url="/app/people/data"
    >
      {(data) => <People people={data.people} />}
    </Polled>
  </section>
);
