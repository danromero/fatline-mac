import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { unstable_dev } from "wrangler";
import { NetworkClient } from "../client/client.ts";
import { approveDevice, Ed25519Key } from "../client/keys.ts";
import { FakeFarcaster, newPerson } from "../client/local.ts";

/** A member's reads a minute, against the real Worker with READS turned down. The other tests raise every limit. */

const READS = 5;
const HOST = "localhost:1";
const folder = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const farcaster = new FakeFarcaster();
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;

const send = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${worker!.port}${path}`, init);
const toWorker: typeof fetch = (input, init) => send(String(input).replace(`http://${HOST}`, ""), init);

before(async () => {
  await farcaster.start();
  const parsed = JSON.parse(readFileSync(folder("wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  parsed.main = folder(parsed.main);
  for (const binding of parsed.ratelimits) binding.simple.limit = binding.name === "READS" ? READS : 100_000;
  const config = join(mkdtempSync(join(tmpdir(), "fatline-reads-")), "wrangler.json");
  writeFileSync(config, JSON.stringify(parsed));
  worker = await unstable_dev(folder("src/server/index.ts"), {
    config,
    ip: "127.0.0.1",
    persist: false,
    logLevel: "error",
    vars: { ADMIN_FID: "3001", NETWORK_HOST: HOST, OPTIMISM_RPC_URL: `http://127.0.0.1:${farcaster.port}/rpc`, FNAME_URL: `http://127.0.0.1:${farcaster.port}/fnames` },
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker?.stop();
  await farcaster.stop();
});

describe("a member's reads", () => {
  test("are limited a minute, and changes aren't", async () => {
    const admin = newPerson(3001, "admin");
    farcaster.add(admin);
    const client = NetworkClient.forNetwork(await approveDevice(admin.phrase, admin.fid, Ed25519Key.random()), HOST, { fetch: toWorker });
    assert.equal(await client.join(), "approved");
    assert.equal(await client.signIn(), "approved");
    const seen: number[] = [];
    // Windows start on the minute, so one may roll over partway. Twice the limit, and one more, is always enough.
    for (let attempt = 0; attempt <= 2 * READS && !seen.includes(429); attempt++) {
      const response = await send("/api/v1/feed", { headers: { authorization: `Bearer ${client.membership.token}` } });
      await response.arrayBuffer();
      seen.push(response.status);
    }
    assert.equal(seen.at(-1), 429, `answered ${seen.join(", ")}`);
    assert.ok(seen.slice(0, -1).every((status) => status === 200), `answered ${seen.join(", ")}`);
    assert.ok(await client.post({ text: "Posting isn't a read" }));
  });
});
