import { deletionStatements, removalStatements, signOutStatements } from "./deletion.ts";
import type { Context, Viewer } from "./env.ts";
import { badRequest, booleanField, choiceField, field, HttpError, json, noContent, problem, readJSON, TEXT, textField } from "./http.ts";
import { pullFollows } from "./follows.ts";
import { addMember } from "./join.ts";
import { collect } from "./media.ts";
import { logStatement, memberRow, setSetting, settings } from "./store.ts";

/**
 * What the admin can do, as JSON. The admin pages in Phase 3 use the same operations. Every change
 * is written to the admin log.
 */

const CODE = /^[A-Za-z0-9\-._~]{1,128}$/;
/** A code the admin types is at least this long, so it can't be guessed in a few tries. Made-up codes are 10. */
const MIN_CHOSEN_CODE = 8;

function fidFrom(text: string) {
  const fid = Number(text);
  if (!Number.isSafeInteger(fid) || fid < 1) throw problem("no-person");
  return fid;
}

export function requireAdmin(viewer: Viewer) {
  if (viewer.role !== "admin") throw new HttpError(403, "Only the admin can do that.");
}

/** GET /admin/requests. */
export async function requests(context: Context) {
  const rows = await context.db
    .prepare("SELECT fid, username, requested, status FROM join_requests ORDER BY requested")
    .all<{ fid: number; username: string | null; requested: number; status: string }>();
  return json({ requests: rows.results });
}

/** POST /admin/requests/{fid}/approve. */
export async function approve(context: Context, viewer: Viewer, fidText: string) {
  const fid = fidFrom(fidText);
  const request = await context.db.prepare("SELECT custody, avatar FROM join_requests WHERE fid = ?").bind(fid)
    .first<{ custody: string; avatar: string | null }>();
  if (!request) throw problem("no-request");
  // The owner the request last read, which the hourly job checks again first.
  await addMember(context, fid, request.custody, 0, request.avatar, "member", [logStatement(context, viewer.fid, "approved", { fid })]);
  return noContent();
}

/** POST /admin/requests/{fid}/refuse. */
export async function refuse(context: Context, viewer: Viewer, fidText: string) {
  const fid = fidFrom(fidText);
  const changed = await context.db.prepare("UPDATE join_requests SET status = 'refused' WHERE fid = ?").bind(fid).run();
  if (changed.meta.changes === 0) throw problem("no-request");
  await logStatement(context, viewer.fid, "refused", { fid }).run();
  return noContent();
}

/** POST /admin/members/{fid}/remove. Removing someone also blocks them until the admin unblocks them. */
export async function remove(context: Context, viewer: Viewer, fidText: string) {
  const fid = fidFrom(fidText);
  if (fid === viewer.fid || fid === context.adminFid) throw problem("not-the-admin");
  const member = await memberRow(context, fid);
  if (!member) throw problem("no-member");
  await context.db.batch([
    ...removalStatements(context, fid, { block: true, by: viewer.fid, username: member.username }),
    logStatement(context, viewer.fid, "removed", { fid, username: member.username }),
  ]);
  await collect(context, fid);
  return noContent();
}

/**
 * POST /admin/members/{fid}/sign-out. Signs someone out on every device, for a lost or stolen one.
 * Their posts stay and they aren't blocked, so they can sign in again with their recovery phrase.
 */
export async function signOut(context: Context, viewer: Viewer, fidText: string) {
  const fid = fidFrom(fidText);
  const member = await memberRow(context, fid);
  if (!member) throw problem("no-member");
  await context.db.batch([
    ...signOutStatements(context, fid),
    logStatement(context, viewer.fid, "signed out", { fid, username: member.username }),
  ]);
  return noContent();
}

/** POST /admin/posts/{hash}/delete. Deletes one post or reply, as its author deleting it would: a post with replies leaves a placeholder. */
export async function deletePost(context: Context, viewer: Viewer, hashText: string) {
  const hash = hashText.toLowerCase();
  const row = await context.db.prepare("SELECT fid, deleted FROM posts WHERE hash = ?").bind(hash).first<{ fid: number; deleted: number | null }>();
  if (!row || row.deleted !== null) throw problem("no-post");
  await context.db.batch([
    ...deletionStatements(context, "hash = ?", [hash]),
    logStatement(context, viewer.fid, "deleted a post by", { fid: row.fid, post: hash }),
  ]);
  await collect(context);
  return noContent();
}

/** GET /admin/blocks. */
export async function blocks(context: Context) {
  const rows = await context.db.prepare("SELECT fid, username, blocked FROM blocks ORDER BY blocked DESC").all();
  return json({ blocks: rows.results });
}

/** DELETE /admin/blocks/{fid}. They can ask to join again. */
export async function unblock(context: Context, viewer: Viewer, fidText: string) {
  const fid = fidFrom(fidText);
  await context.db.batch([
    context.db.prepare("DELETE FROM blocks WHERE fid = ?").bind(fid),
    logStatement(context, viewer.fid, "unblocked", { fid }),
  ]);
  return noContent();
}

export interface InviteRow {
  code: string;
  uses_left: number | null;
  expires: number | null;
  created: number;
  used: number;
  revoked: number | null;
}

const inviteJSON = (row: InviteRow) => ({
  code: row.code, usesLeft: row.uses_left, expires: row.expires, created: row.created, used: row.used, revoked: row.revoked,
});

