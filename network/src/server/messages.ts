import { blake3 } from "@noble/hashes/blake3.js";
import { toHex } from "../protocol/protobuf.ts";
import {
  byteLength, characterCount, hasStrayMarks, hidesText, joinMentions, MAX_CHARACTERS, MAX_EMBEDS, MAX_MENTIONS, MAX_TEXT_BYTES, MAX_URL_BYTES, reversesText,
} from "../protocol/text.ts";
import { deletionStatements } from "./deletion.ts";
import { collect, fetchPreviews } from "./media.ts";
import type { Context, Viewer } from "./env.ts";
import { badRequest, base64, HttpError, json, notFound, readBytes, refused } from "./http.ts";
import { usernames } from "./store.ts";
import { checkDaily, countDaily } from "./daily.ts";
import { allBytesOf, bytesOf, integerOf, Malformed, onlyFields, packed, readFields, safeNumber, sameBytes, utf8 } from "./wire.ts";

const MAX_MESSAGE_BYTES = 4096;
const FARCASTER_EPOCH = 1_609_459_200;
const OLDEST = 24 * 60 * 60;
const NEWEST = 10 * 60;
const LIKE = 1n;

const TYPE = { castAdd: 1n, castRemove: 2n, reactionAdd: 3n, reactionRemove: 4n } as const;
const BODY_FIELD = { 1: 5, 2: 6, 3: 7, 4: 7 } as const;

interface Checked {
  type: bigint;
  fid: number;
  time: number;
  hash: string;
  signer: string;
  body: Uint8Array;
  bytes: Uint8Array;
}

/** Checks a message's form, hash, and signature, as docs/NETWORK.md describes. */
async function check(bytes: Uint8Array): Promise<Checked> {
  const message = readFields(bytes);
  onlyFields(message, [1, 2, 3, 4, 5, 6, 7]);
  const data = bytesOf(message, 1);
  const dataBytes = bytesOf(message, 7);
  const signed = dataBytes ?? data;
  if (!signed || (data && dataBytes && !sameBytes(data, dataBytes))) throw new Malformed("data and data_bytes differ");

  const hash = bytesOf(message, 2);
  const signature = bytesOf(message, 4);
  const signer = bytesOf(message, 6);
  if (integerOf(message, 3) !== 1n || integerOf(message, 5) !== 1n) throw new Malformed("Unknown hash or signature scheme");
  if (hash?.length !== 20 || signature?.length !== 64 || signer?.length !== 32) throw new Malformed("Bad hash, signature, or signer");
  if (!sameBytes(blake3(signed, { dkLen: 20 }), hash)) throw new HttpError(400, "The hash doesn't match the message.");
  const key = await crypto.subtle.importKey("raw", signer.slice(), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signature.slice(), hash.slice()))) {
    throw new HttpError(400, "The signature doesn't check out.");
  }

  const fields = readFields(signed);
  // No network field: a network message must be one no Farcaster node accepts.
  const type = integerOf(fields, 1);
  if (type === undefined || !(Number(type) in BODY_FIELD)) throw new HttpError(400, "This network doesn't take that kind of message.");
  const bodyField = BODY_FIELD[Number(type) as keyof typeof BODY_FIELD];
  onlyFields(fields, [1, 2, 3, bodyField]);
  const timestamp = integerOf(fields, 3);
  if (timestamp === undefined || timestamp > 0xffffffffn) throw new Malformed("Bad timestamp");
  return {
    type,
    fid: safeNumber(integerOf(fields, 2), "FID"),
    time: Number(timestamp) + FARCASTER_EPOCH,
    hash: toHex(hash),
    signer: toHex(signer),
    body: bytesOf(fields, bodyField) ?? new Uint8Array(),
    bytes,
  };
}

interface CastRef {
  fid: number;
  hash: string;
}

function castId(bytes: Uint8Array): CastRef {
  const fields = readFields(bytes);
  onlyFields(fields, [1, 2]);
  const hash = bytesOf(fields, 2);
  if (hash?.length !== 20) throw new Malformed("A post's hash is 20 bytes");
  return { fid: safeNumber(integerOf(fields, 1), "FID"), hash: toHex(hash) };
}

/**
 * The message's key is still live and its sender still a member, checked in the statement that writes
 * it, with the sender's FID as `?2` and the key as `?10`. A post or like checked before the admin
 * removed someone, and written after, would otherwise stay with no member to delete it.
 */
const STILL_SIGNING = "EXISTS (SELECT 1 FROM network_keys WHERE key = ?10 AND fid = ?2 AND revoked IS NULL) AND EXISTS (SELECT 1 FROM members WHERE fid = ?2)";

type StoredEmbed = { kind: "link"; url: string } | { kind: "image"; id: string; url: string } | { kind: "post"; fid: number; hash: string };

