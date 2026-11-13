import { networkOrigin } from "../protocol/approvals.ts";
import { followList, hubURL, pullFollows } from "./follows.ts";
import { joinMentions } from "../protocol/text.ts";
import * as admin from "./admin.ts";
import { roleOf } from "./env.ts";
import type { Context, Viewer } from "./env.ts";
import { base64url, decodePart, HttpError, json, problemMessage, sha256Hex } from "./http.ts";
import { iconPath, MAX_ICON_BYTES, removeIcon, saveIcon } from "./icon.ts";
import { settings, usernames } from "./store.ts";
import { invitePath } from "./invite.ts";

/**
 * The admin pages at /admin. Fatline's Manage Network asks for a one-time link, which signs the
 * browser in with a cookie only HTTPS can read. Every form carries a token tied to that sign-in, and
 * the cookie isn't sent from other sites.
 */

const LINK_LIFETIME = 60;
/** The network key `?5`, of FID `?2`, and its device, still live. */
const LIVE_KEY = `SELECT 1 FROM network_keys n JOIN device_keys d ON d.key = n.device_key
  WHERE n.key = ?5 AND n.fid = ?2 AND n.revoked IS NULL AND d.revoked IS NULL`;
const SESSION_LIFETIME = 12 * 60 * 60;
const COOKIE = "fatline_admin";

/** POST /api/v1/admin-link. */
export async function adminLink(context: Context, viewer: Viewer) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await context.db
    .prepare("INSERT INTO admin_links (token, fid, expires, network_key) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), viewer.fid, context.now + LINK_LIFETIME, viewer.networkKey)
    .run();
  return json({ url: `${networkOrigin(context.host)}/admin/login?token=${token}` });
}

const escape = (text: unknown) =>
  String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** How a member shows: @username, or !fid without one. */
function handle(names: Map<number, string>, fid: number) {
  const name = names.get(fid) ?? `!${fid}`;
  return name.startsWith("!") ? name : `@${name}`;
}

