import { isIPv4, isIPv6 } from "node:net";

/**
 * The unit the login throttle counts one source by. An IPv4 address stands alone.
 * An IPv6 address counts as its /64, the smallest prefix a host is normally given
 * whole (RFC 6177): counted per address, one host could present unlimited sources.
 * An IPv4-mapped IPv6 address counts as its IPv4 address. Null for anything that
 * is not an IP address, so the caller fails closed instead of inventing a source.
 */
export function sourceNetwork(remoteAddress: string): string | null {
  const zoneAt = remoteAddress.indexOf("%");
  const address = zoneAt === -1 ? remoteAddress : remoteAddress.slice(0, zoneAt);
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an address `isIPv6` accepted, or null if it does not expand to eight. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        if (!isIPv4(piece)) return null;
        const [a, b, c, d] = piece.split(".").map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}
