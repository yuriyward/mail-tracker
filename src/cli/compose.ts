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
  pointLinks,
  removePixels,
  trackableUrls,
} from "../../mailspring-plugin/src/rewrite";
import { normaliseAddress, tokenSetAddresses } from "../recipients";
import { isToken } from "../tokens";
import { createClient, readToken, workerOrigin } from "./client";
import type { Client } from "./client";
import { registerDom } from "./dom";
import {
  bodyToHtml,
  bodyToText,
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

const everyoneOf = (options: ComposeOptions): string[] => [
  ...options.to,
  ...options.cc,
  ...options.bcc,
];

/**
 * Registers the message with one token set per address, or one shared set; answers the
 * sets in the Worker's order. Every image and redirect URL must be on the Worker's origin.
 */
const registerSets = async (
  client: Client,
  draftId: string,
  options: ComposeOptions,
  body: HTMLElement,
  shared: boolean
): Promise<{ token: string; shared: boolean; sets: MintedSet[] }> => {
  const everyone = everyoneOf(options);
  const answer = await client.post("/api/messages", {
    draftId,
    draftTracked: true,
    linkText: linkTexts(body, client.origin),
    links: trackableUrls(body, client.origin),
    recipient: everyone.join(", "),
    recipients: tokenSetAddresses(everyone.map(addressOf), false),
    shared,
    subject: options.subject,
  });
  const parsed = minted.safeParse(answer.body);
  const ours = (url: string, kind: string): boolean =>
    url.startsWith(`${client.origin}/${kind}/`);
  if (
    (answer.status !== 200 && answer.status !== 201) ||
    !parsed.success ||
    !parsed.data.recipients.every(
      (set) =>
        ours(set.imageUrl, "i") &&
        set.links.every((link) => ours(link.redirectUrl, "l"))
    )
  ) {
    throw new Error(
      `registration failed: the Worker answered ${answer.status}`
    );
  }
  return {
    sets: parsed.data.recipients,
    shared: parsed.data.shared,
    token: parsed.data.token,
  };
};

/** Registers the message: one recipient gets their own set, several one shared set. */
const register = async (
  client: Client,
  draftId: string,
  options: ComposeOptions,
  body: HTMLElement
): Promise<{ token: string; shared: boolean; set: MintedSet }> => {
  const addresses = tokenSetAddresses(
    everyoneOf(options).map(addressOf),
    false
  );
  const registered = await registerSets(
    client,
    draftId,
    options,
    body,
    addresses.length > 1
  );
  const [set, ...more] = registered.sets;
  if (!set || more.length > 0) {
    throw new Error("registration failed: expected one token set");
  }
  return { set, shared: registered.shared, token: registered.token };
};

/**
 * The plain-text alternative: the template's text (signature links with their
 * destinations) with the body's lines in its slot, exactly as written (ADR-0004).
 */
const composeText = (options: ComposeOptions): string => {
  const marker = `mail-tracker-body-${crypto.randomUUID()}`;
  const doc = parseHtml(fillTemplate(options.template, `<p>${marker}</p>`));
  autolink(doc.body);
  return htmlToText(doc.body)
    .split(marker)
    .join(bodyToText(options.body, options.markdown));
};

/** The filled template, parsed afresh for each copy, and the text alternative. */
const render = (options: ComposeOptions) => {
  if (everyoneOf(options).length === 0) {
    throw new Error("give at least one recipient (--to, --cc or --bcc)");
  }
  const filled = fillTemplate(
    options.template,
    bodyToHtml(options.body, options.markdown)
  );
  const parse = (): Document => {
    const doc = parseHtml(filled);
    // Bare https URLs become links, as the plugin does, so their clicks are tracked too.
    autolink(doc.body);
    return doc;
  };
  const output = (doc: Document): string => serialise(doc, isDocument(filled));
  return { output, parse, text: composeText(options) };
};

/**
 * Renders the email and, unless `track` is off, registers it and applies its token set
 * with the plugin's own code, so a composed draft is tracked exactly like a Mailspring one.
 */
export const compose = async (
  options: ComposeOptions,
  deps: { client: Client | null; draftId: () => string }
): Promise<Composed> => {
  const { output, parse, text } = render(options);
  const doc = parse();
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
    return { html: output(doc), receipt, text };
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
  return { html: output(doc), receipt, text };
};

/** Which header a recipient of a per-recipient compose came from. */
export type Role = "to" | "cc" | "bcc";

export interface RecipientItem {
  /** The copy's directory: recipients/<i>/ (0-based, in To, Cc, Bcc order). */
  i: number;
  /** The address as registered (lower case); its token set belongs to it alone. */
  address: string;
  role: Role;
  /** The image token in this copy's `/i/<token>.png`. */
  imageToken: string;
  /** This copy's redirect tokens: linkTokens[k] goes to receipt `links[k]`. */
  linkTokens: string[];
}

export interface SplitReceipt {
  status: "tracked";
  mode: "per-recipient";
  /** The message token: one message row for every copy (ADR-0003). */
  token: string;
  draftId: string;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  /** The tracked destinations in token order (the read API's `position`). */
  links: string[];
  items: RecipientItem[];
}

export interface Body {
  html: string;
  text: string;
}

export interface SplitComposed {
  /** The owner's copy: no image, every tracked link at its destination. */
  self: Body;
  /** One copy per item, in `receipt.items` order. */
  recipients: Body[];
  receipt: SplitReceipt;
}

/** One entry per address, in To, Cc, Bcc order; an address given twice is refused. */
const splitRecipients = (
  options: ComposeOptions
): { address: string; role: Role }[] => {
  const roles: [Role, string[]][] = [
    ["to", options.to],
    ["cc", options.cc],
    ["bcc", options.bcc],
  ];
  const seen = new Set<string>();
  return roles.flatMap(([role, values]) =>
    values.map((value) => {
      const address = normaliseAddress(addressOf(value));
      if (address === "" || seen.has(address)) {
        throw new Error(
          `--per-recipient needs each address once: ${address === "" ? "an empty address" : `${address} is given twice`}`
        );
      }
      seen.add(address);
      return { address, role };
    })
  );
};

const tokenOf = (url: string, kind: "i" | "l"): string => {
  const { pathname } = new URL(url);
  const token = kind === "i" ? pathname.slice(3, -4) : pathname.slice(3);
  if (!isToken(token)) {
    throw new Error(`registration failed: ${url} holds no token`);
  }
  return token;
};

/** Puts one recipient's set into its copy; answers its tokens, in `links` order. */
const applySet = (
  doc: Document,
  set: MintedSet,
  links: readonly string[],
  origin: string
): Pick<RecipientItem, "imageToken" | "linkTokens"> => {
  const redirect = new Map(
    set.links.map((link) => [link.url, link.redirectUrl])
  );
  const linkTokens = links.map((url) => {
    const href = redirect.get(url);
    if (href === undefined) {
      throw new Error(`registration failed: no redirect for ${url}`);
    }
    return tokenOf(href, "l");
  });
  applyTokenSet(
    doc.body,
    { imageUrl: set.imageUrl, links: Object.fromEntries(redirect) },
    origin
  );
  return { imageToken: tokenOf(set.imageUrl, "i"), linkTokens };
};

/**
 * `--per-recipient` (split sending, ADR-0004): one message row with one token set per
 * address, one copy per recipient carrying only that recipient's image and redirects, and
 * the owner's copy with no image and each tracked link at the destination its tokens
 * redirect to. The copies differ only in those URLs: the same links in the same order.
 */
export const composePerRecipient = async (
  options: ComposeOptions,
  deps: { client: Client; draftId: () => string }
): Promise<SplitComposed> => {
  const { output, parse, text } = render(options);
  const people = splitRecipients(options);
  const draftId = deps.draftId();
  const self = parse();
  const registered = await registerSets(
    deps.client,
    draftId,
    options,
    self.body,
    false
  );
  const links = trackableUrls(self.body, deps.client.origin);
  const byAddress = new Map(registered.sets.map((set) => [set.address, set]));
  if (registered.shared || byAddress.size !== people.length) {
    throw new Error("registration failed: expected one token set per address");
  }
  const copies = people.map((person, i) => {
    const set = byAddress.get(person.address);
    if (!set) {
      throw new Error(
        `registration failed: no token set for ${person.address}`
      );
    }
    const doc = parse();
    const item = applySet(doc, set, links, deps.client.origin);
    return {
      body: { html: output(doc), text },
      item: { ...person, i, ...item },
    };
  });
  removePixels(self.body, deps.client.origin);
  pointLinks(self.body, Object.fromEntries(links.map((url) => [url, url])));
  return {
    receipt: {
      bcc: options.bcc,
      cc: options.cc,
      draftId,
      items: copies.map((copy) => copy.item),
      links,
      mode: "per-recipient",
      status: "tracked",
      subject: options.subject,
      to: options.to,
      token: registered.token,
    },
    recipients: copies.map((copy) => copy.body),
    self: { html: output(self), text },
  };
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
  --body-file <file.txt|file.md> [--template <file.html>] [--no-track | --per-recipient]
  [--out <dir>] [--url <https://worker>] [--token-file <file>]

Writes body.html, body.txt and receipt.json to --out (default exports/compose/<time>).
--per-recipient writes recipients/<i>/body.{html,txt} (recipient i's own tracking),
self/body.{html,txt} (no tracking) and receipt.json instead.
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
  "per-recipient": { type: "boolean" },
  subject: { type: "string" },
  template: { type: "string" },
  to: { multiple: true, type: "string" },
  "token-file": { type: "string" },
  url: { type: "string" },
} as const;

const writeBody = (dir: string, body: Body): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "body.html"), body.html);
  writeFileSync(path.join(dir, "body.txt"), body.text);
};

