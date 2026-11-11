import { fullDate, shortDate } from "./dates";

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

/**
 * A moment as a short date in the reader's time zone (see shortDate), the full date and
 * time on hover; a muted word when there is none. Each refresh re-renders it, so "today"
 * follows the clock.
 */
export const When = ({ ms, none }: { ms: number | null; none: string }) => {
  if (ms === null) {
    return <span className="text-muted-foreground">{none}</span>;
  }
  return (
    <time
      className="whitespace-nowrap tabular-nums"
      dateTime={new Date(ms).toISOString()}
      title={fullDate(ms)}
    >
      {shortDate(ms, Date.now())}
    </time>
  );
};

export const clockOf = (ms: number): string => clock.format(ms);

export const subjectOf = (subject: string): string =>
  subject === "" ? "(no subject)" : subject;
