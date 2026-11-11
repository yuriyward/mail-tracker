import { Hint } from "../hint";
import { dateTooltip, shortDate } from "./dates";

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

/**
 * A moment as a short date in the reader's time zone (see shortDate), the full date and
 * time and how long ago on hover (see dateTooltip); a muted word when there is none. Each
 * refresh re-renders it, so "today" and "3 minutes ago" follow the clock.
 */
export const When = ({ ms, none }: { ms: number | null; none: string }) => {
  if (ms === null) {
    return <span className="text-muted-foreground">{none}</span>;
  }
  const now = Date.now();
  return (
    <Hint label={dateTooltip(ms, now)}>
      <time
        className="whitespace-nowrap tabular-nums"
        dateTime={new Date(ms).toISOString()}
      >
        {shortDate(ms, now)}
      </time>
    </Hint>
  );
};

export const clockOf = (ms: number): string => clock.format(ms);

export const subjectOf = (subject: string): string =>
  subject === "" ? "(no subject)" : subject;
