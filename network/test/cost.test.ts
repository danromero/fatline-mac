import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { NetworkClient } from "../client/client.ts";
import { newPerson, startNetwork, TEST_PNG } from "../client/local.ts";
import type { TestNetwork } from "../client/local.ts";
import { makeLike, makePost, makeRemoval } from "../src/protocol/messages.ts";
import { MIGRATIONS } from "../src/server/migrations.ts";

/**
 * What each route costs in D1 rows, on a network of a known size, and the query plan of every statement
 * the routes and the hourly job run. The Worker reports both in COST_HEADERS mode. A route over its
 * budget, or a new full scan of a table that grows, fails here instead of reaching a reviewer.
 * COST_DEBUG=1 prints what each route measured, for setting a budget.
 */

const admin = newPerson(1001, "admin");
let network: TestNetwork;
let owner: NetworkClient;
const members: NetworkClient[] = [];
let root = "";
const statements = new Set<string>();

interface Cost {
  status: number;
  read: number;
  written: number;
}

async function cost(response: Response): Promise<Cost> {
  for (const sql of JSON.parse(Buffer.from(response.headers.get("x-sql") ?? "W10=", "base64").toString()) as string[]) statements.add(sql);
  await response.arrayBuffer();
  return { status: response.status, read: Number(response.headers.get("x-rows-read")), written: Number(response.headers.get("x-rows-written")) };
}

