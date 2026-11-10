import {
  Actions,
  ComponentRegistry,
  ComposerExtension,
  ExtensionRegistry,
  PreferencesUIStore,
  React,
} from "mailspring-exports";
import type { ComposerFooterProps, FooterComponent } from "mailspring-exports";

import { createExtension } from "./extension";
import { MailTrackerPreferences } from "./preferences";
import { prune } from "./registry";
import type { ConfigStore } from "./registry";
import { CONFIG_KEY, readSettings } from "./settings";
import { createTracker } from "./tracker";
import { httpsTransport } from "./transport";

const TAB_ID = "Mail Tracker";

const log = (message: string): void => {
  console.warn(`mail-tracker: ${message}`);
};

const settings = () => readSettings(AppEnv.config.get(CONFIG_KEY));

const config: ConfigStore = {
  get: (keyPath) => AppEnv.config.get(keyPath),
  set: (keyPath, value) => {
    AppEnv.config.set(keyPath, value);
  },
};

const tracker = createTracker({
  config,
  log,
  now: Date.now,
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
  settings,
  transport: httpsTransport,
});

const MailTrackerExtension = createExtension(ComposerExtension, {
  config,
  log,
  settings,
});

/**
 * Rendered invisibly in every open composer; Mailspring re-renders it with the current
 * draft after each edit. Only drafts open in a composer are registered, by the window
 * that shows the composer.
 */
const RegistrationWatcher: FooterComponent = ({
  draft,
}: ComposerFooterProps) => {
  React.useEffect(() => {
    tracker.draftChanged(draft);
  });
  return null;
};
RegistrationWatcher.displayName = "MailTrackerRegistrationWatcher";

const unlisteners: (() => void)[] = [];

export const activate = (): void => {
  ExtensionRegistry.Composer.register(MailTrackerExtension);
  ComponentRegistry.register(RegistrationWatcher, { role: "Composer:Footer" });
  unlisteners.push(
    Actions.sendDraft.listen((draftId) => {
      // Registration usually finished while composing; this catches a quick send, but
      // Mailspring does not wait for it, so a very late edit can still go out untracked.
      tracker.flush(draftId);
    })
  );
  // The main window owns delivery notices (Mailspring fires draftDeliverySucceeded there)
  // and housekeeping, so these happen once, not once per window.
  if (AppEnv.isMainWindow()) {
    unlisteners.push(
      Actions.draftDeliverySucceeded.listen(({ headerMessageId }) => {
        tracker.delivered(headerMessageId);
      })
    );
    tracker.resume();
    prune(config, Date.now());
  }
  PreferencesUIStore.registerPreferencesTab(
    new PreferencesUIStore.TabItem({
      componentClassFn: () => MailTrackerPreferences,
      displayName: TAB_ID,
      order: 99,
      tabId: TAB_ID,
    })
  );
};

export const deactivate = (): void => {
  ExtensionRegistry.Composer.unregister(MailTrackerExtension);
  ComponentRegistry.unregister(RegistrationWatcher);
  for (const unlisten of unlisteners.splice(0)) {
    unlisten();
  }
  PreferencesUIStore.unregisterPreferencesTab(TAB_ID);
};
