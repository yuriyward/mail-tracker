import type { ColumnDef } from "@tanstack/react-table";

import { personDataSchema } from "../../../src/dashboard-data";
import type { PersonData, PersonEmail } from "../../../src/dashboard-data";
import { MedianFirstOpen, StatusBadges } from "../badges";
import { FigureRow } from "../figure-row";
import { Hint } from "../hint";
import { linkClass } from "../layout";
import { When, subjectOf } from "../lib/format";
import {
  PERSON_EMAIL_COLUMNS,
  PERSON_EMAIL_SORTING,
  openStatesOf,
  personEmailActivityOf,
} from "../lib/tables";
import { ListTable } from "../list-table";
import { Polled } from "../polled";
import { Reopened } from "../reopened";
import { sortHeader } from "../table-parts";

const END = { align: "end", cellClassName: "type-meta" } as const;

const moment = (
  column: (typeof PERSON_EMAIL_COLUMNS)["lastOpen"],
  title: string,
  of: (e: PersonEmail) => number | null,
  none = "—"
): ColumnDef<PersonEmail> => ({
  ...column,
  cell: ({ row }) => <When ms={of(row.original)} none={none} />,
  header: sortHeader<PersonEmail>(title),
  meta: END,
});

const COLUMNS: ColumnDef<PersonEmail>[] = [
  {
    ...PERSON_EMAIL_COLUMNS.subject,
    cell: ({ row }) => {
      const subject = subjectOf(row.original.subject);
      return (
        <Hint label={subject}>
          <a
            className={`${linkClass} block max-w-[36ch] truncate`}
            href={`/app/messages/${row.original.token}`}
          >
            {subject}
          </a>
        </Hint>
      );
    },
    header: sortHeader<PersonEmail>("Subject"),
    meta: { pin: "0", pinEdge: true },
  },
  {
    ...PERSON_EMAIL_COLUMNS.status,
    cell: ({ row }) => <StatusBadges states={openStatesOf(row.original)} />,
    header: "Status",
  },
  moment(
    PERSON_EMAIL_COLUMNS.lastActivity,
    "Last activity",
    personEmailActivityOf
  ),
  moment(PERSON_EMAIL_COLUMNS.sent, "Sent", (e) => e.sentAt, "Not sent"),
  moment(PERSON_EMAIL_COLUMNS.firstOpen, "First open", (e) => e.firstOpen),
  moment(PERSON_EMAIL_COLUMNS.lastOpen, "Last open", (e) => e.lastOpen),
  moment(PERSON_EMAIL_COLUMNS.lastClick, "Last click", (e) => e.lastClick),
  moment(PERSON_EMAIL_COLUMNS.lastReopen, "Re-opened", (e) => e.lastReopen),
  {
    ...PERSON_EMAIL_COLUMNS.opens,
    header: sortHeader<PersonEmail>("Opens"),
    meta: END,
  },
  {
    ...PERSON_EMAIL_COLUMNS.clicks,
    header: sortHeader<PersonEmail>("Clicks"),
    meta: END,
  },
];

const Person = ({ data }: { data: PersonData }) => {
  const { person, emails } = data;
  return (
    <>
      <FigureRow
        figures={[
          { label: "Emails sent", value: person.emails },
          { label: "Emails opened", value: person.opened },
          {
            label: "Median to first open",
            value: <MedianFirstOpen ms={person.medianFirstOpen} />,
          },
          {
            label: "Last open",
            value: <When ms={person.lastOpen} none="—" />,
          },
          {
            label: "Last click",
            value: <When ms={person.lastClick} none="—" />,
          },
        ]}
      />
      {person.lastReopen !== null && (
        <p className="type-meta text-muted-foreground">
          <Reopened ms={person.lastReopen} />
        </p>
      )}
      <ListTable
        caption="Emails"
        columns={COLUMNS}
        data={emails}
        noMatch="No emails match"
        noun={["email", "emails"]}
        rowId={(e) => e.token}
        search={{
          label: "Search this person's emails by subject",
          placeholder: "Search subject",
        }}
        sorting={PERSON_EMAIL_SORTING}
      />
    </>
  );
};

export const PersonPage = ({ address }: { address: string }) => (
  <article className="flex flex-col gap-6">
    <p>
      <a className={linkClass} href="/app/people">
        ← All people
      </a>
    </p>
    <h1 className="type-section break-all">{address}</h1>
    <Polled
      loading="Loading the person"
      missing="Person not found"
      schema={personDataSchema}
      url={`/app/people/${encodeURIComponent(address)}/data`}
    >
      {(data) => <Person data={data} />}
    </Polled>
  </article>
);
