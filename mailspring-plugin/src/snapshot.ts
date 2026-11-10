import type { Contact, Message } from "mailspring-exports";
import { z } from "zod";

import { trackableUrls } from "./rewrite";

/** What a registration covers: compared at send time to spot late edits. */
export interface Snapshot {
  draftId: string;
  subject: string;
  recipient: string;
  links: string[];
}

export const recipients = (draft: Message): string =>
  [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])]
    .map((contact: Contact) => contact.email)
    .join(", ");

export const snapshot = (
  draft: Message,
  root: ParentNode,
  origin: string
): Snapshot => ({
  draftId: draft.headerMessageId,
  links: trackableUrls(root, origin),
  recipient: recipients(draft),
  subject: draft.subject ?? "",
});

export const fingerprint = (value: Snapshot): string => JSON.stringify(value);

const snapshotSchema = z.object({
  draftId: z.string(),
  links: z.array(z.string()),
  recipient: z.string(),
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
