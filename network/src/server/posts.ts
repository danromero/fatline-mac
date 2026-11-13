import { joinMentions } from "../protocol/text.ts";
import type { Context, Viewer } from "./env.ts";
import { base64url, badRequest, fromBase64url, json, notFound } from "./http.ts";
import { mediaFor, mediaLinks } from "./media.ts";
import { networkOrigin } from "../protocol/approvals.ts";
import { usernames, versionTag } from "./store.ts";

/** Reading posts: the feed, a post with its replies, and activity. */

const PAGE = 50;

interface PostRow {
  hash: string;
  fid: number;
  time: number;
  parent: string | null;
  text: string;
  mentions: string;
  embeds: string;
  message: string | null;
  deleted: number | null;
  replies: number;
  likes: number;
  liked: number;
}

type StoredEmbed = { kind: "link"; url: string } | { kind: "image"; id: string; url: string } | { kind: "post"; fid: number; hash: string };

// Counts are kept on each post (see schema.ts), so reading one doesn't read its replies and likes.
const SELECT_POSTS = `SELECT p.hash, p.fid, p.time, p.parent, p.text, p.mentions, p.embeds, p.message, p.deleted,
  p.reply_count AS replies, p.like_count AS likes,
  EXISTS (SELECT 1 FROM likes l WHERE l.post = p.hash AND l.fid = ?1) AS liked
  FROM posts p`;

const NOT_MUTED = "p.fid NOT IN (SELECT muted FROM mutes WHERE fid = ?1)";

/**
 * Posts whose hash is in `?2`, a JSON array. D1 takes at most 100 values in a statement, so a list
 * is one value however long it gets.
 */
const HASH_IN_LIST = "p.hash IN (SELECT value FROM json_each(?2))";

async function selectPosts(context: Context, viewer: Viewer, rest: string, params: unknown[]) {
  const rows = await context.db.prepare(`${SELECT_POSTS} ${rest}`).bind(viewer.fid, ...params).all<PostRow>();
  return rows.results;
}

/** Turns rows into Posts, with quoted posts filled in. */
async function postsJSON(context: Context, viewer: Viewer, rows: PostRow[], options: { nested?: boolean } = {}) {
  const names = await usernames(context);
  const quoted = new Map<string, unknown>();
  if (!options.nested) {
    const hashes = [...new Set(rows.flatMap((row) => (JSON.parse(row.embeds) as StoredEmbed[]).flatMap((embed) => (embed.kind === "post" ? [embed.hash] : []))))];
    if (hashes.length > 0) {
      const quotedRows = await selectPosts(context, viewer, `WHERE p.deleted IS NULL AND ${HASH_IN_LIST}`, [JSON.stringify(hashes)]);
      const built = await postsJSON(context, viewer, quotedRows, { nested: true });
      quotedRows.forEach((row, index) => quoted.set(row.hash, built[index]));
    }
  }

  const stored = options.nested ? [] : rows.flatMap((row) => (row.deleted === null ? (JSON.parse(row.embeds) as StoredEmbed[]) : []));
  const { images, previews, own } = await mediaFor(
    context,
    stored.flatMap((embed) => (embed.kind === "image" ? [embed.id] : [])),
    stored.flatMap((embed) => (embed.kind === "link" ? [embed.url] : [])),
    options.nested ? [] : rows.flatMap((row) => (row.deleted === null && row.embeds.includes('"link"') ? [row.hash] : [])),
  );
  const links = await mediaLinks(context);

  return rows.map((row) => {
    const base = { hash: row.hash, fid: row.fid, time: row.time, parent: row.parent, replies: row.replies };
    if (row.deleted !== null) return { ...base, text: "", mentions: [], embeds: [], likes: 0, liked: false, deleted: true };
    const mentions = JSON.parse(row.mentions) as { fid: number; position: number }[];
    const embeds = options.nested ? [] : (JSON.parse(row.embeds) as StoredEmbed[]).flatMap((embed): Record<string, unknown>[] => {
      if (embed.kind === "post") return [{ type: "post", hash: embed.hash, post: quoted.get(embed.hash) ?? null }];
      if (embed.kind === "image") {
        const image = images.get(embed.id);
        return image
          ? [{ type: "image", url: embed.url, width: image.width, height: image.height, src: links.link(embed.id, "display"), full: links.link(embed.id, "original") }]
          : [];
      }
      // The author's own preview first, then the one the server read.
      const found = own.get(`${row.hash} ${embed.url}`) ?? previews.get(embed.url);
      const preview = found && (found.title || found.description || found.image)
        ? {
            ...(found.title ? { title: found.title } : {}),
            ...(found.description ? { description: found.description } : {}),
            ...(found.image ? { image: links.link(found.image, "display") } : {}),
          }
        : null;
      return [{ type: "link", url: embed.url, preview }];
    });
    return {
      ...base,
      text: joinMentions({ text: row.text, fids: mentions.map((mention) => mention.fid), positions: mentions.map((mention) => mention.position) }, names),
      mentions: [...new Set(mentions.map((mention) => mention.fid))].map((fid) => ({ fid, username: names.get(fid) ?? `!${fid}` })),
      embeds,
      likes: row.likes,
      liked: row.liked === 1,
      deleted: false,
      message: row.message!,
    };
  });
}

