import type { Contact, Message } from "mailspring-exports";
import { z } from "zod";

import type { LinkTexts } from "../../src/link-names";
import { tokenSetAddresses } from "../../src/recipients";
import { carriedPixelToken, linkTexts, trackableUrls } from "./rewrite";

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
  /** Each link's own text in the email, by URL; links without text are left out. */
  linkText: LinkTexts;
  /**
   * Our image token already in the draft (an agent's composed draft, ADR-0004): the
   * Worker registers under the message that owns it. Null for drafts written here.
   */
  pixelToken: string | null;
}

/** To, Cc and Bcc, as Mailspring's participants({ includeFrom: false, includeBcc: true }). */
const participants = (draft: Message): Contact[] => [
  ...(draft.to ?? []),
  ...(draft.cc ?? []),
  ...(draft.bcc ?? []),
];

/** The draft's recipients as token-set keys: normalised, distinct, in draft order. */
export const recipientAddresses = (draft: Message): string[] =>
  tokenSetAddresses(
    participants(draft).map((contact) => contact.email),
    false
  );

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
  linkText: linkTexts(root, origin),
  links: trackableUrls(root, origin),
  pixelToken: carriedPixelToken(root, origin),
  recipient: recipients(draft),
  recipients: recipientAddresses(draft),
  shared,
  subject: draft.subject ?? "",
});

export const fingerprint = (value: Snapshot): string => JSON.stringify(value);

const snapshotSchema = z.object({
  draftId: z.string(),
  // Registrations saved before link text was sent have none.
  linkText: z.record(z.string(), z.string()).default({}),
  links: z.array(z.string()),
  // Registrations saved before pre-tracked drafts (ADR-0004) have none.
  pixelToken: z.string().nullable().default(null),
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
