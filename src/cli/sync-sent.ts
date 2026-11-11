/**
 * `bun run sync-sent`: marks agent-composed emails sent once the owner has sent them from
 * any client (ADR-0004). The owner's agent reads his Sent folder with its own mail tools and
 * pipes the messages in as JSON; this matches each by our tracking image in its HTML to an
 * email the Worker has not seen sent yet, and reports the send time. It never reads mail.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { ownPixelTokens } from "../../mailspring-plugin/src/rewrite";
import { createClient, readToken, workerOrigin } from "./client";
import type { Client } from "./client";
import { registerDom } from "./dom";
import { parseHtml } from "./render";

/** One message from the owner's Sent folder, as his agent supplies it. */
export const sentMessage = z.object({
  html: z.string(),
  recipients: z.array(z.string()).default([]),
  /** When it was sent: ms since the epoch, or an ISO 8601 date; null when neither. */
  sentAt: z
    .union([z.number(), z.string().transform((value) => Date.parse(value))])
    .transform((ms) => (Number.isFinite(ms) ? Math.trunc(ms) : null)),
  subject: z.string().default(""),
});
export type SentMessage = z.output<typeof sentMessage>;

export const sentInput = z.array(sentMessage);

const unsentList = z.object({
  messages: z.array(
    z.object({ image_tokens: z.array(z.string()), token: z.string() })
  ),
});

export type SyncStatus =
  /** Matched and the Worker recorded the send time. */
  | "marked"
  /** Matched an email that an earlier message in this input already marked. */
  | "duplicate"
  /** No image of an unsent email outside quoted text. */
  | "unmatched"
  /** `sentAt` is not a date. */
  | "invalid"
  /** The Worker did not answer 204. */
  | "failed";

export interface SyncResult {
  status: SyncStatus;
  subject: string;
  sentAt: number | null;
  /** The matched message token, when there is one. */
  token: string | null;
  /** The Worker's HTTP status for "failed". */
  httpStatus: number | null;
}

export interface SyncReport {
  results: SyncResult[];
  marked: number;
  unmatched: number;
  failed: number;
}

/** Image token to message token, for every email the Worker has not seen sent. */
const awaitingSend = async (client: Client): Promise<Map<string, string>> => {
  const answer = await client.get("/api/messages?unsent=1");
  const parsed = unsentList.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success) {
    throw new Error(
      `listing unsent emails failed: the Worker answered ${answer.status}`
    );
  }
  return new Map(
    parsed.data.messages.flatMap((m) =>
      m.image_tokens.map((image): [string, string] => [image, m.token])
    )
  );
};

const result = (
  status: SyncStatus,
  sent: SentMessage,
  extra: Partial<SyncResult> = {}
): SyncResult => ({
  httpStatus: null,
  sentAt: sent.sentAt,
  status,
  subject: sent.subject,
  token: null,
  ...extra,
});

/**
 * Marks each matched email sent at its `sentAt`, oldest first; the Worker keeps the first
 * time it is told, so running this again changes nothing.
 */
export const syncSent = async (
  client: Client,
  input: readonly SentMessage[]
): Promise<SyncReport> => {
  const byImage = await awaitingSend(client);
  const sent = input.toSorted(
    (a, b) => (a.sentAt ?? Infinity) - (b.sentAt ?? Infinity)
  );
  const done = new Set<string>();
  const results: SyncResult[] = [];
  for (const message of sent) {
    const { sentAt } = message;
    const images = ownPixelTokens(parseHtml(message.html), client.origin);
    const token = images
      .map((image) => byImage.get(image))
      .find((found) => found !== undefined);
    if (sentAt === null) {
      results.push(result("invalid", message));
    } else if (token === undefined) {
      results.push(result("unmatched", message));
    } else if (done.has(token)) {
      results.push(result("duplicate", message, { token }));
    } else {
      // oxlint-disable-next-line no-await-in-loop -- one email at a time, oldest first.
      const answer = await client.post(`/api/messages/${token}/sent`, {
        sentAt,
      });
      done.add(token);
      results.push(
        answer.status === 204
          ? result("marked", message, { token })
          : result("failed", message, { httpStatus: answer.status, token })
      );
    }
  }
  const tally = (status: SyncStatus): number =>
    results.filter((r) => r.status === status).length;
  return {
    failed: tally("failed") + tally("invalid"),
    marked: tally("marked"),
    results,
    unmatched: tally("unmatched"),
  };
};

const USAGE = `usage: <sent messages as JSON> | bun run sync-sent [--url <https://worker>]
  [--token-file <file>] [--read-token-file <file>]

stdin: [{ "subject", "recipients": [addresses], "sentAt": ms or ISO date, "html" }]
Prints a JSON report; each result has a status: marked, duplicate, unmatched, invalid
or failed. Exits 1 when any failed or was invalid.
Environment: MAIL_TRACKER_URL, MAIL_TRACKER_API_TOKEN, MAIL_TRACKER_READ_TOKEN (or
each with _FILE).`;

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      "read-token-file": { type: "string" },
      "token-file": { type: "string" },
      url: { type: "string" },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const { env } = process;
  const client = createClient({
    fetch,
    origin: workerOrigin(values.url ?? env.MAIL_TRACKER_URL),
    readToken: readToken(
      env,
      "MAIL_TRACKER_READ_TOKEN",
      values["read-token-file"]
    ),
    writeToken: readToken(env, "MAIL_TRACKER_API_TOKEN", values["token-file"]),
  });
  const input = sentInput.parse(JSON.parse(await Bun.stdin.text()));
  registerDom();
  const report = await syncSent(client, input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.failed > 0 ? 1 : 0;
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`sync-sent: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
