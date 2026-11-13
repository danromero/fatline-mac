import * as admin from "./admin.ts";
import { adminLink, adminPages } from "./adminpages.ts";
import { adminFid, hostFor } from "./env.ts";
import type { Context, Env, Viewer } from "./env.ts";
import { base64, errorResponse, HttpError, json, notFound } from "./http.ts";
import { endSession, join, session, viewer as signedIn } from "./join.ts";
import * as members from "./members.ts";
import { submit } from "./messages.ts";
import { MEDIA_ID, serve, setPreviews, upload } from "./media.ts";
import type { Size } from "./media.ts";
import { activity, feed, thread } from "./posts.ts";
import { hourly } from "./scheduled.ts";
import { ensureSchema } from "./schema.ts";
import { invite } from "./invite.ts";
import { serveIcon } from "./icon.ts";
import { tooOld, updateRequired } from "./appversion.ts";
import { insecure, secured } from "./transport.ts";
import { addressBlock } from "./hosts.ts";
import { checkDaily, countDaily, FREE_READ } from "./daily.ts";
import { meter } from "./meter.ts";
import type { Usage } from "./meter.ts";

type Handler = (context: Context, request: Request, match: string[], viewer: Viewer) => Promise<Response> | Response;

/**
 * An API route, and the rules `api` applies around its handler. Every signed-in route is limited by
 * address before its token is looked up, then by member, and reads by READS too. The rest is declared
 * here, so a route's rules are read in one line and nothing in `api` looks at a path. Nothing here moves
 * the feed version: triggers do, with every change feeds show (migrations.ts).
 */
type Route = {
  method: string;
  path: RegExp;
  handler: Handler;
} & (
  | {
      who: "anyone";
      /** Its limit a minute by address: JOINS for what could be guessed, or none for what reads nothing. */
      limit: "JOINS" | "none";
    }
  | {
      /** A signed-in "member", or the "admin". */
      who: "member" | "admin";
      /** A second limit a minute by member, for posting and uploads. */
      limit?: "MESSAGES";
      /**
       * How a member's request counts against the day, when not by default: changes by the rows they
       * write, and reads by the rows they read past FREE_READ. "free" never counts: signing out and
       * leaving, so a stolen device that spent the day's budget can't keep its owner from them. "own" is
       * counted by its handler, as messages are, which lets deletes through.
       */
      daily?: "free" | "own";
    }
);

const HASH = "(0x[0-9a-fA-F]{40})";
const FID = "(\\d{1,16})";

