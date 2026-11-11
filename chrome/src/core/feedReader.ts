import type { FeedCast, Quote } from "./cast.ts";
import { FeedHTTPError } from "./errors.ts";
import type { Client } from "./http.ts";
import { byteLength } from "./message.ts";

export interface Person {
  handle: string;
  fid: number;
}

export interface Read {
  casts: FeedCast[];
  handles: Record<number, string>;
  latestSeen: number;
  /** False if a full read ran out of pages before reaching the end of the window. */
  complete: boolean;
}

interface RemoteAuthor {
  fid: number;
  username?: string;
  pfp_url?: string;
}

interface RemoteEmbed {
  url?: string;
  metadata?: { content_type?: string };
  cast?: { text?: string; author?: RemoteAuthor };
}

interface RemoteCast {
  hash: string;
  text?: string;
  timestamp: string;
  parent_hash?: string | null;
  author: RemoteAuthor;
  mentioned_profiles?: { username?: string }[];
  mentioned_profiles_ranges?: { start: number; end: number }[];
  embeds?: RemoteEmbed[];
}

/** Neynar charges for the casts a page could return, so a short page keeps an unchanged feed cheap. */
const POLL_LIMIT = 10;
const POLL_MAX_PAGES = 10;
const WINDOW_LIMIT = 100;
const WINDOW_MAX_PAGES = 8;
/** A cast can arrive slightly out of order, so a poll reads a little past the last one it saw. */
const POLL_OVERLAP_SECONDS = 120;
const MAX_FOLLOWS = 3500;
const LINKS_PAGE_SIZE = 1000;
const MAX_LINK_PAGES = 50;
const MAX_CAST_BYTES = 12_000;
const MAX_HANDLE_BYTES = 64;
const MAX_LINKS = 4;
const MAX_IMAGES = 4;
const MAX_LINK_BYTES = 2048;
const USERS_PER_CALL = 100;
const USER_CALLS_AT_ONCE = 5;
const MEDIA_HOSTS = new Set(["imagedelivery.net", "stream.farcaster.xyz", "media.tenor.com", "media1.tenor.com", "media.firefly.land", "i.imgur.com"]);
const MEDIA_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "svg", "mp4", "mov", "webm", "m3u8", "mp3", "m4a", "wav"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic"]);

