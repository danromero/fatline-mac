import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { newPerson } from "../client/local.ts";
import { alice, rejects, useCabin } from "./fixtures.ts";

/** People the admin follows, who get in without waiting once pulled. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("people the admin follows on Farcaster", () => {
  test("wait until the admin pulls their follows, then get in at once, and the log says why", async () => {
    const hal = newPerson(1901, "hal");
    fixture.network.farcaster.follow(alice.fid, hal.fid);
    assert.equal(await joined(hal), "pending", "nothing is pulled yet");
    const pulled = await as(alice).pullFollows();
    assert.deepEqual([pulled.count, pulled.complete], [1, true]);
    assert.equal(await as(hal).signIn(), "approved");
    const hana = newPerson(1905, "hana");
    fixture.network.farcaster.follow(alice.fid, hana.fid);
    await as(alice).pullFollows();
    assert.equal(await joined(hana), "approved");
    const log = await as(alice).log();
    assert.ok(log.some((entry) => entry.action === "approved by following" && (entry.detail as { fid?: number }).fid === hana.fid));
    assert.ok(log.some((entry) => entry.action === "pulled follows"));
  });

  test("joining and signing in never ask the hub, so a waiting request can't spend its key", async () => {
    const ivy = newPerson(1902, "ivy");
    const before = fixture.network.farcaster.hubCalls;
    assert.equal(await joined(ivy), "pending");
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(await as(ivy).signIn(), "pending");
    assert.equal(await (await fixture.network.device(ivy)).join(), "pending");
    assert.equal(fixture.network.farcaster.hubCalls, before);

    // Following them later lets them in only once the admin pulls again.
    fixture.network.farcaster.follow(alice.fid, ivy.fid);
    assert.equal(await as(ivy).signIn(), "pending");
    await as(alice).pullFollows();
    assert.equal(await as(ivy).signIn(), "approved");
  });

  test("a pull takes every page, and replaces the last list", async () => {
    const many = Array.from({ length: 250 }, (_, index) => 50_000 + index);
    for (const fid of many) fixture.network.farcaster.follow(alice.fid, fid);
    fixture.network.farcaster.hubPageSize = 100;
    const before = fixture.network.farcaster.hubCalls;
    const pulled = await as(alice).pullFollows();
    fixture.network.farcaster.hubPageSize = 1000;
    assert.equal(fixture.network.farcaster.hubCalls - before, 3);
    assert.deepEqual([pulled.count, pulled.complete], [fixture.network.farcaster.follows.get(alice.fid)!.size, true]);

    // Unfollowed on Farcaster: still in the old list until the admin pulls again.
    const jay = newPerson(1903, "jay");
    fixture.network.farcaster.follow(alice.fid, jay.fid);
    await as(alice).pullFollows();
    fixture.network.farcaster.follows.get(alice.fid)!.delete(jay.fid);
    await as(alice).pullFollows();
    assert.equal(await joined(jay), "pending");
  });

  test("a hub that's down changes nothing", async () => {
    const lee = newPerson(1906, "lee");
    fixture.network.farcaster.follow(alice.fid, lee.fid);
    fixture.network.farcaster.hubDown = true;
    await rejects(as(alice).pullFollows(), 502, /didn't answer/);
    fixture.network.farcaster.hubDown = false;
    assert.equal(await joined(lee), "pending", "the failed pull kept the old list");
    await as(alice).pullFollows();
    assert.equal(await as(lee).signIn(), "approved");
  });

  test("wait when the admin turns it off", async () => {
    assert.equal((await as(alice).settings()).admitFollows, true);
    assert.equal((await as(alice).updateSettings({ admitFollows: false })).admitFollows, false);
    const kim = newPerson(1904, "kim");
    fixture.network.farcaster.follow(alice.fid, kim.fid);
    await as(alice).pullFollows();
    assert.equal(await joined(kim), "pending");
    assert.equal(await as(kim).signIn(), "pending");
    await as(alice).updateSettings({ admitFollows: true });
    assert.equal(await as(kim).signIn(), "approved");
    await rejects(as(alice).updateSettings({ admitFollows: "yes" as unknown as boolean }), 400, /true or false/);
  });
});
