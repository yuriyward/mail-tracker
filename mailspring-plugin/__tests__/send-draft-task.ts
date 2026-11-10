// A stand-in for Mailspring's real caller of composer extensions, following
// app/src/flux/tasks/send-draft-task.ts (Mailspring master a8c31c1, 2026-11-10):
// `applyExtensionTransforms` and the body handling of `SendDraftTask.forSending`.
// Like the original it calls the hooks synchronously, never awaits them, and serialises
// draftBodyRootNode immediately, so anything a hook does after an `await` is lost.
import type { Contact, Message, SendTransformArgs } from "mailspring-exports";

export interface StandInExtension {
  applyTransformsForSending?: (args: SendTransformArgs) => void;
  needsPerRecipientBodies?: (draft: Message) => boolean;
}

export interface SentTask {
  /** The body sent when bodies are shared (and the Sent copy when they are not separate). */
  body: string;
  /** Present when an extension asked for separate bodies; `self` is filed as the Sent copy. */
  perRecipientBodies: Record<string, string> | null;
  /** Values the hooks returned; Mailspring ignores them, so a Promise here is a bug. */
  returned: unknown[];
}

const participants = (draft: Message): Contact[] => [
  ...(draft.to ?? []),
  ...(draft.cc ?? []),
  ...(draft.bcc ?? []),
];

const applyExtensionTransforms = (
  extensions: StandInExtension[],
  draft: Message,
  recipient: Contact | null,
  returned: unknown[]
): string => {
  const before = draft.body ?? "";
  const hooks = extensions.filter((ext) =>
    Boolean(ext.applyTransformsForSending)
  );
  if (draft.plaintext) {
    for (const ext of hooks) {
      returned.push(ext.applyTransformsForSending?.({ draft, recipient }));
    }
    const after = draft.body ?? "";
    draft.body = before;
    return after;
  }
  const draftBodyRootNode = document.implementation
    .createHTMLDocument("")
    .createElement("root");
  draftBodyRootNode.innerHTML = before;
  for (const ext of hooks) {
    returned.push(
      ext.applyTransformsForSending?.({ draft, draftBodyRootNode, recipient })
    );
    if (draft.body !== before) {
      throw new Error(
        "applyTransformsForSending should modify draftBodyRootNode, not draft.body."
      );
    }
  }
  return draftBodyRootNode.innerHTML;
};

/** SendDraftTask.forSending's body handling; `sendsViaGraph` mirrors Graph accounts. */
export const forSending = (
  extensions: StandInExtension[],
  draft: Message,
  sendsViaGraph = false
): SentTask => {
  const returned: unknown[] = [];
  const separateBodies = extensions.some(
    (ext) => ext.needsPerRecipientBodies?.(draft) === true
  );
  let perRecipientBodies: Record<string, string> | null = null;
  if (separateBodies) {
    perRecipientBodies = { self: draft.body ?? "" };
  }
  let body = draft.body ?? "";
  if (separateBodies && !sendsViaGraph && perRecipientBodies) {
    for (const recipient of participants(draft)) {
      perRecipientBodies[recipient.email] = applyExtensionTransforms(
        extensions,
        draft,
        recipient,
        returned
      );
    }
  } else {
    body = applyExtensionTransforms(extensions, draft, null, returned);
  }
  return { body, perRecipientBodies, returned };
};
