import { fromHex } from "../protocol/protobuf.ts";
import { deviceApprover, networkApprovalIsValid, sessionSignatureIsValid } from "../protocol/verify.ts";
import { roleOf } from "./env.ts";
import type { Context, Viewer } from "./env.ts";
import { custody, revokeOtherCustody, username } from "./identity.ts";
import { badRequest, base64url, field, HttpError, json, noContent, readJSON, refused, sha256Hex } from "./http.ts";
import { logStatement, memberRow } from "./store.ts";
import { copyAvatar } from "./media.ts";
import { checkDaily, countDaily, DAILY, today } from "./daily.ts";
import { admittedByFollow } from "./follows.ts";

const APPROVAL_WINDOW = 10 * 60;
const SESSION_WINDOW = 5 * 60;
const SESSION_LIFETIME = 30 * 24 * 60 * 60;
const CODE = /^[A-Za-z0-9\-._~]{1,128}$/;
const TOO_MANY_SIGNINS = "That's a lot of signing in for one day. Try again tomorrow.";
/**
 * Devices an account can have on a network at once. Revoked ones don't count, and neither do ones
 * neither added nor signed in within ACTIVE_DEVICE, since an app that's deleted never says so.
 */
const MAX_DEVICES = 10;
const ACTIVE_DEVICE = 30 * 24 * 60 * 60;
/** Network keys kept per account. Past this, the oldest go, and their device joins again with its own key. */
const MAX_NETWORK_KEYS = 10;
/** Sessions kept per account. Past this, the oldest end. */
const MAX_SESSIONS = 20;

type Status = "approved" | "pending" | "refused";

