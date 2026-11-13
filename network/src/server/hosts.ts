/**
 * Which hosts the server may fetch for someone, for avatars and link previews. It reads the host as
 * text and looks nothing up, so a public name that points at a private address still passes. Workers
 * can't reach private networks, so this is a second line, not the only one.
 */

/** Hosts a server must never fetch for someone: local names, and private, reserved, or translated addresses. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.includes(":")) {
    const groups = ipv6(host);
    return groups !== null && publicIPv6(groups);
  }
  const v4 = ipv4(host);
  if (v4) return publicIPv4(v4);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // A name ending in a number is an IPv4 address spelled another way, such as 127.1, 0x7f000001, or 0177.0.0.1.
  if (/^(\d+|0x[0-9a-f]*)$/.test(host.split(".").at(-1)!)) return false;
  return host.includes(".");
}

/** An IPv6 address's /64, such as `2001:db8:1:2::/64`, which one person usually has all of. Anything else as it is. */
export function addressBlock(address: string): string {
  const groups = address.includes(":") ? ipv6(address.toLowerCase()) : null;
  return groups ? `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64` : address;
}

/** The four bytes of a dotted IPv4 address, or null for anything else, including leading zeros. */
function ipv4(text: string): number[] | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)?.slice(1);
  if (!parts || parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

function publicIPv4([a, b]: number[]): boolean {
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a! >= 224);
}

/**
 * The eight 16-bit groups of an IPv6 address, or null if it isn't one. Takes `::` and a dotted IPv4
 * address at the end, such as `::ffff:127.0.0.1`. A zone, such as `%en0`, isn't an address.
 */
function ipv6(text: string): number[] | null {
  let rest = text;
  let tail: number[] = [];
  const dotted = /^(.*:)([\d.]+)$/.exec(text);
  if (dotted && dotted[2]!.includes(".")) {
    const v4 = ipv4(dotted[2]!);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    rest = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...back].some(Number.isNaN)) return null;
  const given = head.length + back.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return null;
  return [...head, ...Array<number>(8 - given).fill(0), ...back, ...tail];
}

/**
 * Only global unicast, 2000::/3. Everything else is unspecified, loopback, unique local, link-local,
 * multicast, or reserved, including IPv4 in IPv6: mapped (::ffff:0:0/96), compatible (::/96), and
 * NAT64 (64:ff9b::/96), any of which can reach a private IPv4 address.
 */
function publicIPv6([a, b]: number[]): boolean {
  if ((a! & 0xe000) !== 0x2000) return false;
  // Teredo (2001::/32) and 6to4 (2002::/16) carry an IPv4 address too. 2001:db8::/32 is for examples.
  if (a === 0x2001 && (b === 0 || b === 0xdb8)) return false;
  return a !== 0x2002;
}
