import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { newPerson, TEST_PNG } from "../client/local.ts";
import { alice, bob, findPost, frank, now, rejects, useCabin } from "./fixtures.ts";

/** The hourly job: usernames, custody, and retention. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("the hourly job", () => {
  test("follows username changes, and drops device keys an old custody address approved", async () => {
    const code = await as(alice).createInvite();
    assert.equal(await joined(frank, code.code), "approved");
    assert.equal(await as(frank).signIn(), "approved");

    // Frank's FID moves to a new custody address and gets a new fname.
    const moved = { ...frank, phrase: newPerson(0, null).phrase, username: "frankie" };
    fixture.network.farcaster.add(moved);
    await fixture.network.runHourly(now() + 25 * 60 * 60);

    await rejects(as(frank).feed(), 401);
    assert.equal(await as(frank).signIn(), "refused");
    const fresh = await fixture.network.device(moved);
    devices.set(frank.fid, fresh);
    assert.equal(await fresh.join(), "approved");
    assert.equal(await fresh.signIn(), "approved");
    assert.equal((await fresh.network()).you.username, "frankie");
  });

  test("drops a device key a wrong custody answer let in, even when the member's own custody is right", async () => {
    const gina = newPerson(1201, "gina");
    const code = await as(alice).createInvite();
    assert.equal(await joined(gina, code.code), "approved");
    assert.equal(await as(gina).signIn(), "approved");

    // Optimism wrongly says someone else owns Gina's FID, just long enough for them to add a device.
    const impostor = { ...newPerson(0, null), fid: gina.fid, username: "gina" };
    fixture.network.farcaster.add(impostor);
    const fake = await fixture.network.device(impostor);
    assert.equal(await fake.join(), "approved");
    assert.equal(await fake.signIn(), "approved");
    fixture.network.farcaster.add(gina);

    // Believing the wrong owner also ended Gina's own devices, as a real change of owner would.
    assert.equal(await as(gina).signIn(), "refused");

    // Every member is due a day later. Runs until each has been checked, twelve at a time.
    for (let run = 0; run < 3; run++) await fixture.network.runHourly(now() + 26 * 60 * 60);
    assert.equal(await fake.signIn(), "refused");
    const again = await fixture.network.device(gina);
    devices.set(gina.fid, again);
    assert.equal(await again.join(), "approved");
    assert.equal(await again.signIn(), "approved");
    assert.equal(await fake.signIn(), "refused");
  });

  test("a new owner's device ends the old owner's devices at once", async () => {
    const hana = newPerson(1202, "hana");
    const code = await as(alice).createInvite();
    assert.equal(await joined(hana, code.code), "approved");
    assert.equal(await as(hana).signIn(), "approved");

    const moved = { ...hana, phrase: newPerson(0, null).phrase };
    fixture.network.farcaster.add(moved);
    const fresh = await fixture.network.device(moved);
    assert.equal(await fresh.join(), "approved");
    await rejects(as(hana).feed(), 401);
    assert.equal(await as(hana).signIn(), "refused");
    assert.equal(await fresh.signIn(), "approved");
    devices.set(hana.fid, fresh);
  });

  test("with retention at 30 days, posts go 30 days after their time, and not before", async () => {
    // The last run was 25 hours ahead, which also ended sessions older than that. Sign in again.
    for (const person of [alice, bob]) assert.equal(await as(person).signIn(), "approved");
    const keep = await as(bob).post({ text: "Kept forever" });
    await fixture.network.runHourly(now() + 31 * 24 * 60 * 60);
    for (const person of [alice, bob]) assert.equal(await as(person).signIn(), "approved");
    assert.ok(findPost((await as(bob).feed()).posts, keep), "retention is forever by default");

    await as(alice).updateSettings({ retention: "30 days" });
    const soon = await as(bob).post({ text: "Gone in 30 days" });
    const picture = await as(bob).uploadImage(TEST_PNG, "image/png");
    const pictured = await as(bob).post({ text: "My picture goes too", embeds: [{ url: picture.url }] });
    const full = (findPost((await as(bob).feed()).posts, pictured)!.embeds[0] as { full: string }).full;
    await fixture.network.runHourly(now() + 29 * 24 * 60 * 60);
    for (const person of [alice, bob]) assert.equal(await as(person).signIn(), "approved");
    assert.ok(findPost((await as(bob).feed()).posts, soon), "still here after 29 days");

    await fixture.network.runHourly(now() + 31 * 24 * 60 * 60);
    for (const person of [alice, bob]) assert.equal(await as(person).signIn(), "approved");
    const after = (await as(bob).feed()).posts;
    assert.ok(!findPost(after, soon), "gone after 31 days");
    assert.equal((await fetch(full)).status, 404, "and the pictures expired posts used");
    assert.ok(!findPost(after, keep), "and so is everything else that old");
  });
});