function parseURL(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

const extension = (url: URL) => {
  const last = url.pathname.split("/").at(-1) ?? "";
  return last.includes(".") ? last.split(".").at(-1)!.toLowerCase() : "";
};

export const seconds = (timestamp: string): number | null => {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
};

/** Neynar writes an account that has no username as `!` and its FID. */
function usableHandle(username: string | undefined): string | null {
  if (!username || username.startsWith("!") || byteLength(username) > MAX_HANDLE_BYTES) return null;
  return username;
}

/** A picture the app can show. When Neynar hasn't inspected the link yet, its address decides. */
function isImage(embed: RemoteEmbed): boolean {
  const url = embed.url ? parseURL(embed.url) : null;
  if (!url || url.protocol !== "https:") return false;
  const type = embed.metadata?.content_type?.toLowerCase();
  if (type) return type.startsWith("image/") && !type.startsWith("image/svg");
  return url.hostname.toLowerCase() === "imagedelivery.net" || IMAGE_EXTENSIONS.has(extension(url));
}

function isReadableLink(embed: RemoteEmbed): boolean {
  const url = embed.url ? parseURL(embed.url) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return false;
  if (MEDIA_HOSTS.has(url.hostname.toLowerCase()) || MEDIA_EXTENSIONS.has(extension(url))) return false;
  const type = embed.metadata?.content_type?.toLowerCase() ?? "";
  return !type.startsWith("image/") && !type.startsWith("video/") && !type.startsWith("audio/");
}

/**
 * Neynar's text already has each mention, and its range covers it. The network's own text leaves a gap,
 * marked by an empty range at that UTF-8 offset, filled here from the last one back so offsets stay right.
 */
function writingOutMentions(cast: RemoteCast): string {
  const text = cast.text ?? "";
  const profiles = cast.mentioned_profiles ?? [];
  const missing = (cast.mentioned_profiles_ranges ?? [])
    .map((range, index) => ({ range, profile: profiles[index] }))
    .filter(({ range, profile }) => profile && range.start === range.end);
  if (missing.length === 0) return text;
  let bytes = [...new TextEncoder().encode(text)];
  for (const { range, profile } of missing.sort((left, right) => right.range.start - left.range.start)) {
    const handle = usableHandle(profile.username);
    if (!handle || range.start < 0 || range.start > bytes.length) continue;
    bytes = [...bytes.slice(0, range.start), ...new TextEncoder().encode(`@${handle}`), ...bytes.slice(range.start)];
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const isIn = (text: string, link: string) => text.includes(link.replace(/^https?:\/\//i, ""));

/** Keeps only what the app shows. Returns null for a reply, or a cast with nothing to show. */
export function feedCast(cast: RemoteCast): FeedCast | null {
  const time = seconds(cast.timestamp);
  if (cast.parent_hash || time === null) return null;
  const text = writingOutMentions(cast).trim();
  if (byteLength(text) > MAX_CAST_BYTES) return null;
  const embeds = (cast.embeds ?? []).filter((embed) => embed && typeof embed === "object");
  const fits = (link: string) => byteLength(link) <= MAX_LINK_BYTES;
  const links = embeds.filter(isReadableLink).map((embed) => embed.url!).filter((link) => fits(link) && !isIn(text, link)).slice(0, MAX_LINKS);
  const images = embeds.filter(isImage).map((embed) => embed.url!).filter(fits).slice(0, MAX_IMAGES);
  let quote: Quote | undefined;
  const quoted = embeds.find((embed) => embed.cast)?.cast;
  const quotedText = quoted?.text?.trim();
  if (quoted?.author && quotedText && byteLength(quotedText) <= MAX_CAST_BYTES) {
    quote = { fid: quoted.author.fid, handle: usableHandle(quoted.author.username) ?? String(quoted.author.fid), text: quotedText };
  }
  if (!text && links.length === 0 && images.length === 0 && !quote) return null;
  const hash = cast.hash.toLowerCase();
  const kept: FeedCast = { hash: hash.startsWith("0x") ? hash : `0x${hash}`, fid: cast.author.fid, time, text };
  if (links.length > 0) kept.links = links;
  if (quote) kept.quote = quote;
  if (cast.author.pfp_url && fits(cast.author.pfp_url)) kept.avatar = cast.author.pfp_url;
  if (images.length > 0) kept.images = images;
  return kept;
}

/** Skips a row the app can't read instead of failing the page it came in. */
const isRemoteCast = (value: unknown): value is RemoteCast => {
  const cast = value as RemoteCast | null;
  return typeof cast?.hash === "string" && typeof cast.timestamp === "string" && typeof cast.author?.fid === "number";
};

function collect(read: Read, casts: RemoteCast[], follows: Set<number>) {
  for (const cast of casts) {
    if (!follows.has(cast.author.fid)) continue;
    const time = seconds(cast.timestamp);
    if (time !== null) read.latestSeen = Math.max(read.latestSeen, time);
    const handle = usableHandle(cast.author.username);
    if (handle) read.handles[cast.author.fid] = handle;
    let kept: FeedCast | null = null;
    try {
      kept = feedCast(cast);
    } catch {
      // One bad row shouldn't fail the page it came in.
    }
    if (kept) read.casts.push(kept);
  }
}

/** A successful answer without the list it's meant to have is a bad answer, not an empty one. */
function list<T>(value: T[] | undefined): T[] {
  if (!Array.isArray(value)) throw new FeedHTTPError(502);
  return value;
}

const newRead = (): Read => ({ casts: [], handles: {}, latestSeen: 0, complete: true });

/** Reads who an account follows and what they've posted from a server that speaks Neynar's API. */
export class FeedReader {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  private async get<T>(base: string, path: string, query: Record<string, string>): Promise<T> {
    const response = await this.client.raw(base, path, query);
    // A 404 from upstream isn't the app's signal that an account has no follow list yet.
    if (response.status !== 200) throw new FeedHTTPError(response.status === 404 ? 502 : response.status);
    return JSON.parse(response.text) as T;
  }

  private async page(fid: number, limit: number, cursor?: string) {
    const query: Record<string, string> = { fid: String(fid), with_recasts: "false", limit: String(limit) };
    if (cursor) query.cursor = cursor;
    const page = await this.get<{ casts?: unknown[]; next?: { cursor?: string | null } }>(this.client.connection.feedBase, "feed/following/", query);
    return { casts: list(page.casts).filter(isRemoteCast), cursor: page.next?.cursor ?? undefined };
  }

  /** Reads this account's following feed back until it overlaps the last read. */
  async poll(fid: number, since: number, follows: Set<number>): Promise<Read> {
    const read = newRead();
    let cursor: string | undefined;
    for (let index = 0; index < POLL_MAX_PAGES; index++) {
      const page = await this.page(fid, POLL_LIMIT, cursor);
      collect(read, page.casts, follows);
      cursor = page.cursor;
      const oldest = page.casts.length ? seconds(page.casts.at(-1)!.timestamp) : null;
      if (!cursor || oldest === null || oldest <= since - POLL_OVERLAP_SECONDS) break;
    }
    return read;
  }

  /** Reads everything back to `oldestAllowed`. */
  async window(fid: number, oldestAllowed: number, follows: Set<number>): Promise<Read> {
    const read = newRead();
    let cursor: string | undefined;
    for (let index = 0; index < WINDOW_MAX_PAGES; index++) {
      const page = await this.page(fid, WINDOW_LIMIT, cursor);
      collect(read, page.casts, follows);
      cursor = page.cursor;
      const oldest = page.casts.length ? seconds(page.casts.at(-1)!.timestamp) : null;
      if (!cursor || oldest === null || oldest < oldestAllowed) return read;
    }
    read.complete = false;
    return read;
  }

  /** A cast made here carries no picture, and the feed never returns it for an account that doesn't follow itself. */
  async avatar(fid: number): Promise<string | null> {
    const page = await this.get<{ users?: { fid: number; pfp_url?: string }[] }>(this.client.connection.feedBase, "user/bulk/", { fids: String(fid) });
    const link = list(page.users).find((user) => user.fid === fid)?.pfp_url;
    return link && byteLength(link) <= MAX_LINK_BYTES ? link : null;
  }

  /** Everyone this account follows on the network, sorted by FID. A failed read throws. */
  async follows(fid: number): Promise<Person[]> {
    const targets = new Set<number>();
    let token: string | undefined;
    let pages = 0;
    type Links = { messages?: { data?: { type?: string; linkBody?: { type?: string; targetFid?: number } } }[]; nextPageToken?: string };
    do {
      pages++;
      const query: Record<string, string> = { fid: String(fid), link_type: "follow", pageSize: String(LINKS_PAGE_SIZE) };
      if (token) query.pageToken = token;
      const page = await this.get<Links>(this.client.connection.nodeBase, "linksByFid", query);
      for (const message of list(page.messages)) {
        const target = message.data?.linkBody?.targetFid;
        if (message.data?.type === "MESSAGE_TYPE_LINK_ADD" && message.data.linkBody?.type === "follow" && target) targets.add(target);
      }
      const next = page.nextPageToken || undefined;
      token = next === token ? undefined : next;
    } while (token && targets.size < MAX_FOLLOWS && pages < MAX_LINK_PAGES);
    const fids = [...targets].sort((left, right) => left - right).slice(0, MAX_FOLLOWS);
    const names = await this.handles(fids);
    return fids.map((target) => ({ handle: names[target] ?? String(target), fid: target }));
  }

  private async handles(fids: number[]): Promise<Record<number, string>> {
    const calls: number[][] = [];
    for (let index = 0; index < fids.length; index += USERS_PER_CALL) calls.push(fids.slice(index, index + USERS_PER_CALL));
    const names: Record<number, string> = {};
    for (let index = 0; index < calls.length; index += USER_CALLS_AT_ONCE) {
      const pages = await Promise.all(calls.slice(index, index + USER_CALLS_AT_ONCE).map((call) =>
        this.get<{ users?: { fid: number; username?: string }[] }>(this.client.connection.feedBase, "user/bulk/", { fids: call.join(",") })));
      for (const page of pages) {
        for (const user of list(page.users)) {
          const handle = usableHandle(user.username);
          if (handle) names[user.fid] = handle;
        }
      }
    }
    return names;
  }
}