/** POST /join. */
export async function join(context: Context, request: Request) {
  const body = await readJSON(request);
  const fid = field.integer(body, "fid");
  if (fid < 1) throw badRequest("fid should be a whole number.");
  const deviceKey = field.hex(body, "deviceKey", 32);
  const networkKey = field.hex(body, "networkKey", 32);
  const deviceApproval = field.object(body, "deviceApproval");
  const networkApproval = field.object(body, "networkApproval");
  const issuedAt = field.integer(deviceApproval, "issuedAt");
  const deviceSignature = field.hex(deviceApproval, "signature", 65);
  const issued = field.integer(networkApproval, "issued");
  const networkSignature = field.hex(networkApproval, "signature", 64);
  const invite = field.optionalString(body, "invite", 128);
  if (invite !== undefined && !CODE.test(invite)) throw badRequest("That isn't an invite code.");
  const avatar = field.optionalString(body, "avatar", 1024);

  if (Math.abs(context.now - issued) > APPROVAL_WINDOW) throw new HttpError(401, "Your device's clock is off. Check the time and try again.");
  if (!networkApprovalIsValid(context.host, fid, fromHex(deviceKey)!, fromHex(networkKey)!, { issued, signature: networkSignature })) {
    throw new HttpError(401, "That network key wasn't approved by this device.");
  }

  const known = await context.db
    .prepare("SELECT fid, custody, signature, issued_at, revoked FROM device_keys WHERE key = ?")
    .bind(deviceKey)
    .first<{ fid: number; custody: string; signature: string; issued_at: number; revoked: number | null }>();
  if (known && (known.fid !== fid || known.revoked !== null)) throw new HttpError(401, "Sign in with your recovery phrase again.");
  if (known && (known.signature !== deviceSignature || known.issued_at !== issuedAt)) throw new HttpError(401, "That device key was approved differently before.");

  let custodyAddress = known?.custody;
  /** Whether Optimism said who owns the FID during this request. */
  let fresh = false;
  if (!custodyAddress) {
    const approver = deviceApprover(fid, fromHex(deviceKey)!, { issuedAt, signature: deviceSignature });
    if (!approver) throw new HttpError(401, "That device key's approval isn't valid.");
    const devices = await context.db
      .prepare(`SELECT COUNT(*) AS count FROM device_keys d WHERE d.fid = ?1 AND d.revoked IS NULL AND (d.added > ?2 OR EXISTS (
          SELECT 1 FROM network_keys n JOIN sessions s ON s.network_key = n.key AND s.fid = ?1
          WHERE n.fid = ?1 AND n.device_key = d.key AND s.expires > ?3))`)
      // A session that hasn't expired was started within its 30 days, the same as ACTIVE_DEVICE.
      .bind(fid, context.now - ACTIVE_DEVICE, context.now)
      .first<{ count: number }>();
    // The admin is never shut out this way, since only the admin could let them back in.
    if (fid !== context.adminFid && (devices?.count ?? 0) >= MAX_DEVICES) {
      throw new HttpError(429, "This account has too many devices on this network. The admin can sign you out everywhere, so you can start again.");
    }
    // Any key can sign an approval for any FID, so asking Optimism is what a made-up join costs. The
    // whole network asks at most CUSTODY's limit a minute, so public RPCs don't start turning it away.
    // Keyed by host: every network on one Cloudflare account shares the binding's namespace.
    if (context.env.CUSTODY && !(await context.env.CUSTODY.limit({ key: `custody:${context.host}` })).success) {
      throw new HttpError(429, "Lots of people are joining right now. Try again in a minute.");
    }
    const owner = await custody(context.env, fid);
    if (owner !== approver) throw new HttpError(401, `That recovery phrase doesn't own FID ${fid}.`);
    custodyAddress = owner;
    fresh = true;
    // An FID with a new owner, a member or still waiting: devices the old one approved stop here now,
    // not at the daily check, and a waiting request takes the new owner.
    await context.db.batch(revokeOtherCustody(context, fid, owner));
  }

  const existingKey = await context.db.prepare("SELECT fid, revoked FROM network_keys WHERE key = ?").bind(networkKey).first<{ fid: number; revoked: number | null }>();
  if (existingKey && (existingKey.fid !== fid || existingKey.revoked !== null)) throw new HttpError(401, "Make a new network key and try again.");

  const keyWrites = [
    // Only while the FID's member row and waiting request name the same owner, checked in the
    // statement that writes: a join checked just before the FID got a new owner, and slower than the
    // new owner's join, adds nothing.
    context.db
      .prepare(`INSERT INTO device_keys (key, fid, custody, issued_at, signature, added) SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (SELECT 1 FROM members WHERE fid = ?2 AND custody != ?3)
        AND NOT EXISTS (SELECT 1 FROM join_requests WHERE fid = ?2 AND custody != ?3) ON CONFLICT (key) DO NOTHING`)
      .bind(deviceKey, fid, custodyAddress, issuedAt, deviceSignature, context.now),
    context.db
      .prepare(`INSERT INTO network_keys (key, fid, device_key, issued, signature, added) SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM device_keys WHERE key = ?3 AND fid = ?2 AND revoked IS NULL) ON CONFLICT (key) DO NOTHING`)
      .bind(networkKey, fid, deviceKey, issued, networkSignature, context.now),
    // The oldest past the newest MAX_NETWORK_KEYS go, with their sessions, so no one can add rows without end.
    context.db.prepare(`DELETE FROM sessions WHERE network_key IN (SELECT key FROM network_keys WHERE fid = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?)`)
      .bind(fid, MAX_NETWORK_KEYS),
    context.db.prepare(`DELETE FROM network_keys WHERE rowid IN (SELECT rowid FROM network_keys WHERE fid = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?)`)
      .bind(fid, MAX_NETWORK_KEYS),
  ];

  // Anyone can call this, so the account's own day counts it, now that its key is shown to be its own.
  await checkDaily(context, fid, "joins", "That's a lot of joins for one day. Try again tomorrow.");
  await countDaily(context, fid, "joins").run();
  // A member let in on an owner read now is next checked in a day; one read before, within the hour.
  const status = await admit(context, fid, custodyAddress, fresh ? context.now : 0, invite, avatar);
  // Keys are kept for pending requests too, so the same device can sign in once approved.
  if (status !== "refused") await context.db.batch(keyWrites);
  return json({ status });
}

