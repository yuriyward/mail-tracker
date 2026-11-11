/**
 * How a draft's recipients map to token sets (ADR-0003); shared by the Worker and the
 * Mailspring plugin, so both agree on the keys.
 */

/** Addresses compare case-insensitively, as mail servers treat them in practice. */
export const normaliseAddress = (address: string): string =>
  address.trim().toLowerCase();

/**
 * The token sets a registration asks for: one per distinct address, or, when the account
 * sends one body to all (Microsoft Graph), a single set: the recipient's own when there is
 * only one, otherwise one with the unknown address ''.
 */
export const tokenSetAddresses = (
  recipients: readonly string[],
  shared: boolean
): string[] => {
  const addresses = [
    ...new Set(recipients.map((a) => normaliseAddress(a))),
  ].filter((a) => a !== "");
  if (!shared) {
    return addresses;
  }
  return [addresses.length === 1 ? (addresses[0] ?? "") : ""];
};
