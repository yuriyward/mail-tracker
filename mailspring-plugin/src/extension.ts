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
import { applyTokenSet, untrack } from "./rewrite";
import { skipReason, trackerOrigin } from "./settings";
import type { Settings } from "./settings";
import { parseSnapshot, recipientAddresses, snapshot } from "./snapshot";
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

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * Why the cached tokens no longer fit the draft as sent, or null when they do. Tokens are
 * only used when the registration covers exactly the draft's current recipients and was
 * made for the same delivery mode (one shared body under Graph, or one body each);
 * anything else could credit one recipient's tokens to someone else.
 */
export const mismatch = (
  draft: Message,
  entry: Registration,
  sendsViaGraph: boolean
): string | null => {
  const registered = parseSnapshot(entry.fingerprint);
  if (
    !registered ||
    !sameSet(registered.recipients, recipientAddresses(draft))
  ) {
    return "recipients changed after registration; sent untracked";
  }
  if (registered.shared !== entry.shared || entry.shared !== sendsViaGraph) {
    return "delivery mode (shared Graph body or one body each) changed after registration; sent untracked";
  }
  return null;
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
  if (parseSnapshot(entry.fingerprint)?.subject !== sent.subject) {
    notes.push(
      "subject changed after registration; the Worker keeps the registered one"
    );
  }
  return notes;
};

type Choice = { set: TokenSet } | { untracked: string };

/**
 * The token set for the body Mailspring is building, once `mismatch` has confirmed the
 * registration fits the draft. A shared registration (Graph) has one set for the one body;
 * a per-recipient call gets that recipient's set. A null recipient on a per-recipient
 * registration means Mailspring builds one body for all after all, so that body goes out
 * untracked rather than credit one person.
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
    : { untracked: "a recipient without registered tokens goes untracked" };
};

/** Removes the carried tracking from the body Mailspring is about to file as the Sent copy. */
const cleanSentCopy = (
  draft: Message,
  origin: string,
  carried: Readonly<Record<string, string>>
): void => {
  // An inert document, as Mailspring uses for sending, so images in the body are not fetched.
  const root = document.implementation
    .createHTMLDocument("")
    .createElement("root");
  root.innerHTML = draft.body ?? "";
  untrack(root, origin, carried);
  draft.body = root.innerHTML;
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
     *
     * An agent's composed draft (ADR-0004) already carries its image and redirects, so the
     * untransformed body is not clean. Mailspring calls this on its own clone of the draft
     * (SendDraftTask.forSending) and reads `self` from that clone's body straight after, so
     * the carried tracking is taken out here: the Sent copy gets no image and the original
     * URLs, and the hook below puts each recipient's own tokens back from the clean body.
     */
    static needsPerRecipientBodies(draft: Message): boolean {
      try {
        const tracked = active(draft, deps);
        const separate =
          tracked !== null &&
          mismatch(draft, tracked.entry, deps.sendsViaGraph(draft)) === null;
        if (separate && tracked.entry.carried !== null) {
          try {
            cleanSentCopy(draft, tracked.origin, tracked.entry.carried);
          } catch (error) {
            // The recipients' bodies are still built; only the Sent copy keeps the tracking.
            deps.log(`cleaning the Sent copy failed: ${String(error)}`);
          }
        }
        return separate;
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
        const stale = mismatch(draft, tracked.entry, deps.sendsViaGraph(draft));
        if (stale !== null) {
          once(draft, stale);
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
        // An agent's composed draft: its own image goes, and its redirects become this
        // recipient's (ADR-0004).
        applyTokenSet(
          draftBodyRootNode,
          choice.set,
          tracked.origin,
          tracked.entry.carried ?? {}
        );
      } catch (error) {
        // Never block sending; the body is left as far as it got, which is at worst untracked.
        deps.log(`tracking skipped: ${String(error)}`);
      }
    }
  };
};
