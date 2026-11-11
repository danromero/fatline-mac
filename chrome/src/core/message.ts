import { blake3 } from "@noble/hashes/blake3.js";
import { PostingError } from "./errors.ts";

const encoder = new TextEncoder();

export const byteLength = (text: string) => encoder.encode(text).length;

export function toHex(bytes: Uint8Array): string {
  return "0x" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads 0x-prefixed hex, the form hashes and keys take in the network's JSON. */
export function fromHex(hex: string): Uint8Array | null {
  if (!hex.startsWith("0x") || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex.slice(2))) return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return bytes;
}

class Protobuf {
  private readonly out: number[] = [];

  integer(field: number, value: number) {
    this.varint(field * 8);
    this.varint(value);
  }

  bytes(field: number, value: Uint8Array) {
    this.varint(field * 8 + 2);
    this.varint(value.length);
    for (const byte of value) this.out.push(byte);
  }

  get data() {
    return Uint8Array.from(this.out);
  }

  private varint(value: number) {
    let remaining = value;
    while (remaining >= 128) {
      this.out.push((remaining % 128) | 128);
      remaining = Math.floor(remaining / 128);
    }
    this.out.push(remaining);
  }
}

/** Holds the private key out of reach. Only ever asked to sign a message hash. */
export interface Signer {
  publicKey: Uint8Array;
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export interface SignedMessage {
  hash: string;
  bytes: Uint8Array;
}

export interface SignedCast extends SignedMessage {
  fid: number;
  text: string;
  timestamp: number;
}

export interface SignedRemoval extends SignedMessage {
  fid: number;
  /** The deleted cast's hash. */
  target: string;
}

export function farcasterTime(date: Date = new Date()): number {
  const seconds = Math.floor(date.getTime() / 1000) - 1_609_459_200;
  if (seconds <= 0 || seconds > 0xffffffff) throw new PostingError("invalidClock");
  return seconds;
}

async function sign(type: number, field: number, body: Uint8Array, fid: number, signer: Signer, date: Date): Promise<SignedMessage> {
  const data = new Protobuf();
  data.integer(1, type);
  data.integer(2, fid);
  data.integer(3, farcasterTime(date));
  data.integer(4, 1); // Mainnet
  data.bytes(field, body);

  const digest = blake3(data.data, { dkLen: 20 });
  const message = new Protobuf();
  message.bytes(1, data.data);
  message.bytes(2, digest);
  message.integer(3, 1); // BLAKE3
  message.bytes(4, await signer.sign(digest));
  message.integer(5, 1); // Ed25519
  message.bytes(6, signer.publicKey);
  message.bytes(7, data.data);
  return { hash: toHex(digest), bytes: message.data };
}

export async function makeCast(fid: number, text: string, signer: Signer, date: Date = new Date()): Promise<SignedCast> {
  if (text.trim().length === 0 || byteLength(text) > 320) throw new PostingError("invalidCast");
  const body = new Protobuf();
  body.bytes(2, new Uint8Array()); // Empty packed mentions and offsets match the Farcaster SDK.
  body.bytes(4, encoder.encode(text));
  body.bytes(5, new Uint8Array());
  const message = await sign(1, 5, body.data, fid, signer, date);
  return { ...message, fid, text, timestamp: farcasterTime(date) };
}

export async function makeRemoval(fid: number, target: string, signer: Signer, date: Date = new Date()): Promise<SignedRemoval> {
  const lowered = target.toLowerCase();
  const hash = fromHex(lowered);
  if (hash?.length !== 20) throw new PostingError("invalidCast");
  const body = new Protobuf();
  body.bytes(1, hash);
  const message = await sign(2, 6, body.data, fid, signer, date);
  return { ...message, fid, target: lowered };
}

export interface KeyAuthorization {
  fid: number;
  deadline: number;
  nonce: number;
  ttl: number;
  custodySignature: Uint8Array;
  metadata: Uint8Array;
}

/** Authorizes a new posting key. The custody signature covers the two scopes written here. */
export async function makeKeyAdd(authorization: KeyAuthorization, signer: Signer, date: Date = new Date()): Promise<SignedMessage> {
  const body = new Protobuf();
  body.bytes(1, signer.publicKey);
  body.integer(2, 1); // Ed25519
  body.bytes(3, authorization.custodySignature);
  body.integer(4, authorization.deadline);
  body.integer(5, authorization.nonce);
  body.bytes(6, authorization.metadata);
  body.integer(7, 1); // Signed key request metadata
  body.bytes(9, Uint8Array.of(1, 2)); // Packed CAST_ADD and CAST_REMOVE scopes
  body.integer(10, authorization.ttl);
  return sign(16, 19, body.data, authorization.fid, signer, date);
}
