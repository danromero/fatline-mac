import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { toHex } from "../src/protocol/protobuf.ts";
import { NetworkClient } from "./client.ts";
import { Ed25519Key } from "./keys.ts";
import type { Identity } from "./keys.ts";

/** How the scripted client keeps one person's keys between runs. Plain text, so for testing only. */
export interface KeyFile {
  fid: number;
  custody: string;
  device: { secret: string; issuedAt: number; signature: string };
  networks: Record<string, { secret: string; issued: number; signature: string; token?: string; expires?: number }>;
}

export function readKeyFile(path: string): KeyFile {
  return JSON.parse(readFileSync(path, "utf8")) as KeyFile;
}

export function writeKeyFile(path: string, keys: KeyFile) {
  writeFileSync(path, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function keyFileFor(identity: Identity, networks: KeyFile["networks"] = {}): KeyFile {
  return { fid: identity.fid, custody: identity.custody, device: { secret: toHex(identity.device.secret), ...identity.approval }, networks };
}

export function identityFrom(keys: KeyFile): Identity {
  return {
    fid: keys.fid,
    custody: keys.custody,
    device: Ed25519Key.fromHex(keys.device.secret),
    approval: { issuedAt: keys.device.issuedAt, signature: keys.device.signature },
  };
}

/** The saved client for `host`, or null if this person hasn't joined it. */
export function clientFrom(keys: KeyFile, host: string): NetworkClient | null {
  const saved = keys.networks[host];
  if (!saved) return null;
  return new NetworkClient(identityFrom(keys), {
    host,
    networkKey: Ed25519Key.fromHex(saved.secret),
    approval: { issued: saved.issued, signature: saved.signature },
    token: saved.token,
    expires: saved.expires,
  });
}

/** Keeps the client's network key and session in `keys`. */
export function remember(keys: KeyFile, client: NetworkClient): KeyFile {
  const { networkKey, approval, token, expires } = client.membership;
  keys.networks[client.host] = { secret: toHex(networkKey.secret), ...approval, token, expires };
  return keys;
}
