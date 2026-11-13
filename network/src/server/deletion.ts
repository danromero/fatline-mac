import type { Context } from "./env.ts";

/**
 * Deletes the posts and replies `where` matches, following docs/NETWORK.md: a post with replies left
 * becomes a placeholder, replies go entirely, and a placeholder goes once its last reply does.
 * `where` is a condition on the posts table, with `params` bound for it in each statement.
 */
export function deletionStatements(context: Context, where: string, params: unknown[]): D1PreparedStatement[] {
  const db = context.db;
  const matching = `SELECT hash FROM posts WHERE ${where}`;
  return [
    db.prepare(`INSERT INTO removed (hash, fid, removed) SELECT hash, fid, ? FROM posts WHERE (${where}) AND deleted IS NULL ON CONFLICT (hash) DO NOTHING`)
      .bind(context.now, ...params),
    db.prepare(`DELETE FROM likes WHERE post IN (${matching})`).bind(...params),
    db.prepare(`DELETE FROM mentions WHERE post IN (${matching})`).bind(...params),
    db.prepare(`DELETE FROM posts WHERE (${where}) AND parent IS NOT NULL`).bind(...params),
    db.prepare(`UPDATE posts SET deleted = ?, text = '', mentions = '[]', embeds = '[]', message = NULL
      WHERE (${where}) AND parent IS NULL AND deleted IS NULL AND EXISTS (SELECT 1 FROM posts r WHERE r.parent = posts.hash)`)
      .bind(context.now, ...params),
    db.prepare(`DELETE FROM posts WHERE (${where}) AND parent IS NULL AND deleted IS NULL
      AND NOT EXISTS (SELECT 1 FROM posts r WHERE r.parent = posts.hash)`).bind(...params),
    // Triggers (migrations.ts) do the rest: a placeholder goes with its last reply, a post's images and
    // links with it, and a link's preview with the last post that has it.
  ];
}

/**
 * Ends every device of someone's: their device keys and network keys stop working, and their sessions
 * and admin page sign-ins end. Nothing they posted goes. To come back, they enter their recovery
 * phrase, which approves a new device key.
 */
export function signOutStatements(context: Context, fid: number): D1PreparedStatement[] {
  const db = context.db;
  return [
    db.prepare("UPDATE device_keys SET revoked = ? WHERE fid = ? AND revoked IS NULL").bind(context.now, fid),
    db.prepare("UPDATE network_keys SET revoked = ? WHERE fid = ? AND revoked IS NULL").bind(context.now, fid),
    db.prepare("DELETE FROM sessions WHERE fid = ?").bind(fid),
    db.prepare("DELETE FROM admin_links WHERE fid = ?").bind(fid),
    db.prepare("DELETE FROM admin_sessions WHERE fid = ?").bind(fid),
  ];
}

/** Takes someone out of the network: everything they posted or liked, their keys, and their sessions. */
export function removalStatements(context: Context, fid: number, options: { block: boolean; by: number | null; username: string | null }) {
  const db = context.db;
  const statements = [
    ...deletionStatements(context, "fid = ?", [fid]),
    db.prepare("DELETE FROM likes WHERE fid = ?").bind(fid),
    db.prepare("DELETE FROM mutes WHERE fid = ? OR muted = ?").bind(fid, fid),
    db.prepare("DELETE FROM reports WHERE fid = ?").bind(fid),
    db.prepare("UPDATE network_keys SET revoked = ? WHERE fid = ? AND revoked IS NULL").bind(context.now, fid),
    db.prepare("DELETE FROM sessions WHERE fid = ?").bind(fid),
    db.prepare("DELETE FROM members WHERE fid = ?").bind(fid),
    db.prepare("DELETE FROM join_requests WHERE fid = ?").bind(fid),
  ];
  if (options.block) {
    statements.push(
      db.prepare("INSERT INTO blocks (fid, username, blocked, by) VALUES (?, ?, ?, ?) ON CONFLICT (fid) DO NOTHING")
        .bind(fid, options.username, context.now, options.by),
    );
  }
  return statements;
}
