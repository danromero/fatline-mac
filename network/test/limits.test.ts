import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { unstable_dev } from "wrangler";
import { english, generateMnemonic } from "viem/accounts";
import { NetworkClient } from "../client/client.ts";
import { approveDevice, Ed25519Key } from "../client/keys.ts";

/**
 * The per-address limit, against the real Worker with REQUESTS turned down to a few a minute. The
 * other server tests raise every limit, since all their requests come from one address.
 */

const LIMIT = 4;
const CUSTODY_LIMIT = 3;
const PICTURES_LIMIT = 5;
const INVITE_PATH = "limits-invite-path-0123456789";
const folder = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** wrangler.jsonc with only REQUESTS turned down, written to a temporary folder. */
function config() {
  const parsed = JSON.parse(readFileSync(folder("wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  parsed.main = folder(parsed.main);
  const limits: Record<string, number> = { REQUESTS: LIMIT, CUSTODY: CUSTODY_LIMIT, PICTURES: PICTURES_LIMIT };
  for (const binding of parsed.ratelimits) binding.simple.limit = limits[binding.name] ?? 100_000;
  const path = join(mkdtempSync(join(tmpdir(), "fatline-limits-")), "wrangler.json");
  writeFileSync(path, JSON.stringify(parsed));
  return path;
}

let worker: Awaited<ReturnType<typeof unstable_dev>>;
const send = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${worker.port}${path}`, init);

before(async () => {
  worker = await unstable_dev(folder("src/server/index.ts"), {
    config: config(),
    ip: "127.0.0.1",
    persist: false,
    logLevel: "error",
    // Nothing listens on port 9, so asking Optimism fails at once, as a throttled RPC would.
    vars: { ADMIN_FID: "1", OPTIMISM_RPC_URL: "http://127.0.0.1:9/rpc", MINIMUM_MAC_VERSION: "0.4.0", INVITE_PATH },
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker?.stop();
});

/** Sends a request until it's turned away, and gives each answer's status. */
async function statuses(send: () => Promise<Response>) {
  const seen: number[] = [];
  // Windows start on the minute, so one may roll over partway. Twice the limit, and one more, is always enough.
  for (let attempt = 0; attempt <= 2 * LIMIT && !seen.includes(429); attempt++) {
    const response = await send();
    await response.arrayBuffer();
    seen.push(response.status);
  }
  return seen;
}

describe("requests from one address", () => {
  test("made-up tokens and cookies are limited per address, before anything looks them up", async () => {
    const junk = { authorization: "Bearer not-a-real-token-at-all" };
    const tries: [string, RequestInit][] = [
      ["/api/v1/feed", { headers: junk }],
      ["/api/v1/admin/requests", { headers: junk }],
      ["/admin/requests", { headers: { cookie: "fatline_admin=not-a-real-cookie-value-at-all" } }],
      ["/admin/login?token=not-a-real-link-token-at-all", {}],
    ];
    for (const [index, [path, init]] of tries.entries()) {
      const seen = await statuses(() => send(path, init));
      assert.equal(seen.at(-1), 429, `${path} answered ${seen.join(", ")}`);
      assert.ok(seen.slice(0, -1).every((status) => status === 401), `${path} answered ${seen.join(", ")}`);
      // The first path uses up the address's limit, and the rest share it.
      if (index === 0) assert.ok(seen.length > 1, "the first requests get through, to be refused");
    }
  });

  test("routes anyone can call keep their own limit", async () => {
    assert.equal((await send("/api/v1/")).status, 200);
    assert.equal((await send("/api/v1/invites/NOPE")).status, 404);
  });

  test("made-up joins from new devices ask Optimism only so often, across the whole network", async () => {
    const host = `127.0.0.1:${worker.port}`;
    const seen: number[] = [];
    for (let attempt = 0; attempt <= 2 * CUSTODY_LIMIT && !seen.includes(429); attempt++) {
      // A new phrase each time: any key can sign an approval for FID 3.
      const identity = await approveDevice(generateMnemonic(english), 3, Ed25519Key.random());
      const response = await send("/api/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(NetworkClient.forNetwork(identity, host).joinRequest()),
      });
      await response.arrayBuffer();
      seen.push(response.status);
    }
    assert.equal(seen.at(-1), 429, `answers were ${seen.join(", ")}`);
    assert.ok(seen.slice(0, -1).every((status) => status === 503), `answers were ${seen.join(", ")}`);
  });

  test("an old Mac build is limited by address too, before its answer reads the network's name", async () => {
    // The first test left this address over its limit for the minute.
    const old = await send("/api/v1/", { headers: { "fatline-app": "mac/0.3.90" } });
    assert.ok(old.status === 429 || old.status === 426, `answered ${old.status}`);
    // Each with a code an app can act on, whatever the words.
    assert.equal(((await old.json()) as { code: string }).code, old.status === 429 ? "too-many" : "update-required");
    const seen = await statuses(() => send("/api/v1/feed", { headers: { "fatline-app": "mac/0.3.90" } }));
    assert.equal(seen.at(-1), 429, `answered ${seen.join(", ")}`);
    assert.ok(seen.slice(0, -1).every((status) => status === 426), `answered ${seen.join(", ")}`);
  });

  test("the invite page, which reads the network's name, is limited by address", async () => {
    // The first test left this address over its limit for the minute, so this may be turned away at once.
    const seen = await statuses(() => send(`/${INVITE_PATH}/invite`));
    assert.equal(seen.at(-1), 429, `answered ${seen.join(", ")}`);
    assert.ok(seen.slice(0, -1).every((status) => status === 200), `answered ${seen.join(", ")}`);
    // A post's page reads nothing, so it isn't.
    assert.equal((await send(`/p/0x${"a".repeat(40)}`)).status, 200);
  });

  test("image links and the network's picture are limited by address", async () => {
    const seen: number[] = [];
    for (let attempt = 0; attempt <= 2 * PICTURES_LIMIT && !seen.includes(429); attempt++) {
      const response = await send(attempt % 2 ? "/icon" : `/media/${"a".repeat(22)}/thumb?e=1&s=x`);
      await response.arrayBuffer();
      seen.push(response.status);
    }
    assert.equal(seen.at(-1), 429, `answered ${seen.join(", ")}`);
    assert.ok(seen.slice(0, -1).every((status) => status === 404 || status === 403), `answered ${seen.join(", ")}`);
  });
});

