/**
 * The people view: one row per recipient address across every listed email, from the
 * per-token-set figures (store.recipientActivity) and the re-open signal (src/reopen.ts).
 * Counting follows the email list: counted opens and clicks, repeats left out. Kept free
 * of Worker-only imports so the dashboard app can bundle it.
 */
import type { Person, PersonEmail } from "./dashboard-data";
import { NO_REOPENS } from "./reopen";
import type { Reopens } from "./reopen";
import type { RecipientActivityRow } from "./schema";

/** The middle value, or the mean of the two middle ones; null for none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
};

const latest = (moments: readonly (number | null)[]): number | null => {
  const known = moments.filter((ms) => ms !== null);
  return known.length === 0 ? null : Math.max(...known);
};

/** One email as one person saw it. */
export const personEmail = (
  row: RecipientActivityRow,
  reopens: Reopens
): PersonEmail => ({
  clicks: row.clicks,
  firstOpen: row.first_open,
  lastClick: row.last_click,
  lastOpen: row.last_open,
  lastReopen: reopens.lastReopen,
  opens: row.opens,
  reopens: reopens.reopens,
  sentAt: row.sent_at,
  subject: row.subject,
  token: row.message_token,
});

/** Delay from sending to the first probable-human open; null when either is missing. */
const firstOpenDelay = (row: RecipientActivityRow): number | null =>
  row.sent_at === null || row.first_human_open === null
    ? null
    : Math.max(0, row.first_human_open - row.sent_at);

/** One person's figures from their token sets (all with the same address). */
export const personOf = (
  address: string,
  rows: readonly RecipientActivityRow[],
  reopensOf: (recipientToken: string) => Reopens
): Person => {
  const emails = rows.map((row) =>
    personEmail(row, reopensOf(row.recipient_token))
  );
  const lastSent = latest(emails.map((e) => e.sentAt));
  const lastOpen = latest(emails.map((e) => e.lastOpen));
  const lastClick = latest(emails.map((e) => e.lastClick));
  return {
    address,
    emails: emails.length,
    lastActivity: latest([lastSent, lastOpen, lastClick]),
    lastClick,
    lastOpen,
    lastReopen: latest(emails.map((e) => e.lastReopen)),
    lastSent,
    medianFirstOpen: median(
      rows.map((row) => firstOpenDelay(row)).filter((ms) => ms !== null)
    ),
    opened: emails.filter((e) => e.opens > 0 || e.clicks > 0).length,
    reopens: emails.reduce((sum, e) => sum + e.reopens, 0),
  };
};

/** Everyone, newest activity first; people with no activity at all last, by address. */
export const peopleOf = (
  rows: readonly RecipientActivityRow[],
  reopens: ReadonlyMap<string, Reopens>
): Person[] => {
  const byAddress = new Map<string, RecipientActivityRow[]>();
  for (const row of rows) {
    byAddress.set(row.address, [...(byAddress.get(row.address) ?? []), row]);
  }
  const reopensOf = (token: string): Reopens =>
    reopens.get(token) ?? NO_REOPENS;
  return [...byAddress]
    .map(([address, own]) => personOf(address, own, reopensOf))
    .toSorted(
      (a, b) =>
        (b.lastActivity ?? -1) - (a.lastActivity ?? -1) ||
        a.address.localeCompare(b.address)
    );
};
