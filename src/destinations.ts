const MAX_URL_LENGTH = 4096;
const LOCAL_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/iu;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

export type DestinationCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * The redirect allow-list: only absolute https URLs to a public host name, without
 * credentials. Destinations are stored when minted and checked again on redirect, so a
 * tracking URL can never be turned into an open redirect.
 */
export const checkDestination = (raw: string): DestinationCheck => {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "too long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "not https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "contains credentials" };
  }
  const host = url.hostname;
  if (host.startsWith("[") || IPV4_LITERAL.test(host) || !host.includes(".")) {
    return { ok: false, reason: "host is not a public domain name" };
  }
  if (LOCAL_HOST.test(host)) {
    return { ok: false, reason: "host is local" };
  }
  return { ok: true, url: url.href };
};