function cursorFor(row: { time: number; hash: string }) {
  return base64url(new TextEncoder().encode(`${row.time}:${row.hash}`));
}

function readCursor(text: string | null): { time: number; hash: string } | null {
  if (!text) return null;
  const decoded = fromBase64url(text);
  const match = decoded && /^(\d{1,12}):(0x[0-9a-f]{40})$/.exec(new TextDecoder().decode(decoded));
  if (!match) throw badRequest("That cursor isn't valid.");
  return { time: Number(match[1]), hash: match[2]! };
}

/** GET /feed. Deleted posts stay out of the feed, even with replies. */
export async function feed(context: Context, viewer: Viewer, request: Request) {
  const cursorText = new URL(request.url).searchParams.get("cursor");
  const cursor = readCursor(cursorText);
  // Nothing changed since the device last read this page: one row read, not the whole feed.
  const tag = await versionTag(context, viewer.fid, `feed/${cursorText ?? ""}`);
  if (request.headers.get("if-none-match") === tag) return notModified(tag);
  return cachedRead(context, tag, async () => {
    const rows = await selectPosts(
      context,
      viewer,
      `WHERE p.parent IS NULL AND p.deleted IS NULL AND ${NOT_MUTED}
        ${cursor ? "AND (p.time < ?2 OR (p.time = ?2 AND p.hash < ?3))" : ""}
        ORDER BY p.time DESC, p.hash DESC LIMIT ${PAGE + 1}`,
      cursor ? [cursor.time, cursor.hash] : [],
    );
    const page = rows.slice(0, PAGE);
    return { posts: await postsJSON(context, viewer, page), next: rows.length > PAGE ? cursorFor(page.at(-1)!) : null };
  });
}

const notModified = (tag: string) => new Response(null, { status: 304, headers: { etag: tag, "cache-control": "no-store" } });

/** GET /posts/{hash}. */
/**
 * Replies come this many to a page, newest page first, oldest first within it, so an app that reads
 * one page shows the latest replies, as people expect. `next` goes back to older ones.
 */
const REPLIES_PAGE = 200;

export async function thread(context: Context, viewer: Viewer, hash: string, request: Request) {
  const cursorText = new URL(request.url).searchParams.get("cursor");
  const cursor = readCursor(cursorText);
  const tag = await versionTag(context, viewer.fid, `thread/${hash}/${cursorText ?? ""}`);
  if (request.headers.get("if-none-match") === tag) return notModified(tag);
  return cachedRead(context, tag, async () => {
    const [row] = await selectPosts(context, viewer, "WHERE p.hash = ?2", [hash]);
    if (!row) throw notFound("That post isn't here.");
    const replies = row.parent === null
      ? await selectPosts(
        context,
        viewer,
        `WHERE p.parent = ?2 AND ${NOT_MUTED} ${cursor ? "AND (p.time < ?3 OR (p.time = ?3 AND p.hash < ?4))" : ""}
          ORDER BY p.time DESC, p.hash DESC LIMIT ${REPLIES_PAGE + 1}`,
        [hash, ...(cursor ? [cursor.time, cursor.hash] : [])],
      )
      : [];
    const page = replies.slice(0, REPLIES_PAGE);
    const next = replies.length > REPLIES_PAGE ? cursorFor(page.at(-1)!) : null;
    const [post, ...rest] = await postsJSON(context, viewer, [row, ...page.reverse()]);
    return { post, replies: rest, next };
  });
}

/**
 * An answer built once per version and kept in Cloudflare's cache under its tag, so a device that
 * polls without If-None-Match also costs a row while nothing has changed. The tag names the viewer,
 * and nothing serves the cache's addresses, so no one gets another member's answer.
 */