/** GET /admin/invites. */
export async function invites(context: Context) {
  const rows = await context.db.prepare("SELECT * FROM invites ORDER BY created DESC").all<InviteRow>();
  return json({ invites: rows.results.map(inviteJSON) });
}

/** A code that's easy to read aloud: no 0, O, 1, I, or L. */
function newCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => alphabet[byte % alphabet.length]).join("");
}

/** POST /admin/invites: `{ code?, uses?, expires? }`. One use and no expiry unless given. `uses: null` is unlimited. */
export async function createInvite(context: Context, viewer: Viewer, request: Request) {
  const body = await readJSON(request);
  const code = field.optionalString(body, "code", 128);
  const uses = body.uses === null ? null : body.uses === undefined ? 1 : field.integer(body, "uses");
  const expires = body.expires === undefined || body.expires === null ? null : field.integer(body, "expires");
  return json(inviteJSON(await makeInvite(context, viewer, { code, uses, expires })), 201);
}

/** Makes an invite code. The admin pages and the JSON route both use this. */
export async function makeInvite(context: Context, viewer: Viewer, options: { code?: string; uses: number | null; expires: number | null }) {
  const chosen = options.code?.trim();
  const code = chosen || newCode();
  const { uses, expires } = options;
  if (!CODE.test(code) || (chosen && chosen.length < MIN_CHOSEN_CODE)) throw badRequest("A code is 8 to 128 characters from A-Z a-z 0-9 - . _ ~");
  if (uses !== null && uses < 1) throw badRequest("uses should be at least 1, or null for unlimited.");
  if (expires !== null && expires <= context.now) throw badRequest("expires should be in the future.");
  const added = await context.db
    .prepare("INSERT INTO invites (code, uses_left, expires, created, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING")
    .bind(code, uses, expires, context.now, viewer.fid)
    .run();
  if (added.meta.changes === 0) throw problem("code-exists");
  await logStatement(context, viewer.fid, "made invite code", { code, uses, expires }).run();
  return (await context.db.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<InviteRow>())!;
}

/** DELETE /admin/invites/{code}. */
export async function revokeInvite(context: Context, viewer: Viewer, code: string) {
  const changed = await context.db.prepare("UPDATE invites SET revoked = ? WHERE code = ? AND revoked IS NULL").bind(context.now, code).run();
  if (changed.meta.changes === 0) throw problem("no-code");
  await logStatement(context, viewer.fid, "revoked invite code", { code }).run();
  return noContent();
}

/** GET /admin/settings. */
export async function getSettings(context: Context) {
  return json(await settings(context));
}

/** PATCH /admin/settings: `{ name?, retention?, admitFollows? }`. */
export async function updateSettings(context: Context, viewer: Viewer, request: Request) {
  const body = await readJSON(request);
  await changeSettings(context, viewer, { name: body.name, retention: body.retention, admitFollows: body.admitFollows });
  return json(await settings(context));
}

/** Changes the network's name, retention, or who gets in without waiting. The admin pages and the JSON route both use this. */
export async function changeSettings(context: Context, viewer: Viewer, change: { name?: unknown; retention?: unknown; admitFollows?: unknown }) {
  const name = textField(change.name, "name", TEXT.networkName)?.trim();
  const retention = choiceField(change.retention, "retention", ["30 days", "forever"] as const);
  const admitFollows = booleanField(change.admitFollows, "admitFollows");
  const statements = [];
  if (name !== undefined) statements.push(setSetting(context, "name", name));
  if (retention !== undefined) statements.push(setSetting(context, "retention", retention));
  if (admitFollows !== undefined) statements.push(setSetting(context, "admit_follows", admitFollows ? "on" : "off"));
  if (statements.length) await context.db.batch([...statements, logStatement(context, viewer.fid, "changed settings", { name, retention, admitFollows })]);
}

/** POST /admin/follows/pull. Takes the admin's follows from the hub once, for joins to check against. */
export async function pull(context: Context, viewer: Viewer) {
  return json(await pullFollows(context, viewer));
}

/** GET /admin/reports. */
export async function reports(context: Context) {
  const rows = await context.db
    .prepare(`SELECT r.id, r.post, r.post_fid AS postFid, r.fid, r.note, r.created, r.resolved,
      EXISTS (SELECT 1 FROM posts p WHERE p.hash = r.post AND p.deleted IS NULL) AS here
      FROM reports r ORDER BY r.created DESC LIMIT 500`)
    .all<Record<string, unknown>>();
  return json({ reports: rows.results.map((row) => ({ ...row, here: row.here === 1 })) });
}

/** POST /admin/reports/{id}/resolve. */
export async function resolveReport(context: Context, viewer: Viewer, idText: string) {
  const id = Number(idText);
  const changed = await context.db.prepare("UPDATE reports SET resolved = ? WHERE id = ? AND resolved IS NULL").bind(context.now, id).run();
  if (changed.meta.changes === 0) throw problem("no-report");
  await logStatement(context, viewer.fid, "resolved report", { id }).run();
  return noContent();
}

/** GET /admin/log. */
export async function log(context: Context) {
  const rows = await context.db.prepare("SELECT id, time, admin, action, detail FROM admin_log ORDER BY id DESC LIMIT 500")
    .all<{ id: number; time: number; admin: number | null; action: string; detail: string }>();
  return json({ entries: rows.results.map((row) => ({ ...row, detail: JSON.parse(row.detail) })) });
}

