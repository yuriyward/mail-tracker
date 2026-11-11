/* oxlint-disable no-bitwise -- prefix masks on hex digits. */
/**
 * Addresses as fixed-width lowercase hex strings (8 digits for IPv4, 32 for IPv6), so plain
 * string comparison orders them like numbers. The Worker uses these to match hits against the
 * published blocks without BigInt (src/ip.ts), which is much slower to parse.
 */

import type { IpVersion } from "./ip";

export interface IpKey {
  version: IpVersion;
  key: string;
}

/** An inclusive range of keys of one version. */
export interface KeyRange {
  version: IpVersion;
  start: string;
  end: string;
}

const HEX_GROUP = /^[\da-f]{1,4}$/iu;
const V4_PART = /^\d{1,3}$/u;
const V4_MAPPED = "00000000000000000000ffff";

const v4Key = (text: string): string | null => {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let key = "";
  for (const part of parts) {
    if (!V4_PART.test(part) || Number(part) > 255) {
      return null;
    }
    key += Number(part).toString(16).padStart(2, "0");
  }
  return key;
};

const groupsKey = (text: string): string | null => {
  if (text === "") {
    return "";
  }
  let key = "";
  const parts = text.split(":");
  for (const [index, part] of parts.entries()) {
    const v4 = index === parts.length - 1 ? v4Key(part) : null;
    if (v4 !== null) {
      key += v4;
    } else if (HEX_GROUP.test(part)) {
      key += part.toLowerCase().padStart(4, "0");
    } else {
      return null;
    }
  }
  return key;
};

const v6Key = (text: string): string | null => {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = groupsKey(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsKey(halves[1] ?? "") : "";
  if (head === null || tail === null) {
    return null;
  }
  const missing = 32 - head.length - tail.length;
  if (halves.length === 2 ? missing < 4 : missing !== 0) {
    return null;
  }
  return head + "0".repeat(missing) + tail;
};

const familyKey = (text: string): IpKey | null => {
  if (text.includes(":")) {
    const key = v6Key(text);
    return key === null ? null : { key, version: 6 };
  }
  const key = v4Key(text);
  return key === null ? null : { key, version: 4 };
};

/** The key of an address; IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) come back as IPv4. */
export const ipKey = (text: string): IpKey | null => {
  const ip = familyKey(text.trim());
  return ip?.version === 6 && ip.key.startsWith(V4_MAPPED)
    ? { key: ip.key.slice(V4_MAPPED.length), version: 4 }
    : ip;
};

/** The keys of the first and last address of `address/length`; host bits are ignored. */
export const cidrKeyRange = (text: string): KeyRange | null => {
  const [address = "", length, ...rest] = text.trim().split("/");
  const ip = familyKey(address);
  if (ip === null || rest.length > 0) {
    return null;
  }
  const bits = ip.key.length * 4;
  const prefix = length === undefined ? bits : Number(length);
  if (!(length === undefined || V4_PART.test(length)) || prefix > bits) {
    return null;
  }
  const whole = Math.floor(prefix / 4);
  const partial = prefix % 4;
  const fill = (digit: string) => digit.repeat(ip.key.length - whole - 1);
  if (whole === ip.key.length) {
    return { end: ip.key, start: ip.key, version: ip.version };
  }
  const digit = Number.parseInt(ip.key.charAt(whole), 16);
  const keep = (0xf << (4 - partial)) & 0xf;
  const head = ip.key.slice(0, whole);
  return {
    end: head + (digit | (~keep & 0xf)).toString(16) + fill("f"),
    start: head + (digit & keep).toString(16) + fill("0"),
    version: ip.version,
  };
};