async function cachedRead(context: Context, tag: string, build: () => Promise<unknown>): Promise<Response> {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  const key = new Request(`${networkOrigin(context.host)}/__answers/${tag.replaceAll('"', "")}`);
  const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", etag: tag };
  const kept = await cache?.match(key);
  if (kept) return new Response(kept.body, { headers });
  const text = JSON.stringify(await build());
  if (cache) context.waitUntil(cache.put(key, new Response(text, { headers: { "content-type": "application/json", "cache-control": "max-age=3600" } })));
  return new Response(text, { headers });
}

/** GET /activity: replies to your posts and mentions of you, newest first. */
export async function activity(context: Context, viewer: Viewer, request: Request) {
  const cursorText = new URL(request.url).searchParams.get("cursor");
  const cursor = readCursor(cursorText);
  const tag = await versionTag(context, viewer.fid, `activity/${cursorText ?? ""}`);
  if (request.headers.get("if-none-match") === tag) return notModified(tag);
  return cachedRead(context, tag, async () => {
    // Replies to you and mentions of you, each read newest first by its own index and stopped at a page,
    // then merged in the order a single list would have.
    const params = [viewer.fid, ...(cursor ? [cursor.time, cursor.hash] : [])];
    const replies = await context.db
      .prepare(`SELECT 'reply' AS kind, hash, time FROM posts WHERE parent_fid = ?1 AND fid != ?1 AND deleted IS NULL
          AND fid NOT IN (SELECT muted FROM mutes WHERE fid = ?1) ${cursor ? "AND (time < ?2 OR (time = ?2 AND hash < ?3))" : ""}
        ORDER BY time DESC, hash DESC LIMIT ${PAGE + 1}`)
      .bind(...params)
      .all<{ kind: "reply" | "mention"; hash: string; time: number }>();
    const mentions = await context.db
      .prepare(`SELECT 'mention' AS kind, post AS hash, time FROM mentions WHERE fid = ?1
          AND author NOT IN (SELECT muted FROM mutes WHERE fid = ?1) ${cursor ? "AND (time < ?2 OR (time = ?2 AND post < ?3))" : ""}
        ORDER BY time DESC, post DESC LIMIT ${PAGE + 1}`)
      .bind(...params)
      .all<{ kind: "reply" | "mention"; hash: string; time: number }>();
    const newest = (a: { kind: string; hash: string; time: number }, b: { kind: string; hash: string; time: number }) =>
      b.time - a.time || (b.hash > a.hash ? 1 : b.hash < a.hash ? -1 : 0) || (b.kind > a.kind ? 1 : b.kind < a.kind ? -1 : 0);
    const items = { results: [...replies.results, ...mentions.results].sort(newest).slice(0, PAGE + 1) };
    const page = items.results.slice(0, PAGE);
    // A reply that also mentions you shows once, as a reply.
    const seen = new Set<string>();
    const unique = page.filter((item) => !seen.has(item.hash) && seen.add(item.hash));
    const hashes = unique.map((item) => item.hash);
    const rows = hashes.length
      ? await selectPosts(context, viewer, `WHERE ${HASH_IN_LIST}`, [JSON.stringify(hashes)])
      : [];
    const posts = await postsJSON(context, viewer, rows);
    const byHash = new Map(rows.map((row, index) => [row.hash, posts[index]]));
    // A reply comes with the post it answers, without that post's own embeds, so an app can quote it.
    const parentHashes = [...new Set(rows.flatMap((row) => (row.parent ? [row.parent] : [])))];
    const parentRows = parentHashes.length
      ? await selectPosts(context, viewer, `WHERE ${HASH_IN_LIST}`, [JSON.stringify(parentHashes)])
      : [];
    const parentPosts = await postsJSON(context, viewer, parentRows, { nested: true });
    const parents = new Map(parentRows.map((row, index) => [row.hash, parentPosts[index]]));
    const parentOf = new Map(rows.map((row) => [row.hash, row.parent ? (parents.get(row.parent) ?? null) : null]));
    return {
      items: unique.flatMap((item) =>
        byHash.has(item.hash) ? [{ kind: item.kind, post: byHash.get(item.hash), parent: parentOf.get(item.hash) ?? null }] : [],
      ),
      next: items.results.length > PAGE ? cursorFor(page.at(-1)!) : null,
    };
  });
}
