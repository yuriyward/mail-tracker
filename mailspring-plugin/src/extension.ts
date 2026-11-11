import type {
  ComposerExtension,
  Contact,
  Message,
  SendTransformArgs,
} from "mailspring-exports";

import { normaliseAddress } from "../../src/recipients";
import { autolink } from "./autolink";
import { lookup } from "./registry";
import type { ConfigStore, Registration, TokenSet } from "./registry";
import { applyTokenSet } from "./rewrite";
import { skipReason, trackerOrigin } from "./settings";
import type { Settings } from "./settings";
import { parseSnapshot, snapshot } from "./snapshot";
import type { Snapshot } from "./snapshot";

export interface ExtensionDeps {
  settings: () => Settings;
  /** The draft's account sends one body to all recipients (Microsoft Graph). */
  sendsViaGraph: (draft: Message) => boolean;
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

const differences = (
  sent: Snapshot,
  entry: Registration,
  set: TokenSet
): string[] => {
  const registered = new Set(Object.keys(set.links));
  const late = sent.links.filter((url) => !registered.has(url));
  const notes =
    late.length > 0
      ? [`${late.length} link(s) added after registration stay untracked`]
      : [];
  const before = parseSnapshot(entry.fingerprint);
  if (
    before?.subject !== sent.subject ||
    before.recipient !== sent.recipient ||
    before.shared !== sent.shared
  ) {
    notes.push(
      "subject or recipients changed after registration; the Worker keeps the registered ones"
    );
  }
  return notes;
};

type Choice = { set: TokenSet } | { untracked: string };

/**
 * The token set for the body Mailspring is building. A per-recipient call gets that
 * recipient's set; a shared registration (Graph) has one set, used for whatever body is
 * built. A null recipient on a per-recipient registration means Mailspring builds one
 * body for all after all, so that body goes out untracked rather than credit one person.
 */
const choose = (
  entry: Registration,
  recipient: Contact | null | undefined
): Choice => {
  const sets = Object.values(entry.recipients);
  const [only] = sets;
  if (entry.shared && only && sets.length === 1) {
    return { set: only };
  }
  if (!recipient) {
    return {
      untracked:
        "one body for all recipients, but the draft was registered per recipient; sent untracked",
    };
  }
  const set = entry.recipients[normaliseAddress(recipient.email)];
  return set
    ? { set }
    : { untracked: "a recipient added after registration goes untracked" };
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

  /** Logs a message once per draft and text (the hook runs once per recipient). */
  const once = (draft: Message, message: string): void => {
    const key = `${draft.headerMessageId}\n${message}`;
    if (!warned.has(key)) {
      warned.add(key);
      deps.log(message);
    }
  };

  /** Logs once per draft when the registration is stale. */
  const warnIfStale = (
    draft: Message,
    root: HTMLElement,
    entry: Registration,
    set: TokenSet,
    origin: string
  ): void => {
    const sent = snapshot(draft, root, origin, deps.sendsViaGraph(draft));
    const notes = differences(sent, entry, set);
    if (notes.length > 0) {
      once(draft, `sending with an older registration: ${notes.join("; ")}`);
    }
  };

  return class MailTrackerExtension extends Base {
    /**
     * Asks for one body per recipient whenever this draft will be tracked; Mailspring then
     * files its untransformed `self` body as the Sent copy and runs the hook below once per
     * recipient, each with that recipient's tokens. Graph accounts get one shared body.
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
      recipient,
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
        const choice = choose(tracked.entry, recipient);
        if ("untracked" in choice) {
          once(draft, choice.untracked);
          return;
        }
        // Bare URLs become links first, as when registering, so their clicks are tracked.
        autolink(draftBodyRootNode);
        warnIfStale(
          draft,
          draftBodyRootNode,
          tracked.entry,
          choice.set,
          tracked.origin
        );
        applyTokenSet(draftBodyRootNode, choice.set, tracked.origin);
      } catch (error) {
        // Never block sending; the body is left as far as it got, which is at worst untracked.
        deps.log(`tracking skipped: ${String(error)}`);
      }
    }
  };
};
