import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { english, generateMnemonic } from "viem/accounts";
import { unstable_dev } from "wrangler";
import { NetworkClient } from "./client.ts";
import { approveDevice, custodyAddress, Ed25519Key } from "./keys.ts";

/**
 * Runs the real Worker under wrangler's local dev, with an in-memory D1, and stands in for Optimism
 * and Farcaster's fname server, so the tests and the demo need no real accounts.
 */

const folder = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** A 64 by 48 green PNG with a text chunk in it, which uploads should take out. */
export const TEST_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAFHRFWHRDb21tZW50AHNlY3JldCBwbGFjZWgPqY0AAABlSURBVHic7c9RCQAgFMDA18IYtrB/JEP4cQiDBbjNOvvrhgsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS147AJ5nZBbjcxYyAAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));

export interface Person {
  fid: number;
  phrase: string;
  username: string | null;
}

/** Answers `custodyOf` and `idOf` like the ID registry, `/transfers/current` like the fname server, and follows like a hub. */
export class FakeFarcaster {
  readonly custody = new Map<number, string>();
  readonly usernames = new Map<number, string>();
  /** Who follows whom, as a hub would answer: follower → the FIDs they follow. */
  readonly follows = new Map<number, Set<number>>();
  /** Set to make the stand-in fname server answer 503, as if it were down. */
  fnamesDown = false;
  /** FIDs the stand-in ID registry won't answer for, as if Optimism were down for them. */
  readonly custodyDown = new Set<number>();
  /** Set to make the stand-in hub answer 503, as if it were down. */
  hubDown = false;
  /** How many times the network has asked the hub, so tests can check joins never do. */
  hubCalls = 0;
  /** How many times the network has read the test page, so tests can check it reads nothing for an app that does. */
  pageLoads = 0;
  /** The most the hub gives in one page, whatever the network asks for, so tests can make it page. */
  hubPageSize = 1000;
  private server = createServer((request, response) => this.answer(request, response));
  port = 0;

  add(person: Person) {
    this.custody.set(person.fid, custodyAddress(person.phrase));
    if (person.username) this.usernames.set(person.fid, person.username);
    else this.usernames.delete(person.fid);
  }