/** Writes the copies and the receipt to `out`; answers the receipt as printed. */
const writeOut = (out: string, composed: Composed | SplitComposed): string => {
  if ("self" in composed) {
    writeBody(path.join(out, "self"), composed.self);
    for (const [i, body] of composed.recipients.entries()) {
      writeBody(path.join(out, "recipients", String(i)), body);
    }
  } else {
    writeBody(out, composed);
  }
  const receipt = `${JSON.stringify({ ...composed.receipt, out }, null, 2)}\n`;
  writeFileSync(path.join(out, "receipt.json"), receipt);
  return receipt;
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: cliOptions, strict: true });
  const bodyFile = values["body-file"];
  if (values.help === true || bodyFile === undefined) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = values.help === true ? 0 : 2;
    return;
  }
  const perRecipient = values["per-recipient"] === true;
  const track = values["no-track"] !== true;
  if (perRecipient && !track) {
    throw new Error("--per-recipient tracks each copy; leave out --no-track");
  }
  const { env } = process;
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
  const options: ComposeOptions = {
    bcc: list(values.bcc),
    body: readFileSync(bodyFile, "utf-8"),
    cc: list(values.cc),
    markdown: values.markdown === true || /\.(?:md|markdown)$/iu.test(bodyFile),
    subject: values.subject ?? "",
    template: readFileSync(templateFile, "utf-8"),
    to: list(values.to),
    track,
  };
  const composed =
    perRecipient && client
      ? await composePerRecipient(options, { client, draftId: newDraftId })
      : await compose(options, { client, draftId: newDraftId });
  const out = values.out ?? path.join("exports", "compose", String(Date.now()));
  process.stdout.write(writeOut(out, composed));
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`compose: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
