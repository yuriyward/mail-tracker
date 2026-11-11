/**
 * Read-side views shared by the dashboard (/app/…/data) and the read API (/api): the email
 * list with addresses and re-opens, and the people view.
 */
import { listMessage, reopensByEmail } from "./dashboard-data";
import type { ListMessage, Person, PersonEmail } from "./dashboard-data";
import type { Db } from "./env";
import { peopleOf, personEmail, personOf } from "./people";
import { preloadHints } from "./preload";
import { normaliseAddress } from "./recipients";
import { NO_REOPENS } from "./reopen";
import type { Reopens } from "./reopen";
import type { MessageSummary } from "./schema";
import type { Listed, MessageDetail } from "./store";
import {
  currentAddresses,
  countedOpens,
  listMessages,
  messageDetail,
  recipientActivity,
} from "./store";
import { isToken } from "./tokens";

export interface ListView {
  summaries: MessageSummary[];
  messages: ListMessage[];
}

/** The listed emails, newest first, each with its current addresses and re-opens. */
export const listView = async (
  db: Db,
  limit: number,
  listed: Listed = "listed"
): Promise<ListView> => {
  const [summaries, addresses, opens] = await Promise.all([
    listMessages(db, limit, listed),
    currentAddresses(db),
    countedOpens(db),
  ]);
  const { byEmail } = reopensByEmail(opens);
  return {
    messages: summaries.map((m) =>
      listMessage(m, {
        addresses: addresses.get(m.token) ?? [],
        reopens: byEmail.get(m.token) ?? NO_REOPENS,
      })
    ),
    summaries,
  };
};

export interface DetailView {
  detail: MessageDetail;
  /** Possible Gmail preloads by event id: they compare this email with the others. */
  preloads: Map<number, string>;
}

/** One email's rows, with the Gmail preload hints worked out over every email. */
export const detailView = async (
  db: Db,
  token: string
): Promise<DetailView | null> => {
  if (!isToken(token)) {
    return null;
  }
  const [detail, opens] = await Promise.all([
    messageDetail(db, token),
    countedOpens(db),
  ]);
  return detail ? { detail, preloads: preloadHints(opens) } : null;
};

/** Re-opens per current token set, over every listed email. */
const reopensBySet = async (db: Db): Promise<Map<string, Reopens>> =>
  reopensByEmail(await countedOpens(db)).bySet;

/** Everyone the listed emails went to, newest activity first. */
export const peopleView = async (db: Db): Promise<Person[]> => {
  const [rows, bySet] = await Promise.all([
    recipientActivity(db),
    reopensBySet(db),
  ]);
  return peopleOf(rows, bySet);
};

export interface PersonView {
  person: Person;
  /** Their emails, newest sent first. */
  emails: PersonEmail[];
}

/** Addresses are stored normalised (src/recipients.ts); one without "@" has no page. */
export const personView = async (
  db: Db,
  address: string
): Promise<PersonView | null> => {
  if (!address.includes("@")) {
    return null;
  }
  const [rows, bySet] = await Promise.all([
    recipientActivity(db, normaliseAddress(address)),
    reopensBySet(db),
  ]);
  const [first] = rows;
  if (!first) {
    return null;
  }
  const reopensOf = (token: string): Reopens => bySet.get(token) ?? NO_REOPENS;
  return {
    emails: rows.map((row) => personEmail(row, reopensOf(row.recipient_token))),
    person: personOf(first.address, rows, reopensOf),
  };
};
