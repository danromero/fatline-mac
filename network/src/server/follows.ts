import type { Context, Env, Viewer } from "./env.ts";
import { problem } from "./http.ts";
import { logStatement, setSetting } from "./store.ts";

/**
 * Who the admin follows on Farcaster, pulled from the hub at HUB_URL (any Snapchain HTTP API, with
 * HUB_API_KEY sent as `x-api-key` when it's set) only when the admin presses Pull follows on
 * Settings. Joins and sign-ins check the list kept here, so nothing a requester does reaches the hub
 * or spends its key. People on the list get in without waiting, unless the admin turns that off.
 */

const TIMEOUT_MS = 5000;
const PAGE_SIZE = 1000;
/** Workers on the free plan get 50 fetches a request, so a pull stops after 40 pages. */
const MAX_PAGES = 40;
/** FIDs written in one statement, as one JSON array. */
const ROWS_PER_INSERT = 5000;

export function hubURL(env: Env): string | null {
  return env.HUB_URL?.trim().replace(/\/+$/, "") || null;
}

function hubHeaders(env: Env): HeadersInit {
  const key = env.HUB_API_KEY?.trim();
  return key ? { "x-api-key": key, accept: "application/json" } : { accept: "application/json" };
}

export interface FollowList {
  /** People on the list, or 0 before the first pull. */
  count: number;
  /** When it was pulled, or null if it hasn't been, or was pulled for another admin. */
  pulled: number | null;
  /** False when Farcaster had more than one pull takes. */
  complete: boolean;
}

/** The follow list's settings rows, read together: a handful of rows, whatever the list's size. */
async function followSettings(context: Context) {
  const rows = await context.db
    .prepare("SELECT key, value FROM settings WHERE key IN ('follows_of', 'follows_pulled', 'follows_complete', 'follows_count', 'admit_follows')")
    .all<{ key: string; value: string }>();
  return new Map(rows.results.map((row) => [row.key, row.value]));
}

function listFrom(context: Context, values: Map<string, string>): FollowList {
  if (context.adminFid === null || values.get("follows_of") !== String(context.adminFid)) return { count: 0, pulled: null, complete: false };
  return { count: Number(values.get("follows_count")) || 0, pulled: Number(values.get("follows_pulled")) || null, complete: values.get("follows_complete") === "yes" };
}

/** The kept list's size and age, for Settings, as saved when it was pulled. Only a list pulled for the current ADMIN_FID counts. */
export async function followList(context: Context): Promise<FollowList> {
  const values = await followSettings(context);
  const list = listFrom(context, values);
  // A list pulled before the count was saved is counted once here, on the admin's Settings page.
  if (list.pulled !== null && !values.has("follows_count")) {
    const counted = await context.db.prepare("SELECT COUNT(*) AS count FROM follows").first<{ count: number }>();
    list.count = counted?.count ?? 0;
    await setSetting(context, "follows_count", String(list.count)).run();
  }
  return list;
}

/**
 * Whether `fid` is on the admin's follow list as last pulled, the setting is on, and there's a hub.
 * Anyone waiting runs this at every sign-in, so it reads the settings rows and one indexed row, never
 * the list itself.
 */
export async function admittedByFollow(context: Context, fid: number): Promise<boolean> {
  const admin = context.adminFid;
  if (!hubURL(context.env) || admin === null || fid === admin) return false;
  const values = await followSettings(context);
  if (values.get("admit_follows") === "off" || listFrom(context, values).pulled === null) return false;
  return (await context.db.prepare("SELECT 1 FROM follows WHERE fid = ?").bind(fid).first()) !== null;
}

/** The FID a hub message says the admin follows, or null for anything else. */
function followed(message: unknown, admin: number): number | null {
  const data = (message as { data?: { type?: unknown; fid?: unknown; linkBody?: { type?: unknown; targetFid?: unknown } } } | null)?.data;
  const target = data?.linkBody?.targetFid;
  if (data?.type !== "MESSAGE_TYPE_LINK_ADD" || data.fid !== admin || data.linkBody?.type !== "follow") return null;
  return typeof target === "number" && Number.isSafeInteger(target) && target > 0 ? target : null;
}

/**
 * Pulls everyone the admin follows from the hub, page by page, and keeps that list in place of the
 * last one. A hub that fails or answers oddly changes nothing. Waiting requests on the new list get
 * in the next time their app checks.
 */
export async function pullFollows(context: Context, viewer: Viewer): Promise<FollowList> {
  const hub = hubURL(context.env);
  const admin = context.adminFid;
  if (!hub || admin === null) throw problem("no-hub");
  const fids = new Set<number>();
  let token = "";
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ fid: String(admin), link_type: "follow", pageSize: String(PAGE_SIZE) });
    if (token) query.set("pageToken", token);
    let answer: { messages?: unknown; nextPageToken?: unknown };
    try {
      const response = await fetch(`${hub}/linksByFid?${query}`, { headers: hubHeaders(context.env), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`The hub answered ${response.status}`);
      answer = (await response.json()) as typeof answer;
      if (!Array.isArray(answer.messages)) throw new Error("The hub's answer has no messages");
    } catch (error) {
      console.error("pulling follows failed", String(error));
      throw problem("hub-failed");
    }
    for (const message of answer.messages) {
      const fid = followed(message, admin);
      if (fid !== null) fids.add(fid);
    }
    token = typeof answer.nextPageToken === "string" ? answer.nextPageToken : "";
    if (!token || answer.messages.length === 0) {
      complete = true;
      break;
    }
  }

  const list = [...fids];
  const inserts = [];
  for (let at = 0; at < list.length; at += ROWS_PER_INSERT) {
    const chunk = list.slice(at, at + ROWS_PER_INSERT);
    inserts.push(context.db.prepare("INSERT INTO follows (fid) SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING").bind(JSON.stringify(chunk)));
  }
  await context.db.batch([
    context.db.prepare("DELETE FROM follows"),
    ...inserts,
    setSetting(context, "follows_of", String(admin)),
    setSetting(context, "follows_pulled", String(context.now)),
    setSetting(context, "follows_complete", complete ? "yes" : "no"),
    setSetting(context, "follows_count", String(list.length)),
    logStatement(context, viewer.fid, "pulled follows", { count: list.length, complete }),
  ]);
  return { count: list.length, pulled: context.now, complete };
}
