import { checkDestination } from "../../src/destinations";
import { cleanLinkText } from "../../src/link-names";
import type { LinkTexts } from "../../src/link-names";
import type { TokenSet } from "./registry";

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
const trackableAnchors = (
  root: ParentNode,
  origin: string
): { anchor: Element; url: string }[] => {
  const { host } = new URL(origin);
  return [...root.querySelectorAll("a[href]")].flatMap((anchor) => {
    const url = isQuoted(anchor) ? null : normalised(anchor);
    return url === null || new URL(url).host === host ? [] : [{ anchor, url }];
  });
};

export const trackableUrls = (root: ParentNode, origin: string): string[] => [
  ...new Set(trackableAnchors(root, origin).map(({ url }) => url)),
];

/** An anchor's visible text, or its image's alt text when it only holds an image. */
const anchorText = (anchor: Element): string => {
  const text = cleanLinkText(anchor.textContent ?? "");
  if (text !== "") {
    return text;
  }
  const alt = [...anchor.querySelectorAll("img[alt]")]
    .map((img) => cleanLinkText(img.getAttribute("alt") ?? ""))
    .find((value) => value !== "");
  return alt ?? "";
};

/**
 * The text of each trackable URL, from its first anchor that has some; URLs whose anchors
 * only repeat the URL (autolinked bare URLs) or are empty are left out, so the dashboard
 * names them by their domain.
 */
export const linkTexts = (root: ParentNode, origin: string): LinkTexts => {
  const texts: LinkTexts = {};
  for (const { anchor, url } of trackableAnchors(root, origin)) {
    const text = anchorText(anchor);
    if (text !== "" && texts[url] === undefined) {
      texts[url] = text;
    }
  }
  return texts;
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
 * The tracking image, marked up like Mailspring's own (open-tracking-composer-extension.ts):
 * `<img alt="" src="….png">` with no width, height, style or class, which are what pixel
 * blockers look for. The Worker serves a transparent 1x1 PNG, so it stays invisible.
 */
export const pixel = (doc: Document, imageUrl: string): HTMLImageElement => {
  const img = doc.createElement("img");
  img.setAttribute("alt", "");
  img.setAttribute("src", imageUrl);
  return img;
};

/**
 * Applies one recipient's token set synchronously: links whose URL was registered point at
 * their redirect, every other link is left untouched, and the image goes before any quoted
 * text. Returns the number of links rewritten.
 */
export const applyTokenSet = (
  root: HTMLElement,
  entry: TokenSet,
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
  const img = pixel(root.ownerDocument, entry.imageUrl);
  const quote = root.querySelector(QUOTE);
  if (quote?.parentNode) {
    quote.parentNode.insertBefore(img, quote);
  } else {
    root.append(img);
  }
  return rewritten;
};
