import { checkDestination } from "../../src/destinations";

/** Text here is left as written: existing links, quoted text, code. */
const SKIP = "a, .gmail_quote, blockquote, code, pre, script, style";

const BARE_URL = /https:\/\/[^\s<>"']+/giu;

/** Characters that end a sentence or close a bracket or quote, not part of the URL. */
const TRAILING = /[.,;:!?)\]"'”’»]+$/u;

const linkify = (text: Text): void => {
  const value = text.data;
  const parts: (string | HTMLAnchorElement)[] = [];
  let last = 0;
  for (const match of value.matchAll(BARE_URL)) {
    const url = match[0].replace(TRAILING, "");
    if (checkDestination(url).ok) {
      const start = match.index;
      parts.push(value.slice(last, start));
      const anchor = text.ownerDocument.createElement("a");
      anchor.setAttribute("href", url);
      anchor.textContent = url;
      parts.push(anchor);
      last = start + url.length;
    }
  }
  if (parts.length > 0) {
    parts.push(value.slice(last));
    text.replaceWith(...parts.filter((part) => part !== ""));
  }
};

/**
 * Turns bare https URLs in text into links, so they are tracked like links written as
 * links; otherwise the recipient's client makes them clickable itself and the click
 * bypasses the Worker. Only URLs the redirect allow-list accepts become links.
 */
export const autolink = (root: HTMLElement): void => {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT
  );
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.parentElement?.closest(SKIP) === null) {
      texts.push(node);
    }
  }
  for (const text of texts) {
    linkify(text);
  }
};
