import { blake3 } from "@noble/hashes/blake3.js";
import { fromHex, Protobuf, toHex } from "./protobuf.ts";
import { byteLength, characterCount, joinMentions, MAX_CHARACTERS, MAX_EMBEDS, MAX_TEXT_BYTES, MAX_URL_BYTES, splitMentions } from "./text.ts";

/** Message types a network accepts. Farcaster's numbers. */
export const MessageType = { castAdd: 1, castRemove: 2, reactionAdd: 3, reactionRemove: 4 } as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const BODY_FIELD = { 1: 5, 2: 6, 3: 7, 4: 7 } as const;
const LIKE = 1;

/** Holds the private key out of reach. Only ever asked to sign a message hash. */
export interface Signer {
  publicKey: Uint8Array;
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export interface SignedMessage {
  type: MessageType;
  fid: number;
  timestamp: number;
  hash: string;
  bytes: Uint8Array;
}

/** A post or reply on this network, by its author's FID and hash. */
export interface PostRef {
  fid: number;
  hash: string;
}

export type Embed = { url: string } | { post: PostRef };

export interface Draft {
  /** What was typed, with mentions as @username. */
  text: string;
  /** Lowercase usernames of members who can be mentioned, and their FIDs. */
  handles?: Map<string, number>;
  embeds?: Embed[];
  /** Set for a reply. Must be a top-level post. */
  parent?: PostRef;
}

export class DraftError extends Error {}

export function farcasterTime(date: Date = new Date()): number {
  const seconds = Math.floor(date.getTime() / 1000) - 1_609_459_200;
  if (seconds <= 0 || seconds > 0xffffffff) throw new RangeError("The clock is wrong");
  return seconds;
}

/** Signs any body as a network message. The make functions below check their input first. Tests use this to send what they'd refuse. */
export async function signMessage(type: MessageType, body: Uint8Array, fid: number, signer: Signer, date: Date = new Date()): Promise<SignedMessage> {
  const timestamp = farcasterTime(date);
  const data = new Protobuf();
  data.integer(1, type);
  data.integer(2, fid);
  data.integer(3, timestamp);
  // No network field: 0, which no Farcaster node accepts.
  data.bytes(BODY_FIELD[type], body);

  const digest = blake3(data.data, { dkLen: 20 });
  const message = new Protobuf();
  message.bytes(1, data.data);
  message.bytes(2, digest);
  message.integer(3, 1); // BLAKE3
  message.bytes(4, await signer.sign(digest));
  message.integer(5, 1); // Ed25519
  message.bytes(6, signer.publicKey);
  message.bytes(7, data.data);
  return { type, fid, timestamp, hash: toHex(digest), bytes: message.data };
}

function castId(ref: PostRef): Uint8Array {
  const hash = fromHex(ref.hash.toLowerCase());
  if (hash?.length !== 20) throw new DraftError("A post's hash is 20 bytes");
  const id = new Protobuf();
  id.integer(1, ref.fid);
  id.bytes(2, hash);
  return id.data;
}

function checkURL(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DraftError("Not a link");
  }
  if (parsed.protocol !== "https:") throw new DraftError("Links must use https");
  if (byteLength(url) > MAX_URL_BYTES) throw new DraftError("Link too long");
}

/** A post, or a reply when `draft.parent` is set. Applies the rules in docs/NETWORK.md that a client can check. */
export async function makePost(fid: number, draft: Draft, signer: Signer, date: Date = new Date()): Promise<SignedMessage> {
  const embeds = draft.embeds ?? [];
  if (embeds.length > MAX_EMBEDS) throw new DraftError("At most 2 attachments");
  const split = splitMentions(draft.text, draft.handles ?? new Map());
  const usernames = new Map([...(draft.handles ?? new Map())].map(([name, id]) => [id, name]));
  if (characterCount(joinMentions(split, usernames)) > MAX_CHARACTERS) throw new DraftError("Over 280 characters");
  if (byteLength(split.text) > MAX_TEXT_BYTES) throw new DraftError("Text too long");
  if (draft.text.trim() === "" && embeds.length === 0) throw new DraftError("Nothing to post");

  const fids = new Protobuf();
  split.fids.forEach((id) => fids.packed(id));
  const positions = new Protobuf();
  split.positions.forEach((position) => positions.packed(position));

  // Field order and the always-present packed fields match the Farcaster SDK's encoding.
  const body = new Protobuf();
  body.bytes(2, fids.data);
  if (draft.parent) body.bytes(3, castId(draft.parent));
  // Left out when empty, as the SDK does.
  if (split.text !== "") body.string(4, split.text);
  body.bytes(5, positions.data);
  for (const embed of embeds) {
    const encoded = new Protobuf();
    if ("url" in embed) {
      checkURL(embed.url);
      encoded.string(1, embed.url);
    } else {
      encoded.bytes(2, castId(embed.post));
    }
    body.bytes(6, encoded.data);
  }
  return signMessage(MessageType.castAdd, body.data, fid, signer, date);
}

/** Deletes one of your own posts or replies. */
export async function makeRemoval(fid: number, target: string, signer: Signer, date: Date = new Date()): Promise<SignedMessage> {
  const hash = fromHex(target.toLowerCase());
  if (hash?.length !== 20) throw new DraftError("A post's hash is 20 bytes");
  const body = new Protobuf();
  body.bytes(1, hash);
  return signMessage(MessageType.castRemove, body.data, fid, signer, date);
}

function reaction(target: PostRef) {
  const body = new Protobuf();
  body.integer(1, LIKE);
  body.bytes(2, castId(target));
  return body.data;
}

export const makeLike = (fid: number, target: PostRef, signer: Signer, date: Date = new Date()) =>
  signMessage(MessageType.reactionAdd, reaction(target), fid, signer, date);

export const makeUnlike = (fid: number, target: PostRef, signer: Signer, date: Date = new Date()) =>
  signMessage(MessageType.reactionRemove, reaction(target), fid, signer, date);

/** The address an image takes inside a signed message. */
export const imageURL = (host: string, id: string) => `https://${host}/m/${id}`;
