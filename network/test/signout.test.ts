import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NetworkClient } from "../client/client.ts";
import { newPerson } from "../client/local.ts";
import { alice, bob, findPost, rejects, useCabin } from "./fixtures.ts";

/** Ending one session, and the admin signing someone out everywhere. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("signing out", () => {
  const ivy = newPerson(1301, "ivy");
  let laptop: NetworkClient;
  let phone: NetworkClient;

  /** Calls the API with a device's current token, without the client's own checks. */
  const call = (device: NetworkClient, method: string, path: string) =>
    fixture.network.fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${device.membership.token}` } });

  test("DELETE /session ends the token it's sent with, and only that one", async () => {
    const code = await as(alice).createInvite();
    assert.equal(await joined(ivy, code.code), "approved");
    laptop = as(ivy);
    phone = await fixture.network.device(ivy);
    assert.equal(await phone.join(), "approved");
    for (const device of [laptop, phone]) assert.equal(await device.signIn(), "approved");

    assert.equal((await call(laptop, "DELETE", "/session")).status, 204);
    assert.equal((await call(laptop, "GET", "/network")).status, 401);
    assert.equal((await call(laptop, "DELETE", "/session")).status, 401);
    assert.equal((await call(phone, "GET", "/network")).status, 200, "the other device stays signed in");
    assert.equal((await fixture.network.fetch("/api/v1/session", { method: "DELETE" })).status, 401);

    // The device's keys stay, so it signs in again without the recovery phrase.
    assert.equal(await laptop.signIn(), "approved");
    assert.equal((await call(laptop, "GET", "/network")).status, 200);
  });

  test("the admin can sign someone out everywhere, which keeps their posts and lets them back with their phrase", async () => {
    const kept = await laptop.post({ text: "Still here after signing out" });
    assert.equal((await call(as(bob), "POST", `/admin/members/${ivy.fid}/sign-out`)).status, 403);
    assert.equal((await call(as(alice), "POST", `/admin/members/${ivy.fid}/sign-out`)).status, 204);

    for (const device of [laptop, phone]) {
      assert.equal((await call(device, "GET", "/network")).status, 401);
      assert.equal(await device.signIn(), "refused");
    }
    await rejects(laptop.join(), 401, /recovery phrase/);
    assert.ok(findPost((await as(bob).feed()).posts, kept), "their posts stay");
    assert.ok((await as(bob).members()).some((member) => member.fid === ivy.fid), "they're still a member");
    assert.ok(!(await as(alice).blocks()).some((block) => block.fid === ivy.fid), "and not blocked");
    const entry = (await as(alice).log()).find((item) => item.action === "signed out");
    assert.deepEqual(entry?.detail, { fid: ivy.fid, username: "ivy" });

    // Their recovery phrase approves a new device key, which gets in without asking.
    const fresh = await fixture.network.device(ivy);
    devices.set(ivy.fid, fresh);
    assert.equal(await fresh.join(), "approved");
    assert.equal(await fresh.signIn(), "approved");
    assert.equal((await call(as(alice), "POST", "/admin/members/9999/sign-out")).status, 404);
  });
});
