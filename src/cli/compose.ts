/**
 * `bun run compose`: renders an agent's email with tracking already in it (ADR-0004), so it
 * is tracked whichever client the owner sends the draft from. It registers the message with
 * the Worker, puts the image and redirect URLs into the HTML, and writes body.html,
 * body.txt and receipt.json. It never creates the draft or sends anything (N1).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { autolink } from "../../mailspring-plugin/src/autolink";
import {
  applyTokenSet,
  linkTexts,
  trackableUrls,
} from "../../mailspring-plugin/src/rewrite";
import { tokenSetAddresses } from "../recipients";
import { createClient, readToken, workerOrigin } from "./client";
import type { Client } from "./client";
import { registerDom } from "./dom";
import {
  bodyToHtml,
  fillTemplate,
  htmlToText,
  isDocument,
  parseHtml,
  serialise,
} from "./render";

export const DEFAULT_TEMPLATE = path.join(import.meta.dir, "template.html");

export interface ComposeOptions {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The body as written: plain text, or Markdown when `markdown`. */
  body: string;
  markdown: boolean;
  /** HTML with one `{{body}}` slot. */
  template: string;
  track: boolean;
}

export interface Receipt {
  /** "tracked": registered, image and redirects in body.html; "untracked": --no-track. */
  status: "tracked" | "untracked";
  /** The message token, for `bun run sync-sent` and the read API; null when untracked. */
  token: string | null;
  draftId: string | null;
  /** One token set for several recipients (a shared copy, recipient unknown). */
  shared: boolean;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  imageUrl: string | null;
  links: { url: string; redirectUrl: string }[];
}

export interface Composed {
  html: string;
  text: string;
  receipt: Receipt;
}

const minted = z.object({
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.string(),
      links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
    })
  ),
  shared: z.boolean(),
  token: z.string(),
});
type MintedSet = z.infer<typeof minted>["recipients"][number];

/** `Alex Example <alex@example.com>` or `alex@example.com` to the address. */
export const addressOf = (value: string): string =>
  (/<(?<address>[^<>]+)>\s*$/u.exec(value)?.groups?.address ?? value).trim();

/** Registers the message: one recipient gets their own set, several one shared set. */
const register = async (
  client: Client,
  draftId: string,
  options: ComposeOptions,
  body: HTMLElement
): Promise<{ token: string; shared: boolean; set: MintedSet }> => {
  const everyone = [...options.to, ...options.cc, ...options.bcc];
  const addresses = tokenSetAddresses(everyone.map(addressOf), false);
  const answer = await client.post("/api/messages", {
    draftId,
    draftTracked: true,
    linkText: linkTexts(body, client.origin),
    links: trackableUrls(body, client.origin),
    recipient: everyone.join(", "),
    recipients: addresses,
    shared: addresses.length > 1,
    subject: options.subject,
  });
  const parsed = minted.safeParse(answer.body);
  const [set, ...more] = parsed.success ? parsed.data.recipients : [];
  const ours = (url: string, kind: string): boolean =>
    url.startsWith(`${client.origin}/${kind}/`);
  if (
    (answer.status !== 200 && answer.status !== 201) ||
    !parsed.success ||
    !set ||
    more.length > 0 ||
    !ours(set.imageUrl, "i") ||
    !set.links.every((link) => ours(link.redirectUrl, "l"))
  ) {
    throw new Error(
      `registration failed: the Worker answered ${answer.status}`
    );
  }
  return { set, shared: parsed.data.shared, token: parsed.data.token };
};

/**
 * Renders the email and, unless `track` is off, registers it and applies its token set
 * with the plugin's own code, so a composed draft is tracked exactly like a Mailspring one.
 */
