/** Shared Gmail client predicate, for display and read-time SQL classification. */
const signatures = [
  { text: "googleimageproxy", word: false },
  { text: "ggpht.com", word: false },
  { text: "google", word: true },
] as const;

export const gmailProxyReason = {
  matches: (reason: string): boolean => {
    const lower = reason.toLowerCase();
    return signatures.some(({ text, word }) =>
      word ? lower.split(/\W/u).includes(text) : lower.includes(text)
    );
  },
  /** SQL equivalent of matches; column is a trusted SQL expression, never user input. */
  sql: (column: string): string =>
    `(${signatures
      .map(({ text, word }) =>
        word
          ? `(' ' || LOWER(${column}) || ' ') GLOB '*[^a-z0-9_]${text}[^a-z0-9_]*'`
          : `INSTR(LOWER(${column}), '${text}') > 0`
      )
      .join(" OR ")})`,
};
