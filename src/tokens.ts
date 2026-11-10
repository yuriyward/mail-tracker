const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[\w-]{22}$/u;

/** A random, unguessable 128-bit token, base64url without padding (22 characters). */
export const newToken = (): string =>
  btoa(
    String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

export const isToken = (value: string): boolean => TOKEN_PATTERN.test(value);
