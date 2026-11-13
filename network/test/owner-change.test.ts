import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NetworkClient } from "../client/client.ts";
import { newPerson } from "../client/local.ts";
import type { Person } from "../client/local.ts";
import { alice, now, rejects, useNetwork } from "./fixtures.ts";

/**
 * When an FID gets a new owner, everything the old owner's devices could do stops: app sessions,
 * admin page sign-ins, sign-in links not used yet, and keys kept for a request still waiting. Against
 * the real Worker on a local D1, with a network of this file's own.
 */

const fixture = useNetwork({}, async (fixture) => {
  await fixture.joined(alice);
  await fixture.as(alice).signIn();
});
const { as, joined } = fixture;

/** The same FID and username, owned by a new recovery phrase. */
const movedTo = (person: Person): Person => ({ ...person, phrase: newPerson(0, null).phrase });

/** A device for `person`, joined and signed in. */
async function device(person: Person, invite?: string) {
  fixture.network.farcaster.add(person);
  const client = await fixture.network.device(person);
  await client.join({ invite });
  await client.signIn();
  return client;
}

/** Trades a sign-in link for the admin pages' cookie, or null when it doesn't sign in. */
async function cookieFrom(link: string) {
  const url = new URL(link);
  const response = await fixture.network.fetch(url.pathname + url.search, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie");
  return response.status === 303 && cookie ? cookie.split(";")[0]! : null;
}

const settingsPage = (cookie: string) => fixture.network.fetch("/admin/settings", { headers: { cookie }, redirect: "manual" });

async function submitName(cookie: string, csrf: string, name: string) {
  return fixture.network.fetch("/admin/settings", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${fixture.network.host}` },
    body: new URLSearchParams({ csrf, name }),
  });
}

describe("a new owner", () => {
  let admin: NetworkClient;
  let alicesOwner: Person;

  test("ends the old owner's admin pages and sign-in links, and can sign in to them", async () => {
    const old = as(alice);
    const cookie = (await cookieFrom(await old.adminLink()))!;
    const page = await settingsPage(cookie);
    assert.equal(page.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const unused = await old.adminLink();

    alicesOwner = movedTo(alice);
    admin = await device(alicesOwner);

    await rejects(old.feed(), 401);
    assert.equal((await settingsPage(cookie)).status, 401, "the old cookie is signed out");
    assert.notEqual((await submitName(cookie, csrf, "Changed by the old owner")).status, 303);
    assert.notEqual((await admin.network()).name, "Changed by the old owner");
    assert.equal(await cookieFrom(unused), null, "the link the old owner didn't use yet");

    const fresh = (await cookieFrom(await admin.adminLink()))!;
    assert.equal((await settingsPage(fresh)).status, 200);
  });

  test("leaves the current owner's admin pages alone when they add another device", async () => {
    const cookie = (await cookieFrom(await admin.adminLink()))!;
    const second = await fixture.network.device(alicesOwner);
    assert.equal(await second.join(), "approved");
    assert.equal(await second.signIn(), "approved");
    assert.equal((await settingsPage(cookie)).status, 200);
    assert.equal(await admin.signIn(), "approved");
  });

  test("ends the old owner's keys kept for a request still waiting, before the admin approves it", async () => {
    const jo = newPerson(2101, "jo");
    assert.equal(await joined(jo), "pending");
    const stale = as(jo);
    const moved = movedTo(jo);
    fixture.network.farcaster.add(moved);
    const current = await fixture.network.device(moved);
    assert.equal(await current.join(), "pending");

    await admin.approve(jo.fid);
    assert.equal(await current.signIn(), "approved");
    assert.equal(await stale.signIn(), "refused");
    // So it never gets a session to post with.
    await rejects(stale.join(), 401);

    // The current owner's own devices keep working, and can join again.
    assert.equal(await current.join(), "approved");
    assert.equal(await current.signIn(), "approved");
    assert.ok(await current.post({ text: "Posted by the new owner" }));
  });

  test("ends the old owner's waiting keys when the admin's follow lets the FID in", async () => {
    const kit = newPerson(2102, "kit");
    assert.equal(await joined(kit), "pending");
    const stale = as(kit);
    const moved = movedTo(kit);
    fixture.network.farcaster.add(moved);
    const current = await fixture.network.device(moved);
    assert.equal(await current.join(), "pending");

    fixture.network.farcaster.follow(alice.fid, kit.fid);
    await admin.pullFollows();
    assert.equal(await stale.signIn(), "refused");
    assert.equal(await current.signIn(), "approved");
    assert.equal(await stale.signIn(), "refused");
  });

  test("keeps a refused or blocked FID out", async () => {
    const lu = newPerson(2103, "lu");
    assert.equal(await joined(lu), "pending");
    await admin.refuse(lu.fid);
    const movedLu = movedTo(lu);
    fixture.network.farcaster.add(movedLu);
    assert.equal(await (await fixture.network.device(movedLu)).join(), "refused");

    const mo = newPerson(2104, "mo");
    const code = await admin.createInvite();
    assert.equal(await joined(mo, code.code), "approved");
    await admin.removeMember(mo.fid);
    const movedMo = movedTo(mo);
    fixture.network.farcaster.add(movedMo);
    assert.equal(await (await fixture.network.device(movedMo)).join(), "refused");
  });

  test("that the network never heard about is checked within the hour of the admin approving", async () => {
    const ned = newPerson(2105, "ned");
    assert.equal(await joined(ned), "pending");
    const stale = as(ned);
    fixture.network.farcaster.add(movedTo(ned));
    await admin.approve(ned.fid);
    // Nothing has told the network about the new owner yet.
    assert.equal(await stale.signIn(), "approved");
    await fixture.network.runHourly(now() + 60 * 60);
    assert.equal(await stale.signIn(), "refused");
    assert.equal(await admin.signIn(), "approved", "members checked at joining aren't due yet");
  });
});
