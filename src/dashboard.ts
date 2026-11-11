import { Hono } from "hono";

import { accessAuth } from "./auth";
import type { JwksSource } from "./auth";
import { CLASS_LABELS } from "./classify";
import type { AppEnv, Db } from "./env";
import { html } from "./html";
import type { SafeHtml } from "./html";
import type { EventRow, MessageSummary } from "./schema";
import { listMessages, messageDetail } from "./store";
import type { MessageDetail } from "./store";
import { isToken } from "./tokens";

const LIST_LIMIT = 200;

/** How often an open, visible dashboard tab asks for fresh rows. */
export const REFRESH_MS = 15_000;

/** Scripts and fetches only from this origin; never inline script. */
export const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Served as /app/refresh.js. Polls the `data-refresh` URL of the page's tbody while the
 * tab is visible, swaps in the server-rendered (already escaped) rows and shows when.
 */
const REFRESH_SCRIPT = `"use strict";
(() => {
  const rows = document.querySelector("tbody[data-refresh]");
  const status = document.getElementById("updated");
  if (!rows || !status) return;
  let timer;
  let busy = false;
  let last = status.textContent;
  const schedule = () => {
    clearTimeout(timer);
    timer = document.hidden ? undefined : setTimeout(tick, ${REFRESH_MS});
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(rows.dataset.refresh, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      rows.innerHTML = data.rows;
      last = "updated " + data.updated;
      status.textContent = last;
    } catch {
      status.textContent = last + " · refresh failed, retrying (reload if this persists)";
    } finally {
      busy = false;
      schedule();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      schedule();
    } else {
      void tick();
    }
  });
  schedule();
})();
`;

const STYLE = html`<style>
  body {
    font:
      14px/1.4 system-ui,
      sans-serif;
    margin: 2rem;
    color: #1b1b1b;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid #ddd;
  }
  .class-human {
    color: #0a6b2f;
  }
  .class-proxy {
    color: #6b5a0a;
  }
  .class-scanner,
  .class-self,
  .muted {
    color: #777;
  }
</style>`;

const time = (ms: number | null): SafeHtml | string => {
  if (ms === null) {
    return "—";
  }
  const iso = new Date(ms).toISOString();
  return html`<time datetime="${iso}"
    >${iso.slice(0, 16).replace("T", " ")} UTC</time
  >`;
};

const page = (title: string, body: SafeHtml): string =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · mail-tracker</title>
        ${STYLE}
        <script src="/app/refresh.js" defer></script>
      </head>
      <body>
        ${body}
      </body>
    </html>`.value;

/** hh:mm:ss UTC, the moment the rows on screen were read. */
const clockOf = (ms: number): string =>
  `${new Date(ms).toISOString().slice(11, 19)} UTC`;

const updated = (ms: number): SafeHtml =>
  html`<p id="updated" class="muted" aria-live="polite">
    updated ${clockOf(ms)}
  </p>`;

/** The JSON a refresh fetch returns: tbody markup, escaped like the page. */
const refreshJson = (rows: readonly SafeHtml[], ms: number) => ({
  rows: rows.map((row) => row.value).join(""),
  updated: clockOf(ms),
});

const subjectOf = (subject: string): string =>
  subject === "" ? "(no subject)" : subject;

const messageRow = (m: MessageSummary): SafeHtml =>
  html`<tr>
    <td><a href="/app/messages/${m.token}">${subjectOf(m.subject)}</a></td>
    <td>${m.recipient}</td>
    <td>${time(m.sent_at)}</td>
    <td>${time(m.first_open)}</td>
    <td>${time(m.last_open)}</td>
    <td>${m.opens}</td>
    <td>${m.clicks}</td>
  </tr>`;

const listRows = (messages: MessageSummary[]): SafeHtml[] =>
  messages.map((m) => messageRow(m));

const listPage = (messages: MessageSummary[], ms: number): string =>
  page(
    "Emails",
    html`<h1>Emails</h1>
      ${updated(ms)}
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Recipient</th>
            <th>Sent</th>
            <th>First open</th>
            <th>Last open</th>
            <th>Opens</th>
            <th>Clicks</th>
          </tr>
        </thead>
        <tbody data-refresh="/app/data">
          ${listRows(messages)}
        </tbody>
      </table>
      <p class="muted">
        Opens and clicks count probable humans and on-open image proxies;
        prefetches, scanners and your own hits appear only in each timeline.
      </p>`
  );

const eventRow = (e: EventRow, urls: Map<string, string>): SafeHtml =>
  html`<tr>
    <td>${time(e.at)}</td>
    <td>
      ${e.kind === "open" ? "open" : `click ${urls.get(e.link_token ?? "") ?? ""}`}
    </td>
    <td class="class-${e.class}">${CLASS_LABELS[e.class]}</td>
    <td>${e.reason}</td>
    <td class="muted">${e.user_agent} ${e.as_organization} ${e.country}</td>
  </tr>`;

const eventRows = (detail: MessageDetail): SafeHtml[] => {
  const urls = new Map(detail.links.map((link) => [link.token, link.url]));
  return detail.events.map((e) => eventRow(e, urls));
};

const detailPage = (detail: MessageDetail, ms: number): string => {
  const { message } = detail;
  return page(
    subjectOf(message.subject),
    html`<p><a href="/app">← All emails</a></p>
      <h1>${subjectOf(message.subject)}</h1>
      <p>To ${message.recipient}, sent ${time(message.sent_at)}</p>
      ${updated(ms)}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Class</th>
            <th>Reason</th>
            <th>Client</th>
          </tr>
        </thead>
        <tbody data-refresh="/app/messages/${message.token}/data">
          ${eventRows(detail)}
        </tbody>
      </table>`
  );
};

const findDetail = async (
  db: Db,
  token: string
): Promise<MessageDetail | null> =>
  isToken(token) ? await messageDetail(db, token) : null;

/** The per-email dashboard; Cloudflare Access authenticates, the Worker verifies. */
export const dashboardRoutes = (now: () => number, jwks: JwksSource) => {
  const app = new Hono<AppEnv>();
  app.use("*", accessAuth(jwks));

  app.get("/refresh.js", (c) =>
    c.body(REFRESH_SCRIPT, 200, {
      ...HEADERS,
      "Content-Type": "text/javascript; charset=utf-8",
    })
  );

  app.get("/", async (c) =>
    c.html(
      listPage(await listMessages(c.env.DB, LIST_LIMIT), now()),
      200,
      HEADERS
    )
  );

  app.get("/data", async (c) =>
    c.json(
      refreshJson(listRows(await listMessages(c.env.DB, LIST_LIMIT)), now()),
      200,
      HEADERS
    )
  );

  app.get("/messages/:token", async (c) => {
    const detail = await findDetail(c.env.DB, c.req.param("token"));
    return detail
      ? c.html(detailPage(detail, now()), 200, HEADERS)
      : c.html(page("Not found", html`<h1>Not found</h1>`), 404, HEADERS);
  });

  app.get("/messages/:token/data", async (c) => {
    const detail = await findDetail(c.env.DB, c.req.param("token"));
    return detail
      ? c.json(refreshJson(eventRows(detail), now()), 200, HEADERS)
      : c.json({ error: "not found" }, 404, HEADERS);
  });

  return app;
};
