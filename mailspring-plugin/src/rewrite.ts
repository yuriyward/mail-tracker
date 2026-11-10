import { checkDestination } from "../../src/destinations";
import type { Registration } from "./registry";

/** Quoted earlier messages; their links are left as they were (like Mailspring's own tracking). */
const QUOTE = ".gmail_quote";

const isQuoted = (element: Element): boolean => element.closest(QUOTE) !== null;

const normalised = (anchor: Element): string | null => {
  const check = checkDestination(anchor.getAttribute("href")?.trim() ?? "");
  return check.ok ? check.url : null;
};

/**
 * The URLs to register: https links the Worker accepts, outside quoted text, not already
 * pointing at the tracker; normalised and in order of first appearance.
 */
export const trackableUrls = (root: ParentNode, origin: string): string[] => {
  const { host } = new URL(origin);
  const urls = [...root.querySelectorAll("a[href]")]
    .filter((anchor) => !isQuoted(anchor))
    .map((anchor) => normalised(anchor))
    .filter((url): url is string => url !== null && new URL(url).host !== host);
  return [...new Set(urls)];
};

/** Removes tracking images already in the body, e.g. quoted from an earlier tracked email. */
const removePixels = (root: ParentNode, origin: string): void => {
  for (const img of root.querySelectorAll("img")) {
    if ((img.getAttribute("src") ?? "").startsWith(`${origin}/i/`)) {
      img.remove();
    }
  }
};

/**
 * Applies a registration synchronously: links whose URL was registered point at their
 * redirect, every other link is left untouched, and the image goes before any quoted text.
 * Returns the number of links rewritten.
 */
export const applyRegistration = (
  root: HTMLElement,
  entry: Registration,
  origin: string
): number => {
  removePixels(root, origin);
  let rewritten = 0;
  for (const anchor of root.querySelectorAll("a[href]")) {
    const url = isQuoted(anchor) ? null : normalised(anchor);
    const redirect = url === null ? undefined : entry.links[url];
    if (redirect !== undefined) {
      anchor.setAttribute("href", redirect);
      rewritten += 1;
    }
  }
  const img = root.ownerDocument.createElement("img");
  img.setAttribute("src", entry.imageUrl);
  img.setAttribute("width", "1");
  img.setAttribute("height", "1");
  img.setAttribute("alt", "");
  img.setAttribute("style", "border:0;width:1px;height:1px;");
  const quote = root.querySelector(QUOTE);
  if (quote?.parentNode) {
    quote.parentNode.insertBefore(img, quote);
  } else {
    root.append(img);
  }
  return rewritten;
};
