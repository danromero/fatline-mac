import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NetworkClient } from "../client/client.ts";
import { signSession } from "../client/keys.ts";
import { newPerson } from "../client/local.ts";
import { toHex } from "../src/protocol/protobuf.ts";
import { alice, bob, useNetwork } from "./fixtures.ts";

/**
 * A day's sign-ins, past which signing in writes nothing. Against the real Worker on a local D1, with
 * a network of this file's own.
 */

const fixture = useNetwork({ COST_HEADERS: "1" }, async (fixture) => {
  await fixture.joined(alice);
  await fixture.as(alice).signIn();
});
const { as, joined } = fixture;

/** A sign-in request signed by `client`'s network key, for `fid` unless said. */
function signed(client: NetworkClient, fid = client.fid) {
  const key = client.membership.networkKey;
  return JSON.stringify({ fid, networkKey: toHex(key.publicKey), ...signSession(fid, fixture.network.host, key) });
}

/** DAILY.signins in src/server/daily.ts, which the tests can't import without the Worker's types. */
const SIGNINS = 100;

const send = (body: string) => fixture.network.fetch("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body });

async function useUp(client: NetworkClient, leave = 0) {
  for (let count = 0; count < SIGNINS - leave; count++) assert.notEqual((await send(signed(client))).status, 429);
}

describe("a day's sign-ins", () => {
  test("past the limit, a waiting request's sign-in writes nothing", async () => {
    const rae = newPerson(2401, "rae");
    assert.equal(await joined(rae), "pending");
    await useUp(as(rae));
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await send(signed(as(rae)));
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("x-rows-written"), "0");
    }
  });

  test("past the limit, a member's sign-in writes nothing", async () => {
    const code = await as(alice).createInvite();
    assert.equal(await joined(bob, code.code), "approved");
    await useUp(as(bob));
    const response = await send(signed(as(bob)));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-rows-written"), "0");
  });

  test("sign-ins sent at once at the limit get exactly what's left", async () => {
    const sid = newPerson(2402, "sid");
    assert.equal(await joined(sid), "pending");
    await useUp(as(sid), 2);
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => send(signed(as(sid)))))).map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 202).length, 2, statuses.join(" "));
    assert.equal(statuses.filter((status) => status === 429).length, 8, statuses.join(" "));
  });

  test("a signature is used once, and one account's key can't spend another's day", async () => {
    const tao = newPerson(2403, "tao");
    assert.equal(await joined(tao), "pending");
    const body = signed(as(tao));
    assert.equal((await send(body)).status, 202);
    const again = await send(body);
    assert.equal(again.status, 401);
    assert.match(await again.text(), /already used/);

    const before = await send(signed(as(alice)));
    assert.equal(before.status, 200);
    const borrowed = await send(signed(as(tao), alice.fid));
    assert.equal(borrowed.status, 401);
    assert.equal(borrowed.headers.get("x-rows-written"), "0");
    assert.equal(await as(alice).signIn(), "approved");
  });

  test("a revoked key is still refused", async () => {
    const uma = newPerson(2404, "uma");
    const code = await as(alice).createInvite();
    assert.equal(await joined(uma, code.code), "approved");
    const out = await fixture.network.fetch(`/api/v1/admin/members/${uma.fid}/sign-out`, {
      method: "POST", headers: { authorization: `Bearer ${as(alice).membership.token}` },
    });
    assert.equal(out.status, 204);
    const response = await send(signed(as(uma)));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-rows-written"), "0");
  });
});
