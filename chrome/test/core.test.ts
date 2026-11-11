import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blake3 } from "@noble/hashes/blake3.js";
import { farcasterURL, imageURL, linkedText, linkLabel, shortAge } from "../src/core/cast.ts";
import { choiceFromTyped, connectionFor, httpsServer, parseInvite } from "../src/core/connection.ts";
import { FeedHTTPError, PostingError } from "../src/core/errors.ts";
import { emptyFeedState, FeedModel } from "../src/core/feedModel.ts";
import type { FeedState } from "../src/core/feedModel.ts";
import { feedCast, FeedReader } from "../src/core/feedReader.ts";
import type { Read } from "../src/core/feedReader.ts";
import { Client, connectionProblem } from "../src/core/http.ts";
import type { HTTPRequest, HTTPResponse } from "../src/core/http.ts";
import { fromHex, makeCast, makeKeyAdd, makeRemoval, toHex } from "../src/core/message.ts";
import type { Signer } from "../src/core/message.ts";
import { Snapchain } from "../src/core/snapchain.ts";
import { IOS_CAST, IOS_KEY_ADD } from "./fixtures.ts";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));

/** Reads one protobuf message into its fields. Enough for these fixtures. */
function fields(data: Uint8Array): Map<number, Uint8Array | number> {
  const found = new Map<number, Uint8Array | number>();
  let index = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    while (true) {
      const byte = data[index++];
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
  };
  while (index < data.length) {
    const tag = varint();
    if ((tag & 7) === 0) found.set(tag >> 3, varint());
    else {
      const length = varint();
      found.set(tag >> 3, data.slice(index, index + length));
      index += length;
    }
  }
  return found;
}

const signerFrom = (message: Map<number, Uint8Array | number>): Signer => ({
  publicKey: message.get(6) as Uint8Array,
  sign: async () => message.get(4) as Uint8Array,
});

const fixtureDate = new Date(1_790_000_000_000);

describe("signing matches what the iOS app signed", () => {
  test("a cast is byte for byte the same", async () => {
    const fixture = bytes(IOS_CAST);
    const message = fields(fixture);
    const cast = await makeCast(42, "Hello from iOS café", signerFrom(message), fixtureDate);
    assert.equal(toHex(cast.bytes), toHex(fixture));
    assert.equal(cast.hash, toHex(blake3(message.get(1) as Uint8Array, { dkLen: 20 })));
  });

  // The fixture predates delete, so its key has one scope. Everything else has to match.
  test("a key authorization differs only by adding the delete scope", async () => {
    const fixture = bytes(IOS_KEY_ADD);
    const message = fields(fixture);
    const data = fields(message.get(1) as Uint8Array);
    const body = fields(data.get(19) as Uint8Array);
    const signed = await makeKeyAdd({
      fid: data.get(2) as number,
      deadline: body.get(4) as number,
      nonce: body.get(5) as number,
      ttl: body.get(10) as number,
      custodySignature: body.get(3) as Uint8Array,
      metadata: body.get(6) as Uint8Array,
    }, signerFrom(message), new Date(((data.get(3) as number) + 1_609_459_200) * 1000));
    const ours = fields(fields(fields(signed.bytes).get(1) as Uint8Array).get(19) as Uint8Array);
    assert.deepEqual([...(body.get(9) as Uint8Array)], [1]);
    assert.deepEqual([...(ours.get(9) as Uint8Array)], [1, 2]);
    ours.delete(9);
    body.delete(9);
    assert.deepEqual([...ours.entries()], [...body.entries()]);
  });

  test("a removal names the target hash", async () => {
    const target = `0x${"ab".repeat(20)}`;
    const signer: Signer = { publicKey: new Uint8Array(32), sign: async () => new Uint8Array(64) };
    const removal = await makeRemoval(42, target.toUpperCase().replace("0X", "0x"), signer, fixtureDate);
    assert.equal(removal.target, target);
    assert.ok(toHex(removal.bytes).includes(`0802102a1880ab8b56200132160a14${"ab".repeat(20)}`));
  });

  test("the limit is UTF-8 bytes, and blank casts are refused", async () => {
    const signer: Signer = { publicKey: new Uint8Array(32), sign: async () => new Uint8Array(64) };
    await makeCast(1, "é".repeat(160), signer, fixtureDate);
    await assert.rejects(makeCast(1, `${"é".repeat(160)}a`, signer, fixtureDate));
    await assert.rejects(makeCast(1, " \n ", signer, fixtureDate));
    await assert.rejects(makeRemoval(1, "0xabc", signer, fixtureDate));
  });

  test("hex needs its prefix", () => {
    assert.equal(fromHex("abcd"), null);
    assert.deepEqual([...fromHex("0xabcd")!], [0xab, 0xcd]);
  });
});