/** POST /messages. */
export async function submit(context: Context, viewer: Viewer, request: Request) {
  const bytes = await readBytes(request, MAX_MESSAGE_BYTES);
  let message: Checked;
  try {
    message = await check(bytes);
  } catch (error) {
    if (error instanceof Malformed) throw badRequest(`That message isn't one this network takes: ${error.message}.`);
    throw error;
  }
  if (message.fid !== viewer.fid) throw new HttpError(403, "You can only send messages for your own account.");
  const signer = await context.db
    .prepare("SELECT 1 FROM network_keys WHERE key = ? AND fid = ? AND revoked IS NULL")
    .bind(message.signer, message.fid)
    .first();
  if (!signer) throw new HttpError(400, "That message wasn't signed by one of your keys on this network.");
  if (message.time < context.now - OLDEST || message.time > context.now + NEWEST) {
    throw badRequest("That message's time is too far from now. Check your device's clock.");
  }
  // Deleting never counts against the day's changes, so someone can always take down what a stolen device posted.
  const counted = message.type !== TYPE.castRemove;
  if (counted) await checkDaily(context, message.fid, "writes", "That's a lot of changes for one day. Try again tomorrow.");

  let changed: boolean;
  try {
    // An app that reads its links' pages itself says so, and the server fetches nothing for it.
    if (message.type === TYPE.castAdd) changed = await addPost(context, message, request.headers.get("fatline-previews") !== "app");
    else if (message.type === TYPE.castRemove) changed = await removePost(context, message);
    else changed = await react(context, message, message.type === TYPE.reactionAdd);
  } catch (error) {
    if (error instanceof Malformed) throw badRequest(`That message isn't one this network takes: ${error.message}.`);
    throw error;
  }
  // A delete that deleted nothing, a message sent again, counts after all, so replaying one can't write without end.
  if (!counted && !changed) await checkDaily(context, message.fid, "writes", "That's a lot of changes for one day. Try again tomorrow.");
  if (counted || !changed) await countDaily(context, message.fid, "writes", context.usage?.written ?? 1).run();
  return json({ hash: message.hash });
}

/** Each handler answers whether it changed anything, so a message sent again costs no version bump. */
async function addPost(context: Context, message: Checked, readLinks: boolean): Promise<boolean> {
  const fields = readFields(message.body);
  onlyFields(fields, [2, 3, 4, 5, 6]);
  const textBytes = bytesOf(fields, 4) ?? new Uint8Array();
  const text = utf8(textBytes);
  const mentioned = packed(bytesOf(fields, 2) ?? new Uint8Array()).map((value) => safeNumber(value, "mention"));
  const positions = packed(bytesOf(fields, 5) ?? new Uint8Array()).map(Number);
  const parentBytes = bytesOf(fields, 3);
  const parent = parentBytes ? castId(parentBytes) : null;
  const embedFields = allBytesOf(fields, 6);

  // A deleted post's hash is kept in removed, even while a placeholder with its hash stays for its replies.
  if (await context.db.prepare("SELECT 1 FROM removed WHERE hash = ?").bind(message.hash).first()) throw badRequest("That post was deleted.");
  if (await context.db.prepare("SELECT 1 FROM posts WHERE hash = ?").bind(message.hash).first()) return false;

  if (textBytes.length > MAX_TEXT_BYTES) throw badRequest("That post's text is too long.");
  if (reversesText(text) || hasStrayMarks(text)) throw badRequest("A post can't have characters that reverse or hide text.");
  if (mentioned.length > MAX_MENTIONS) throw badRequest("A post can mention at most 10 people.");
  if (mentioned.length !== positions.length) throw new Malformed("Mentions and positions don't match");
  if (positions.some((position, index) => position > textBytes.length || (index > 0 && position < positions[index - 1]!))) {
    throw new Malformed("Bad mention position");
  }
  if (embedFields.length > MAX_EMBEDS) throw badRequest("A post can have at most 2 attachments.");
  if (text.trim() === "" && mentioned.length === 0 && embedFields.length === 0) throw badRequest("That post is empty.");

  const names = await usernames(context);
  for (const fid of mentioned) if (!names.has(fid)) throw badRequest("You can only mention members of this network.");
  if (characterCount(joinMentions({ text, fids: mentioned, positions }, names)) > MAX_CHARACTERS) {
    throw badRequest("That post is over 280 characters.");
  }

  const embeds: StoredEmbed[] = [];
  for (const embedBytes of embedFields) embeds.push(await embed(context, message.fid, embedBytes));

  if (parent) {
    const row = await context.db.prepare("SELECT fid, parent, deleted FROM posts WHERE hash = ?").bind(parent.hash)
      .first<{ fid: number; parent: string | null; deleted: number | null }>();
    if (!row || row.fid !== parent.fid || row.deleted !== null) throw badRequest("The post you're replying to isn't here.");
    if (row.parent !== null) throw badRequest("Replies go on posts, not on other replies.");
  }

  const mentionRows = [...new Set(mentioned)].filter((fid) => fid !== message.fid);
  // Everything after the post goes in only if the post did, so nothing is left pointing at a post that isn't there.
  const posted = "EXISTS (SELECT 1 FROM posts WHERE hash = ?1)";
  const written = await context.db.batch([
    context.db
      .prepare(`INSERT INTO posts (hash, fid, time, parent, text, mentions, embeds, message, received, parent_fid)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11 WHERE ${STILL_SIGNING} ON CONFLICT (hash) DO NOTHING`)
      .bind(
        message.hash, message.fid, message.time, parent?.hash ?? null, text,
        JSON.stringify(mentioned.map((fid, index) => ({ fid, position: positions[index] }))),
        JSON.stringify(embeds), base64(message.bytes), context.now, message.signer, parent?.fid ?? null,
      ),
    ...mentionRows.map((fid) =>
      context.db.prepare(`INSERT INTO mentions (post, fid, author, time) SELECT ?1, ?2, ?3, ?4 WHERE ${posted} ON CONFLICT DO NOTHING`)
        .bind(message.hash, fid, message.fid, message.time),
    ),
  ]);
  // Removed, or signed out everywhere, while this was being checked: nothing went in.
  if (written[0]!.meta.changes === 0 && !(await context.db.prepare("SELECT 1 FROM posts WHERE hash = ?").bind(message.hash).first())) throw refused();
  const links = embeds.flatMap((item) => (item.kind === "link" ? [item.url] : []));
  if (links.length && readLinks) context.waitUntil(fetchPreviews(context, links, message.fid).catch((error) => console.error("previews failed", String(error))));
  return written[0]!.meta.changes > 0;
}

