import { describe, expect, test } from "bun:test";

import {
  dateTooltip,
  fullDate,
  relativeTime,
  shortDate,
} from "../src/lib/dates";

/** Wednesday 11 November 2026, 14:30 in Berlin (UTC+1). */
const NOW = Date.parse("2026-11-11T14:30:00+01:00");
const BERLIN = { locale: "en-US", timeZone: "Europe/Berlin" };
const at = (iso: string) => shortDate(Date.parse(iso), NOW, BERLIN);

describe("shortDate", () => {
  test("today shows only the time", () => {
    expect(at("2026-11-11T12:54:00+01:00")).toBe("12:54 PM");
    expect(at("2026-11-11T00:00:00+01:00")).toBe("12:00 AM");
    expect(
      shortDate(Date.parse("2026-11-11T12:54:00+01:00"), NOW, {
        locale: "en-GB",
        timeZone: "Europe/Berlin",
      })
    ).toBe("12:54");
  });

  test("the six days before today show only the weekday", () => {
    expect(at("2026-11-10T23:59:00+01:00")).toBe("Tue");
    expect(at("2026-11-09T08:00:00+01:00")).toBe("Mon");
    expect(at("2026-11-05T00:00:00+01:00")).toBe("Thu");
  });

  test("a week ago and older this year shows the month and day", () => {
    expect(at("2026-11-04T23:59:00+01:00")).toBe("Nov 4");
    expect(at("2026-01-01T00:00:00+01:00")).toBe("Jan 1");
  });

  test("before this year adds the year", () => {
    expect(at("2025-11-04T10:00:00+01:00")).toBe("Nov 4, 2025");
    expect(at("2025-12-31T23:59:00+01:00")).toBe("Dec 31, 2025");
  });

  test("a time after now (clock skew) shows the date, never a weekday", () => {
    expect(at("2026-11-13T10:00:00+01:00")).toBe("Nov 13");
  });

  test("days are calendar days in the reader's time zone", () => {
    // 23:30 UTC on 10 Nov is 10 Nov in New York but 11 Nov (today) in Tokyo.
    const ms = Date.parse("2026-11-10T23:30:00Z");
    const now = Date.parse("2026-11-11T05:00:00Z");
    expect(
      shortDate(ms, now, { locale: "en-GB", timeZone: "Asia/Tokyo" })
    ).toBe("08:30");
    // In New York `now` is still 11 Nov 00:00 local, so 10 Nov 18:30 is yesterday.
    expect(
      shortDate(ms, now, { locale: "en-GB", timeZone: "America/New_York" })
    ).toBe("Tue");
    // New Year's Eve in UTC is already next year in Tokyo.
    const eve = Date.parse("2025-12-31T20:00:00Z");
    const later = Date.parse("2026-06-01T00:00:00Z");
    expect(shortDate(eve, later, { locale: "en-US", timeZone: "UTC" })).toBe(
      "Dec 31, 2025"
    );
    expect(
      shortDate(eve, later, { locale: "en-US", timeZone: "Asia/Tokyo" })
    ).toBe("Jan 1");
  });

  test("a daylight-saving change does not move the day boundaries", () => {
    // Berlin left summer time on 25 Oct 2026. From 24 Oct 23:59 to 31 Oct 00:30 is less
    // than seven elapsed days (an hour was repeated), but seven calendar days.
    const now = Date.parse("2026-10-31T00:30:00+01:00");
    expect(
      shortDate(Date.parse("2026-10-25T01:00:00+02:00"), now, BERLIN)
    ).toBe("Sun");
    expect(
      shortDate(Date.parse("2026-10-24T23:59:00+02:00"), now, BERLIN)
    ).toBe("Oct 24");
  });
});

describe("fullDate", () => {
  test("the date and time in the reader's locale and zone", () => {
    expect(fullDate(Date.parse("2026-11-04T12:54:00+01:00"), BERLIN)).toBe(
      "Nov 4, 2026, 12:54 PM"
    );
    expect(
      fullDate(Date.parse("2026-11-04T12:54:00+01:00"), {
        locale: "en-GB",
        timeZone: "Asia/Tokyo",
      })
    ).toBe("4 Nov 2026, 20:54");
  });
});

