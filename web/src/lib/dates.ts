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
  /** "3 hours ago", "in 2 weeks": always a number. */
  relative: Intl.RelativeTimeFormat;
  /** "yesterday", "tomorrow": the day words. */
  relativeDay: Intl.RelativeTimeFormat;
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
    full: make({ dateStyle: "medium", timeStyle: "short" }),
    monthDay: make({ day: "numeric", month: "short" }),
    monthDayYear: make({ day: "numeric", month: "short", year: "numeric" }),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: "always" }),
    relativeDay: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;

/**
 * How long ago `ms` was, or how far ahead: "just now" within a minute, then minutes,
 * hours under a day, and from there calendar days in the zone ("yesterday", "3 days
 * ago"), weeks from 7 days and months from 30. Future times read "in …".
 */
export const relativeTime = (
  ms: number,
  now: number,
  zone: DateZone = {}
): string => {
  const { relative, relativeDay } = formatsFor(zone);
  const elapsed = now - ms;
  const sign = elapsed > 0 ? -1 : 1;
  const span = Math.abs(elapsed);
  if (span < MINUTE_MS) {
    return "just now";
  }
  if (span < HOUR_MS) {
    return relative.format(sign * Math.floor(span / MINUTE_MS), "minute");
  }
  if (span < DAY_MS) {
    return relative.format(sign * Math.floor(span / HOUR_MS), "hour");
  }
  // At least a day has passed, so never "today", even across a short calendar day.
  const days = Math.max(
    1,
    Math.abs(calendarDay(now, zone).day - calendarDay(ms, zone).day)
  );
  if (days < WEEK_DAYS) {
    return relativeDay.format(sign * days, "day");
  }
  if (days < MONTH_DAYS) {
    return relative.format(sign * Math.floor(days / WEEK_DAYS), "week");
  }
  return relative.format(sign * Math.floor(days / MONTH_DAYS), "month");
};

/** "Nov 11, 2026, 12:54 AM": the full date and time, for hovering a short date. */
export const fullDate = (ms: number, zone: DateZone = {}): string =>
  formatsFor(zone).full.format(ms);

/** "Nov 11, 2026, 12:54 AM · 3 hours ago": what hovering a date shows. */
export const dateTooltip = (
  ms: number,
  now: number,
  zone: DateZone = {}
): string => `${fullDate(ms, zone)} · ${relativeTime(ms, now, zone)}`;

/** A span of time, coarse: "under a minute", "12 min", "3 h 5 min", "2 d 4 h". */
export const duration = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) {
    return "under a minute";
  }
  if (ms < HOUR_MS) {
    return `${minutes} min`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  if (ms < DAY_MS) {
    const rest = minutes - hours * 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(ms / DAY_MS);
  const rest = hours - days * 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
};
