import type {
  ComposerExtension,
  Message,
  SendTransformArgs,
} from "mailspring-exports";

import { autolink } from "./autolink";
import { lookup } from "./registry";
import type { ConfigStore, Registration } from "./registry";
import { applyRegistration } from "./rewrite";
import { skipReason, trackerOrigin } from "./settings";
import type { Settings } from "./settings";
import { parseSnapshot, snapshot } from "./snapshot";
import type { Snapshot } from "./snapshot";

export interface ExtensionDeps {
  settings: () => Settings;
  config: ConfigStore;
  log: (message: string) => void;
}

const active = (
  draft: Message,
  deps: ExtensionDeps
): { entry: Registration; origin: string } | null => {
  const settings = deps.settings();
  const origin = trackerOrigin(settings);
  if (draft.plaintext || skipReason(settings) !== null || origin === null) {
    return null;
  }
  const entry = lookup(deps.config, draft.headerMessageId);
  return entry ? { entry, origin } : null;
};

const differences = (sent: Snapshot, entry: Registration): string[] => {
  const registered = new Set(Object.keys(entry.links));
  const late = sent.links.filter((url) => !registered.has(url));
  const notes =
    late.length > 0
      ? [`${late.length} link(s) added after registration stay untracked`]
      : [];
  const before = parseSnapshot(entry.fingerprint);
  if (before?.subject !== sent.subject || before.recipient !== sent.recipient) {
    notes.push(
      "subject or recipients changed after registration; the Worker keeps the registered ones"
    );
  }
  return notes;
};

/**
 * The composer extension. Mailspring calls both hooks synchronously while it builds the
 * SendDraftTask (app/src/flux/tasks/send-draft-task.ts) and serialises the body straight
 * after, so nothing here waits for the network: it uses tokens registered while composing.
 */
export const createExtension = (
  Base: typeof ComposerExtension,
  deps: ExtensionDeps
) => {
  const warned = new Set<string>();

  /** Logs once per draft (the hook runs once per recipient) when the registration is stale. */
  const warnIfStale = (
    draft: Message,
    root: HTMLElement,
    entry: Registration,
    origin: string
  ): void => {
    if (warned.has(draft.headerMessageId)) {
      return;
    }
    const notes = differences(snapshot(draft, root, origin), entry);
    if (notes.length > 0) {
      warned.add(draft.headerMessageId);
      deps.log(`sending with an older registration: ${notes.join("; ")}`);
    }
  };

  return class MailTrackerExtension extends Base {
    /**
     * Asks for one body per recipient whenever this draft will be tracked; Mailspring then
     * files its untransformed `self` body as the Sent copy (except for Graph accounts, see
     * README). The hook below then runs once per recipient with the same tokens.
     */
    static needsPerRecipientBodies(draft: Message): boolean {
      try {
        return active(draft, deps) !== null;
      } catch (error) {
        deps.log(`needsPerRecipientBodies failed: ${String(error)}`);
        return false;
      }
    }

    static override applyTransformsForSending({
      draft,
      draftBodyRootNode,
    }: SendTransformArgs): void {
      try {
        // Plaintext drafts have no body node; they are sent untracked.
        if (!draftBodyRootNode) {
          return;
        }
        const tracked = active(draft, deps);
        if (!tracked) {
          return;
        }
        // Bare URLs become links first, as when registering, so their clicks are tracked.
        autolink(draftBodyRootNode);
        warnIfStale(draft, draftBodyRootNode, tracked.entry, tracked.origin);
        applyRegistration(draftBodyRootNode, tracked.entry, tracked.origin);
      } catch (error) {
        // Never block sending; the body is left as far as it got, which is at worst untracked.
        deps.log(`tracking skipped: ${String(error)}`);
      }
    }
  };
};
