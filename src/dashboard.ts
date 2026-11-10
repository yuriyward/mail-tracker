import { Hono } from "hono";

import { accessAuth } from "./auth";
import type { JwksSource } from "./auth";
import { CLASS_LABELS } from "./classify";
import type { AppEnv } from "./env";
import { html } from "./html";
import type { SafeHtml } from "./html";
import type { EventRow, MessageSummary } from "./schema";
import { listMessages, messageDetail } from "./store";
import { isToken } from "./tokens";

const LIST_LIMIT = 200;

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
};

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
      </head>
      <body>
        ${body}
      </body>
    </html>`.value;

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

const listPage = (messages: MessageSummary[]): string =>
  page(
    "Emails",
    html`<h1>Emails</h1>
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
        <tbody>
          ${messages.map((m) => messageRow(m))}
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

/** The per-email dashboard; Cloudflare Access authenticates, the Worker verifies. */
export const dashboardRoutes = (jwks: JwksSource) => {
  const app = new Hono<AppEnv>();
  app.use("*", accessAuth(jwks));

  app.get("/", async (c) =>
    c.html(listPage(await listMessages(c.env.DB, LIST_LIMIT)), 200, HEADERS)
  );

  app.get("/messages/:token", async (c) => {
    const token = c.req.param("token");
    const detail = isToken(token) ? await messageDetail(c.env.DB, token) : null;
    if (!detail) {
      return c.html(page("Not found", html`<h1>Not found</h1>`), 404, HEADERS);
    }
    const urls = new Map(detail.links.map((link) => [link.token, link.url]));
    const { message } = detail;
    return c.html(
      page(
        subjectOf(message.subject),
        html`<p><a href="/app">← All emails</a></p>
          <h1>${subjectOf(message.subject)}</h1>
          <p>To ${message.recipient}, sent ${time(message.sent_at)}</p>
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
            <tbody>
              ${detail.events.map((e) => eventRow(e, urls))}
            </tbody>
          </table>`
      ),
      200,
      HEADERS
    );
  });

  return app;
};
