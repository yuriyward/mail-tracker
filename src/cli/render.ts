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

/**
 * The body as HTML. Markdown goes through Bun's parser with the GFM tag filter, so raw
 * `<script>`, `<style>` or `<iframe>` in it is shown as text; bare URLs are left for
 * the plugin's autolinker, which knows the redirect allow-list.
 */
export const bodyToHtml = (source: string, markdown: boolean): string =>
  markdown
    ? Bun.markdown.html(source, { tagFilter: true })
    : plainToHtml(source);

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
