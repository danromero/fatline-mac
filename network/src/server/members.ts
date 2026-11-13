import { checkDaily, countDaily } from "./daily.ts";
import { removalStatements } from "./deletion.ts";
import type { Context, Viewer } from "./env.ts";
import { badRequest, decodePart, field, HttpError, json, noContent, notFound, problem, readJSON, TEXT } from "./http.ts";
import { iconLink } from "./icon.ts";
import { collect, mediaLinks, ownUpload } from "./media.ts";
import { memberJSON, memberRow, settings } from "./store.ts";
import type { MemberRow } from "./store.ts";

const CODE = /^[A-Za-z0-9\-._~]{1,128}$/;

/** GET /invites/{code}: what a valid code opens, before joining. `escaped` is the code as it is in the path. */
export async function invite(context: Context, escaped: string) {
  const code = decodePart(escaped);
  if (code === null || !CODE.test(code)) throw notFound("That invite code isn't valid.");
  const valid = await context.db
    .prepare("SELECT 1 FROM invites WHERE code = ? AND revoked IS NULL AND (expires IS NULL OR expires > ?) AND (uses_left IS NULL OR uses_left > 0)")
    .bind(code, context.now)
    .first();
  if (!valid) throw notFound("That invite code isn't valid.");
  return json({ name: (await settings(context)).name, icon: await iconLink(context) });
}

async function mutedBy(context: Context, viewer: Viewer) {
  const rows = await context.db.prepare("SELECT muted FROM mutes WHERE fid = ?").bind(viewer.fid).all<{ muted: number }>();
  return new Set(rows.results.map((row) => row.muted));
}

/** GET /network. */
export async function network(context: Context, viewer: Viewer) {
  const current = await settings(context);
  const you = await memberRow(context, viewer.fid);
  return json({ name: current.name, icon: await iconLink(context), retention: current.retention, you: memberJSON(context, you!, false, await mediaLinks(context)) });
}

/** GET /members. */
export async function members(context: Context, viewer: Viewer) {
  const rows = await context.db.prepare("SELECT * FROM members ORDER BY joined, fid").all<MemberRow>();
  const muted = await mutedBy(context, viewer);
  const links = await mediaLinks(context);
  return json({ members: rows.results.map((row) => memberJSON(context, row, muted.has(row.fid), links)) });
}

/** PATCH /me. */
export async function updateProfile(context: Context, viewer: Viewer, request: Request) {
  const body = await readJSON(request);
  const displayName = field.text(body, "displayName", TEXT.displayName);
  const bio = field.text(body, "bio", TEXT.bio);
  const avatar = field.optionalString(body, "avatar", 100);
  // Their Farcaster picture, which the app uploaded itself, so the server needn't fetch it.
  const farcasterPicture = field.optionalString(body, "farcasterPicture", 100);
  if (avatar !== undefined && avatar !== "farcaster" && !(await ownUpload(context, viewer.fid, avatar))) throw badRequest("That image isn't on this network.");
  if (farcasterPicture !== undefined && !(await ownUpload(context, viewer.fid, farcasterPicture))) throw badRequest("That image isn't on this network.");

  const before = await memberRow(context, viewer.fid);
  const statements = [];
  if (displayName !== undefined) statements.push(context.db.prepare("UPDATE members SET display_name = ? WHERE fid = ?").bind(displayName.trim(), viewer.fid));
  if (bio !== undefined) statements.push(context.db.prepare("UPDATE members SET bio = ? WHERE fid = ?").bind(bio.trim(), viewer.fid));
  if (avatar === "farcaster") statements.push(context.db.prepare("UPDATE members SET avatar_media = NULL WHERE fid = ?").bind(viewer.fid));
  if (avatar !== undefined && avatar !== "farcaster") {
    statements.push(context.db.prepare("UPDATE members SET avatar_media = ? WHERE fid = ?").bind(avatar, viewer.fid));
  }
  if (farcasterPicture !== undefined) statements.push(context.db.prepare("UPDATE members SET farcaster_media = ? WHERE fid = ?").bind(farcasterPicture, viewer.fid));
  if (statements.length) await context.db.batch(statements);
  // A picture that was replaced goes.
  if ((avatar !== undefined && before?.avatar_media) || (farcasterPicture !== undefined && before?.farcaster_media)) await collect(context);
  return json(memberJSON(context, (await memberRow(context, viewer.fid))!, false, await mediaLinks(context)));
}

function memberFid(text: string) {
  const fid = Number(text);
  if (!Number.isSafeInteger(fid) || fid < 1) throw problem("no-member");
  return fid;
}

/** PUT /mutes/{fid}. */
export async function mute(context: Context, viewer: Viewer, fidText: string) {
  const fid = memberFid(fidText);
  if (fid === viewer.fid) throw badRequest("You can't mute yourself.");
  if (!(await memberRow(context, fid))) throw problem("no-member");
  await context.db.prepare("INSERT INTO mutes (fid, muted) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(viewer.fid, fid).run();
  return noContent();
}

/** DELETE /mutes/{fid}. */
export async function unmute(context: Context, viewer: Viewer, fidText: string) {
  await context.db.prepare("DELETE FROM mutes WHERE fid = ? AND muted = ?").bind(viewer.fid, memberFid(fidText)).run();
  return noContent();
}

/** POST /reports. */
export async function report(context: Context, viewer: Viewer, request: Request) {
  const body = await readJSON(request);
  const post = field.hex(body, "post", 20);
  const note = field.text(body, "note", TEXT.note) ?? "";
  await checkDaily(context, viewer.fid, "reports", "That's 20 reports today. The admin will see the ones you sent.");
  const row = await context.db.prepare("SELECT fid FROM posts WHERE hash = ? AND deleted IS NULL").bind(post).first<{ fid: number }>();
  if (!row) throw notFound("That post isn't here.");
  await context.db.batch([
    context.db.prepare("INSERT INTO reports (post, post_fid, fid, note, created) VALUES (?, ?, ?, ?, ?)").bind(post, row.fid, viewer.fid, note.trim(), context.now),
    countDaily(context, viewer.fid, "reports"),
  ]);
  return noContent();
}

/** POST /leave. Everything of yours goes, as when the admin removes someone, but you can ask to join again. */
export async function leave(context: Context, viewer: Viewer) {
  if (viewer.fid === context.adminFid) throw new HttpError(403, "The person who runs this network can't leave it.");
  const row = await memberRow(context, viewer.fid);
  await context.db.batch(removalStatements(context, viewer.fid, { block: false, by: null, username: row?.username ?? null }));
  await collect(context, viewer.fid);
  return noContent();
}