const routes: Route[] = [
  { method: "GET", path: /^\/$/, who: "anyone", limit: "none", handler: () => json({ fatline: "network", version: 1 }) },
  { method: "GET", path: /^\/invites\/([^/]{1,200})$/, who: "anyone", limit: "JOINS", handler: (c, _r, m) => members.invite(c, m[1]!) },
  { method: "POST", path: /^\/join$/, who: "anyone", limit: "JOINS", handler: (c, r) => join(c, r) },
  { method: "POST", path: /^\/session$/, who: "anyone", limit: "JOINS", handler: (c, r) => session(c, r) },
  { method: "DELETE", path: /^\/session$/, who: "member", daily: "free", handler: (c, r) => endSession(c, r) },

  { method: "GET", path: /^\/network$/, who: "member", handler: (c, _r, _m, v) => members.network(c, v) },
  { method: "GET", path: /^\/feed$/, who: "member", handler: (c, r, _m, v) => feed(c, v, r) },
  { method: "GET", path: new RegExp(`^/posts/${HASH}$`), who: "member", handler: (c, r, m, v) => thread(c, v, m[1]!.toLowerCase(), r) },
  { method: "POST", path: /^\/messages$/, who: "member", limit: "MESSAGES", daily: "own", handler: (c, r, _m, v) => submit(c, v, r) },
  { method: "PUT", path: new RegExp(`^/posts/${HASH}/previews$`), who: "member", limit: "MESSAGES", handler: (c, r, m, v) => setPreviews(c, v, m[1]!.toLowerCase(), r) },
  { method: "POST", path: /^\/media$/, who: "member", limit: "MESSAGES", handler: (c, r, _m, v) => upload(c, v, r) },
  { method: "GET", path: /^\/activity$/, who: "member", handler: (c, r, _m, v) => activity(c, v, r) },
  { method: "GET", path: /^\/members$/, who: "member", handler: (c, _r, _m, v) => members.members(c, v) },
  { method: "PATCH", path: /^\/me$/, who: "member", handler: (c, r, _m, v) => members.updateProfile(c, v, r) },
  { method: "PUT", path: new RegExp(`^/mutes/${FID}$`), who: "member", handler: (c, _r, m, v) => members.mute(c, v, m[1]!) },
  { method: "DELETE", path: new RegExp(`^/mutes/${FID}$`), who: "member", handler: (c, _r, m, v) => members.unmute(c, v, m[1]!) },
  { method: "POST", path: /^\/reports$/, who: "member", handler: (c, r, _m, v) => members.report(c, v, r) },
  { method: "POST", path: /^\/leave$/, who: "member", daily: "free", handler: (c, _r, _m, v) => members.leave(c, v) },

  { method: "GET", path: /^\/admin\/requests$/, who: "admin", handler: (c) => admin.requests(c) },
  { method: "POST", path: new RegExp(`^/admin/requests/${FID}/approve$`), who: "admin", handler: (c, _r, m, v) => admin.approve(c, v, m[1]!) },
  { method: "POST", path: new RegExp(`^/admin/requests/${FID}/refuse$`), who: "admin", handler: (c, _r, m, v) => admin.refuse(c, v, m[1]!) },
  { method: "POST", path: new RegExp(`^/admin/members/${FID}/remove$`), who: "admin", handler: (c, _r, m, v) => admin.remove(c, v, m[1]!) },
  { method: "POST", path: new RegExp(`^/admin/members/${FID}/sign-out$`), who: "admin", handler: (c, _r, m, v) => admin.signOut(c, v, m[1]!) },
  { method: "POST", path: new RegExp(`^/admin/posts/${HASH}/delete$`), who: "admin", handler: (c, _r, m, v) => admin.deletePost(c, v, m[1]!) },
  { method: "GET", path: /^\/admin\/blocks$/, who: "admin", handler: (c) => admin.blocks(c) },
  { method: "DELETE", path: new RegExp(`^/admin/blocks/${FID}$`), who: "admin", handler: (c, _r, m, v) => admin.unblock(c, v, m[1]!) },
  { method: "GET", path: /^\/admin\/invites$/, who: "admin", handler: (c) => admin.invites(c) },
  { method: "POST", path: /^\/admin\/invites$/, who: "admin", handler: (c, r, _m, v) => admin.createInvite(c, v, r) },
  { method: "DELETE", path: /^\/admin\/invites\/([A-Za-z0-9\-._~]{1,128})$/, who: "admin", handler: (c, _r, m, v) => admin.revokeInvite(c, v, m[1]!) },
  { method: "GET", path: /^\/admin\/settings$/, who: "admin", handler: (c) => admin.getSettings(c) },
  { method: "PATCH", path: /^\/admin\/settings$/, who: "admin", handler: (c, r, _m, v) => admin.updateSettings(c, v, r) },
  { method: "POST", path: /^\/admin\/follows\/pull$/, who: "admin", handler: (c, _r, _m, v) => admin.pull(c, v) },
  { method: "GET", path: /^\/admin\/reports$/, who: "admin", handler: (c) => admin.reports(c) },
  { method: "POST", path: /^\/admin\/reports\/(\d{1,16})\/resolve$/, who: "admin", handler: (c, _r, m, v) => admin.resolveReport(c, v, m[1]!) },
  { method: "GET", path: /^\/admin\/log$/, who: "admin", handler: (c) => admin.log(c) },
  { method: "POST", path: /^\/admin-link$/, who: "admin", handler: (c, _r, _m, v) => adminLink(c, v) },
];

async function limit(binding: RateLimit | undefined, key: string) {
  if (binding && !(await binding.limit({ key })).success) throw new HttpError(429, "Too many requests. Try again in a minute.");
}

