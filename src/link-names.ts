/**
 * Short names for links. The plugin sends each link's own text from the email when it
 * registers the draft; the dashboard shows that text, or, when there is none (a bare URL,
 * an image), a name derived from the host. Shared by the Worker, the plugin and the app,
 * so keep it free of Worker-only imports.
 */

/** A link's own text by its normalised URL, as the plugin sends it at registration. */
export type LinkTexts = Record<string, string>;

/** Longest link text kept; the dashboard truncates further on screen. */
export const MAX_LINK_TEXT = 200;

/** Text that is itself a URL or a host name says nothing a domain name would not. */
const URL_LIKE = /^(?:[a-z][\w+.-]*:\/\/|www\.)\S*$/iu;

/** Host prefixes that only pick a site's mobile or "www" flavour. */
const NOISE_PREFIX = /^(?:www\d*|m|mobile)\./iu;

/**
 * A link's text as stored: whitespace collapsed, cut to MAX_LINK_TEXT; '' when it is
 * empty or just repeats a URL (an autolinked bare URL).
 */
export const cleanLinkText = (text: string): string => {
  const clean = text.replaceAll(/\s+/gu, " ").trim();
  if (clean === "" || URL_LIKE.test(clean)) {
    return "";
  }
  return clean.length > MAX_LINK_TEXT
    ? `${clean.slice(0, MAX_LINK_TEXT - 1).trimEnd()}…`
    : clean;
};

/** "https://www.linkedin.com/in/x" → "linkedin.com"; the URL itself if it does not parse. */
export const domainName = (url: string): string => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const stripped = host.replace(NOISE_PREFIX, "");
    return stripped.includes(".") ? stripped : host;
  } catch {
    return url;
  }
};

/** What the dashboard shows for a link: its own text, else its domain. */
export const linkName = (url: string, text: string): string => {
  const clean = cleanLinkText(text);
  return clean === "" ? domainName(url) : clean;
};
