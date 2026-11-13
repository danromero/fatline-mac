import { deletionStatements } from "./deletion.ts";
import { collect } from "./media.ts";
import type { Context } from "./env.ts";
import { custody, revokeOtherCustody, username } from "./identity.ts";
import { settings } from "./store.ts";
import { oldCounts } from "./daily.ts";

const DAY = 24 * 60 * 60;
const RETENTION = 30 * DAY;
/**
 * Each member costs four requests to check: two to Optimism RPCs that must agree, and two to the fname
 * server. Workers on the free plan get 50 per run, so each hourly run checks the 12 members checked
 * longest ago. That covers 288 a day, more than a network of 100 needs.
 */
const CHECKS_PER_RUN = 12;

/** Runs every hour. */
export async function hourly(context: Context) {
  await expire(context);
  await checkMembers(context);
  await context.db.batch([
    context.db.prepare("DELETE FROM used_signatures WHERE expires < ?").bind(context.now),
    context.db.prepare("DELETE FROM sessions WHERE expires < ?").bind(context.now),
    context.db.prepare("DELETE FROM admin_links WHERE expires < ?").bind(context.now),
    context.db.prepare("DELETE FROM admin_sessions WHERE expires < ?").bind(context.now),
    oldCounts(context),
    // Timestamps more than a day old are refused anyway, so two days is enough to stop a deleted post coming back.
    context.db.prepare("DELETE FROM removed WHERE removed < ?").bind(context.now - 2 * DAY),
  ]);
  await collect(context);
}

/** When retention is 30 days, deletes each post and reply 30 days after its timestamp. The pictures they used go after. */
export async function expire(context: Context) {
  if ((await settings(context)).retention !== "30 days") return;
  await context.db.batch(deletionStatements(context, "time < ?", [context.now - RETENTION]));
}

/** How long a member whose ownership check failed waits to be tried again. */
const RETRY = 3 * 60 * 60;

/**
 * Follows each member's Farcaster username, and stops accepting device keys any address but the FID's
 * owner approved: an old custody address once the FID has a new one, or one a wrong answer let in.
 * That person enters their recovery phrase again.
 *
 * Ownership and the username are separate: the fname server being down never keeps an old owner in,
 * and the last username stays until it answers. A member counts as checked only once Optimism said
 * who owns the FID. One it didn't answer for stays due, and waits RETRY to be tried again, so a few
 * that keep failing don't hold up everyone else.
 */
export async function checkMembers(context: Context) {
  const due = await context.db
    .prepare("SELECT fid FROM members WHERE checked < ? AND check_after <= ? ORDER BY checked LIMIT ?")
    .bind(context.now - DAY, context.now, CHECKS_PER_RUN)
    .all<{ fid: number }>();
  for (const member of due.results) {
    const [owner, name] = await Promise.allSettled([custody(context.env, member.fid), username(context.env, member.fid)]);
    try {
      if (owner.status === "rejected") {
        // Optimism didn't answer, or its RPCs disagreed: nothing is known, so nothing changes.
        await context.db.prepare("UPDATE members SET check_after = ? WHERE fid = ?").bind(context.now + RETRY, member.fid).run();
        continue;
      }
      const statements = [
        name.status === "fulfilled"
          ? context.db.prepare("UPDATE members SET username = ?, checked = ?, check_after = 0 WHERE fid = ?").bind(name.value, context.now, member.fid)
          : context.db.prepare("UPDATE members SET checked = ?, check_after = 0 WHERE fid = ?").bind(context.now, member.fid),
      ];
      // Every time, not only when the owner changed: a device key a wrong answer let in has the wrong
      // custody even while the member's own is right.
      if (owner.value) statements.push(...revokeOtherCustody(context, member.fid, owner.value));
      await context.db.batch(statements);
    } catch (error) {
      // The database didn't take it. This member stays due, and the next run tries again.
      console.error("member check failed", member.fid, String(error));
    }
  }
}
