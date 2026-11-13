import { ed25519 } from "@noble/curves/ed25519.js";
import { mnemonicToAccount } from "viem/accounts";
import { deviceKeyTypedData, networkKeyText, sessionText, unixTime } from "../src/protocol/approvals.ts";
import type { Signer } from "../src/protocol/messages.ts";
import { fromHex, toHex } from "../src/protocol/protobuf.ts";

const encoder = new TextEncoder();

/**
 * An Ed25519 key held in memory. The apps keep theirs in the Keychain or as a key JavaScript can't
 * export. This scripted client keeps them in a file, so it's for testing only.
 */
export class Ed25519Key implements Signer {
  readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;

  constructor(secret: Uint8Array) {
    this.secret = secret;
    this.publicKey = ed25519.getPublicKey(secret);
  }

  static random() {
    return new Ed25519Key(ed25519.utils.randomSecretKey());
  }

  static fromHex(hex: string) {
    const secret = fromHex(hex);
    if (secret?.length !== 32) throw new Error("An Ed25519 secret is 32 bytes");
    return new Ed25519Key(secret);
  }

  async sign(bytes: Uint8Array) {
    return ed25519.sign(bytes, this.secret);
  }

  signText(text: string) {
    return toHex(ed25519.sign(encoder.encode(text), this.secret));
  }
}

export interface DeviceApproval {
  issuedAt: number;
  /** 65 bytes from the custody address, as hex. */
  signature: string;
}

/** A device's key and the custody address's approval of it. Made once per device. */
export interface Identity {
  fid: number;
  custody: string;
  device: Ed25519Key;
  approval: DeviceApproval;
}

/** The custody address a recovery phrase holds, on the path Farcaster and the apps use. */
export function custodyAddress(phrase: string): string {
  return mnemonicToAccount(normalize(phrase)).address.toLowerCase();
}

/** Signs the device key approval with the recovery phrase, as the apps' recovery helper will. */
export async function approveDevice(phrase: string, fid: number, device: Ed25519Key, now = new Date()): Promise<Identity> {
  const account = mnemonicToAccount(normalize(phrase));
  const issuedAt = unixTime(now);
  const signature = await account.signTypedData(deviceKeyTypedData(fid, device.publicKey, issuedAt));
  return { fid, custody: account.address.toLowerCase(), device, approval: { issuedAt, signature } };
}

export interface NetworkApproval {
  issued: number;
  signature: string;
}

export function approveNetworkKey(identity: Identity, host: string, networkKey: Ed25519Key, now = new Date()): NetworkApproval {
  const issued = unixTime(now);
  return { issued, signature: identity.device.signText(networkKeyText(host, identity.fid, networkKey.publicKey, issued)) };
}

export function signSession(fid: number, host: string, networkKey: Ed25519Key, now = new Date()) {
  const issued = unixTime(now);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { issued, nonce, signature: networkKey.signText(sessionText(host, fid, issued, nonce)) };
}

function normalize(phrase: string) {
  return phrase.trim().toLowerCase().split(/\s+/u).join(" ");
}