/** The address a request came from, as Cloudflare saw it. IPv6 counts by /64, the block one connection usually has. */
const address = (request: Request) => `ip:${addressBlock(request.headers.get("cf-connecting-ip") ?? "local")}`;

/** The route for a request, and what its path matched. */
function find(method: string, path: string): { route: Route; match: string[] } {
  const candidates = routes.filter((route) => route.path.test(path));
  const route = candidates.find((candidate) => candidate.method === method);
  if (!route) throw candidates.length ? new HttpError(405, "That route doesn't take that method.") : notFound();
  return { route, match: route.path.exec(path)! };
}

const NOBODY: Viewer = { fid: 0, role: "member", networkKey: "" };

/** Who's asking, once the route's limits a minute let them through. */
async function admit(context: Context, request: Request, route: Route): Promise<Viewer> {
  if (route.who === "anyone") {
    if (route.limit === "JOINS") await limit(context.env.JOINS, address(request));
    return NOBODY;
  }
  // Per address before the token is looked up, so made-up tokens can't each cost a database read without end.
  await limit(context.env.REQUESTS, address(request));
  const viewer = await signedIn(context, request);
  await limit(context.env.REQUESTS, `fid:${viewer.fid}`);
  // Reads count for the day only past FREE_READ, so they have their own limit a minute too.
  if (request.method === "GET") await limit(context.env.READS, `fid:${viewer.fid}`);
  if (route.limit === "MESSAGES") await limit(context.env.MESSAGES, `fid:${viewer.fid}`);
  if (route.who === "admin") admin.requireAdmin(viewer);
  return viewer;
}

const OVER = {
  writes: "That's a lot of changes for one day. Try again tomorrow.",
  reads: "That's a lot of reading for one day. Try again tomorrow.",
};

/** The daily budget a request counts against here, or null when it doesn't or its handler counts. */
function budget(route: Route, method: string): keyof typeof OVER | null {
  if (route.who !== "member" || route.daily) return null;
  return method === "GET" ? "reads" : "writes";
}

async function api(context: Context, request: Request, path: string): Promise<Response> {
  // An old build is asked to update before anything else, but naming the network takes a read, so the address limit comes first.
  if (tooOld(context, request)) {
    await limit(context.env.REQUESTS, address(request));
    throw await updateRequired(context);
  }
  const { route, match } = find(request.method, path);
  const viewer = await admit(context, request, route);
  // A member's work runs on a metered database, so one member can't spend the database's daily rows.
  const counts = budget(route, request.method);
  if (counts) await checkDaily(context, viewer.fid, counts, OVER[counts]);
  const usage = { read: 0, written: 0 };
  const work = route.who === "member" ? { ...context, db: meter(context.db, usage), usage } : context;
  const response = await route.handler(work, request, match, viewer);
  if (counts === "writes" && response.ok) await countDaily(context, viewer.fid, "writes", usage.written).run();
  if (counts === "reads" && usage.read > FREE_READ) await countDaily(context, viewer.fid, "reads", usage.read).run();
  return response;
}

