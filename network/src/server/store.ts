import { roleOf } from "./env.ts";
import type { Context } from "./env.ts";
import { displayUsername } from "./identity.ts";
import type { MediaLinks } from "./media.ts";
import { sha256Hex } from "./http.ts";

/** Small reads and writes most handlers share. */

export type Retention = "30 days" | "forever";

export interface Settings {
  name: string;
  retention: Retention;
  /** People the admin follows on Farcaster get in without waiting, when the network has a hub. */
  admitFollows: boolean;
}

export async function settings(context: Context): Promise<Settings> {
  const rows = await context.db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  return {
    name: values.get("name") || context.host,
    retention: values.get("retention") === "30 days" ? "30 days" : "forever",
    admitFollows: values.get("admit_follows") !== "off",
  };
}

export function setSetting(context: Context, key: string, value: string) {
  return context.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value);
}

/**
 * The ETag for `what` as `viewer` sees it: the version, the hour (image links change hourly), the viewer,
 * whom they've muted, and what was asked. Triggers move the version with every change to what feeds,
 * threads, and activity show, but only from even to odd (migrations.ts), so first this moves an odd one
 * on to even: the next change then moves it again. The version is read before the answer is built, so a
 * change during it only means the next poll gets it again. An unchanged feed answers 304 for a row or two.
 */
export async function versionTag(context: Context, fid: number, what: string) {
  const [, read] = await context.db.batch([
    context.db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version' AND CAST(value AS INTEGER) % 2 = 1"),
    context.db
      .prepare(`SELECT (SELECT value FROM settings WHERE key = 'version') AS version,
        (SELECT group_concat(muted) FROM (SELECT muted FROM mutes WHERE fid = ?1 ORDER BY muted)) AS mutes`)
      .bind(fid),
  ]);
  const row = (read!.results as { version: string | null; mutes: string | null }[])[0];
  return `"${(await sha256Hex(`${row?.version ?? "0"}/${Math.floor(context.now / 3600)}/${fid}/${row?.mutes ?? ""}/${what}`)).slice(0, 32)}"`;
}

export function logStatement(context: Context, admin: number | null, action: string, detail: Record<string, unknown>) {
  return context.db
    .prepare("INSERT INTO admin_log (time, admin, action, detail) VALUES (?, ?, ?, ?)")
    .bind(context.now, admin, action, JSON.stringify(detail));
}

export interface MemberRow {
  fid: number;
  username: string | null;
  display_name: string;
  bio: string;
  avatar_media: string | null;
  farcaster_avatar: string | null;
  farcaster_media: string | null;
  role: "admin" | "member";
  custody: string;
  joined: number;
}

export const memberRow = (context: Context, fid: number) =>
  context.db.prepare("SELECT * FROM members WHERE fid = ?").bind(fid).first<MemberRow>();

/** Every member's name, for mentions. Networks are small, so this is one cheap read. */
export async function usernames(context: Context): Promise<Map<number, string>> {
  const rows = await context.db.prepare("SELECT fid, username FROM members").all<{ fid: number; username: string | null }>();
  return new Map(rows.results.map((row) => [row.fid, displayUsername(row.fid, row.username)]));
}

export function memberJSON(context: Context, row: MemberRow, muted: boolean, links: MediaLinks) {
  // A picture they uploaded here, or else their Farcaster one as copied in, or else none.
  const avatar = row.avatar_media ?? row.farcaster_media;
  return {
    fid: row.fid,
    username: displayUsername(row.fid, row.username),
    displayName: row.display_name,
    bio: row.bio,
    avatar: avatar ? links.link(avatar, "thumb") : null,
    /** Whether the picture is one they uploaded here, rather than their Farcaster one. */
    ownAvatar: row.avatar_media !== null,
    role: roleOf(context, row.fid),
    joined: row.joined,
    muted,
  };
}