describe("connections", () => {
  test("only HTTPS servers are accepted", () => {
    assert.equal(httpsServer("example.com/"), "https://example.com");
    assert.equal(httpsServer("http://example.com"), null);
    assert.equal(httpsServer("https://user:pw@example.com"), null);
    assert.equal(httpsServer("https://example.com?x=1"), null);
  });

  test("invites are one code and one server", () => {
    assert.deepEqual(parseInvite("ABC-1@server.example:8443/fatline"), { code: "ABC-1", server: "https://server.example:8443/fatline" });
    assert.equal(parseInvite("a b@server.example"), null);
    assert.equal(parseInvite("a@b@c"), null);
  });

  test("routes match the Mac app", () => {
    assert.equal(connectionFor({ kind: "custom", url: "https://s.example/k" }).feedBase, "https://s.example/k/v2/farcaster");
    assert.equal(connectionFor({ kind: "invite", code: "c", server: "https://s.example" }).nodeBase, "https://s.example/v1/node");
    assert.equal(choiceFromTyped("neynar", "two words"), null);
  });

  test("the credential only goes to its own servers", async () => {
    const seen: HTTPRequest[] = [];
    const client = new Client(connectionFor({ kind: "neynar", key: "secret" }), async (request) => {
      seen.push(request);
      return { status: 200, text: "{}" };
    });
    await client.raw("https://api.neynar.com/v2/farcaster", "x", {});
    await client.raw("https://elsewhere.example", "x", {});
    assert.equal(seen[0].headers["x-api-key"], "secret");
    assert.equal(seen[1].headers["x-api-key"], undefined);
  });

  test("a custom server that can't sign in is turned away", async () => {
    const choice = { kind: "custom" as const, url: "https://s.example" };
    const answers = (signers: string) => new Client(connectionFor(choice), async (request): Promise<HTTPResponse> => {
      if (request.url.includes("feed/following")) return { status: 200, text: '{"casts":[]}' };
      if (request.url.includes("userDataByFid")) return { status: 200, text: '{"messages":[]}' };
      return { status: 200, text: signers };
    });
    assert.equal(await connectionProblem(choice, answers('{"signers":[],"currentUserNonce":0}')), null);
    assert.match((await connectionProblem(choice, answers('{"signers":[]}')))!, /Snapchain/);
  });
});

function scripted(responses: (HTTPResponse | null)[]) {
  const requests: HTTPRequest[] = [];
  const client = new Client(connectionFor({ kind: "invite", code: "c", server: "https://s.example" }), async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("lost connection");
    return next;
  });
  return { node: new Snapchain(client, async () => {}), requests };
}

