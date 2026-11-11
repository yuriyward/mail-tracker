import type { Contact, Message } from "mailspring-exports";
import { z } from "zod";

import { tokenSetAddresses } from "../../src/recipients";
import { trackableUrls } from "./rewrite";

/**
 * What a registration covers, sent as the body of POST /api/messages and compared at send
 * time to spot late edits.
 */
export interface Snapshot {
  draftId: string;
  subject: string;
  /** Every recipient, for display. */
  recipient: string;
  /** The addresses that get a token set (ADR-0003), normalised. */
  recipients: string[];
  /** The account sends one body to all (Microsoft Graph): one shared token set. */
  shared: boolean;
  links: string[];
}

/** To, Cc and Bcc, as Mailspring's participants({ includeFrom: false, includeBcc: true }). */
const participants = (draft: Message): Contact[] => [
  ...(draft.to ?? []),
  ...(draft.cc ?? []),
  ...(draft.bcc ?? []),
];

export const recipients = (draft: Message): string =>
  participants(draft)
    .map((contact) => contact.email)
    .join(", ");

export const snapshot = (
  draft: Message,
  root: ParentNode,
  origin: string,
  shared: boolean
): Snapshot => ({
  draftId: draft.headerMessageId,
  links: trackableUrls(root, origin),
  recipient: recipients(draft),
  recipients: tokenSetAddresses(
    participants(draft).map((contact) => contact.email),
    false
  ),
  shared,
  subject: draft.subject ?? "",
});

export const fingerprint = (value: Snapshot): string => JSON.stringify(value);

const snapshotSchema = z.object({
  draftId: z.string(),
  links: z.array(z.string()),
  recipient: z.string(),
  recipients: z.array(z.string()),
  shared: z.boolean(),
  subject: z.string(),
});

export const parseSnapshot = (text: string): Snapshot | null => {
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