function ago(now: number, time: number) {
  const seconds = Math.max(0, now - time);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const when = (now: number, time: number) => `<time datetime="${new Date(time * 1000).toISOString()}" title="${new Date(time * 1000).toUTCString()}">${ago(now, time)}</time>`;

const STYLE = `
:root { --paper: #FDFBF7; --ink: #0A2F1D; --secondary: #54635A; --action: #0A2F1D; --action-ink: #FDFBF7;
  --quiet: #ECEFE8; --line: #DFE4DC; --outline: #C5CEC6; --danger: #C42B1C; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --paper: #121B16; --ink: #F0F1E9; --secondary: #AAB8AF; --action: #C0D8C7; --action-ink: #0A2F1D;
    --quiet: #25342B; --line: #3A493F; --outline: #506256; --danger: #FF6B5E; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/20px Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
header, nav, main { max-width: 760px; margin: 0 auto; padding: 0 16px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding-top: 24px; flex-wrap: wrap; }
h1 { font-size: 22px; line-height: 28px; font-weight: 600; margin: 0; }
h2 { font-size: 14px; font-weight: 600; margin: 28px 0 8px; }
.meta, time { color: var(--secondary); font-size: 12px; }
img.icon { display: block; border-radius: 16px; object-fit: cover; }
nav { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
nav a { color: var(--secondary); text-decoration: none; padding: 5px 10px; border-radius: 999px; font-weight: 600; }
nav a.here { background: var(--quiet); color: var(--ink); }
.count { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 999px; background: var(--action); color: var(--action-ink); font-size: 12px; line-height: 18px; text-align: center; }
main { padding-bottom: 48px; }
.row { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.row .grow { flex: 1 1 240px; min-width: 0; }
.row .text { overflow-wrap: anywhere; }
.empty { color: var(--secondary); padding: 16px 0; }
.notice { margin: 16px 0 0; padding: 10px 14px; border-radius: 10px; background: var(--quiet); }
.notice.error { color: var(--danger); }
form.inline { display: inline; margin: 0; }
button, .button { font: inherit; font-weight: 600; border-radius: 999px; padding: 5px 14px; border: 1px solid var(--outline); background: transparent; color: var(--ink); cursor: pointer; }
button.primary { background: var(--action); color: var(--action-ink); border-color: var(--action); }
button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
details[open] > summary { display: none; }
.confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
code { font: 13px/18px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--quiet); padding: 2px 6px; border-radius: 6px; overflow-wrap: anywhere; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input[type=text] { font: inherit; color: var(--ink); background: var(--paper); border: 1px solid var(--outline); border-radius: 8px; padding: 7px 10px; width: 100%; max-width: 360px; }
select { font: inherit; color: var(--ink); background: var(--paper); border: 1px solid var(--outline); border-radius: 8px; padding: 6px 8px; }
.choices label { font-weight: 400; margin: 6px 0; }
.fields { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.fields label { margin-top: 0; }
`;

interface Page {
  title: string;
  here: string;
  body: string;
}

async function layout(context: Context, viewer: Viewer | null, csrf: string, page: Page, notice: { message?: string | null; error?: string | null } = {}) {
  const network = await settings(context);
  let nav = "";
  let who = "";
  if (viewer) {
    const counts = await context.db
      .prepare(`SELECT (SELECT COUNT(*) FROM join_requests WHERE status = 'pending') AS requests,
        (SELECT COUNT(*) FROM reports WHERE resolved IS NULL) AS reports`)
      .first<{ requests: number; reports: number }>();
    const tabs: [string, string, number][] = [
      ["requests", "Requests", counts?.requests ?? 0], ["members", "Members", 0], ["invites", "Invite codes", 0],
      ["reports", "Reports", counts?.reports ?? 0], ["settings", "Settings", 0], ["log", "Log", 0],
    ];
    nav = `<nav>${tabs.map(([path, label, count]) =>
      `<a href="/admin/${path}"${page.here === path ? ' class="here" aria-current="page"' : ""}>${label}${count ? `<span class="count">${count}</span>` : ""}</a>`).join("")}</nav>`;
    const names = await usernames(context);
    who = `<form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escape(csrf)}">
      <span class="meta">${escape(handle(names, viewer.fid))}</span> <button>Sign out</button></form>`;
  }
  const notices = [
    notice.message ? `<p class="notice" role="status">${escape(notice.message)}</p>` : "",
    notice.error ? `<p class="notice error" role="alert">${escape(notice.error)}</p>` : "",
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(page.title)} · ${escape(network.name)}</title><style>${STYLE}</style></head>
<body><header><h1>${escape(network.name)}</h1>${who}</header>${nav}<main>${notices}${page.body}</main></body></html>`;
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      // Not no-referrer: with it, browsers send Origin: null on form posts, which the same-site check refuses.
      "referrer-policy": "same-origin",
      ...headers,
    },
  });
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });

function cookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function cookieToken(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE && value && /^[A-Za-z0-9_-]{20,100}$/.test(value)) return value;
  }
  return null;
}

async function signedOutPage(context: Context, message: string, status = 401) {
  const body = `<p>${escape(message)}</p><p class="meta">Open Manage Network in Fatline to sign in here.</p>`;
  return htmlResponse(await layout(context, null, "", { title: "Admin", here: "", body }), status);
}

/** GET /admin/login?token=: trades a one-time link for a browser session. */
async function login(context: Context, request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return signedOutPage(context, "That link isn't valid.");
  const link = await context.db
    .prepare("DELETE FROM admin_links WHERE token = ? RETURNING fid, expires, network_key")
    .bind(await sha256Hex(token))
    .first<{ fid: number; expires: number; network_key: string | null }>();
  if (!link || link.expires < context.now) return signedOutPage(context, "That link has expired or was already used.");
  const member = await context.db.prepare("SELECT 1 FROM members WHERE fid = ?").bind(link.fid).first();
  if (!member || roleOf(context, link.fid) !== "admin") return signedOutPage(context, "Only the admin can use these pages.", 403);
  const session = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const csrf = base64url(crypto.getRandomValues(new Uint8Array(24)));
  // Only while the key that asked for the link is still live, checked in the statement that writes.
  const started = await context.db
    .prepare(`INSERT INTO admin_sessions (token, fid, csrf, expires, network_key) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (${LIVE_KEY})`)
    .bind(await sha256Hex(session), link.fid, csrf, context.now + SESSION_LIFETIME, link.network_key)
    .run();
  if (started.meta.changes === 0) return signedOutPage(context, "That link has expired or was already used.");
  return redirect("/admin/requests", { "set-cookie": cookie(request, session, SESSION_LIFETIME) });
}

async function session(context: Context, request: Request): Promise<{ viewer: Viewer; csrf: string; token: string } | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await context.db
    .prepare(`SELECT s.fid, s.csrf, s.network_key FROM admin_sessions s JOIN members m ON m.fid = s.fid
      JOIN network_keys n ON n.key = s.network_key AND n.fid = s.fid AND n.revoked IS NULL
      JOIN device_keys d ON d.key = n.device_key AND d.revoked IS NULL
      WHERE s.token = ? AND s.expires > ?`)
    .bind(hash, context.now)
    .first<{ fid: number; csrf: string; network_key: string }>();
  // A session started by an admin who no longer is one ends here, and so does one whose device was
  // signed out, or whose FID has a new owner.
  if (!row || roleOf(context, row.fid) !== "admin") return null;
  return { viewer: { fid: row.fid, role: "admin", networkKey: row.network_key }, csrf: row.csrf, token: hash };
}

function csrfField(csrf: string) {
  return `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
}

function button(action: string, label: string, csrf: string, kind = "") {
  return `<form class="inline" method="post" action="${escape(action)}">${csrfField(csrf)}<button${kind ? ` class="${kind}"` : ""}>${escape(label)}</button></form>`;
}

/** A button that asks once more before doing something that can't be undone. */
function confirmButton(action: string, label: string, question: string, csrf: string) {
  return `<details><summary class="button">${escape(label)}</summary><form class="confirm" method="post" action="${escape(action)}">
    ${csrfField(csrf)}<span>${escape(question)}</span><button class="danger">${escape(label)}</button></form></details>`;
}

const person = (fid: number, username: string | null) =>
  `<strong>${escape(username ? `@${username}` : `!${fid}`)}</strong> <span class="meta">FID ${fid}</span>`;

async function requestsPage(context: Context, csrf: string): Promise<Page> {
  const rows = await context.db
    .prepare("SELECT fid, username, requested, status FROM join_requests ORDER BY requested DESC")
    .all<{ fid: number; username: string | null; requested: number; status: string }>();
  const waiting = rows.results.filter((row) => row.status === "pending");
  const refused = rows.results.filter((row) => row.status === "refused");
  const list = (items: typeof waiting, refusedList: boolean) => items.length
    ? items.map((row) => `<div class="row"><div class="grow">${person(row.fid, row.username)}<div class="meta">Asked ${when(context.now, row.requested)}</div></div>
        ${button(`/admin/requests/${row.fid}/approve`, "Approve", csrf, "primary")}
        ${refusedList ? "" : button(`/admin/requests/${row.fid}/refuse`, "Refuse", csrf)}</div>`).join("")
    : `<p class="empty">${refusedList ? "Nobody refused." : "Nobody is waiting."}</p>`;
  return { title: "Requests", here: "requests", body: `<h2>Waiting</h2>${list(waiting, false)}${refused.length ? `<h2>Refused</h2>${list(refused, true)}` : ""}` };
}

async function membersPage(context: Context, viewer: Viewer, csrf: string): Promise<Page> {
  const members = await context.db
    .prepare("SELECT fid, username, display_name, joined FROM members ORDER BY joined, fid")
    .all<{ fid: number; username: string | null; display_name: string; joined: number }>();
  const blocked = await context.db.prepare("SELECT fid, username, blocked FROM blocks ORDER BY blocked DESC")
    .all<{ fid: number; username: string | null; blocked: number }>();
  const memberRows = members.results.map((row) => {
    const name = row.username ? `@${row.username}` : `!${row.fid}`;
    const signOut = confirmButton(`/admin/members/${row.fid}/sign-out`, "Sign out everywhere", row.fid === viewer.fid
      ? "Sign yourself out on every device, this browser too? You'll sign in again with your recovery phrase."
      : `Sign ${name} out on every device? Their posts stay, and they can sign in again with their recovery phrase.`, csrf);
    const action = row.fid === viewer.fid || roleOf(context, row.fid) === "admin"
      ? `${signOut}<span class="meta">Admin</span>`
      : signOut + confirmButton(`/admin/members/${row.fid}/remove`, "Remove",
        `Remove ${name}? Their posts, replies, and likes are deleted, and they can't ask again until you unblock them.`, csrf);
    return `<div class="row"><div class="grow">${person(row.fid, row.username)}${row.display_name ? ` <span>${escape(row.display_name)}</span>` : ""}
      <div class="meta">Joined ${when(context.now, row.joined)}</div></div>${action}</div>`;
  }).join("");
  const blockedRows = blocked.results.map((row) => `<div class="row"><div class="grow">${person(row.fid, row.username)}
      <div class="meta">Blocked ${when(context.now, row.blocked)}</div></div>${button(`/admin/blocks/${row.fid}/unblock`, "Unblock", csrf)}</div>`).join("");
  return {
    title: "Members",
    here: "members",
    body: `<h2>${members.results.length} ${members.results.length === 1 ? "member" : "members"}</h2>${memberRows}
      ${blocked.results.length ? `<h2>Blocked</h2>${blockedRows}` : ""}`,
  };
}

async function invitesPage(context: Context, csrf: string): Promise<Page> {
  const rows = await context.db.prepare("SELECT * FROM invites ORDER BY created DESC").all<admin.InviteRow>();
  const live = (row: admin.InviteRow) => row.revoked === null && (row.expires === null || row.expires > context.now) && (row.uses_left === null || row.uses_left > 0);
  const describe = (row: admin.InviteRow) => {
    if (row.revoked !== null) return "Revoked";
    if (row.expires !== null && row.expires <= context.now) return "Expired";
    if (row.uses_left === 0) return "Used up";
    const uses = row.uses_left === null ? "Unlimited uses" : `${row.uses_left} ${row.uses_left === 1 ? "use" : "uses"} left`;
    return `${uses}${row.expires ? `, expires ${new Date(row.expires * 1000).toUTCString().slice(5, 16)}` : ""}`;
  };
  const list = rows.results.length
    ? rows.results.map((row) => `<div class="row"><div class="grow"><code>${escape(`${row.code}@${context.host}`)}</code>
        <div class="meta">${describe(row)} · used ${row.used} ${row.used === 1 ? "time" : "times"} · made ${when(context.now, row.created)}</div></div>
        ${live(row) ? button(`/admin/invites/${encodeURIComponent(row.code)}/revoke`, "Revoke", csrf) : ""}</div>`).join("")
    : `<p class="empty">No codes yet.</p>`;
  const form = `<form method="post" action="/admin/invites">${csrfField(csrf)}<div class="fields">
      <div><label for="uses">Uses</label><select id="uses" name="uses"><option value="1">One person</option><option value="5">5 people</option><option value="unlimited">Anyone with it</option></select></div>
      <div><label for="expires">Expires</label><select id="expires" name="expires"><option value="never">Never</option><option value="1">In a day</option><option value="7">In a week</option><option value="30">In 30 days</option></select></div>
      <div><button class="primary">Make a code</button></div></div></form>`;
  const path = invitePath(context.env.INVITE_PATH);
  const page = path
    ? `<h2>Invite page</h2><div class="row"><div class="grow"><code>${escape(`https://${context.host}/${path}/invite`)}</code>
        <div class="meta">People who use it ask to join, and wait under Requests.</div></div></div>`
    : "";
  return { title: "Invite codes", here: "invites", body: `${page}<h2>New code</h2><p class="meta">A code lets someone in without asking.</p>${form}<h2>Codes</h2>${list}` };
}

async function reportsPage(context: Context, csrf: string): Promise<Page> {
  const rows = await context.db
    .prepare(`SELECT r.id, r.post, r.post_fid, r.fid, r.note, r.created, r.resolved, p.text, p.mentions, p.deleted
      FROM reports r LEFT JOIN posts p ON p.hash = r.post ORDER BY r.resolved IS NOT NULL, r.created DESC LIMIT 200`)
    .all<{ id: number; post: string; post_fid: number; fid: number; note: string; created: number; resolved: number | null;
      text: string | null; mentions: string | null; deleted: number | null }>();
  const names = await usernames(context);
  const name = (fid: number) => handle(names, fid);
  const list = rows.results.length
    ? rows.results.map((row) => {
      const mentions = row.mentions ? (JSON.parse(row.mentions) as { fid: number; position: number }[]) : [];
      const text = row.text !== null && row.deleted === null
        ? joinMentions({ text: row.text, fids: mentions.map((mention) => mention.fid), positions: mentions.map((mention) => mention.position) }, names)
        : null;
      return `<div class="row"><div class="grow"><div class="text">${text !== null ? `<strong>${escape(name(row.post_fid))}</strong> ${escape(text)}` : `<span class="meta">The post is gone.</span>`}</div>
        <div class="meta">Reported by ${escape(name(row.fid))} ${when(context.now, row.created)}${row.note ? `: “${escape(row.note)}”` : ""}</div></div>
        ${row.resolved === null ? button(`/admin/reports/${row.id}/resolve`, "Done", csrf) : `<span class="meta">Done</span>`}
        ${row.resolved === null && text !== null
          ? confirmButton(`/admin/posts/${row.post}/delete`, "Delete post", "Delete this post? Replies to it stay, under a placeholder.", csrf)
          : ""}
        ${row.resolved === null && text !== null && row.post_fid !== context.adminFid
          ? confirmButton(`/admin/members/${row.post_fid}/remove`, `Remove ${name(row.post_fid)}`, "Their posts, replies, and likes are deleted, and they're blocked.", csrf)
          : ""}</div>`;
    }).join("")
    : `<p class="empty">No reports.</p>`;
  return { title: "Reports", here: "reports", body: `<h2>Reports</h2>${list}` };
}

async function settingsPage(context: Context, csrf: string): Promise<Page> {
  const current = await settings(context);
  const icon = await iconPath(context);
  const counts = await context.db
    .prepare(`SELECT (SELECT COUNT(*) FROM members) AS members,
      (SELECT COUNT(*) FROM posts WHERE parent IS NULL AND deleted IS NULL) AS posts,
      (SELECT COUNT(*) FROM posts WHERE parent IS NOT NULL) AS replies`)
    .first<{ members: number; posts: number; replies: number }>();
  const radio = (value: string, label: string) =>
    `<label><input type="radio" name="retention" value="${value}"${current.retention === value ? " checked" : ""}> ${label}</label>`;
  // Who gets in without waiting, only offered when the network has a hub to pull the admin's follows from.
  const hub = hubURL(context.env) !== null && context.adminFid !== null;
  const joining = (value: string, label: string) =>
    `<label><input type="radio" name="admitFollows" value="${value}"${current.admitFollows === (value === "on") ? " checked" : ""}> ${label}</label>`;
  const joiningField = hub ? `<label>Joining</label><div class="choices">${joining("on", "People you follow on Farcaster get in at once. Everyone else waits for you")}${joining("off", "Everyone waits for you")}</div>` : "";
  const follows = hub ? await followList(context) : null;
  const followsSection = follows === null ? "" : `<h2>Who you follow</h2>
    <p class="meta">${follows.pulled === null
      ? "Not pulled yet. Until you pull them, everyone waits for you."
      : `${follows.count.toLocaleString("en-US")} ${follows.count === 1 ? "person" : "people"}, pulled ${ago(context.now, follows.pulled)}. People you follow after that wait until you pull again.${follows.complete ? "" : " Farcaster had more than one pull takes, so some of them wait too."}`}</p>
    ${button("/admin/follows/pull", follows.pulled === null ? "Pull follows" : "Pull again", csrf)}`;
  const body = `<form method="post" action="/admin/settings">${csrfField(csrf)}
      <label for="name">Name</label><input type="text" id="name" name="name" maxlength="64" value="${escape(current.name === context.host ? "" : current.name)}" placeholder="${escape(context.host)}">
      <label>Keep posts</label><div class="choices">${radio("forever", "Forever")}${radio("30 days", "For 30 days, then delete them")}</div>
      ${joiningField}
      <p><button class="primary">Save</button></p></form>
    ${followsSection}
    <h2>Picture</h2>
    <p class="meta">Shown in the apps and on the invite page in place of the first letter. A square PNG or JPEG, 512 pixels or more, up to 2 MB.</p>
    ${icon ? `<p><img class="icon" src="${escape(icon)}" width="64" height="64" alt="The network's picture"></p>` : ""}
    <form method="post" action="/admin/icon" enctype="multipart/form-data">${csrfField(csrf)}
      <input type="file" name="icon" accept="image/png,image/jpeg,image/gif" required>
      <p><button class="primary">${icon ? "Replace" : "Upload"}</button></p></form>
    ${icon ? button("/admin/icon/remove", "Remove picture", csrf) : ""}
    <h2>Storage</h2><p class="meta">${counts?.members ?? 0} members · ${counts?.posts ?? 0} posts · ${counts?.replies ?? 0} replies. Images aren't stored yet.</p>`;
  return { title: "Settings", here: "settings", body };
}

async function logPage(context: Context): Promise<Page> {
  const rows = await context.db.prepare("SELECT time, admin, action, detail FROM admin_log ORDER BY id DESC LIMIT 200")
    .all<{ time: number; admin: number | null; action: string; detail: string }>();
  const names = await usernames(context);
  const name = (fid: unknown) => (typeof fid === "number" ? handle(names, fid) : "");
  const list = rows.results.length
    ? rows.results.map((row) => {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      const subject = detail.fid !== undefined ? ` ${name(detail.fid)}` : detail.code ? ` ${detail.code}` : "";
      const who = row.admin === null ? "Someone" : name(row.admin);
      return `<div class="row"><div class="grow">${escape(who)} ${escape(row.action)}${escape(subject)}</div>${when(context.now, row.time)}</div>`;
    }).join("")
    : `<p class="empty">Nothing yet.</p>`;
  return { title: "Log", here: "log", body: `<h2>Log</h2>${list}` };
}

const DAY = 24 * 60 * 60;

/**
 * What a form's result says. A form sends the browser back with a code, such as `?message=saved` or
 * `?error=name-too-long`, and only these words show, so a link can't put its own on the page.
 */
const MESSAGES = new Map([
  ["approved", "Approved. They're in."],
  ["refused", "Refused."],
  ["removed", "Removed. Their posts are gone, and they're blocked."],
  ["post-deleted", "Deleted the post."],
  ["signed-out", "Signed out everywhere. Their posts stay, and they can sign in again with their recovery phrase."],
  ["unblocked", "Unblocked. They can ask to join again."],
  ["made", "Made a code. It's the first one under Codes."],
  ["revoked", "Revoked."],
  ["resolved", "Marked done."],
  ["picture-saved", "Picture saved."],
  ["picture-removed", "Picture removed."],
  ["saved", "Saved."],
  ["follows-pulled", "Pulled who you follow. People on the list who are waiting get in the next time their app checks."],
]);

/** Shown after a form whose action failed for a reason without a code of its own (http.ts). */
const FAILED = "That didn't work. Reload the page and try again.";

/** Runs a form's action. Returns where to go afterward with the code of the message to show there, or null for a form that isn't here. */
async function act(context: Context, viewer: Viewer, path: string, form: FormData): Promise<{ back: string; message: string } | null> {
  let match: RegExpExecArray | null;
  if ((match = /^\/admin\/requests\/(\d{1,16})\/(approve|refuse)$/.exec(path))) {
    await (match[2] === "approve" ? admin.approve : admin.refuse)(context, viewer, match[1]!);
    return { back: "/admin/requests", message: match[2] === "approve" ? "approved" : "refused" };
  }
  if ((match = /^\/admin\/members\/(\d{1,16})\/remove$/.exec(path))) {
    await admin.remove(context, viewer, match[1]!);
    return { back: "/admin/members", message: "removed" };
  }
  if ((match = /^\/admin\/members\/(\d{1,16})\/sign-out$/.exec(path))) {
    await admin.signOut(context, viewer, match[1]!);
    return { back: "/admin/members", message: "signed-out" };
  }
  if ((match = /^\/admin\/blocks\/(\d{1,16})\/unblock$/.exec(path))) {
    await admin.unblock(context, viewer, match[1]!);
    return { back: "/admin/members", message: "unblocked" };
  }
  if (path === "/admin/invites") {
    const uses = String(form.get("uses") ?? "1");
    const expires = String(form.get("expires") ?? "never");
    await admin.makeInvite(context, viewer, {
      uses: uses === "unlimited" ? null : Math.max(1, Number(uses) || 1),
      expires: expires === "never" ? null : context.now + (Number(expires) || 1) * DAY,
    });
    return { back: "/admin/invites", message: "made" };
  }
  if ((match = /^\/admin\/invites\/([A-Za-z0-9\-._~%]{1,400})\/revoke$/.exec(path))) {
    const code = decodePart(match[1]!);
    if (code === null) return null;
    await admin.revokeInvite(context, viewer, code);
    return { back: "/admin/invites", message: "revoked" };
  }
  if ((match = /^\/admin\/posts\/(0x[0-9a-f]{40})\/delete$/.exec(path))) {
    await admin.deletePost(context, viewer, match[1]!);
    return { back: "/admin/reports", message: "post-deleted" };
  }
  if ((match = /^\/admin\/reports\/(\d{1,16})\/resolve$/.exec(path))) {
    await admin.resolveReport(context, viewer, match[1]!);
    return { back: "/admin/reports", message: "resolved" };
  }
  if (path === "/admin/icon") {
    await saveIcon(context, viewer, form.get("icon"));
    return { back: "/admin/settings", message: "picture-saved" };
  }
  if (path === "/admin/icon/remove") {
    await removeIcon(context, viewer);
    return { back: "/admin/settings", message: "picture-removed" };
  }
  if (path === "/admin/follows/pull") {
    await pullFollows(context, viewer);
    return { back: "/admin/settings", message: "follows-pulled" };
  }
  if (path === "/admin/settings") {
    const admitFollows = form.get("admitFollows");
    await admin.changeSettings(context, viewer, {
      name: String(form.get("name") ?? "").trim(),
      retention: form.get("retention") ?? undefined,
      admitFollows: admitFollows === null ? undefined : admitFollows === "on",
    });
    return { back: "/admin/settings", message: "saved" };
  }
  return null;
}

async function notFoundPage(context: Context, viewer: Viewer, csrf: string) {
  return htmlResponse(await layout(context, viewer, csrf, { title: "Not found", here: "", body: "<p>Not found.</p>" }), 404);
}

/** Everything under /admin. */
export async function adminPages(context: Context, request: Request, path: string): Promise<Response> {
  if (path === "/admin/login" && request.method === "GET") return login(context, request);
  const signedIn = await session(context, request);
  if (!signedIn) return signedOutPage(context, "You're not signed in.");
  const { viewer, csrf } = signedIn;

  if (request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    const origin = request.headers.get("origin");
    const limit = path === "/admin/icon" ? MAX_ICON_BYTES + 16 * 1024 : 16 * 1024;
    if (declared > limit || (origin !== null && origin !== new URL(request.url).origin)) return signedOutPage(context, "That form came from somewhere else.", 403);
    const form = await request.formData();
    if (form.get("csrf") !== csrf) return signedOutPage(context, "That form has expired. Go back, reload, and try again.", 403);
    if (path === "/admin/logout") {
      await context.db.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(signedIn.token).run();
      return htmlResponse(await layout(context, null, "", { title: "Signed out", here: "", body: "<p>Signed out.</p>" }), 200,
        { "set-cookie": cookie(request, "", 0) });
    }
    const page = path.startsWith("/admin/icon") || path.startsWith("/admin/follows") ? "/admin/settings"
      : path.startsWith("/admin/posts") ? "/admin/reports" : path.split("/").slice(0, 3).join("/");
    try {
      const done = await act(context, viewer, path, form);
      if (!done) return notFoundPage(context, viewer, csrf);
      return redirect(`${done.back}?message=${done.message}`);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // Only a code goes in the link, and the page shows that code's own words, so no words come from a link.
      return redirect(`${page}?error=${problemMessage(error.code) ? error.code : "failed"}`);
    }
  }

  if (request.method !== "GET") throw new HttpError(405, "That route doesn't take that method.");
  if (path === "/admin" || path === "/admin/") return redirect("/admin/requests");
  const pages: Record<string, () => Promise<Page>> = {
    "/admin/requests": () => requestsPage(context, csrf),
    "/admin/members": () => membersPage(context, viewer, csrf),
    "/admin/invites": () => invitesPage(context, csrf),
    "/admin/reports": () => reportsPage(context, csrf),
    "/admin/settings": () => settingsPage(context, csrf),
    "/admin/log": () => logPage(context),
  };
  const build = pages[path];
  if (!build) return notFoundPage(context, viewer, csrf);
  const params = new URL(request.url).searchParams;
  const error = params.get("error");
  const notice = { message: MESSAGES.get(params.get("message") ?? ""), error: error === "failed" ? FAILED : problemMessage(error ?? "") };
  return htmlResponse(await layout(context, viewer, csrf, await build(), notice));
}
