import type { Context } from "./env.ts";
import { problem } from "./http.ts";

/**
 * What a member can do in a day (UTC), so one member can't spend the database's daily allowance or
 * fill the bucket. Each is counted in one `daily_counts` row per member, day, and kind, so checking
 * costs one row read however much they've done. Counting reads first and adds after, so requests sent
 * at the same moment can go a few over.
 */
export const DAILY = {
  /**
   * Rows a member's changes write in a day, as D1 counts them (index entries too), so a post with ten
   * mentions costs what it writes. A post is about 10 to 20; D1's free plan allows 100,000 a day in all.
   */
  writes: 5000,
  /** Pictures. A post takes two at most, so 25 posts with pictures. */
  uploads: 50,
  reports: 20,
  /** Sign-ins and joins, counted per account once its key is shown to be its own. The apps need a few a month. */
  signins: 100,
  joins: 50,
  /**
   * Rows a member's reads read in a day, counting only reads of more than FREE_READ rows, so a cached
   * or unchanged answer costs nothing and writes nothing. D1's free plan allows 5 million a day in all.
   */
  reads: 200_000,
} as const;

/** A read of up to this many rows is free: answers from the cache, 304s, and small lists. */
export const FREE_READ = 100;

export type DailyKind = keyof typeof DAILY;

const day = (context: Context) => Math.floor(context.now / 86400);

/** Today (UTC), as `daily_counts` numbers days. */
export const today = day;

/** Throws 429 with `message` when `fid` has used up today's `kind`. */
export async function checkDaily(context: Context, fid: number, kind: DailyKind, message: string) {
  const row = await context.db.prepare("SELECT count FROM daily_counts WHERE fid = ? AND day = ? AND kind = ?")
    .bind(fid, day(context), kind).first<{ count: number }>();
  if ((row?.count ?? 0) >= DAILY[kind]) throw problem("daily-limit", message);
}

/** Whether `fid` has any of today's `kind` left, without refusing anything. */
export async function hasDaily(context: Context, fid: number, kind: DailyKind): Promise<boolean> {
  const row = await context.db.prepare("SELECT count FROM daily_counts WHERE fid = ? AND day = ? AND kind = ?")
    .bind(fid, day(context), kind).first<{ count: number }>();
  return (row?.count ?? 0) < DAILY[kind];
}

/** Counts `amount` more of `kind` for `fid` today, one unless said. A statement, to run alone or in a batch. */
export function countDaily(context: Context, fid: number, kind: DailyKind, amount = 1) {
  return context.db
    .prepare("INSERT INTO daily_counts (fid, day, kind, count) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (fid, day, kind) DO UPDATE SET count = count + ?4")
    .bind(fid, day(context), kind, Math.max(1, Math.ceil(amount)));
}

/** Days before yesterday, for the hourly job to delete. */
export function oldCounts(context: Context) {
  return context.db.prepare("DELETE FROM daily_counts WHERE day < ?").bind(day(context) - 1);
}
