export interface Quote {
  fid: number;
  handle: string;
  text: string;
}

export interface FeedCast {
  hash: string;
  fid: number;
  /** Unix seconds. */
  time: number;
  text: string;
  links?: string[];
  quote?: Quote;
  avatar?: string;
  images?: string[];
}

function parse(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

/** A picture's author chooses its address, so only HTTPS to a named public host is fetched. */
export function imageURL(link: string): string | null {
  const url = parse(link);
  if (!url || url.protocol !== "https:") return null;
  // A trailing dot names the same host, so it can't be allowed to slip past the checks below.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host.includes(".") || !/[a-z]/.test(host) || host.startsWith("[")) return null;
  if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) return null;
  return url.href;
}

/** Web links that can be opened safely. The server only sends these, and this checks again. */
export function webLinks(cast: FeedCast): string[] {
  return (cast.links ?? []).filter((link) => {
    const url = parse(link);
    return url !== null && (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  });
}

export const imageURLs = (cast: FeedCast) => (cast.images ?? []).flatMap((link) => imageURL(link) ?? []);

export function isReadable(cast: FeedCast, now = Date.now()): boolean {
  if (cast.time * 1000 > now + 300_000) return false;
  return cast.text.trim() !== "" || webLinks(cast).length > 0 || imageURLs(cast).length > 0 || cast.quote !== undefined;
}

/** What a link shows. Only a leading www. comes off, so a label can't be made to read as another site. */
export function linkLabel(link: string): string {
  const url = parse(link);
  if (!url) return link;
  const host = url.hostname.toLowerCase();
  const shown = host.startsWith("www.") ? host.slice(4) : host;
  if (url.pathname === "/") return shown;
  try {
    return shown + decodeURI(url.pathname);
  } catch {
    return shown + url.pathname;
  }
}

/** The cast on Farcaster's website. Null when the handle is only a stand-in FID or can't be a username. */
export function farcasterURL(cast: FeedCast, handle: string): string | null {
  if (!handle || handle === String(cast.fid) || !/^[a-z0-9\-_.]+$/.test(handle.toLowerCase())) return null;
  if (!cast.hash.startsWith("0x") || cast.hash.length < 10) return null;
  return `https://farcaster.xyz/${handle.toLowerCase()}/${cast.hash.slice(0, 10).toLowerCase()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The feed's short timestamp, such as Now, 5m, 3h, or 2d. */
export function shortAge(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - time));
  if (seconds < 60) return "Now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  const date = new Date(time * 1000);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function fullDate(time: number): string {
  return new Date(time * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface TextPiece {
  text: string;
  url?: string;
}

// A bare address only counts with a suffix people actually use, so "node.js" and "e.g." stay text.
const BARE_SUFFIXES = new Set(["com", "org", "net", "io", "xyz", "co", "ai", "app", "dev", "tech", "me", "tv", "gg", "so", "fm", "to", "ly", "edu", "gov", "info", "news", "social"]);
const LINK = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"]*)?/gi;

/**
 * Cast text split around its web links. Each link opens the address its own text spells out, and a
 * host in another alphabet stays plain text because it can look just like a familiar one.
 */
export function linkedText(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let cursor = 0;
  let found = 0;
  for (const match of text.matchAll(LINK)) {
    if (found >= 20) break;
    const start = match.index;
    if (start > 0 && /[\w@.-]/.test(text[start - 1])) continue;
    const written = match[0].replace(/[.,!?:;)'’”\]]+$/, "");
    const hasScheme = /^https?:\/\//i.test(written);
    const url = parse(hasScheme ? written : `https://${written}`);
    if (!url || !/^[\x00-\x7f]+$/.test(url.hostname)) continue;
    if (url.hostname.split(".").some((label) => label.startsWith("xn--"))) continue;
    if (!hasScheme && !BARE_SUFFIXES.has(url.hostname.split(".").at(-1)!.toLowerCase())) continue;
    if (start > cursor) pieces.push({ text: text.slice(cursor, start) });
    pieces.push({ text: written, url: url.href });
    cursor = start + written.length;
    found++;
  }
  if (cursor < text.length || pieces.length === 0) pieces.push({ text: text.slice(cursor) });
  return pieces;
}