  follow(follower: number, fid: number) {
    this.follows.set(follower, new Set([...(this.follows.get(follower) ?? []), fid]));
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private answer(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/rpc") {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        const data: string = JSON.parse(text).params[0].data;
        const argument = BigInt("0x" + data.slice(10));
        let result = 0n;
        if (data.startsWith("0x65269e47") && this.custodyDown.has(Number(argument))) return send(503, { error: "unavailable" });
        if (data.startsWith("0x65269e47")) result = BigInt(this.custody.get(Number(argument)) ?? 0);
        if (data.startsWith("0xd94fe832")) {
          const owner = [...this.custody].find(([, address]) => BigInt(address) === argument);
          result = BigInt(owner?.[0] ?? 0);
        }
        send(200, { jsonrpc: "2.0", id: 1, result: "0x" + result.toString(16).padStart(64, "0") });
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/fnames/transfers/current") {
      if (this.fnamesDown) return send(503, { error: "unavailable" });
      const fid = url.searchParams.get("fid");
      const name = url.searchParams.get("name");
      const found = fid
        ? [Number(fid), this.usernames.get(Number(fid))] as const
        : ([...this.usernames].find(([, username]) => username === name) ?? [0, undefined]);
      if (!found[1]) return send(404, { error: "Could not resolve current name" });
      return send(200, { transfer: { id: 1, timestamp: 1, username: found[1], owner: "0x0", from: 0, to: found[0] } });
    }
    // The Snapchain HTTP API call a network makes for whom the admin follows, a page at a time.
    if (request.method === "GET" && url.pathname.startsWith("/hub/")) {
      this.hubCalls += 1;
      if (this.hubDown) return send(503, { error: "unavailable" });
      if (url.pathname !== "/hub/linksByFid" || url.searchParams.get("link_type") !== "follow") return send(404, { errCode: "not_found" });
      const fid = Number(url.searchParams.get("fid"));
      const all = [...(this.follows.get(fid) ?? [])];
      const size = Math.min(Number(url.searchParams.get("pageSize")) || 100, this.hubPageSize);
      const from = Number(url.searchParams.get("pageToken") ?? "0") || 0;
      const page = all.slice(from, from + size);
      const messages = page.map((target) => ({
        data: { type: "MESSAGE_TYPE_LINK_ADD", fid, timestamp: 1, network: "FARCASTER_NETWORK_MAINNET", linkBody: { type: "follow", targetFid: target } },
      }));
      return send(200, { messages, nextPageToken: from + size < all.length ? String(from + size) : "" });
    }
    // A picture and a page for avatars and link previews, which local networks may fetch over plain HTTP.
    if (request.method === "GET" && (url.pathname === "/test/avatar.png" || url.pathname === "/test/preview.png")) {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(TEST_PNG.length) });
      response.end(TEST_PNG);
      return;
    }
    // A redirect to something that isn't a URL, as a broken or hostile page might send.
    if (request.method === "GET" && url.pathname === "/test/bad-redirect") {
      response.writeHead(302, { location: "https://[not a host/" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/test/page.html") {
      this.pageLoads++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Ignored title</title>
<meta property="og:title" content="The Cabin Kitchen menu">
<meta property="og:description" content="Breakfast from 7, dinner on Saturdays &amp; Sundays.">
<meta property="og:image" content="/test/preview.png"></head><body>Menu</body></html>`);
      return;
    }
    send(404, { error: "not found" });
  }

  /** Where this stand-in serves its test picture and page. */
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }
}

export function newPerson(fid: number, username: string | null): Person {
  return { fid, phrase: generateMnemonic(english), username };
}

/** `wanted` if nothing is listening there, otherwise any free port. */
async function freePort(wanted = 0): Promise<number> {
  const server = createServer();
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(wanted, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return freePort(0);
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A Worker running locally. */
export interface LocalNetwork {
  host: string;
  /** A new device for this person, joined to nothing yet. */
  device(person: Person): Promise<NetworkClient>;
  /** Runs the hourly job as if it were `at` (Unix seconds). */
  runHourly(at: number): Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

/** A local Worker that reads made-up accounts from `farcaster`. */
export interface TestNetwork extends LocalNetwork {
  farcaster: FakeFarcaster;
}

/**
 * The real wrangler.jsonc with its rate limits raised, because every test request comes from one
 * address. Written to a temporary folder so the real config stays as it is.
 */
function testConfig() {
  const text = readFileSync(folder("wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text);
  config.main = folder(config.main);
  for (const limit of config.ratelimits) limit.simple.limit = 100_000;
  const path = join(mkdtempSync(join(tmpdir(), "fatline-network-")), "wrangler.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

async function launch(adminFid: number, port: number, vars: Record<string, string>, stopAlso: () => Promise<void>): Promise<LocalNetwork> {
  const host = `localhost:${port}`;
  const worker = await unstable_dev(folder("src/server/index.ts"), {
    config: testConfig(),
    ip: "127.0.0.1",
    port,
    persist: false,
    logLevel: "error",
    vars: { ADMIN_FID: String(adminFid), NETWORK_HOST: host, ...vars },
    experimental: { disableExperimentalWarning: true, testScheduled: true },
  });
  return {
    host,
    async device(person) {
      const identity = await approveDevice(person.phrase, person.fid, Ed25519Key.random());
      return NetworkClient.forNetwork(identity, host);
    },
    async runHourly(at) {
      const response = await fetch(`http://${host}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 * * * *")}&time=${at * 1000}`);
      if (!response.ok) throw new Error(`The hourly job answered ${response.status}: ${await response.text()}`);
    },
    fetch: (path, init) => fetch(`http://${host}${path}`, init),
    async stop() {
      await worker.stop();
      await stopAlso();
    },
  };
}

/** A local network with made-up accounts. Nothing reaches Farcaster or Optimism. */
export async function startNetwork(admin: Person, options: { port?: number; vars?: Record<string, string> } = {}): Promise<TestNetwork> {
  const farcaster = new FakeFarcaster();
  await farcaster.start();
  farcaster.add(admin);
  const network = await launch(admin.fid, await freePort(options.port), {
    OPTIMISM_RPC_URL: `http://127.0.0.1:${farcaster.port}/rpc`,
    FNAME_URL: `http://127.0.0.1:${farcaster.port}/fnames`,
    HUB_URL: `http://127.0.0.1:${farcaster.port}/hub`,
    TEST_FETCH_ORIGIN: farcaster.origin,
    ...options.vars,
  }, () => farcaster.stop());
  return { ...network, farcaster };
}

/**
 * A local network that checks real accounts with Optimism's public RPC and Farcaster's fname server,
 * as a deployed one would. Posts stay on this computer.
 */
export function startRealNetwork(adminFid: number, options: { port?: number } = {}): Promise<LocalNetwork> {
  return freePort(options.port).then((port) => launch(adminFid, port, {}, async () => {}));
}