export const compose = async (
  options: ComposeOptions,
  deps: { client: Client | null; draftId: () => string }
): Promise<Composed> => {
  if (options.to.length + options.cc.length + options.bcc.length === 0) {
    throw new Error("give at least one recipient (--to, --cc or --bcc)");
  }
  const filled = fillTemplate(
    options.template,
    bodyToHtml(options.body, options.markdown)
  );
  const doc = parseHtml(filled);
  // Bare https URLs become links, as the plugin does, so their clicks are tracked too.
  autolink(doc.body);
  const text = htmlToText(doc.body);
  const base = {
    bcc: options.bcc,
    cc: options.cc,
    subject: options.subject,
    to: options.to,
  };
  if (!options.track || !deps.client) {
    const receipt: Receipt = {
      ...base,
      draftId: null,
      imageUrl: null,
      links: [],
      shared: false,
      status: "untracked",
      token: null,
    };
    return { html: serialise(doc, isDocument(filled)), receipt, text };
  }
  const draftId = deps.draftId();
  const registered = await register(deps.client, draftId, options, doc.body);
  applyTokenSet(
    doc.body,
    {
      imageUrl: registered.set.imageUrl,
      links: Object.fromEntries(
        registered.set.links.map((link) => [link.url, link.redirectUrl])
      ),
    },
    deps.client.origin
  );
  const receipt: Receipt = {
    ...base,
    draftId,
    imageUrl: registered.set.imageUrl,
    links: registered.set.links,
    shared: registered.shared,
    status: "tracked",
    token: registered.token,
  };
  return { html: serialise(doc, isDocument(filled)), receipt, text };
};

/** A synthetic Message-ID-like key for the registration; never a real header. */
export const newDraftId = (): string =>
  `<compose-${crypto.randomUUID()}@mail-tracker.invalid>`;

const list = (values: string[] | undefined): string[] =>
  (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");

const USAGE = `usage: bun run compose --to <address> [--cc …] [--bcc …] --subject <text>
  --body-file <file.txt|file.md> [--template <file.html>] [--no-track] [--out <dir>]
  [--url <https://worker>] [--token-file <file>]

Writes body.html, body.txt and receipt.json to --out (default exports/compose/<time>).
Environment: MAIL_TRACKER_URL, MAIL_TRACKER_API_TOKEN (or MAIL_TRACKER_API_TOKEN_FILE),
MAIL_TRACKER_TEMPLATE.`;

const cliOptions = {
  bcc: { multiple: true, type: "string" },
  "body-file": { type: "string" },
  cc: { multiple: true, type: "string" },
  help: { type: "boolean" },
  markdown: { type: "boolean" },
  "no-track": { type: "boolean" },
  out: { type: "string" },
  subject: { type: "string" },
  template: { type: "string" },
  to: { multiple: true, type: "string" },
  "token-file": { type: "string" },
  url: { type: "string" },
} as const;

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: cliOptions, strict: true });
  const bodyFile = values["body-file"];
  if (values.help === true || bodyFile === undefined) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = values.help === true ? 0 : 2;
    return;
  }
  const { env } = process;
  const track = values["no-track"] !== true;
  const client = track
    ? createClient({
        fetch,
        origin: workerOrigin(values.url ?? env.MAIL_TRACKER_URL),
        readToken: "",
        writeToken: readToken(
          env,
          "MAIL_TRACKER_API_TOKEN",
          values["token-file"]
        ),
      })
    : null;
  const templateFile =
    values.template ?? env.MAIL_TRACKER_TEMPLATE ?? DEFAULT_TEMPLATE;
  registerDom();
  const composed = await compose(
    {
      bcc: list(values.bcc),
      body: readFileSync(bodyFile, "utf-8"),
      cc: list(values.cc),
      markdown:
        values.markdown === true || /\.(?:md|markdown)$/iu.test(bodyFile),
      subject: values.subject ?? "",
      template: readFileSync(templateFile, "utf-8"),
      to: list(values.to),
      track,
    },
    { client, draftId: newDraftId }
  );
  const out = values.out ?? path.join("exports", "compose", String(Date.now()));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "body.html"), composed.html);
  writeFileSync(path.join(out, "body.txt"), composed.text);
  const receipt = `${JSON.stringify({ ...composed.receipt, out }, null, 2)}\n`;
  writeFileSync(path.join(out, "receipt.json"), receipt);
  process.stdout.write(receipt);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`compose: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
