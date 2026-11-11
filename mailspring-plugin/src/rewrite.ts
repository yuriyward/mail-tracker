import { checkDestination } from "../../src/destinations";
import { cleanLinkText } from "../../src/link-names";
import type { LinkTexts } from "../../src/link-names";
import type { TokenSet } from "./registry";

/** Quoted earlier messages; their links are left as they were (like Mailspring's own tracking). */
const QUOTE = ".gmail_quote";

const isQuoted = (element: Element): boolean => element.closest(QUOTE) !== null;

/** Quoted text in any client's markup: a pixel in here belongs to an earlier email. */
const ANY_QUOTE = `${QUOTE}, blockquote`;

const PIXEL_TOKEN = /^\/i\/(?<token>[\w-]{22})(?:\.png|\.gif)?$/u;

/**
 * The image tokens of our tracking images in the HTML, outside quoted text (an image in
 * quoted text belongs to an earlier email). Used to spot a draft an agent composed with
 * tracking, and to match a sent copy to its email (ADR-0004).
 */
export const ownPixelTokens = (root: ParentNode, origin: string): string[] =>
  [...root.querySelectorAll("img[src]")].flatMap((img) => {
    const src = img.getAttribute("src")?.trim() ?? "";
    const url = URL.canParse(src) ? new URL(src) : null;
    const token =
      url?.origin === origin
        ? PIXEL_TOKEN.exec(url.pathname)?.groups?.token
        : undefined;
    return token !== undefined && img.closest(ANY_QUOTE) === null
      ? [token]
      : [];
  });

/** The draft's own tracking image token (an agent's composed draft), or null. */
export const carriedPixelToken = (
  root: ParentNode,
  origin: string
): string | null => ownPixelTokens(root, origin)[0] ?? null;

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
 * The destination of a link: a redirect the draft already carried (an agent's composed
 * draft, ADR-0004) maps back to its URL; any other link is normalised as written.
 */
const destination = (
  anchor: Element,
  carried: Readonly<Record<string, string>>
): string | null => {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  return Object.hasOwn(carried, href)
    ? (carried[href] ?? null)
    : normalised(anchor);
};

/**
 * Applies one recipient's token set synchronously: links whose URL was registered point at
 * their redirect, every other link is left untouched, and the image goes before any quoted
 * text, replacing any tracking image already there. `carried` maps redirects the draft
 * already carried to their URL, so they are swapped for this recipient's own. Returns the
 * number of links rewritten.
 */
export const applyTokenSet = (
  root: HTMLElement,
  entry: TokenSet,
  origin: string,
  carried: Readonly<Record<string, string>> = {}
): number => {
  removePixels(root, origin);
  let rewritten = 0;
  for (const anchor of root.querySelectorAll("a[href]")) {
    const url = isQuoted(anchor) ? null : destination(anchor, carried);
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
