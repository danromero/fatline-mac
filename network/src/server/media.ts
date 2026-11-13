import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { imageURL } from "../protocol/messages.ts";
import { MAX_EMBEDS, MAX_URL_BYTES } from "../protocol/text.ts";
import { networkOrigin } from "../protocol/approvals.ts";
import type { Context, Viewer } from "./env.ts";
import { base64url, badRequest, field, HttpError, json, noContent, notFound, problem, readBytes, readJSON, TEXT } from "./http.ts";
import { isPublicHost } from "./hosts.ts";
import { concat, sizeProblem, sniff, stripMetadata } from "./imagebytes.ts";
import type { ImageType } from "./imagebytes.ts";
import { checkDaily, countDaily, DAILY, hasDaily } from "./daily.ts";
import { meter } from "./meter.ts";
import { parsePreview } from "./preview.ts";

/**
 * Images: uploads, the sizes made from them, the signed links that serve them, and the pictures the
 * server copies in itself, avatars and link previews. See docs/NETWORK.md.
 *
 * R2 holds each image under its ID: `<id>/original`, and `<id>/display.<format>` and
 * `<id>/thumb.<format>` once a device first asks for them. D1's `media` table says whose it is.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Pictures the server fetches itself are smaller: avatars and preview images. */
const MAX_FETCHED_BYTES = 5 * 1024 * 1024;
/** A link preview's picture is shown small, so it's smaller still. */
const MAX_PREVIEW_PICTURE_BYTES = 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const FETCH_TIMEOUT = 5000;
/** Links last at least an hour. They're the same for an hour at a time, so answers stay cacheable. */
const LINK_HOUR = 3600;
/** An image nothing ever used is deleted after a day. */
const UNUSED_UPLOAD = 24 * 3600;
/** A preview is fetched again after a week. */
const PREVIEW_AGE = 7 * 24 * 3600;

export type Size = "display" | "thumb" | "original";

const RESIZE_TIMEOUT_MS = 5_000;
const SIZES: Record<Exclude<Size, "original">, ImageTransform> = {
  display: { width: 1280, fit: "scale-down" },
  thumb: { width: 192, height: 192, fit: "cover" },
};

export const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;

