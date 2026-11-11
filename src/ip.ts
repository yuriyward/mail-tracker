/* oxlint-disable no-bitwise -- addresses are integers here; masks and shifts are the arithmetic. */
/**
 * IPv4 and IPv6 addresses as integers, and the range arithmetic scripts/refresh-networks.ts
 * needs. The Worker matches addresses with src/ip-key.ts instead.
 */

export type IpVersion = 4 | 6;

/** An inclusive range of addresses of one version. */
export interface IpRange {
  version: IpVersion;
  start: bigint;
  end: bigint;
}

const BITS: Record<IpVersion, bigint> = { 4: 32n, 6: 128n };

const parseV4 = (text: string): bigint | null => {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part) || Number(part) > 255) {
      return null;
    }
    value = (value << 8n) | BigInt(part);
  }
  return value;
};

const parseGroups = (text: string): bigint[] | null => {
  if (text === "") {
    return [];
  }
  const groups: bigint[] = [];
  const parts = text.split(":");
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part.includes(".")) {
      const v4 = parseV4(part);
      if (v4 === null) {
        return null;
      }
      groups.push(v4 >> 16n, v4 & 0xff_ffn);
    } else if (/^[\da-f]{1,4}$/iu.test(part)) {
      groups.push(BigInt(`0x${part}`));
    } else {
      return null;
    }
  }
  return groups;
};

const parseV6 = (text: string): bigint | null => {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => 0n),
    ...tail,
  ];
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
};

/** Parses `address/length` (a bare address is a single-address range); host bits are ignored. */
export const parseCidr = (text: string): IpRange | null => {
  const [address = "", length, ...rest] = text.trim().split("/");
  if (rest.length > 0 || (length !== undefined && !/^\d{1,3}$/u.test(length))) {
    return null;
  }
  const ip = address.includes(":")
    ? { value: parseV6(address), version: 6 as const }
    : { value: parseV4(address), version: 4 as const };
  if (ip.value === null) {
    return null;
  }
  const bits = BITS[ip.version];
  const prefix = length === undefined ? bits : BigInt(length);
  if (prefix > bits) {
    return null;
  }
  const hostMask = (1n << (bits - prefix)) - 1n;
  const start = ip.value & ~hostMask;
  return { end: start | hostMask, start, version: ip.version };
};

const hex = (groups: number[]): string =>
  groups.map((group) => group.toString(16)).join(":");

const formatV6 = (value: bigint): string => {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xff_ffn)
  );
  // Compress the longest run of two or more zero groups (RFC 5952).
  let best = { length: 0, start: -1 };
  let run = { length: 0, start: -1 };
  for (const [index, group] of groups.entries()) {
    run =
      group === 0
        ? {
            length: run.length + 1,
            start: run.length === 0 ? index : run.start,
          }
        : { length: 0, start: -1 };
    if (run.length > best.length) {
      best = run;
    }
  }
  if (best.length < 2) {
    return hex(groups);
  }
  const head = hex(groups.slice(0, best.start));
  const tail = hex(groups.slice(best.start + best.length));
  return `${head}::${tail}`;
};

export const formatIp = (version: IpVersion, value: bigint): string =>
  version === 6
    ? formatV6(value)
    : [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join(".");

/** Sorts ranges and merges overlapping or adjacent ones, per version. */
export const mergeRanges = (ranges: readonly IpRange[]): IpRange[] => {
  const sorted = ranges.toSorted((a, b) =>
    a.version === b.version
      ? Number(a.start > b.start) - Number(a.start < b.start)
      : a.version - b.version
  );
  const merged: IpRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last?.version === range.version && range.start <= last.end + 1n) {
      last.end = range.end > last.end ? range.end : last.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

/** The addresses of `ranges` that are not in `remove`. */
export const subtractRanges = (
  ranges: readonly IpRange[],
  remove: readonly IpRange[]
): IpRange[] => {
  const cuts = mergeRanges(remove);
  const result: IpRange[] = [];
  for (const range of mergeRanges(ranges)) {
    let { start } = range;
    for (const cut of cuts) {
      if (
        cut.version !== range.version ||
        cut.end < start ||
        cut.start > range.end
      ) {
        continue;
      }
      if (cut.start > start) {
        result.push({ end: cut.start - 1n, start, version: range.version });
      }
      start = cut.end + 1n;
    }
    if (start <= range.end) {
      result.push({ end: range.end, start, version: range.version });
    }
  }
  return result;
};

/** The smallest list of CIDR blocks that covers exactly one range. */
export const rangeToCidrs = ({ version, start, end }: IpRange): string[] => {
  const bits = BITS[version];
  const cidrs: string[] = [];
  let next = start;
  while (next <= end) {
    let size = 0n;
    // Grow the block while it stays aligned on `next` and inside the range.
    while (
      size < bits &&
      (next & ((1n << (size + 1n)) - 1n)) === 0n &&
      next + (1n << (size + 1n)) - 1n <= end
    ) {
      size += 1n;
    }
    cidrs.push(`${formatIp(version, next)}/${bits - size}`);
    next += 1n << size;
  }
  return cidrs;
};