const api = (client: NetworkClient, method: string, path: string, body?: RequestInit["body"], type = "application/json") =>
  network.fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${client.membership.token}`, "content-type": type }, body });

const send = (client: NetworkClient, bytes: Uint8Array) => api(client, "POST", "/messages", bytes as RequestInit["body"], "application/octet-stream");

before(async () => {
  network = await startNetwork(admin, { vars: { COST_HEADERS: "1" } });
  owner = await network.device(admin);
  await owner.join();
  await owner.signIn();
  for (let index = 0; index < 12; index++) {
    const person = newPerson(2000 + index, `m${index}`);
    network.farcaster.add(person);
    const client = await network.device(person);
    await client.join({ invite: (await owner.createInvite()).code });
    await client.signIn();
    members.push(client);
  }
  // 150 posts, and a thread of 250 replies with a like from everyone.
  for (let index = 0; index < 150; index++) await members[index % 12]!.post({ text: `Post ${index}` });
  root = await owner.post({ text: "A long thread" });
  for (let index = 0; index < 250; index++) await members[index % 12]!.reply({ fid: admin.fid, hash: root }, { text: `Reply ${index}` });
  for (const member of members) await member.like({ fid: admin.fid, hash: root });
});

after(async () => {
  await network?.stop();
});

/** Each route's budget, a little over what it measured on this network when the test was written. */
describe("what each route costs", () => {
  const within = (measured: Cost, budget: { read?: number; written?: number }, what: string) => {
    if (process.env.COST_DEBUG) console.log(what, measured.read, measured.written);
    assert.ok(measured.status < 400, `${what} answered ${measured.status}`);
    if (budget.read !== undefined) assert.ok(measured.read <= budget.read, `${what} read ${measured.read} rows, over ${budget.read}`);
    if (budget.written !== undefined) assert.ok(measured.written <= budget.written, `${what} wrote ${measured.written} rows, over ${budget.written}`);
  };

  test("reads", async () => {
    within(await cost(await api(owner, "GET", "/feed")), { read: 180, written: 6 }, "the feed");
    within(await cost(await api(owner, "GET", "/feed")), { read: 10, written: 0 }, "the feed again, from the cache");
    within(await cost(await api(owner, "GET", "/activity")), { read: 400, written: 4 }, "activity");
    within(await cost(await api(owner, "GET", `/posts/${root}`)), { read: 600, written: 4 }, "a thread's first page of 200");
    within(await cost(await api(owner, "GET", "/members")), { read: 60, written: 0 }, "the member list");
    within(await cost(await api(owner, "GET", "/network")), { read: 15, written: 0 }, "the network");
  });

  test("changes", async () => {
    const handles = new Map((await owner.members()).map((member) => [member.username, member.fid]));
    const mentions = [...handles.keys()].filter((name) => name.startsWith("m")).slice(0, 10).map((name) => `@${name}`).join(" ");
    const [poster, liker] = [members[0]!, members[1]!];
    const post = await makePost(poster.fid, { text: mentions, handles, embeds: [{ url: "https://x.example/test/page.html" }, { url: "https://y.example/a" }] },
      poster.membership.networkKey);
    within(await cost(await send(poster, post.bytes)), { read: 60, written: 60 }, "a post with ten mentions and two links");
    const previews = JSON.stringify({ previews: [{ url: "https://x.example/test/page.html", title: "A page", description: "About it" }] });
    within(await cost(await api(poster, "PUT", `/posts/${post.hash}/previews`, previews)), { read: 20, written: 10 }, "a post's previews from its app");
    within(await cost(await api(owner, "GET", "/feed")), { read: 180, written: 6 }, "the feed, with that post's previews");
    within(await cost(await send(liker, (await makeLike(liker.fid, { fid: poster.fid, hash: post.hash }, liker.membership.networkKey)).bytes)),
      { read: 20, written: 10 }, "a like");
    within(await cost(await send(poster, (await makeRemoval(poster.fid, post.hash, poster.membership.networkKey)).bytes)),
      { read: 90, written: 35 }, "a delete");
    within(await cost(await api(members[2]!, "PATCH", "/me", JSON.stringify({ bio: "Hello" }))), { read: 15, written: 5 }, "a profile change");
    within(await cost(await api(members[2]!, "PUT", `/mutes/${members[3]!.fid}`)), { read: 10, written: 5 }, "a mute");
    within(await cost(await api(members[2]!, "POST", "/media", TEST_PNG as RequestInit["body"], "image/png")), { read: 10, written: 10 }, "an upload");
  });

  test("the admin's lists", async () => {
    within(await cost(await api(owner, "GET", "/admin/requests")), { read: 10 }, "requests");
    within(await cost(await api(owner, "GET", "/admin/log")), { read: 520 }, "the log");
  });

  test("the hourly job", async () => {
    const now = Math.floor(Date.now() / 1000);
    within(await cost(await network.fetch(`/__test/hourly?at=${now + 3600}`, { method: "POST" })), { read: 150, written: 20 }, "the hourly job");
  });
});

/**
 * Statements allowed to read a whole table, each with why. Anything else that scans a table fails.
 * Matched against the statement with its whitespace collapsed.
 */
const ALLOWED_SCANS: { table: string; statement: RegExp; why: string }[] = [
  { table: "settings", statement: /^SELECT key, value FROM settings$/, why: "a handful of rows" },
  { table: "members", statement: /^SELECT \* FROM members ORDER BY joined, fid$/, why: "GET /members lists every member by design" },
  { table: "members", statement: /^SELECT fid, username FROM members$/, why: "every name, for mentions; one row a member" },
  { table: "members", statement: /^SELECT fid FROM members WHERE checked < \?/, why: "the hourly check, one row a member" },
  { table: "join_requests", statement: /^SELECT fid, username, requested, status FROM join_requests/, why: "the admin's list" },
  { table: "admin_log", statement: /^SELECT id, time, admin, action, detail FROM admin_log ORDER BY id DESC LIMIT/, why: "newest first, stopped by LIMIT" },
  { table: "used_signatures", statement: /^DELETE FROM used_signatures WHERE expires/, why: "hourly; only five minutes of sign-ins" },
  { table: "sessions", statement: /^DELETE FROM sessions WHERE expires/, why: "hourly; at most 20 a member" },
  { table: "admin_links", statement: /^DELETE FROM admin_links WHERE expires/, why: "hourly; a few at most" },
  { table: "admin_sessions", statement: /^DELETE FROM admin_sessions WHERE expires/, why: "hourly; a few at most" },
  { table: "daily_counts", statement: /^DELETE FROM daily_counts WHERE day/, why: "hourly; two days of rows" },
  { table: "removed", statement: /^DELETE FROM removed WHERE removed/, why: "hourly; two days of deletes" },
];

describe("every statement's query plan", () => {
  test("reads a whole table only where it's allowed", () => {
    assert.ok(statements.size > 30, `only ${statements.size} statements were seen`);
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.flat()) db.exec(sql);
    const unexpected: string[] = [];
    const used = new Set<(typeof ALLOWED_SCANS)[number]>();
    // And every statement in a trigger, with the row it was fired for as parameters.
    const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'").all() as { sql: string }[];
    const bodies = triggers.flatMap(({ sql }) => /\bBEGIN\b([\s\S]*)\bEND$/.exec(sql.trim())![1]!.split(";"))
      .map((body) => body.trim().replace(/\b(NEW|OLD)\.\w+/g, "?")).filter(Boolean);
    assert.ok(bodies.length > 20, `only ${bodies.length} trigger statements were seen`);
    for (const sql of [...statements, ...bodies]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail);
      const flat = sql.replace(/\s+/g, " ").trim();
      for (const step of plan) {
        const table = /^SCAN (\w+)/.exec(step)?.[1];
        // json_each, a CTE, a subquery's own rows, or a constant row aren't a table.
        if (!table || ["json_each", "CONSTANT", "j", "e"].includes(table) || step.includes("VIRTUAL TABLE")) continue;
        const allowed = ALLOWED_SCANS.find((entry) => entry.table === table && entry.statement.test(flat));
        if (allowed) used.add(allowed);
        else unexpected.push(`${step}\n    ${flat}`);
      }
    }
    assert.deepEqual(unexpected, [], `Full scans not on the list:\n${unexpected.join("\n")}`);
    // The list stays short: a scan that no longer happens comes off it.
    const stale = ALLOWED_SCANS.filter((entry) => !used.has(entry)).map((entry) => `${entry.table}: ${entry.statement}`);
    assert.deepEqual(stale, [], "Allowed scans that no longer happen");
  });
});