function newID() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Checks an image and keeps it. Throws a 400 for anything that isn't a JPEG, PNG, or GIF within the limits. */
async function store(context: Context, raw: Uint8Array, fid: number | null, kind: "upload" | "avatar" | "preview", expected?: ImageType) {
  const info = sniff(raw);
  if (!info) throw badRequest("That isn't a JPEG, PNG, or GIF.");
  if (expected && info.type !== expected) throw badRequest("That image isn't the type it was sent as.");
  if (info.width < 1 || info.height < 1) throw badRequest("That image has no pixels.");
  const tooBig = sizeProblem(raw, info);
  if (tooBig) throw problem(tooBig);
  const bytes = stripMetadata(raw, info.type);
  const id = newID();
  await bucket(context).put(`${id}/original`, bytes, { httpMetadata: { contentType: info.type } });
  await context.db
    .prepare("INSERT INTO media (id, fid, kind, type, width, height, bytes, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, fid, kind, info.type, info.width, info.height, bytes.length, context.now)
    .run();
  return { id, ...info };
}

function bucket(context: Context): R2Bucket {
  if (!context.env.MEDIA) throw new HttpError(503, "This network can't store images.");
  return context.env.MEDIA;
}

/** POST /media. */
export async function upload(context: Context, viewer: Viewer, request: Request) {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/gif") throw badRequest("Send a JPEG, PNG, or GIF.");
  await checkDaily(context, viewer.fid, "uploads", `That's ${DAILY.uploads} pictures in a day. Try again tomorrow.`);
  const raw = await readBytes(request, MAX_UPLOAD_BYTES);
  const image = await store(context, raw, viewer.fid, "upload", type);
  await countDaily(context, viewer.fid, "uploads").run();
  return json({ id: image.id, url: imageURL(context.host, image.id), width: image.width, height: image.height });
}

// MARK: Signed links

/**
 * Makes the links answers carry. Load it once per request. A thread can carry thousands of links, so
 * the key's HMAC setup is done once and copied for each, about three times faster than starting over,
 * and a link asked for again is the one already made.
 */
export async function mediaLinks(context: Context) {
  const secret = await linkSecret(context);
  const expires = (Math.floor(context.now / LINK_HOUR) + 2) * LINK_HOUR;
  const origin = networkOrigin(context.host);
  const keyed = hmac.create(sha256, secret);
  const made = new Map<string, string>();
  return {
    link(id: string, size: Size) {
      const path = `${id}/${size}`;
      let link = made.get(path);
      if (link === undefined) {
        const signed = base64url(keyed.clone().update(new TextEncoder().encode(`${path}/${expires}`)).digest());
        link = `${origin}/media/${path}?e=${expires}&s=${signed}`;
        made.set(path, link);
      }
      return link;
    },
  };
}

export type MediaLinks = Awaited<ReturnType<typeof mediaLinks>>;

function signature(secret: Uint8Array, id: string, size: string, expires: number) {
  return base64url(hmac(sha256, secret, new TextEncoder().encode(`${id}/${size}/${expires}`)));
}

/** The deploy's `MEDIA_SECRET`, or one the network makes for itself the first time it needs one. */
async function linkSecret(context: Context): Promise<Uint8Array> {
  const configured = context.env.MEDIA_SECRET?.trim();
  if (configured) return new TextEncoder().encode(configured);
  const read = () => context.db.prepare("SELECT value FROM settings WHERE key = 'media_secret'").first<{ value: string }>();
  let row = await read();
  if (!row) {
    const made = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await context.db.prepare("INSERT INTO settings (key, value) VALUES ('media_secret', ?) ON CONFLICT (key) DO NOTHING").bind(made).run();
    row = await read();
  }
  return new TextEncoder().encode(row!.value);
}

/** GET /media/{id}/{size}?e=&s=. Anyone with a link that hasn't expired can load it. */
export async function serve(context: Context, request: Request, id: string, size: Size) {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("e"));
  const given = url.searchParams.get("s") ?? "";
  const secret = await linkSecret(context);
  if (!Number.isSafeInteger(expires) || expires < context.now || !timingSafeEqual(given, signature(secret, id, size, expires))) {
    throw new HttpError(403, "That image link has expired.");
  }
  const row = await context.db.prepare("SELECT type FROM media WHERE id = ?").bind(id).first<{ type: ImageType }>();
  if (!row) throw notFound("That image isn't here.");
  const images = bucket(context);

  // GIFs keep their animation, so every size is the file itself.
  if (size !== "original" && row.type !== "image/gif") {
    const format = preferredFormat(request.headers.get("accept") ?? "", row.type);
    const key = `${id}/${size}.${format.split("/")[1]}`;
    const kept = await images.get(key);
    if (kept) return imageResponse(kept.body, format);
    const made = await resize(context, images, id, size, format);
    if (made) {
      await images.put(key, made, { httpMetadata: { contentType: format } });
      return imageResponse(made, format);
    }
  }
  const original = await images.get(`${id}/original`);
  if (!original) throw notFound("That image isn't here.");
  return imageResponse(original.body, row.type);
}

/** AVIF or WebP when the device takes them. Otherwise JPEG, or PNG for a PNG, which may be transparent. */
function preferredFormat(accept: string, type: ImageType): "image/avif" | "image/webp" | "image/jpeg" | "image/png" {
  if (accept.includes("image/avif")) return "image/avif";
  if (accept.includes("image/webp")) return "image/webp";
  return type === "image/png" ? "image/png" : "image/jpeg";
}

/**
 * A smaller size from the Images binding, or null when there's no binding or it refuses, as it does
 * past the free plan's monthly resizes. Then the original is served, which apps have already shrunk.
 */
async function resize(context: Context, images: R2Bucket, id: string, size: Exclude<Size, "original">, format: string) {
  if (!context.env.IMAGES) return null;
  const original = await images.get(`${id}/original`);
  if (!original) return null;
  try {
    // A resize that stalls gives up, so the picture still loads at its original size.
    const resized = (async () => {
      const result = await context.env.IMAGES!.input(original.body)
        .transform(SIZES[size])
        .output({ format: format as ImageOutputOptions["format"], quality: 82 });
      return new Uint8Array(await new Response(result.image()).arrayBuffer());
    })();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), RESIZE_TIMEOUT_MS));
    return await Promise.race([resized, timeout]);
  } catch (error) {
    console.error("resize failed", id, size, String(error));
    return null;
  }
}