async function embed(context: Context, fid: number, bytes: Uint8Array): Promise<StoredEmbed> {
  const fields = readFields(bytes);
  onlyFields(fields, [1, 2]);
  const urlBytes = bytesOf(fields, 1);
  const cast = bytesOf(fields, 2);
  if ((urlBytes === undefined) === (cast === undefined)) throw new Malformed("An embed is a link or a post");

  if (cast) {
    const ref = castId(cast);
    const row = await context.db.prepare("SELECT fid FROM posts WHERE hash = ? AND deleted IS NULL").bind(ref.hash).first<{ fid: number }>();
    if (!row || row.fid !== ref.fid) throw badRequest("The post you're quoting isn't here.");
    return { kind: "post", ...ref };
  }

  const url = utf8(urlBytes!);
  if (byteLength(url) > MAX_URL_BYTES) throw badRequest("That link is too long.");
  // Links are shown as sent, so they follow the rules names do.
  if (hidesText(url)) throw badRequest("That link has characters that hide or reverse text.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("That isn't a link.");
  }
  if (parsed.protocol !== "https:") throw badRequest("Links must use https.");
  const image = /^\/m\/([A-Za-z0-9_-]{1,64})$/.exec(parsed.pathname);
  if (parsed.host.toLowerCase() === context.host && image) {
    // Only the person who uploaded an image can post it.
    const row = await context.db.prepare("SELECT 1 FROM media WHERE id = ? AND fid = ? AND kind = 'upload'").bind(image[1], fid).first();
    if (!row) throw badRequest("That image isn't on this network.");
    return { kind: "image", id: image[1]!, url };
  }
  return { kind: "link", url };
}

async function removePost(context: Context, message: Checked): Promise<boolean> {
  const fields = readFields(message.body);
  onlyFields(fields, [1]);
  const target = bytesOf(fields, 1);
  if (target?.length !== 20) throw new Malformed("A post's hash is 20 bytes");
  const hash = toHex(target);
  const row = await context.db.prepare("SELECT fid, deleted FROM posts WHERE hash = ?").bind(hash).first<{ fid: number; deleted: number | null }>();
  if (!row) {
    const removed = await context.db.prepare("SELECT fid FROM removed WHERE hash = ?").bind(hash).first<{ fid: number }>();
    if (removed?.fid === message.fid) return false;
    throw notFound("That post isn't here.");
  }
  if (row.fid !== message.fid) throw new HttpError(403, "You can only delete your own posts.");
  if (row.deleted !== null) return false;
  await context.db.batch(deletionStatements(context, "hash = ?", [hash]));
  await collect(context);
  return true;
}

async function react(context: Context, message: Checked, add: boolean): Promise<boolean> {
  const fields = readFields(message.body);
  onlyFields(fields, [1, 2]);
  if (integerOf(fields, 1) !== LIKE) throw badRequest("This network only takes likes.");
  const targetBytes = bytesOf(fields, 2);
  if (!targetBytes) throw new Malformed("A like names a post");
  const target = castId(targetBytes);
  if (!add) {
    const removed = await context.db.prepare("DELETE FROM likes WHERE post = ? AND fid = ?").bind(target.hash, message.fid).run();
    return removed.meta.changes > 0;
  }
  const row = await context.db.prepare("SELECT fid FROM posts WHERE hash = ? AND deleted IS NULL").bind(target.hash).first<{ fid: number }>();
  if (!row || row.fid !== target.fid) throw badRequest("The post you're liking isn't here.");
  return (await context.db
    .prepare(`INSERT INTO likes (post, fid, time, message) SELECT ?1, ?2, ?3, ?4 WHERE ${STILL_SIGNING.replaceAll("?10", "?5")} ON CONFLICT (post, fid) DO NOTHING`)
    .bind(target.hash, message.fid, message.time, base64(message.bytes), message.signer)
    .run()).meta.changes > 0;
}