describe("relativeTime", () => {
  const ago = (iso: string) => relativeTime(Date.parse(iso), NOW, BERLIN);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const back = (ms: number) => relativeTime(NOW - ms, NOW, BERLIN);

  test("under a minute either way is just now", () => {
    expect(back(0)).toBe("just now");
    expect(back(59_999)).toBe("just now");
    expect(back(-59_999)).toBe("just now");
  });

  test("minutes up to 59, hours up to 23", () => {
    expect(back(MIN)).toBe("1 minute ago");
    expect(back(59 * MIN + 59_999)).toBe("59 minutes ago");
    expect(back(HOUR)).toBe("1 hour ago");
    expect(back(23 * HOUR + 59 * MIN)).toBe("23 hours ago");
    // 23 h ago is the previous calendar day, still counted in hours.
    expect(ago("2026-11-10T15:30:00+01:00")).toBe("23 hours ago");
  });

  test("from a day on, calendar days in the zone: yesterday up to 6 days", () => {
    expect(ago("2026-11-10T14:30:00+01:00")).toBe("yesterday");
    expect(ago("2026-11-10T00:00:00+01:00")).toBe("yesterday");
    expect(ago("2026-11-09T23:59:00+01:00")).toBe("2 days ago");
    expect(ago("2026-11-05T00:00:00+01:00")).toBe("6 days ago");
  });

  test("weeks from 7 days, months from 30", () => {
    expect(ago("2026-11-04T23:59:00+01:00")).toBe("1 week ago");
    expect(ago("2026-10-29T12:00:00+01:00")).toBe("1 week ago");
    expect(ago("2026-10-28T12:00:00+01:00")).toBe("2 weeks ago");
    expect(ago("2026-10-13T12:00:00+02:00")).toBe("4 weeks ago");
    expect(ago("2026-10-12T12:00:00+02:00")).toBe("1 month ago");
    expect(ago("2026-05-11T12:00:00+02:00")).toBe("6 months ago");
    expect(ago("2025-11-11T12:00:00+01:00")).toBe("12 months ago");
  });

  test("future times read in …", () => {
    expect(back(-MIN)).toBe("in 1 minute");
    expect(back(-3 * HOUR)).toBe("in 3 hours");
    expect(ago("2026-11-12T14:30:00+01:00")).toBe("tomorrow");
    expect(ago("2026-11-14T10:00:00+01:00")).toBe("in 3 days");
    expect(ago("2026-11-25T10:00:00+01:00")).toBe("in 2 weeks");
    expect(ago("2027-01-11T10:00:00+01:00")).toBe("in 2 months");
  });

  test("the relative part follows the reader's locale", () => {
    const de = { locale: "de-DE", timeZone: "Europe/Berlin" };
    expect(relativeTime(NOW - 3 * HOUR, NOW, de)).toBe("vor 3 Stunden");
    expect(relativeTime(NOW - 24 * HOUR, NOW, de)).toBe("gestern");
  });
});

test("dateTooltip joins the full date and how long ago", () => {
  expect(
    dateTooltip(Date.parse("2026-11-11T11:30:00+01:00"), NOW, BERLIN)
  ).toBe("Nov 11, 2026, 11:30 AM · 3 hours ago");
});

test("a locale with its own digits still finds the day", () => {
  const zone = { locale: "ar-EG", timeZone: "Africa/Cairo" };
  const now = Date.parse("2026-11-11T12:00:00+02:00");
  expect(shortDate(Date.parse("2026-11-11T09:00:00+02:00"), now, zone)).toBe(
    new Intl.DateTimeFormat("ar-EG", {
      timeStyle: "short",
      timeZone: "Africa/Cairo",
    }).format(Date.parse("2026-11-11T09:00:00+02:00"))
  );
});