/** Decides a join request: members and the admin are in, a good code or the admin's follow lets someone in, others wait. */
async function admit(
  context: Context, fid: number, custodyAddress: string, checked: number, invite: string | undefined, avatar: string | undefined,
): Promise<Status> {
  if (await memberRow(context, fid)) return "approved";
  if (await context.db.prepare("SELECT 1 FROM blocks WHERE fid = ?").bind(fid).first()) return "refused";

  if (fid === context.adminFid) {
    await addMember(context, fid, custodyAddress, checked, avatar, "admin", []);
    return "approved";
  }

  if (invite !== undefined) return joinWithCode(context, fid, custodyAddress, checked, invite, avatar);

  const request = await context.db.prepare("SELECT status FROM join_requests WHERE fid = ?").bind(fid).first<{ status: string }>();
  if (request?.status === "refused") return "refused";
  if (await admittedByFollow(context, fid)) {
    await addMember(context, fid, custodyAddress, checked, avatar, "member", [logStatement(context, context.adminFid, "approved by following", { fid })]);
    return "approved";
  }
  if (!request) {
    const name = await username(context.env, fid);
    await context.db
      .prepare("INSERT INTO join_requests (fid, username, avatar, custody, requested, status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .bind(fid, name, avatar ?? null, custodyAddress, context.now)
      .run();
  }
  return "pending";
}

/** An invite code that can still let someone in, as a condition with the code as `?1` and now as `?2`. */
const GOOD_CODE = "code = ?1 AND revoked IS NULL AND (expires IS NULL OR expires > ?2) AND (uses_left IS NULL OR uses_left > 0)";

/**
 * Lets someone in with an invite code, spending a use only once they're in. The fname server is asked
 * first, so its being down spends nothing. The member goes in on the condition that the code is still
 * good, so two joins at once from one FID spend one use. Then the use is spent in one statement; if
 * someone else's join took the code's last use in between, the new member comes out again.
 */
async function joinWithCode(
  context: Context, fid: number, custodyAddress: string, checked: number, code: string, avatar: string | undefined,
): Promise<Status> {
  const name = await username(context.env, fid);
  const added = await context.db
    .prepare(`INSERT INTO members (fid, username, farcaster_avatar, role, custody, joined, checked)
      SELECT ?3, ?4, ?5, 'member', ?6, ?2, ?7 WHERE EXISTS (SELECT 1 FROM invites WHERE ${GOOD_CODE}) ON CONFLICT (fid) DO NOTHING`)
    .bind(code, context.now, fid, name, avatar ?? null, custodyAddress, checked)
    .run();
  if (added.meta.changes === 0) {
    if (await memberRow(context, fid)) return "approved";
    throw new HttpError(400, "That invite code isn't valid any more.");
  }
  const spent = await context.db
    .prepare(`UPDATE invites SET used = used + 1, uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END WHERE ${GOOD_CODE}`)
    .bind(code, context.now)
    .run();
  if (spent.meta.changes === 0) {
    await context.db.prepare("DELETE FROM members WHERE fid = ?").bind(fid).run();
    throw new HttpError(400, "That invite code isn't valid any more.");
  }
  await context.db.batch([
    context.db.prepare("DELETE FROM join_requests WHERE fid = ?").bind(fid),
    logStatement(context, null, "joined with code", { fid, code }),
  ]);
  if (avatar) context.waitUntil(copyAvatar(context, fid, avatar).catch((error) => console.error("avatar copy failed", String(error))));
  return "approved";
}

/**
 * Lets someone in. `checked` is when Optimism last said `custodyAddress` owns the FID: now, or 0 for
 * an owner read before (a waiting request's), which the hourly job checks first.
 */
export async function addMember(
  context: Context, fid: number, custodyAddress: string, checked: number, avatar: string | null | undefined, role: "admin" | "member",
  extra: D1PreparedStatement[],
) {
  const name = await username(context.env, fid);
  await context.db.batch([
    context.db
      .prepare(`INSERT INTO members (fid, username, farcaster_avatar, role, custody, joined, checked) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (fid) DO NOTHING`)
      .bind(fid, name, avatar ?? null, role, custodyAddress, context.now, checked),
    context.db.prepare("DELETE FROM join_requests WHERE fid = ?").bind(fid),
    ...extra,
  ]);
  if (avatar) context.waitUntil(copyAvatar(context, fid, avatar).catch((error) => console.error("avatar copy failed", String(error))));
}

/** POST /session. */
export async function session(context: Context, request: Request) {
  const body = await readJSON(request);
  const fid = field.integer(body, "fid");
  const networkKey = field.hex(body, "networkKey", 32);
  const issued = field.integer(body, "issued");
  const nonce = field.hex(body, "nonce", 16);
  const signature = field.hex(body, "signature", 64);
  if (Math.abs(context.now - issued) > SESSION_WINDOW) throw new HttpError(401, "Your device's clock is off. Check the time and try again.");
  if (!sessionSignatureIsValid(context.host, fid, fromHex(networkKey)!, issued, nonce, signature)) throw new HttpError(401, "That signature doesn't check out.");

  const key = await context.db
    .prepare(`SELECT n.fid, n.revoked, d.revoked AS device_revoked FROM network_keys n JOIN device_keys d ON d.key = n.device_key WHERE n.key = ?`)
    .bind(networkKey)
    .first<{ fid: number; revoked: number | null; device_revoked: number | null }>();
  if (!key || key.fid !== fid) throw new HttpError(401, "This network doesn't know that key. Join again.");
  // A signed-out or revoked key writes nothing, so a thief who kept one can't spend its owner's day.
  if (key.revoked !== null || key.device_revoked !== null) throw refused();

  // Anyone can call this, so the account's own day counts it, now that the key is shown to be live and
  // its own. Past the day's sign-ins, nothing is written.
  await checkDaily(context, fid, "signins", TOO_MANY_SIGNINS);
  // The signature goes in, so it can't be used again, only while the day has sign-ins left, and the
  // sign-in is counted only if it went in. One batch, so sign-ins sent at once get exactly what's left.
  const [used] = await context.db.batch([
    context.db.prepare(`INSERT INTO used_signatures (signature, expires) SELECT ?1, ?2
        WHERE COALESCE((SELECT count FROM daily_counts WHERE fid = ?3 AND day = ?4 AND kind = 'signins'), 0) < ?5
        ON CONFLICT (signature) DO NOTHING`)
      .bind(signature, issued + SESSION_WINDOW, fid, today(context), DAILY.signins),
    context.db.prepare(`INSERT INTO daily_counts (fid, day, kind, count) SELECT ?1, ?2, 'signins', 1 WHERE changes() = 1
        ON CONFLICT (fid, day, kind) DO UPDATE SET count = count + 1`)
      .bind(fid, today(context)),
  ]);
  if (used!.meta.changes === 0) {
    await checkDaily(context, fid, "signins", TOO_MANY_SIGNINS);
    throw new HttpError(401, "That signature was already used.");
  }
  if (!(await memberRow(context, fid))) {
    const request = await context.db.prepare("SELECT status, custody, avatar FROM join_requests WHERE fid = ?").bind(fid)
      .first<{ status: string; custody: string; avatar: string | null }>();
    if (request?.status !== "pending") throw refused();
    // Someone on a follow list pulled after they asked gets in the next time their app checks.
    if (!(await admittedByFollow(context, fid))) return json({ status: "pending" }, 202);
    await addMember(context, fid, request.custody, 0, request.avatar, "member", [logStatement(context, context.adminFid, "approved by following", { fid })]);
  }

  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = context.now + SESSION_LIFETIME;
  await context.db.batch([
    context.db.prepare("INSERT INTO sessions (token, fid, network_key, expires) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), fid, networkKey, expires),
    context.db.prepare("DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE fid = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?)")
      .bind(fid, MAX_SESSIONS),
  ]);
  return json({ token, expires });
}

/** The bearer token a request carries, or null. */
function bearer(request: Request) {
  return /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/** DELETE /session. Ends the token the request carries. The device's keys stay, so it can sign in again. */
export async function endSession(context: Context, request: Request) {
  const token = bearer(request);
  if (token) await context.db.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256Hex(token)).run();
  return noContent();
}

/** The signed-in member a request's bearer token belongs to. */
export async function viewer(context: Context, request: Request): Promise<Viewer> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "Sign in to this network.");
  const row = await context.db
    .prepare(`SELECT s.fid, s.network_key FROM sessions s
      JOIN network_keys n ON n.key = s.network_key AND n.revoked IS NULL
      JOIN members m ON m.fid = s.fid
      WHERE s.token = ? AND s.expires > ?`)
    .bind(await sha256Hex(token), context.now)
    .first<{ fid: number; network_key: string }>();
  if (!row) throw new HttpError(401, "Sign in to this network again.");
  return { fid: row.fid, role: roleOf(context, row.fid), networkKey: row.network_key };
}
