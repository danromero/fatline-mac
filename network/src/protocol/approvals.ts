import { toHex } from "./protobuf.ts";

/** Farcaster's ID registry on Optimism. `custodyOf(fid)` says which address owns an FID. */
export const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b";

/** What a custody address signs, once per device. EIP-712, in the shape viem takes. */
export function deviceKeyTypedData(fid: number, deviceKey: Uint8Array, issuedAt: number) {
  return {
    domain: { name: "Fatline", version: "1" },
    types: {
      DeviceKey: [
        { name: "fid", type: "uint256" },
        { name: "key", type: "bytes" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "DeviceKey",
    message: { fid: BigInt(fid), key: toHex(deviceKey) as `0x${string}`, issuedAt: BigInt(issuedAt) },
  } as const;
}

/** What a device key signs to approve a network key for one network. */
export function networkKeyText(host: string, fid: number, networkKey: Uint8Array, issued: number): string {
  return ["Fatline network key", `network: ${host}`, `fid: ${fid}`, `key: ${toHex(networkKey)}`, `issued: ${issued}`].join("\n");
}

/** What a network key signs to get a session token. The nonce is 16 random bytes, so no two sign-ins sign the same text. */
export function sessionText(host: string, fid: number, issued: number, nonce: string): string {
  return ["Fatline session", `network: ${host}`, `fid: ${fid}`, `issued: ${issued}`, `nonce: ${nonce}`].join("\n");
}

export const unixTime = (date: Date = new Date()) => Math.floor(date.getTime() / 1000);

/**
 * A network's host: the lowercase host name and any port, from an address like `friends.example.com`
 * or `https://friends.example.com`. Only HTTPS, except `http://localhost` for local testing.
 */
export function networkHost(address: string): string | null {
  const trimmed = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.host.toLowerCase();
}

/** The origin requests go to for a host. */
export function networkOrigin(host: string): string {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

const CODE = /^[A-Za-z0-9\-._~]{1,128}$/;

/** `CODE@host`, the way the apps already read codes. */
export function parseInvite(text: string): { code: string; host: string } | null {
  const at = text.trim().lastIndexOf("@");
  if (at <= 0) return null;
  const code = text.trim().slice(0, at);
  const host = networkHost(text.trim().slice(at + 1));
  return CODE.test(code) && host ? { code, host } : null;
}
