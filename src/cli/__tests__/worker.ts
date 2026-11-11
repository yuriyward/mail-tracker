import { API_TOKEN, ORIGIN, READ_TOKEN } from "../../__tests__/harness";
import type { Harness } from "../../__tests__/harness";
import { createClient } from "../client";
import type { Client } from "../client";
import { compose } from "../compose";
import type { Composed, ComposeOptions } from "../compose";

/** The command-line tools' client, calling the Worker app in memory. */
export const workerClient = (h: Harness): Client =>
  createClient({
    fetch: async (request) => {
      const url = new URL(request.url);
      return await h.call(`${url.pathname}${url.search}`, {
        body: request.method === "POST" ? await request.text() : null,
        headers: request.headers,
        method: request.method,
      });
    },
    origin: ORIGIN,
    readToken: READ_TOKEN,
    writeToken: API_TOKEN,
  });

/** A fragment template, as a Mailspring draft body holds. */
export const FRAGMENT = "{{body}}";

let drafts = 0;

/** Composes through the in-memory Worker; options default to one recipient, tracked. */
export const composeWith = async (
  h: Harness,
  options: Partial<ComposeOptions> = {}
): Promise<Composed> => {
  drafts += 1;
  return await compose(
    {
      bcc: [],
      body: "Hi Alex,\n\nThe deck: https://example.org/deck\nPricing: https://example.org/pricing.",
      cc: [],
      markdown: false,
      subject: "Proposal",
      template: FRAGMENT,
      to: ["alex@example.com"],
      track: true,
      ...options,
    },
    {
      client: workerClient(h),
      draftId: () => `<compose-${drafts}@example.test>`,
    }
  );
};
