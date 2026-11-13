import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Message } from "@farcaster/core";
import { NetworkClient, NetworkError } from "../client/client.ts";
import { approveDevice, Ed25519Key } from "../client/keys.ts";
import type { JoinRequest, SessionRequest } from "../src/protocol/api.ts";
import { custodyAgreed, custodyFromFirst, custodyOf, fidOf, PUBLIC_RPCS, rpcList } from "../src/protocol/chain.ts";
import { usernameOf } from "../src/protocol/fnames.ts";
import { fromHex } from "../src/protocol/protobuf.ts";
import { deviceApprover, networkApprovalIsValid, sessionSignatureIsValid } from "../src/protocol/verify.ts";

const PHRASE = "test test test test test test test test test test test junk";
const HOST = "friends.example.com";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in server: records each request and answers from `answer`. */
function fakeServer(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body instanceof Uint8Array ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    const request = { url, method: init.method ?? "GET", headers, body };
    sent.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function newClient(answer: (sent: Sent) => Response) {
  const server = fakeServer(answer);
  const identity = await approveDevice(PHRASE, 3, Ed25519Key.random());
  return { client: NetworkClient.forNetwork(identity, HOST, { fetch: server.fetch }), sent: server.sent };
}

describe("joining and signing in", () => {
  test("a join request carries approvals a server can check", async () => {
    const { client, sent } = await newClient(() => json({ status: "pending" }));
    assert.equal(await client.join({ invite: "ABC" }), "pending");
    const request = sent[0]!;
    assert.equal(request.url, `https://${HOST}/api/v1/join`);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    const body = request.body as JoinRequest;
    assert.deepEqual(Object.keys(body).sort(), ["deviceApproval", "deviceKey", "fid", "invite", "networkApproval", "networkKey"]);
    const deviceKey = fromHex(body.deviceKey)!;
    assert.equal(deviceApprover(body.fid, deviceKey, body.deviceApproval), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    assert.ok(networkApprovalIsValid(HOST, body.fid, deviceKey, fromHex(body.networkKey)!, body.networkApproval));
  });

  test("signing in keeps the token, and waiting or refusal come back as a status", async () => {
    let status = 202;
    const { client, sent } = await newClient(() =>
      status === 200 ? json({ token: "t0ken", expires: 1 }) : json({ status: status === 202 ? "pending" : "refused" }, status),
    );
    assert.equal(await client.signIn(), "pending");
    status = 403;
    assert.equal(await client.signIn(), "refused");
    status = 200;
    assert.equal(await client.signIn(), "approved");
    assert.equal(client.membership.token, "t0ken");
    const body = sent[2]!.body as SessionRequest;
    assert.ok(sessionSignatureIsValid(HOST, 3, fromHex(body.networkKey)!, body.issued, body.nonce, body.signature));
  });
});

describe("as a member", () => {
  test("posts go up as signed bytes with the token", async () => {
    const { client, sent } = await newClient((request) =>
      request.url.endsWith("/session") ? json({ token: "t0ken", expires: 1 }) : json({ hash: "0x" + "00".repeat(20) }),
    );
    await client.signIn();
    await client.post({ text: "Dinner at 7?", embeds: [{ url: "https://example.com/menu" }] });
    const request = sent[1]!;
    assert.equal(request.url, `https://${HOST}/api/v1/messages`);
    assert.equal(request.headers.authorization, "Bearer t0ken");
    assert.equal(request.headers["content-type"], "application/octet-stream");
    const message = Message.decode(request.body as Uint8Array);
    assert.equal(message.data?.castAddBody?.text, "Dinner at 7?");
    assert.deepEqual([...message.signer], [...client.membership.networkKey.publicKey]);
  });

  test("reads and changes reach the routes in the spec", async () => {
    const { client, sent } = await newClient((request) => {
      if (request.url.endsWith("/session")) return json({ token: "t", expires: 1 });
      if (request.url.endsWith("/members")) return json({ members: [] });
      if (request.url.endsWith("/admin-link")) return json({ url: "https://host/admin/login?x" });
      if (["PUT", "DELETE"].includes(request.method) || /reports|leave/.test(request.url)) return new Response(null, { status: 204 });
      return json({});
    });
    await client.signIn();
    await client.feed("c1");
    await client.thread("0x" + "ab".repeat(20));
    await client.activity();
    await client.members();
    await client.network();
    await client.updateProfile({ displayName: "Dan" });
    await client.mute(12);
    await client.unmute(12);
    await client.report("0x" + "ab".repeat(20), "Not okay");
    await client.adminLink();
    await client.leave();
    assert.deepEqual(
      sent.slice(1).map((request) => `${request.method} ${request.url.replace(`https://${HOST}/api/v1`, "")}`),
      [
        "GET /feed?cursor=c1",
        `GET /posts/0x${"ab".repeat(20)}`,
        "GET /activity",
        "GET /members",
        "GET /network",
        "PATCH /me",
        "PUT /mutes/12",
        "DELETE /mutes/12",
        "POST /reports",
        "POST /admin-link",
        "POST /leave",
      ],
    );
  });

  test("an error carries the server's message and status", async () => {
    const { client } = await newClient((request) =>
      request.url.endsWith("/session") ? json({ token: "t", expires: 1 }) : json({ message: "Too many requests. Try again later." }, 429),
    );
    await client.signIn();
    await assert.rejects(client.feed(), (error: unknown) => error instanceof NetworkError && error.status === 429 && /Too many/.test(error.message));
  });

  test("nothing is sent before signing in", async () => {
    const { client, sent } = await newClient(() => json({}));
    await assert.rejects(client.feed(), /Not signed in/);
    assert.equal(sent.length, 0);
  });
});

describe("Optimism", () => {
  const rpc = (result: string) =>
    (async () => json({ jsonrpc: "2.0", id: 1, result })) as unknown as typeof fetch;

  test("reads the custody address and FID from the ID registry's answer", async () => {
    assert.equal(await custodyOf(3, "https://rpc", rpc("0x" + "0".repeat(24) + "6B0BDA3F2FFED5EFC83FA8C024ACFF1DD45793F1")), "0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1");
    assert.equal(await custodyOf(9, "https://rpc", rpc("0x" + "0".repeat(64))), null);
    assert.equal(await fidOf("0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1", "https://rpc", rpc("0x" + "0".repeat(63) + "3")), 3);
    await assert.rejects(custodyOf(3, "https://rpc", (async () => json({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })) as unknown as typeof fetch), /rate limited/);
  });

  test("asks the next RPC when one turns the request away", async () => {
    const asked: string[] = [];
    const answer = "0x" + "0".repeat(24) + "6b0bda3f2ffed5efc83fa8c024acff1dd45793f1";
    const send = (async (url: string) => {
      asked.push(url);
      return url === "https://b" ? json({ jsonrpc: "2.0", id: 1, result: answer }) : json({ error: "busy" }, 429);
    }) as unknown as typeof fetch;
    assert.equal(await custodyFromFirst(3, rpcList("https://a, https://b"), send), "0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1");
    assert.deepEqual(asked, ["https://a", "https://b"]);
    await assert.rejects(custodyFromFirst(3, ["https://a"], send), /429/);
    assert.deepEqual(rpcList(undefined), PUBLIC_RPCS);
    assert.deepEqual(rpcList(" "), PUBLIC_RPCS);
  });

  test("takes an owner only when two RPCs agree", async () => {
    const word = (address: string) => "0x" + "0".repeat(24) + address;
    const owner = "6b0bda3f2ffed5efc83fa8c024acff1dd45793f1";
    const liar = "1111111111111111111111111111111111111111";
    const answers = (byRPC: Record<string, string | null>) => {
      const asked: string[] = [];
      const send = (async (url: string) => {
        asked.push(url);
        const result = byRPC[url];
        return result === null || result === undefined ? json({ error: "busy" }, 429) : json({ jsonrpc: "2.0", id: 1, result: word(result) });
      }) as unknown as typeof fetch;
      return { asked, send };
    };
    const rpcs = ["https://a", "https://b", "https://c", "https://d"];

    // Two agree: the rest aren't asked.
    let run = answers({ "https://a": owner, "https://b": owner });
    assert.equal(await custodyAgreed(3, rpcs, run.send), `0x${owner}`);
    assert.deepEqual(run.asked.sort(), ["https://a", "https://b"]);

    // One lies: the next breaks the tie.
    run = answers({ "https://a": liar, "https://b": owner, "https://c": owner });
    assert.equal(await custodyAgreed(3, rpcs, run.send), `0x${owner}`);
    assert.deepEqual(run.asked, ["https://a", "https://b", "https://c"]);

    // One answers and the rest are busy: not enough.
    run = answers({ "https://a": liar });
    await assert.rejects(custodyAgreed(3, rpcs, run.send), /429/);

    // One against one, and the rest busy: no owner.
    run = answers({ "https://a": liar, "https://b": owner });
    await assert.rejects(custodyAgreed(3, rpcs, run.send), /disagree/);

    // A single listed RPC is trusted alone.
    run = answers({ "https://a": liar });
    assert.equal(await custodyAgreed(3, ["https://a"], run.send), `0x${liar}`);
  });

  test("the live ID registry and fname server know FID 3", { skip: !process.env.CHECK_OPTIMISM && "Set CHECK_OPTIMISM=1 to call Optimism and the fname server" }, async () => {
    assert.equal(await custodyOf(3), "0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1");
    assert.equal(await custodyAgreed(3, PUBLIC_RPCS), "0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1");
    assert.equal(await fidOf("0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1"), 3);
    assert.equal(await custodyOf(999_999_999), null);
    assert.equal(await usernameOf(3), "dwr");
    assert.equal(await usernameOf(999_999_999), null);
  });
});
