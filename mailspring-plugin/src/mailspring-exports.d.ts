/* oxlint-disable max-classes-per-file -- declarations of two classes Mailspring exports. */
// The parts of Mailspring's plugin API this plugin uses. Mailspring provides the module at
// runtime; these declarations follow its sources and are rechecked per release (ADR-0002).
declare module "mailspring-exports" {
  import type * as HostReact from "react";
  export type JsonValue = MailspringJsonValue;

  export interface Contact {
    email: string;
  }

  /** A draft as Mailspring hands it to extensions (see app/src/flux/models/message.ts). */
  export class Message {
    id?: string;
    static attributes: { body: { modelKey: string } };
    categories?: () => { role: string }[];
    headerMessageId: string;
    accountId: string;
    draft: boolean;
    plaintext: boolean;
    body?: string;
    subject?: string;
    to?: Contact[];
    cc?: Contact[];
    bcc?: Contact[];
  }

  /**
   * Arguments of applyTransformsForSending (app/src/flux/tasks/send-draft-task.ts): the
   * caller does not await the hook and serialises draftBodyRootNode right after it returns.
   * draftBodyRootNode is absent for plaintext drafts; recipient is null for a shared body.
   */
  export interface SendTransformArgs {
    draft: Message;
    draftBodyRootNode?: HTMLElement;
    recipient?: Contact | null;
  }

  // oxlint-disable-next-line typescript/no-extraneous-class, unicorn/no-static-only-class -- Mailspring's extension base class has only static hooks.
  export class ComposerExtension {
    static applyTransformsForSending(args: SendTransformArgs): void;
  }

  /** An account (app/src/flux/models/account.ts), reduced to what the plugin uses. */
  export interface Account {
    /**
     * True when Mailspring sends through Microsoft Graph: one body for all recipients,
     * transformed once with a null recipient (send-draft-task.ts). Optional, as releases
     * before Graph sending lack it.
     */
    sendsViaGraph?: () => boolean;
  }
  export interface AccountStoreApi {
    accountForId: (id: string) => Account | null | undefined;
  }
  export const AccountStore: AccountStoreApi;

  /** Props Mailspring passes to `Composer:Footer` components (composer-view.tsx). */
  export interface ComposerFooterProps {
    draft: Message;
    headerMessageId: string;
  }
  export type FooterComponent =
    HostReact.FunctionComponent<ComposerFooterProps>;
  export interface ComponentRegistryApi {
    register: <P>(
      component: HostReact.FunctionComponent<P>,
      options: { role: string }
    ) => void;
    unregister: <P>(component: HostReact.FunctionComponent<P>) => void;
  }
  export const DatabaseStore: {
    find: (
      model: typeof Message,
      id: string
    ) => {
      include: (attribute: { modelKey: string }) => Promise<Message | null>;
    };
  };
  export const ComponentRegistry: ComponentRegistryApi;

  export interface ActionApi<T> {
    listen: (callback: (payload: T) => void) => () => void;
  }
  export interface ActionsApi {
    openPopover: (
      element: ReactElement,
      options: { originRect: DOMRect; direction: string }
    ) => void;
    sendDraft: ActionApi<string>;
    draftDeliverySucceeded: ActionApi<{ headerMessageId: string }>;
  }
  export const Actions: ActionsApi;

  export interface ExtensionRegistryApi {
    Composer: {
      register: (extension: typeof ComposerExtension) => void;
      unregister: (extension: typeof ComposerExtension) => void;
    };
  }
  export const ExtensionRegistry: ExtensionRegistryApi;

  export type ReactElement = HostReact.ReactElement;
  export type Component = () => ReactElement;
  export interface InputEvent {
    target: { value: string; checked: boolean };
  }
  export const React: typeof HostReact;

  export interface PreferencesTab {
    tabId: string;
  }
  export interface PreferencesUIStoreApi {
    TabItem: new (options: {
      tabId: string;
      displayName: string;
      componentClassFn: () => Component;
      order: number;
    }) => PreferencesTab;
    registerPreferencesTab: (tab: PreferencesTab) => void;
    unregisterPreferencesTab: (tabId: string) => void;
  }
  export const PreferencesUIStore: PreferencesUIStoreApi;
}

declare const AppEnv: {
  isMainWindow: () => boolean;
  config: {
    get: (key: string) => MailspringJsonValue | undefined;
    /** Writes one key path in the main process; `undefined` restores the default (removes it). */
    set: (key: string, value: MailspringJsonValue | undefined) => void;
  };
};

type MailspringJsonValue =
  | string
  | number
  | boolean
  | null
  | MailspringJsonValue[]
  | { [key: string]: MailspringJsonValue };
