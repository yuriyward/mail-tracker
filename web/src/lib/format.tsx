const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

/** A moment in the reader's time zone, or a muted word when there is none. */
export const When = ({ ms, none }: { ms: number | null; none: string }) => {
  if (ms === null) {
    return <span className="text-muted-foreground">{none}</span>;
  }
  return (
    <time dateTime={new Date(ms).toISOString()}>{dateTime.format(ms)}</time>
  );
};

export const clockOf = (ms: number): string => clock.format(ms);

export const subjectOf = (subject: string): string =>
  subject === "" ? "(no subject)" : subject;
