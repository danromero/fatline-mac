import { custodyAgreed, rpcList } from "../protocol/chain.ts";
import { DEFAULT_FNAMES, usernameOf } from "../protocol/fnames.ts";
import type { Context, Env } from "./env.ts";
import { HttpError } from "./http.ts";

const TIMEOUT_MS = 10_000;

const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const RPC_TIMEOUT_MS = 5_000;

const timedRPC: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });

/**
 * The address that owns an FID, from Farcaster's ID registry on Optimism, once two RPCs agree. Public
 * RPCs sometimes turn away Cloudflare's shared addresses, so the RPCs in `OPTIMISM_RPC_URL`, or the
 * public ones, are tried in turn. One listed RPC is trusted alone.
 */
export async function custody(env: Env, fid: number): Promise<string | null> {
  try {
    return await custodyAgreed(fid, rpcList(env.OPTIMISM_RPC_URL), timedRPC);
  } catch (error) {
    console.error("custody check failed", fid, String(error));
    throw new HttpError(503, "Couldn't reach Optimism to check that account. Try again in a minute.");
  }
}

/**
 * Stops accepting the FID's device keys that any address but `owner` approved, with their network
 * keys, their sessions, and their admin page sign-ins (which need a live key), whether the FID is a
 * member or still waiting. Run whenever the owner is read, so a key approved on a wrong answer, or by
 * an owner since replaced, goes at once. A request still waiting takes the new owner too, so approving
 * it lets in only theirs.
 */
export function revokeOtherCustody(context: Context, fid: number, owner: string): D1PreparedStatement[] {
  const db = context.db;
  return [
    db.prepare("UPDATE device_keys SET revoked = ? WHERE fid = ? AND custody != ? AND revoked IS NULL").bind(context.now, fid, owner),
    db.prepare(`UPDATE network_keys SET revoked = ? WHERE fid = ? AND revoked IS NULL
      AND device_key IN (SELECT key FROM device_keys WHERE fid = ? AND revoked IS NOT NULL)`).bind(context.now, fid, fid),
    db.prepare("DELETE FROM sessions WHERE fid = ? AND network_key IN (SELECT key FROM network_keys WHERE fid = ? AND revoked IS NOT NULL)").bind(fid, fid),
    db.prepare("UPDATE members SET custody = ?1 WHERE fid = ?2 AND custody != ?1").bind(owner, fid),
    db.prepare("UPDATE join_requests SET custody = ?1 WHERE fid = ?2 AND custody != ?1").bind(owner, fid),
  ];
}

/** The FID's fname, or null if they have none. See `usernameOf`. */
export async function username(env: Env, fid: number): Promise<string | null> {
  try {
    return await usernameOf(fid, env.FNAME_URL || DEFAULT_FNAMES, timed);
  } catch {
    throw new HttpError(503, "Couldn't reach Farcaster's name server. Try again in a minute.");
  }
}

/** How a member's name shows when they have no fname. */
export const displayUsername = (fid: number, name: string | null) => name ?? `!${fid}`;