function imageResponse(body: ReadableStream | Uint8Array, type: string) {
  return new Response(body, {
    headers: {
      "content-type": type,
      // Each ID and size always holds the same picture.
      "cache-control": "private, max-age=86400, immutable",
      vary: "accept",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

// MARK: Fetching from elsewhere

/**
 * Fetches a link for the server itself: HTTPS only, public hosts only, at most three redirects, a short
 * timeout, and no more than `maxBytes`.
 */
async function safeFetch(context: Context, link: string, accept: string, maxBytes: number) {
  let url = new URL(link);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" || !isPublicHost(url.hostname) || url.host === context.host) return null;
    // A local test network sends every fetch to its stand-in, keeping the path, so tests never reach the internet.
    const testOrigin = context.env.TEST_FETCH_ORIGIN;
    const target = testOrigin ? new URL(url.pathname + url.search, testOrigin) : url;
    const response = await fetch(target.toString(), {
      redirect: "manual",
      headers: { accept, "user-agent": "FatlineNetwork/1 (link previews)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }).catch(() => null);
    if (!response) return null;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      // A Location that isn't a URL means no preview, never a throw that skips the rest.
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      continue;
    }
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return null;
    const bytes = await readLimited(response.body, maxBytes);
    return bytes && { bytes, type: response.headers.get("content-type") ?? "", url };
  }
  return null;
}

async function readLimited(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return concat(parts);
}

/** Copies a picture from elsewhere into this network. Null if it can't be fetched or isn't an image. */
async function copyImage(context: Context, link: string, fid: number | null, kind: "avatar" | "preview") {
  try {
    const limit = kind === "preview" ? MAX_PREVIEW_PICTURE_BYTES : MAX_FETCHED_BYTES;
    const fetched = await safeFetch(context, link, "image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.8", limit);
    if (!fetched) return null;
    return (await store(context, fetched.bytes, fid, kind)).id;
  } catch {
    return null;
  }
}

/** Copies a member's Farcaster picture, so other members' devices never load it from outside. */
export async function copyAvatar(context: Context, fid: number, link: string) {
  const id = await copyImage(context, link, fid, "avatar");
  if (!id) return;
  await context.db.prepare("UPDATE members SET farcaster_media = ? WHERE fid = ?").bind(id, fid).run();
  // The copy it replaced. One for a member who left meanwhile goes in a day.
  await collect(context);
}

/**
 * Reads each link's page for its title, description, and picture, unless it was read this week. Each
 * new link copies its picture, so the picture counts against the poster's pictures for the day; past
 * that, the preview keeps its words and has no picture.
 */
export async function fetchPreviews(given: Context, links: string[], poster: number) {
  // This runs after the answer, so the poster is charged for its rows here.
  const usage = { read: 0, written: 0 };
  const context: Context = { ...given, db: meter(given.db, usage) };
  try {
    await readPreviews(context, links, poster);
  } finally {
    await countDaily(given, poster, "writes", usage.written).run();
  }
}

async function readPreviews(context: Context, links: string[], poster: number) {
  for (const link of links) {
    // One link that fails leaves the others, and the cleanup below, to run.
    try {
      const kept = await context.db.prepare("SELECT fetched FROM link_previews WHERE url = ?").bind(link).first<{ fetched: number }>();
      if (kept && kept.fetched > context.now - PREVIEW_AGE) continue;
      const page = await safeFetch(context, link, "text/html", MAX_PAGE_BYTES);
      const preview = page && page.type.includes("html") ? parsePreview(new TextDecoder().decode(page.bytes), page.url) : null;
      let image: string | null = null;
      if (preview?.image && (await hasDaily(context, poster, "uploads"))) {
        image = await copyImage(context, preview.image, null, "preview");
        if (image) await countDaily(context, poster, "uploads").run();
      }
      // Only while a post still has the link: a preview goes with the last one (migrations.ts). And
      // only over a stale one: two posts of one new link at once each read it, and the first stays.
      await context.db
        .prepare(`INSERT INTO link_previews (url, title, description, image, fetched)
          SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM post_links WHERE url = ?1)
          ON CONFLICT (url) DO UPDATE SET title = excluded.title, description = excluded.description, image = excluded.image, fetched = excluded.fetched
          WHERE link_previews.fetched <= ?6`)
        .bind(link, preview?.title ?? null, preview?.description ?? null, image, context.now, context.now - PREVIEW_AGE)
        .run();
    } catch (error) {
      console.error("preview failed", String(error));
    }
  }
  // Pictures of previews fetched again. One for a post that went meanwhile goes in a day.
  await collect(context);
}

/**
 * PUT /posts/{hash}/previews: `{ previews: [{ url, title?, description?, image? }] }`. The author's app
 * read its links' pages and sends what it found, with any picture uploaded first, so the server fetches
 * nothing. Only the post's author, only for its own links, and each replaces that link's last.
 */
export async function setPreviews(context: Context, viewer: Viewer, hash: string, request: Request) {
  const list = (await readJSON(request)).previews;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_EMBEDS) throw badRequest(`previews should be a list of 1 to ${MAX_EMBEDS}.`);
  const post = await context.db.prepare("SELECT fid, deleted FROM posts WHERE hash = ?").bind(hash).first<{ fid: number; deleted: number | null }>();
  if (!post || post.deleted !== null) throw problem("no-post");
  if (post.fid !== viewer.fid) throw new HttpError(403, "Only a post's author can send its previews.");
  const links = new Set((await context.db.prepare("SELECT url FROM post_links WHERE post = ?").bind(hash).all<{ url: string }>()).results.map((row) => row.url));
  const statements = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw badRequest("Each preview should be an object.");
    const entry = item as Record<string, unknown>;
    const url = field.optionalString(entry, "url", MAX_URL_BYTES);
    if (url === undefined || !links.has(url)) throw badRequest("A preview is for one of the post's own links.");
    const image = field.optionalString(entry, "image", 100) ?? null;
    if (image !== null && !(await ownUpload(context, viewer.fid, image))) throw badRequest("That image isn't on this network.");
    statements.push(
      context.db.prepare("UPDATE post_links SET title = ?, description = ?, image = ? WHERE post = ? AND url = ?").bind(
        field.text(entry, "title", TEXT.previewTitle) ?? null, field.text(entry, "description", TEXT.previewDescription) ?? null, image, hash, url,
      ),
    );
  }
  await context.db.batch(statements);
  // A picture an earlier preview had.
  await collect(context);
  return noContent();
}

// MARK: Cleanup

/**
 * Deletes images nothing uses: at once when something used one, and a day after it came when nothing
 * ever did, such as an upload never posted or a preview's picture that lost a race. With `fid`, also
 * every image of theirs nothing uses, for someone leaving or removed. Triggers keep each image's count
 * of uses on every path (migrations.ts), so this reads only unused images, by index. 200 a call, and the
 * hourly job takes the rest.
 */
export async function collect(context: Context, fid?: number) {
  const rows = await context.db
    .prepare(`SELECT id FROM media WHERE uses = 0 AND attached = 1
      UNION SELECT id FROM media WHERE uses = 0 AND attached = 0 AND created < ?1
      UNION SELECT id FROM media WHERE fid = ?2 AND uses = 0 LIMIT 200`)
    .bind(context.now - UNUSED_UPLOAD, fid ?? null)
    .all<{ id: string }>();
  if (rows.results.length) await deleteImages(context, rows.results.map((row) => row.id));
}

/** Every key an image can have in R2: the original, and each size in each format it's served as. */
function keysOf(id: string) {
  return [`${id}/original`, ...["display", "thumb"].flatMap((size) => ["avif", "webp", "jpeg", "png"].map((format) => `${id}/${size}.${format}`))];
}

/**
 * Deletes images from R2 and D1. R2 takes up to 1,000 keys a call and doesn't mind keys that aren't
 * there, so this needs no listing. D1 gets the IDs as one JSON array, since it takes at most 100
 * values in a statement.
 */
async function deleteImages(context: Context, ids: string[]) {
  const keys = ids.flatMap(keysOf);
  if (context.env.MEDIA) for (let at = 0; at < keys.length; at += 1000) await context.env.MEDIA.delete(keys.slice(at, at + 1000));
  await context.db.prepare("DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).run();
}

/** Whether `id` is a picture `fid` uploaded to this network. */
export async function ownUpload(context: Context, fid: number, id: string) {
  return MEDIA_ID.test(id) && Boolean(await context.db.prepare("SELECT 1 FROM media WHERE id = ? AND fid = ? AND kind = 'upload'").bind(id, fid).first());
}

type Preview = { title: string | null; description: string | null; image: string | null };

/**
 * Rows for the images and previews in a set of posts, for building answers. A post's own preview of a
 * link, sent by its author's app, is keyed by post and link; one the server read is keyed by link.
 */
export async function mediaFor(context: Context, ids: string[], links: string[], posts: string[] = []) {
  const images = new Map<string, { width: number; height: number }>();
  const previews = new Map<string, Preview>();
  const own = new Map<string, Preview>();
  if (posts.length) {
    const rows = await context.db
      .prepare(`SELECT post, url, title, description, image FROM post_links WHERE post IN (SELECT value FROM json_each(?))
        AND (title IS NOT NULL OR description IS NOT NULL OR image IS NOT NULL)`)
      .bind(JSON.stringify(posts)).all<Preview & { post: string; url: string }>();
    for (const row of rows.results) own.set(`${row.post} ${row.url}`, row);
  }
  if (ids.length) {
    // One JSON array, since D1 takes at most 100 values in a statement.
    const rows = await context.db.prepare("SELECT id, width, height FROM media WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids)).all<{ id: string; width: number; height: number }>();
    for (const row of rows.results) images.set(row.id, row);
  }
  if (links.length) {
    const rows = await context.db.prepare("SELECT url, title, description, image FROM link_previews WHERE url IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(links)).all<{ url: string; title: string | null; description: string | null; image: string | null }>();
    for (const row of rows.results) previews.set(row.url, row);
  }
  return { images, previews, own };
}
