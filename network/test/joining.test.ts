import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NetworkClient } from "../client/client.ts";
import { approveDevice, Ed25519Key, signSession } from "../client/keys.ts";
import { toHex } from "../src/protocol/protobuf.ts";
import { newPerson } from "../client/local.ts";
import { alice, bob, carol, dave, erin, rejects, useNetwork } from "./fixtures.ts";

/** Joining a network: codes, requests, refusals, and sign-ins. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useNetwork();
const { as, joined, devices } = fixture;

describe("joining", () => {
  test("the server says what it is, and nothing about the network", async () => {
    assert.deepEqual(await (await fixture.network.fetch("/api/v1/")).json(), { fatline: "network", version: 1 });
  });

  test("the admin is let in at once", async () => {
    assert.equal(await joined(alice), "approved");
    assert.equal(await as(alice).signIn(), "approved");
    const info = await as(alice).network();
    assert.equal(info.name, fixture.network.host);
    assert.equal(info.you.role, "admin");
    assert.equal(info.you.username, "alice");
  });

  test("an invite code lets someone in, and a one-use code is then spent", async () => {
    await as(alice).updateSettings({ name: "Cabin" });
    const invite = await as(alice).createInvite({ code: "CABIN-01" });
    assert.deepEqual(await (await fixture.network.fetch("/api/v1/invites/CABIN-01")).json(), { name: "Cabin", icon: null });
    assert.equal(await joined(bob, invite.code), "approved");
    assert.equal(await as(bob).signIn(), "approved");
    assert.equal((await fixture.network.fetch("/api/v1/invites/CABIN-01")).status, 404);
    const spent = (await as(alice).invites()).find((code) => code.code === "CABIN-01")!;
    assert.deepEqual([spent.used, spent.usesLeft], [1, 0]);
  });

  test("a code with a broken % escape is not found, not a server error", async () => {
    for (const code of ["%E0%A4", "%", "abc%zz"]) {
      const response = await fixture.network.fetch(`/api/v1/invites/${code}`);
      assert.equal(response.status, 404, code);
      assert.match(((await response.json()) as { message: string }).message, /isn't valid/);
    }
  });

  test("a code the admin types is at least 8 characters", async () => {
    await rejects(as(alice).createInvite({ code: "SHORT-1" }), 400, /8 to 128 characters/);
    await rejects(as(alice).createInvite({ code: "A" }), 400, /8 to 128 characters/);
    assert.equal((await as(alice).createInvite({ code: "  LONGER-1  " })).code, "LONGER-1");
    assert.equal((await as(alice).createInvite()).code.length, 10, "made-up codes are 10");
  });

  test("a spent or unknown code is refused", async () => {
    fixture.network.farcaster.add(carol);
    const client = await fixture.network.device(carol);
    await rejects(client.join({ invite: "CABIN-01" }), 400, /isn't valid/);
    await rejects(client.join({ invite: "NOPE" }), 400, /isn't valid/);
  });

  test("a code is spent only once someone is in", async () => {
    const sam = newPerson(1103, "sam");
    fixture.network.farcaster.add(sam);
    const code = await as(alice).createInvite({ uses: 2 });
    fixture.network.farcaster.fnamesDown = true;
    await rejects((await fixture.network.device(sam)).join({ invite: code.code }), 503, /name server/);
    fixture.network.farcaster.fnamesDown = false;
    assert.equal((await as(alice).invites()).find((invite) => invite.code === code.code)!.used, 0, "nothing was spent");

    // Two joins at once from one person spend one use.
    const identity = await approveDevice(sam.phrase, sam.fid, Ed25519Key.random());
    const [first, second] = [NetworkClient.forNetwork(identity, fixture.network.host), NetworkClient.forNetwork(identity, fixture.network.host)];
    assert.deepEqual(await Promise.all([first.join({ invite: code.code }), second.join({ invite: code.code })]), ["approved", "approved"]);
    assert.deepEqual(((({ used, usesLeft }) => [used, usesLeft])((await as(alice).invites()).find((invite) => invite.code === code.code)!)), [1, 1]);
    await as(alice).removeMember(sam.fid);
    await as(alice).unblock(sam.fid);
  });

  test("two people can't both spend a one-use code", async () => {
    const code = await as(alice).createInvite();
    const one = newPerson(1101, "one");
    const two = newPerson(1102, "two");
    fixture.network.farcaster.add(one);
    fixture.network.farcaster.add(two);
    const [first, second] = [await fixture.network.device(one), await fixture.network.device(two)];
    const results = await Promise.allSettled([first.join({ invite: code.code }), second.join({ invite: code.code })]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const winner = results[0]!.status === "fulfilled" ? one : two;
    // Tidy up, so later tests see only the members they expect.
    await as(alice).removeMember(winner.fid);
    await as(alice).unblock(winner.fid);
  });

  test("without a code, someone waits for the admin", async () => {
    assert.equal(await joined(carol), "pending");
    assert.equal(await joined(carol), "pending");
    assert.equal(await as(carol).signIn(), "pending");
    const waiting = await as(alice).requests();
    assert.deepEqual(waiting.map((request) => [request.fid, request.username, request.status]), [[1003, "carol", "pending"]]);
    await as(alice).approve(carol.fid);
    assert.equal(await as(carol).signIn(), "approved");
    assert.deepEqual(await as(alice).requests(), []);
  });

  test("the admin can refuse someone, and asking again stays refused", async () => {
    assert.equal(await joined(dave), "pending");
    await as(alice).refuse(dave.fid);
    assert.equal(await as(dave).signIn(), "refused");
    assert.equal(await (await fixture.network.device(dave)).join(), "refused");
  });

  test("a phrase that doesn't own the FID is refused", async () => {
    const impostor = await approveDevice(newPerson(0, null).phrase, bob.fid, Ed25519Key.random());
    await rejects(NetworkClient.forNetwork(impostor, fixture.network.host).join(), 401, /doesn't own FID 1002/);
  });

  test("an approval for another network is refused", async () => {
    const identity = await approveDevice(bob.phrase, bob.fid, Ed25519Key.random());
    const elsewhere = NetworkClient.forNetwork(identity, "other.example.com");
    const sent = elsewhere.joinRequest();
    const response = await fixture.network.fetch("/api/v1/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent) });
    assert.equal(response.status, 401);
  });

  test("someone with no fname shows as !fid", async () => {
    const code = await as(alice).createInvite({ uses: null });
    assert.equal(await joined(erin, code.code), "approved");
    assert.equal(await as(erin).signIn(), "approved");
    assert.equal((await as(erin).network()).you.username, "!1005");
  });

  test("a second device of a member gets in without asking", async () => {
    const second = await fixture.network.device(bob);
    assert.equal(await second.join(), "approved");
    assert.equal(await second.signIn(), "approved");
    assert.equal((await second.network()).you.fid, bob.fid);
  });

  test("a sign-in signature works once", async () => {
    const client = as(bob);
    const signed = signSession(bob.fid, fixture.network.host, client.membership.networkKey);
    const body = JSON.stringify({ fid: bob.fid, networkKey: toHex(client.membership.networkKey.publicKey), ...signed });
    const send = () => fixture.network.fetch("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 401);
  });

  test("members and admin routes need signing in, and admin routes need the admin", async () => {
    assert.equal((await fixture.network.fetch("/api/v1/feed")).status, 401);
    assert.equal((await fixture.network.fetch("/api/v1/feed", { headers: { authorization: "Bearer not-a-real-token-at-all" } })).status, 401);
    await rejects(as(bob).requests(), 403, /Only the admin/);
  });
});