describe("posting", () => {
  const cast = { fid: 42, text: "Hello", hash: "0xaa", bytes: new Uint8Array([1]), timestamp: 1 };
  const receipt = { status: 200, text: '{"hash":"0xaa","data":{"fid":42}}' };

  test("a receipt for this cast is success", async () => {
    await scripted([receipt]).node.submit(cast);
  });

  test("a lost answer is confirmed by looking the cast up", async () => {
    await scripted([null, receipt]).node.submit(cast);
  });

  test("a clear rejection is shown", async () => {
    const { node } = scripted([{ status: 400, text: '{"message":"bad"}' }, { status: 404, text: "" }]);
    await assert.rejects(node.submit(cast), (error: PostingError) => error.kind === "rejected" && error.message === "bad");
  });

  test("an unclear answer stays unconfirmed", async () => {
    const { node } = scripted([{ status: 500, text: "" }, { status: 404, text: "" }, { status: 500, text: "" }, { status: 404, text: "" }]);
    await assert.rejects(node.submit(cast), (error: PostingError) => error.kind === "unconfirmed");
  });

  test("a retry looks first, and doesn't resend what already landed", async () => {
    const { node, requests } = scripted([receipt]);
    await node.submit(cast, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
  });

  test("a deletion whose cast is gone is a success", async () => {
    const removal = { fid: 42, target: "0xbb", hash: "0xcc", bytes: new Uint8Array([1]) };
    await scripted([null, { status: 404, text: "" }]).node.remove(removal);
  });

  test("account lookup returns the FID and next nonce", async () => {
    const address = "0x00000000000000000000000000000000000000aa";
    const { node } = scripted([
      { status: 200, text: JSON.stringify({ fid: 42, idRegisterEventBody: { to: address } }) },
      { status: 200, text: '{"signers":[],"currentUserNonce":2}' },
    ]);
    assert.deepEqual(await node.account(address), { fid: 42, nonce: 3 });
  });

  test("a phrase with no account says so", async () => {
    const { node } = scripted([{ status: 400, text: '{"message":"status: NotFound"}' }]);
    await assert.rejects(node.account("0xaa"), (error: PostingError) => error.kind === "accountNotFound");
  });

  test("key state reads scope and expiry", () => {
    const text = (extra: string) => `{"signers":[{"fid":1,"key":"0xabc"${extra}}]}`;
    assert.deepEqual(Snapchain.parseSignerState(text(""), 1, "0xabc"), { status: "active", canDelete: true });
    assert.equal(Snapchain.parseSignerState(text(',"scopes":["MESSAGE_TYPE_CAST_ADD"]'), 1, "0xabc").canDelete, false);
    assert.equal(Snapchain.parseSignerState(text(',"expiresAt":100'), 1, "0xabc", 200_000).status, "expired");
    assert.equal(Snapchain.parseSignerState(text(""), 2, "0xabc").status, "missing");
  });
});

describe("casts", () => {
  const remote = (extra: object) => ({ hash: "abc", timestamp: "2026-11-09T12:00:00.000Z", author: { fid: 1, username: "a" }, text: "hi", ...extra });

  test("replies are left out and hashes get their prefix", () => {
    assert.equal(feedCast(remote({ parent_hash: "0x1" })), null);
    assert.equal(feedCast(remote({}))!.hash, "0xabc");
  });

  test("mentions the network left out are written in at their UTF-8 offset", () => {
    const cast = feedCast(remote({ text: "é hi", mentioned_profiles: [{ username: "bob" }], mentioned_profiles_ranges: [{ start: 3, end: 3 }] }));
    assert.equal(cast!.text, "é @bobhi");
  });

  test("images and links are told apart", () => {
    const cast = feedCast(remote({ embeds: [
      { url: "https://imagedelivery.net/a/b" },
      { url: "https://example.com/page", metadata: { content_type: "text/html" } },
      { url: "https://example.com/video.mp4" },
    ] }));
    assert.deepEqual(cast!.images, ["https://imagedelivery.net/a/b"]);
    assert.deepEqual(cast!.links, ["https://example.com/page"]);
  });

  test("only public HTTPS images load", () => {
    assert.equal(imageURL("https://printer.local./x.png"), null);
    assert.equal(imageURL("https://localhost./x.png"), null);
    assert.equal(imageURL("http://a.example/x.png"), null);
    assert.equal(imageURL("https://printer.local/x.png"), null);
    assert.equal(imageURL("https://192.168.1.1/x.png"), null);
    assert.ok(imageURL("https://a.example/x.png"));
  });

  test("text links open what they spell out", () => {
    assert.deepEqual(linkedText("see example.com/a."), [{ text: "see " }, { text: "example.com/a", url: "https://example.com/a" }, { text: "." }]);
    assert.deepEqual(linkedText("node.js is fine"), [{ text: "node.js is fine" }]);
    assert.deepEqual(linkedText("xn--pple-43d.com"), [{ text: "xn--pple-43d.com" }]);
    assert.equal(linkedText("http://a.example")[0].url, "http://a.example/");
  });

  test("labels and Farcaster links", () => {
    assert.equal(linkLabel("https://www.example.com/a"), "example.com/a");
    assert.equal(farcasterURL({ hash: "0x1234567890ab", fid: 1, time: 0, text: "" }, "Dan"), "https://farcaster.xyz/dan/0x12345678");
    assert.equal(farcasterURL({ hash: "0x1234567890ab", fid: 1, time: 0, text: "" }, "1"), null);
  });

  test("ages", () => {
    const now = 1_790_000_000_000;
    assert.equal(shortAge(now / 1000 - 5, now), "Now");
    assert.equal(shortAge(now / 1000 - 300, now), "5m");
    assert.equal(shortAge(now / 1000 - 7200, now), "2h");
    assert.equal(shortAge(now / 1000 - 172800, now), "2d");
  });
});

describe("reading the network", () => {
  const reader = (body: object) => new FeedReader(new Client(connectionFor({ kind: "custom", url: "https://s.example" }), async () => ({ status: 200, text: JSON.stringify(body) })));
  const good = { hash: "abc", timestamp: "2026-11-09T12:00:00.000Z", author: { fid: 1, username: "a" }, text: "hi" };

  test("one bad row doesn't fail the page", async () => {
    const read = await reader({ casts: [{ ...good, hash: "bad", text: 5 }, { ...good, embeds: [null] }] }).poll(1, 0, new Set([1]));
    assert.deepEqual(read.casts.map((cast) => cast.hash), ["0xabc"]);
  });

  test("a successful answer missing its list is a failure, not an empty feed", async () => {
    await assert.rejects(reader({}).poll(1, 0, new Set([1])), (error: FeedHTTPError) => error.status === 502);
    await assert.rejects(reader({}).follows(1), (error: FeedHTTPError) => error.status === 502);
  });
});

describe("the feed", () => {
  function model(start = 1_790_000_000) {
    let clock = start;
    let reads = 0;
    let avatars = 0;
    let saved: FeedState | undefined = emptyFeedState();
    const readResult = (fid: number, text: string): Read => ({
      casts: [{ hash: `0x${text}`, fid, time: clock - 10, text }],
      handles: { [fid]: "person" },
      latestSeen: clock - 10,
      complete: true,
    });
    const feed = new FeedModel({
      fid: 1,
      handle: "me",
      source: "s",
      usesInvite: false,
      reader: {
        follows: async () => [{ handle: "person", fid: 2 }],
        avatar: async () => { avatars++; return "https://a.example/me.png"; },
        window: async () => { reads++; return readResult(2, "full"); },
        poll: async () => { reads++; return readResult(2, `poll${reads}`); },
      },
      load: async () => saved,
      save: async (state) => { saved = state; },
      changed: () => {},
      now: () => clock * 1000,
    });
    return { feed, tick: (seconds: number) => { clock += seconds; }, reads: () => reads, avatars: () => avatars, saved: () => saved! };
  }

  test("a sign-in reads the list and the whole window", async () => {
    const { feed, reads } = model();
    await feed.start(true);
    assert.deepEqual(feed.casts.map((cast) => cast.text), ["full"]);
    assert.equal(reads(), 1);
  });

  test("reads are spaced out, so many tabs can't spend more", async () => {
    const { feed, reads, tick } = model();
    await feed.start(true);
    tick(30);
    await feed.refresh("launch");
    assert.equal(reads(), 1);
    tick(20);
    await feed.refresh("launch");
    assert.equal(reads(), 2);
  });

  test("returning to the tab waits a minute", async () => {
    const { feed, reads, tick } = model();
    await feed.start(true);
    tick(59);
    await feed.refreshIfStale();
    assert.equal(reads(), 1);
    tick(2);
    await feed.refreshIfStale();
    assert.equal(reads(), 2);
  });

  test("a new frame within the minute reads nothing", async () => {
    const { feed, reads, tick } = model();
    await feed.start(true);
    tick(50);
    await feed.start(false);
    assert.equal(reads(), 1);
    tick(11);
    await feed.start(false);
    assert.equal(reads(), 2);
  });

  test("hidden people leave the feed", async () => {
    const { feed } = model();
    await feed.start(true);
    await feed.toggleVisibility(2);
    assert.equal(feed.casts.length, 0);
  });

  test("your own post shows right away, and a deleted one stays gone", async () => {
    const { feed, tick } = model();
    await feed.start(true);
    const posted = { hash: "0xmine", fid: 1, time: 1_790_000_000, text: "mine" };
    tick(5);
    await feed.addPosted(posted);
    assert.equal(feed.casts[0].text, "mine");
    await feed.removeDeleted(posted);
    assert.ok(!feed.casts.some((cast) => cast.hash === "0xmine"));
  });

  test("your own casts show your picture, looked up once a day", async () => {
    const { feed, avatars, tick } = model();
    await feed.start(true);
    await feed.addPosted({ hash: "0xmine", fid: 1, time: 1_790_000_000, text: "mine" });
    assert.equal(feed.casts.find((cast) => cast.hash === "0xmine")!.avatar, "https://a.example/me.png");
    tick(120);
    await feed.refresh("pull");
    assert.equal(avatars(), 1);
    tick(86_400);
    await feed.refresh("pull");
    assert.equal(avatars(), 2);
  });

  test("errors become the right banner", async () => {
    const failing = (status: number, usesInvite: boolean) => new FeedModel({
      fid: 1, handle: "me", source: "s", usesInvite,
      reader: { avatar: async () => null, follows: async () => { throw new FeedHTTPError(status); }, window: async () => { throw new Error(); }, poll: async () => { throw new Error(); } },
      load: async () => undefined, save: async () => {}, changed: () => {},
    });
    const refused = failing(401, false);
    await refused.start(true);
    assert.equal(refused.problem, "refused");
    const limited = failing(402, true);
    await limited.start(true);
    assert.equal(limited.problem, "limitReached");
    const down = failing(503, false);
    await down.start(true);
    assert.equal(down.problem, "unreachable");
  });

  test("a server change drops its casts", async () => {
    const { saved, feed } = model();
    await feed.start(true);
    const state = saved();
    const moved = new FeedModel({
      fid: 1, handle: "me", source: "other", usesInvite: false,
      reader: { avatar: async () => null, follows: async () => [], window: async () => ({ casts: [], handles: {}, latestSeen: 0, complete: true }), poll: async () => ({ casts: [], handles: {}, latestSeen: 0, complete: true }) },
      load: async () => state, save: async () => {}, changed: () => {},
    });
    await moved.start(false);
    assert.equal(moved.casts.length, 0);
  });
});
