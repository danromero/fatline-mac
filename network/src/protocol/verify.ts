import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { networkKeyText, sessionText } from "./approvals.ts";
import { fromHex, toHex } from "./protobuf.ts";

/**
 * Checks for the approvals in docs/NETWORK.md, written straight from the EIP-712 rules rather than
 * with the library the client signs with, so the two have to agree. The server uses these.
 */

const encoder = new TextEncoder();
const keccak = (...parts: Uint8Array[]) => keccak_256(concat(...parts));

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function uint256(value: number | bigint) {
  const out = new Uint8Array(32);
  let remaining = BigInt(value);
  for (let index = 31; index >= 0 && remaining > 0n; index--) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

const DOMAIN_SEPARATOR = keccak(
  keccak(encoder.encode("EIP712Domain(string name,string version)")),
  keccak(encoder.encode("Fatline")),
  keccak(encoder.encode("1")),
);
const DEVICE_KEY_TYPE = keccak(encoder.encode("DeviceKey(uint256 fid,bytes key,uint256 issuedAt)"));

/** The EIP-712 digest a custody address signs to approve a device key. */
export function deviceKeyDigest(fid: number, deviceKey: Uint8Array, issuedAt: number): Uint8Array {
  const struct = keccak(DEVICE_KEY_TYPE, uint256(fid), keccak(deviceKey), uint256(issuedAt));
  return keccak(Uint8Array.of(0x19, 0x01), DOMAIN_SEPARATOR, struct);
}

/** The address that signed a device key approval, lowercase, or null if the signature is malformed. */
export function deviceApprover(fid: number, deviceKey: Uint8Array, approval: { issuedAt: number; signature: string }): string | null {
  const signature = fromHex(approval.signature);
  if (signature?.length !== 65 || deviceKey.length !== 32) return null;
  const v = signature[64]!;
  if (v !== 27 && v !== 28) return null;
  try {
    const point = secp256k1.Signature.fromBytes(signature.slice(0, 64), "compact")
      .addRecoveryBit(v - 27)
      .recoverPublicKey(deviceKeyDigest(fid, deviceKey, approval.issuedAt));
    return toHex(keccak_256(point.toBytes(false).slice(1)).slice(-20));
  } catch {
    return null;
  }
}

function verifyText(signature: string, text: string, publicKey: Uint8Array) {
  const bytes = fromHex(signature);
  if (bytes?.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(bytes, encoder.encode(text), publicKey);
  } catch {
    return false;
  }
}

export function networkApprovalIsValid(host: string, fid: number, deviceKey: Uint8Array, networkKey: Uint8Array, approval: { issued: number; signature: string }) {
  return verifyText(approval.signature, networkKeyText(host, fid, networkKey, approval.issued), deviceKey);
}

export function sessionSignatureIsValid(host: string, fid: number, networkKey: Uint8Array, issued: number, nonce: string, signature: string) {
  return verifyText(signature, sessionText(host, fid, issued, nonce), networkKey);
}