/** The page a post's link shows outside the apps. It shows nothing from the post. */
function openPage(host: string, hash: string) {
  const link = `fatline://open?network=${encodeURIComponent(host)}&amp;post=${hash}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Fatline</title>
<style>
:root { color-scheme: light dark; --paper: #f6f1e6; --ink: #1f3d2b; }
@media (prefers-color-scheme: dark) { :root { --paper: #14211a; --ink: #efe8d8; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper); color: var(--ink);
  font: 16px/1.4 Inter, -apple-system, system-ui, sans-serif; }
main { text-align: center; padding: 16px; }
a { display: inline-block; margin-top: 16px; padding: 10px 20px; border-radius: 999px; background: var(--ink); color: var(--paper);
  text-decoration: none; font-weight: 600; }
</style></head>
<body><main><p>This post is in a private Fatline network.</p><a href="${link}">Open in Fatline</a></main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}

function contextFor(env: Env, host: string, now: number, waitUntil: (work: Promise<unknown>) => void): Context {
  return { env, db: env.DB, host, now, adminFid: adminFid(env), waitUntil };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return insecure(request) ?? secured(request, await measured(request, env, ctx));
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env.DB);
    const host = env.NETWORK_HOST?.trim().toLowerCase() || "";
    await hourly(contextFor(env, host, Math.floor(controller.scheduledTime / 1000), (work) => ctx.waitUntil(work)));
  },
} satisfies ExportedHandler<Env>;

/**
 * The answer, and for local cost tests (COST_HEADERS on localhost) what it cost in D1 rows and which
 * statements it ran, so tests can hold each route to a budget and check every statement's query plan.
 */
async function measured(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (env.COST_HEADERS !== "1" || !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return answer(request, env, ctx);
  // Migrations first, unmeasured: they aren't the route's, and their statements would overflow a header.
  await ensureSchema(env.DB);
  const cost: Usage = { read: 0, written: 0, sql: new Set() };
  const metered: Env = { ...env, DB: meter(env.DB, cost) };
  let response: Response;
  if (url.pathname === "/__test/hourly" && request.method === "POST") {
    const at = Number(url.searchParams.get("at")) || Math.floor(Date.now() / 1000);
    await hourly(contextFor(metered, metered.NETWORK_HOST?.trim().toLowerCase() || "", at, (work) => ctx.waitUntil(work)));
    response = new Response(null, { status: 204 });
  } else {
    response = await answer(request, metered, ctx);
  }
  const answered = new Response(response.body, response);
  answered.headers.set("x-rows-read", String(cost.read));
  answered.headers.set("x-rows-written", String(cost.written));
  answered.headers.set("x-sql", base64(new TextEncoder().encode(JSON.stringify([...cost.sql!]))));
  return answered;
}

/**
 * Everything the Worker answers, in order, each with the limit a minute by address that comes before
 * anything is read. The API's routes have their own. A handler that gives null leaves the request to
 * the ones after it.
 */
interface Surface {
  path: RegExp;
  methods?: string[];
  limit: "REQUESTS" | "PICTURES" | "none";
  /** It reads the database, so the schema must be ready. */
  database: boolean;
  handler: (context: Context, request: Request, match: string[]) => Promise<Response | null> | Response | null;
}

const surfaces: Surface[] = [
  { path: /^\/api\/v1(\/.*)?$/, limit: "none", database: true, handler: (c, r, m) => api(c, r, m[1] || "/") },
  // The pages look up a cookie or a one-time link on every request.
  { path: /^\/admin(\/.*)?$/, limit: "REQUESTS", database: true, handler: (c, r, m) => adminPages(c, r, m[0]!) },
  // Anyone with a link can load it, and each load reads D1 and R2.
  {
    path: /^\/media\/([^/]+)\/(display|thumb|original)$/, methods: ["GET"], limit: "PICTURES", database: true,
    handler: (c, r, m) => (MEDIA_ID.test(m[1]!) ? serve(c, r, m[1]!, m[2] as Size) : null),
  },
  { path: /^\/icon$/, methods: ["GET", "HEAD"], limit: "PICTURES", database: false, handler: (c, r) => serveIcon(c.env, r) },
  // Behind a secret path, shaped as invitePath allows. The page reads the network's name.
  { path: /^\/[A-Za-z0-9_-]{16,128}\/[^/]+$/, limit: "REQUESTS", database: true, handler: (c, r, m) => invite(c, r, m[0]!) },
  { path: /^\/p\/(0x[0-9a-fA-F]{40})$/, methods: ["GET"], limit: "none", database: false, handler: (c, _r, m) => openPage(c.host, m[1]!.toLowerCase()) },
];

async function answer(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const context = contextFor(env, hostFor(env, request), Math.floor(Date.now() / 1000), (work) => ctx.waitUntil(work));
  try {
    for (const surface of surfaces) {
      const match = surface.path.exec(pathname);
      if (!match || (surface.methods && !surface.methods.includes(request.method))) continue;
      if (surface.limit !== "none") await limit(env[surface.limit], address(request));
      if (surface.database) await ensureSchema(env.DB);
      const response = await surface.handler(context, request, match);
      if (response) return response;
    }
    // Includes /m/{id}, the address an image has inside a signed message, which serves nothing.
    throw notFound();
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    console.error(error);
    return json({ message: "Something went wrong on the server." }, 500);
  }
}
