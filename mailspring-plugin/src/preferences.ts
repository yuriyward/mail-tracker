import { React } from "mailspring-exports";
import type { InputEvent, ReactElement } from "mailspring-exports";

import { CONFIG_KEY, readSettings, toStored } from "./settings";
import type { Settings } from "./settings";

const h = React.createElement;

const field = (label: string, input: ReactElement): ReactElement =>
  h(
    "label",
    { style: { display: "block", margin: "12px 0" } },
    label,
    h("br", null),
    input
  );

/** Preferences tab: enable switch, Worker URL and API token, stored in Mailspring's config. */
export const MailTrackerPreferences = (): ReactElement => {
  const [settings, setSettings] = React.useState<Settings>(
    readSettings(AppEnv.config.get(CONFIG_KEY))
  );
  const update = (patch: Partial<Settings>): void => {
    const next = { ...settings, ...patch };
    AppEnv.config.set(CONFIG_KEY, toStored(next));
    setSettings(next);
  };
  return h(
    "div",
    {
      className: "container-mail-tracker",
      style: { maxWidth: 520, padding: 20 },
    },
    h("h2", null, "Mail Tracker"),
    h(
      "label",
      null,
      h("input", {
        checked: settings.enabled,
        onChange: (event: InputEvent) => {
          update({ enabled: event.target.checked });
        },
        type: "checkbox",
      }),
      " Track opens and clicks when sending"
    ),
    field(
      "Worker URL",
      h("input", {
        onChange: (event: InputEvent) => {
          update({ apiUrl: event.target.value });
        },
        placeholder: "https://track.example.com",
        style: { width: "100%" },
        type: "url",
        value: settings.apiUrl,
      })
    ),
    field(
      "API token",
      h("input", {
        onChange: (event: InputEvent) => {
          update({ apiToken: event.target.value });
        },
        style: { width: "100%" },
        type: "password",
        value: settings.apiToken,
      })
    )
  );
};
