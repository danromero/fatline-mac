import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { unstable_dev } from "wrangler";
import { NetworkClient } from "../client/client.ts";
import { approveDevice, Ed25519Key } from "../client/keys.ts";
import { FakeFarcaster, newPerson } from "../client/local.ts";
import type { Person } from "../client/local.ts";

/**
 * Changing ADMIN_FID, against the real Worker: one network run by one FID, then the same database
 * deployed with another. The old admin's stored role still says admin, and must count for nothing.
 */

const HOST = "localhost:1";
const folder = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const first = newPerson(2001, "first");
const second = newPerson(2002, "second");

const farcaster = new FakeFarcaster();
const database = mkdtempSync(join(tmpdir(), "fatline-admin-role-"));
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;

/** The real wrangler.jsonc with its limits raised, in a temporary folder. */
function config() {
  const parsed = JSON.parse(readFileSync(folder("wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  parsed.main = folder(parsed.main);
  for (const binding of parsed.ratelimits) binding.simple.limit = 100_000;
  const path = join(mkdtempSync(join(tmpdir(), "fatline-admin-role-config-")), "wrangler.json");
  writeFileSync(path, JSON.stringify(parsed));
  return path;
}

/** Runs the Worker on the same database, run by `admin`. */
async function deploy(admin: Person) {
  await worker?.stop();
  worker = await unstable_dev(folder("src/server/index.ts"), {
    config: config(),
    ip: "127.0.0.1",
    persistTo: database,
    logLevel: "error",
    vars: {
      ADMIN_FID: String(admin.fid),
      NETWORK_HOST: HOST,
      OPTIMISM_RPC_URL: `http://127.0.0.1:${farcaster.port}/rpc`,
      FNAME_URL: `http://127.0.0.1:${farcaster.port}/fnames`,
    },
    experimental: { disableExperimentalWarning: true },
  });
}

/** Whichever Worker is running now, whatever port it has. Signatures always name HOST. */
const send = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${worker!.port}${path}`, init);
const toWorker: typeof fetch = (input, init) => send(String(input).replace(`http://${HOST}`, ""), init);

async function device(person: Person) {
  farcaster.add(person);
  return NetworkClient.forNetwork(await approveDevice(person.phrase, person.fid, Ed25519Key.random()), HOST, { fetch: toWorker });
}

const bearer = (client: NetworkClient) => ({ authorization: `Bearer ${client.membership.token}` });

before(async () => {
  await farcaster.start();
});

after(async () => {
  await worker?.stop();
  await farcaster.stop();
  rmSync(database, { recursive: true, force: true });
});

describe("changing ADMIN_FID", () => {
  let old: NetworkClient;
  let cookie = "";

  test("the first admin runs the network", async () => {
    await deploy(first);
    old = await device(first);
    assert.equal(await old.join(), "approved");
    assert.equal(await old.signIn(), "approved");
    assert.equal((await old.network()).you.role, "admin");
    const link = new URL(await old.adminLink());
    const login = await send(link.pathname + link.search, { redirect: "manual" });
    assert.equal(login.status, 303);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await send("/admin/requests", { headers: { cookie } })).status, 200);
  });

  test("once ADMIN_FID names someone else, the old admin is a member everywhere", async () => {
    await deploy(second);
    assert.equal((await old.network()).you.role, "member", "GET /network");
    assert.equal((await old.members()).find((member) => member.fid === first.fid)?.role, "member", "GET /members");
    assert.equal((await send("/api/v1/admin/requests", { headers: bearer(old) })).status, 403, "the admin API");
    assert.equal((await send("/api/v1/admin-link", { method: "POST", headers: bearer(old) })).status, 403, "a sign-in link");
    assert.equal((await send("/admin/requests", { headers: { cookie } })).status, 401, "the admin page session they already had");
  });

  test("the new admin joins as admin, and sees the old one as a member they can remove", async () => {
    const next = await device(second);
    assert.equal(await next.join(), "approved");
    assert.equal(await next.signIn(), "approved");
    assert.equal((await next.network()).you.role, "admin");
    const link = new URL(await next.adminLink());
    const login = await send(link.pathname + link.search, { redirect: "manual" });
    const page = await send("/admin/members", { headers: { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0]! } });
    assert.ok((await page.text()).includes(`action="/admin/members/${first.fid}/remove"`));
    await next.removeMember(first.fid);
    assert.ok(!(await next.members()).some((member) => member.fid === first.fid));
  });
});
