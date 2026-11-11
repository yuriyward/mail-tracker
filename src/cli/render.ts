/**
 * Rendering an agent's email for `bun run compose` (ADR-0004): the body (plain text or
 * Markdown) into an HTML template's `{{body}}` slot, and a plain-text alternative from the
 * result. Uses the DOM globals (happy-dom in the command-line tools and in tests).
 */

export const BODY_SLOT = "{{body}}";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const BLOCKS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TR",
  "UL",
]);
const SKIPPED = new Set(["HEAD", "IMG", "SCRIPT", "STYLE", "TITLE"]);

/** Plain text: paragraphs at blank lines, line breaks kept. */
const plainToHtml = (text: string): string =>
  text
    .replaceAll("\r\n", "\n")
    .trim()
    .split(/\n\s*\n/u)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`
    )
    .join("\n");

/** Elements a soft break next to them separates, so it stays a plain newline. */
const BREAK_BOUNDARIES = new Set(["BR", "LI", "TBODY", "THEAD", "TD", "TH"]);

const isInline = (node: Node | null): boolean => {
  if (node === null) {
    return false;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return /\S/u.test(node.textContent ?? "");
  }
  if (!(node instanceof Element)) {
    return false;
  }
  const tag = node.tagName.toUpperCase();
  return !BLOCKS.has(tag) && !BREAK_BOUNDARIES.has(tag);
};

/** A text node's newlines as `<br>` where text runs on both sides of them. */
const breakLines = (node: Text, doc: Document): void => {
  const [first = "", ...rest] = (node.textContent ?? "").split("\n");
  const parts: Node[] = [doc.createTextNode(first)];
  let before = /\S/u.test(first) || isInline(node.previousSibling);
  for (const [index, line] of rest.entries()) {
    const after =
      /\S/u.test(rest.slice(index).join("")) || isInline(node.nextSibling);
    if (before && after) {
      parts.push(doc.createElement("br"));
    }
    parts.push(doc.createTextNode(`\n${line}`));
    before ||= /\S/u.test(line);
  }
  node.replaceWith(...parts);
};

/**
 * Markdown "breaks" mode: every soft line break (a newline inside a paragraph, list item
 * or heading) becomes `<br>`, so the email keeps the lines as the agent wrote them. Code
 * blocks and the newlines between blocks are left alone.
 */
const softBreaksToBr = (html: string): string => {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html"
  );
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const multiline = (node.textContent ?? "").includes("\n");
    if (
      multiline &&
      node instanceof Text &&
      node.parentElement?.closest("pre") === null
    ) {
      texts.push(node);
    }
  }
  for (const node of texts) {
    breakLines(node, doc);
  }
  return `${doc.body.innerHTML}\n`;
};

/**
 * The body as HTML. Markdown goes through Bun's parser with the GFM tag filter, so raw
 * `<script>`, `<style>` or `<iframe>` in it is shown as text, then in "breaks" mode: a
 * single newline is a line break, a blank line a paragraph. Bare URLs are left for the
 * plugin's autolinker, which knows the redirect allow-list.
 */
export const bodyToHtml = (source: string, markdown: boolean): string =>
  markdown
    ? softBreaksToBr(Bun.markdown.html(source, { tagFilter: true }))
    : plainToHtml(source);

/** `[text](url)` (not an image) and its destination, optionally in `<…>` or titled. */
const INLINE_LINK =
  /(?<!!)\[(?<text>[^\]\n]*)\]\(\s*<?(?<url>[^\s()<>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu;

const plainLinks = (line: string): string =>
  line
    .split(/(?<code>`+[^`\n]*?`+)/u)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replaceAll(INLINE_LINK, (_match, text: string, url: string) =>
            text.trim() === "" || text.trim() === url ? url : `${text} (${url})`
          )
    )
    .join("");

/**
 * The body's lines for the plain-text alternative, exactly as written: in Markdown only
 * `[text](url)` becomes `text (url)` (code is left as it is).
 */
export const bodyToText = (source: string, markdown: boolean): string => {
  const lines = source.replaceAll("\r\n", "\n").trim().split("\n");
  if (!markdown) {
    return lines.join("\n");
  }
  let fence: string | null = null;
  return lines
    .map((line) => {
      const marker = /^ {0,3}(?<fence>`{3,}|~{3,})/u.exec(line)?.groups?.fence;
      if (fence !== null) {
        // A closing fence: the same character, at least as many of it.
        if (marker?.startsWith(fence) === true) {
          fence = null;
        }
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      return plainLinks(line);
    })
    .join("\n");
};

/** Puts the body into the template's one `{{body}}` slot. */
export const fillTemplate = (template: string, body: string): string => {
  const parts = template.split(BODY_SLOT);
  if (parts.length !== 2) {
    throw new Error(
      `the template must hold ${BODY_SLOT} exactly once (found ${parts.length - 1})`
    );
  }
  return `${parts[0] ?? ""}${body}${parts[1] ?? ""}`;
};

/** Whether the template is a whole document rather than a fragment. */
export const isDocument = (html: string): boolean => /<html[\s>]/iu.test(html);

export const parseHtml = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

/** The document as written back: a whole document, or just the body's contents. */
export const serialise = (doc: Document, whole: boolean): string =>
  whole
    ? `<!doctype html>\n${doc.documentElement.outerHTML}\n`
    : `${doc.body.innerHTML}\n`;

/** A link's destination, when it says more than the link's own text. */
const linkSuffix = (anchor: Element): string => {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  const text = (anchor.textContent ?? "").trim();
  return /^(?:https?|mailto):/iu.test(href) && href !== text
    ? ` (${href})`
    : "";
};

/** What goes before an element's text: a paragraph break, a list bullet, or nothing. */
const opening = (tag: string): string => {
  if (BLOCKS.has(tag)) {
    return "\n\n";
  }
  return tag === "LI" ? "\n- " : "";
};

const collect = (node: Node, out: string[]): void => {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push((node.textContent ?? "").replaceAll(/\s+/gu, " "));
    return;
  }
  if (!(node instanceof Element)) {
    return;
  }
  const tag = node.tagName.toUpperCase();
  if (SKIPPED.has(tag)) {
    return;
  }
  if (tag === "BR") {
    out.push("\n");
    return;
  }
  out.push(opening(tag));
  if (tag === "PRE") {
    out.push(node.textContent ?? "");
  } else {
    for (const child of node.childNodes) {
      collect(child, out);
    }
  }
  out.push(tag === "A" ? linkSuffix(node) : "", BLOCKS.has(tag) ? "\n\n" : "");
};

/**
 * A plain-text alternative of the rendered email: paragraphs and list items on their own
 * lines, each link followed by its destination (as written, never a tracking URL).
 */
export const htmlToText = (root: Element): string => {
  const out: string[] = [];
  collect(root, out);
  return `${out
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim()}\n`;
};
