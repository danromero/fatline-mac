import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const PATH = "/mock-secret-path";
const SCRIPT = fileURLToPath(new URL("../check.sh", import.meta.url));
const ADDRESS = "0x7071cfba18280fd0bc1142d98f8e67fb094d9544";
const FIRST = `0x${"a".repeat(40)}`;
const SECOND = `0x${"b".repeat(40)}`;
const NOT_FOUND = { status: 400, body: { error: "x", error_detail: 'status: NotFound, message: "x"' } };

function answer(route, query, method) {
  if (route === "/v2/farcaster/feed/following/") {
    if (query.get("fid") === "1") return { body: { casts: [] } };
    if (query.get("cursor") === "next%3D") return { body: { casts: [{ hash: SECOND, author: { fid: 2 } }] } };
    return { body: { casts: [{ hash: FIRST, author: { fid: 2 } }], next: { cursor: "next%3D" } } };
  }
  if (route === "/v2/farcaster/user/bulk/") return { body: { users: [{ fid: 1, custody_address: ADDRESS }] } };
  if (route === "/v1/userDataByFid") return { body: { messages: [] } };
  if (route === "/v1/signersByFid") return { body: { currentUserNonce: 0, signers: [{ fid: 1, key: "0x11" }] } };
  if (route === "/v1/onChainIdRegistryEventByAddress") {
    if (query.get("address") !== ADDRESS) return NOT_FOUND;
    return { body: { fid: 1, idRegisterEventBody: { to: ADDRESS } } };
  }
  if (route === "/v1/linksByFid") {
    const body = { messages: [{ data: { linkBody: { targetFid: 9 } } }] };
    return { body: query.get("pageToken") ? body : { ...body, nextPageToken: "abc=" } };
  }
  if (route === "/v1/castById") return query.get("hash") === FIRST ? { body: { hash: FIRST } } : NOT_FOUND;
  if (route === "/v1/submitMessage" && method === "POST") return { status: 400, body: "Invalid protobuf data" };
  return { status: 404, body: "Not found" };
}

let override;
let server;
let base;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname.startsWith(`${PATH}/`) ? url.pathname.slice(PATH.length) : "";
    const result = override?.(route) ?? answer(route, url.searchParams, request.method);
    request.resume();
    response.statusCode = result.status ?? 200;
    response.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${PATH}`;
});

after(() => server.close());
beforeEach(() => { override = undefined; });

function check(url = base) {
  return new Promise(resolve => {
    execFile("bash", [SCRIPT, url], (error, stdout, stderr) => {
      resolve({ exit: error ? error.code : 0, stdout, stderr });
    });
  });
}

test("passes a server that meets the contract, without printing its URL", async () => {
  const result = await check();
  assert.equal(result.exit, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /FAIL/);
  assert.doesNotMatch(result.stdout + result.stderr, /mock-secret-path/);
});

test("accepts a base URL with a trailing slash", async () => {
  assert.equal((await check(`${base}/`)).exit, 0);
});

test("fails a signer list with no nonce, which would break sign-in", async () => {
  override = route => (route === "/v1/signersByFid" ? { body: { signers: [{ key: "0x11" }] } } : undefined);
  const result = await check();
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /FAIL {2}signers and nonce: HTTP 200 with the wrong response shape/);
});

test("requires exactly HTTP 200 for a read", async () => {
  override = route => (route === "/v1/userDataByFid" ? { status: 201, body: { messages: [] } } : undefined);
  const result = await check();
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /FAIL {2}node route answers: HTTP 201/);
});

test("explains a rejected key and used-up credits", async () => {
  override = route => (route === "/v1/castById" ? { status: 401, body: "no" } : undefined);
  assert.match((await check()).stdout, /cast lookup: HTTP 401, the key was rejected/);
  override = route => (route === "/v1/castById" ? { status: 402, body: "no" } : undefined);
  assert.match((await check()).stdout, /cast lookup: HTTP 402, out of credits/);
});

test("names a Worker that is missing its secrets", async () => {
  override = () => ({ status: 503, body: "Server not configured" });
  assert.match((await check()).stdout, /feed route answers: HTTP 503, a secret is missing/);
});

test("fails when the submit route doesn't exist", async () => {
  override = route => (route === "/v1/submitMessage" ? { status: 404, body: "Not found" } : undefined);
  assert.match((await check()).stdout, /FAIL {2}submit route rejects a bad message: HTTP 404/);
});

test("fails a server that answers on a wrong path", async () => {
  const answerAll = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url.startsWith("/wrong-path/")) return response.end("{}");
    answerAll(request, response);
  });
  const result = await check();
  server.removeAllListeners("request");
  server.on("request", answerAll);
  assert.match(result.stdout, /FAIL {2}wrong path is 404: expected 404, got 200/);
});

test("refuses a plain HTTP address", async () => {
  assert.equal((await check("http://example.com/path")).exit, 2);
});
