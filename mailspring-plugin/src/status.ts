import type * as ReactTypes from "react";

import type { ReadDetail, ReadMessage } from "./read-client";
import { READ_REFRESH_MS } from "./read-client";

const EMPTY_MESSAGES: ReadMessage[] = [];

const counted = (event: ReadDetail["events"][number]): boolean =>
  event.counted === 1 && event.duplicate === 0;

export const statusText = (detail: ReadDetail): string => {
  const events = detail.events.filter(counted);
  const opens = events.filter((event) => event.kind === "open");
  const human = opens.filter((event) => event.class === "human").length;
  const proxy = opens.filter((event) => event.class === "proxy").length;
  const clicks = events.filter((event) => event.kind === "click").length;
  return `${opens.length > 0 ? "Opened" : "No opens"} · ${human} human opens · ${proxy} proxy opens · ${clicks} clicks`;
};

/** Uses the host's React, never bundles a second copy into Mailspring. */
export const createStatusComponents = (options: {
  React: typeof ReactTypes;
  read: (message: ReadMessage) => Promise<ReadDetail | null>;
  openPanel: (element: ReactTypes.ReactElement, rect: DOMRect) => void;
}) => {
  const { React } = options;
  const h = React.createElement;
  const Panel = ({ detail }: { detail: ReadDetail }) =>
    h(
      "div",
      {
        style: {
          boxSizing: "border-box",
          flexShrink: 0,
          maxHeight: 360,
          minWidth: 360,
          overflowWrap: "anywhere",
          overflowX: "hidden",
          overflowY: "auto",
          padding: 12,
          whiteSpace: "normal",
          width: 360,
        },
        tabIndex: -1,
      },
      h("strong", null, statusText(detail)),
      detail.recipients.some((recipient) => recipient.address === "") &&
        h("p", null, "Shared copy, recipient unknown"),
      ...detail.recipients.map((recipient) =>
        h(
          "p",
          { key: recipient.token },
          `${recipient.address || "Shared copy, recipient unknown"}${recipient.current ? "" : " (removed recipient)"}: ${recipient.opens} opens, ${recipient.clicks} clicks`
        )
      ),
      ...detail.events.map((event, index) => {
        const recipient = detail.recipients.find(
          (entry) => entry.token === event.recipient_token
        );
        const link = detail.links.find(
          (entry) => entry.token === event.link_token
        );
        return h(
          "div",
          {
            key: index,
            style: { borderTop: "1px solid #aaa", padding: "6px 0" },
          },
          h(
            "div",
            null,
            `${recipient === undefined || recipient.address === "" ? "Recipient unknown" : recipient.address} · ${new Date(event.at).toLocaleString()} · ${event.kind}`
          ),
          h(
            "div",
            null,
            [
              event.label,
              event.via,
              event.country,
              event.user_agent || "Device unknown",
            ]
              .filter(Boolean)
              .join(" · ")
          ),
          event.hint !== null && h("div", null, event.hint),
          event.preloadHint !== null && h("div", null, event.preloadHint),
          link && h("div", null, `${link.name}: ${link.url}`)
        );
      })
    );

  const Status = ({
    messages,
    compact = false,
  }: {
    messages: ReadMessage[];
    compact?: boolean;
  }) => {
    const [detail, setDetail] = React.useState<ReadDetail | null>(null);
    React.useEffect(() => {
      let active = true;
      const refresh = async () => {
        // Most recent tracked outgoing message wins, even after an untracked reply.
        let next: ReadDetail | null = null;
        // oxlint-disable-next-line unicorn/no-array-reverse -- copy first; older Electron versions lack toReversed.
        for (const message of [...messages].reverse()) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- stop after the newest tracked message; avoid fetching the whole thread.
          next = await options.read(message);
          if (next) {
            break;
          }
        }
        if (active) {
          setDetail(next);
        }
      };
      setDetail(null);
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, READ_REFRESH_MS);
      const focus = () => {
        void refresh();
      };
      window.addEventListener("focus", focus);
      return () => {
        active = false;
        clearInterval(timer);
        window.removeEventListener("focus", focus);
      };
    }, [messages]);
    if (!detail) {
      return null;
    }
    const text = statusText(detail);
    const show = (event: ReactTypes.SyntheticEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      options.openPanel(
        h(Panel, { detail }),
        event.currentTarget.getBoundingClientRect()
      );
    };
    return h(
      "button",
      {
        "aria-label": text,
        className: `mail-tracker-status ${detail.events.some((event) => counted(event) && event.kind === "open") ? "opened" : "unopened"}`,
        onClick: (event: ReactTypes.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          // Native button keyboard activation has no preceding mousedown.
          if (event.detail === 0) {
            show(event);
          }
        },
        onMouseDown: (event: ReactTypes.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          if (event.button === 0) {
            show(event);
          }
        },
        style: {
          background: "transparent",
          border: 0,
          color: "inherit",
          cursor: "pointer",
          padding: "2px 4px",
        },
        title: text,
        type: "button",
      },
      h(
        "svg",
        {
          "aria-hidden": true,
          fill: "none",
          height: 12,
          stroke: "currentColor",
          strokeWidth: 2,
          style: {
            opacity: detail.events.some(
              (event) => counted(event) && event.kind === "open"
            )
              ? 1
              : 0.35,
            verticalAlign: "middle",
          },
          viewBox: "0 0 24 16",
          width: 18,
        },
        h("path", { d: "M1 8C4 3 8 1 12 1s8 2 11 7c-3 5-7 7-11 7S4 13 1 8Z" }),
        h("circle", { cx: 12, cy: 8, r: 3 })
      ),
      compact
        ? ` ${detail.events.filter((event) => counted(event) && event.kind === "open").length} ↗ ${detail.events.filter((event) => counted(event) && event.kind === "click").length}`
        : text
    );
  };
  const MessageStatus = ({ message }: { message: ReadMessage }) => {
    const messages = React.useMemo(() => [message], [message]);
    return h(Status, { messages });
  };
  MessageStatus.displayName = "MailTrackerMessageStatus";
  const ThreadIcon = ({ thread }: { thread: { __messages?: ReadMessage[] } }) =>
    h(Status, { compact: true, messages: thread.__messages ?? EMPTY_MESSAGES });
  ThreadIcon.displayName = "MailTrackerThreadIcon";
  return { MessageStatus, Panel, Status, ThreadIcon };
};
