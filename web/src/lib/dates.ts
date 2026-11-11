/**
 * Dates the way Mailspring lists them: today only the time, the six days before only the
 * weekday, older the date, with the year only when it is not the current one. Days are
 * calendar days in `timeZone` (the reader's own when undefined), so DST never shifts them.
 */

const DAY_MS = 86_400_000;
/** Today plus the six days before it: a weekday name is never ambiguous. */
const WEEKDAY_DAYS = 6;

export interface DateZone {
  /** BCP 47 locale; the reader's own when undefined. */
  locale?: string | undefined;
  /** IANA time zone; the reader's own when undefined. */
  timeZone?: string | undefined;
}

interface Formats {
  day: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
  monthDay: Intl.DateTimeFormat;
  monthDayYear: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
}

const cache = new Map<string, Formats>();

const formatsFor = ({ locale, timeZone }: DateZone): Formats => {
  const key = `${locale ?? ""}|${timeZone ?? ""}`;
  const known = cache.get(key);
  if (known) {
    return known;
  }
  const make = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone });
  const made: Formats = {
    // Parsed, not shown: Latin digits whatever the reader's locale.
    day: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "numeric",
      timeZone,
      year: "numeric",
    }),
    full: make({ dateStyle: "full", timeStyle: "long" }),
    monthDay: make({ day: "numeric", month: "short" }),
    monthDayYear: make({ day: "numeric", month: "short", year: "numeric" }),
    time: make({ timeStyle: "short" }),
    weekday: make({ weekday: "short" }),
  };
  cache.set(key, made);
  return made;
};

/** The calendar day of `ms` in the zone, as whole days since the epoch, and its year. */
const calendarDay = (ms: number, zone: DateZone) => {
  const parts = formatsFor(zone).day.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const year = part("year");
  return {
    day: Date.UTC(year, part("month") - 1, part("day")) / DAY_MS,
    year,
  };
};

/** "12:54" today, "Mon" this week, "Nov 4" this year, "Nov 4, 2025" before. */
export const shortDate = (
  ms: number,
  now: number,
  zone: DateZone = {}
): string => {
  const formats = formatsFor(zone);
  const then = calendarDay(ms, zone);
  const today = calendarDay(now, zone);
  const daysAgo = today.day - then.day;
  if (daysAgo === 0) {
    return formats.time.format(ms);
  }
  if (daysAgo > 0 && daysAgo <= WEEKDAY_DAYS) {
    return formats.weekday.format(ms);
  }
  return then.year === today.year
    ? formats.monthDay.format(ms)
    : formats.monthDayYear.format(ms);
};

/** The full date and time with its zone, for hovering a short date. */
export const fullDate = (ms: number, zone: DateZone = {}): string =>
  formatsFor(zone).full.format(ms);
