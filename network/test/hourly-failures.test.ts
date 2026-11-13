import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newPerson } from "../client/local.ts";
import type { Person } from "../client/local.ts";
import { alice, now, useNetwork } from "./fixtures.ts";

/**
 * The hourly ownership check when Optimism or the fname server doesn't answer. Against the real
 * Worker on a local D1, with a network of this file's own.
 */

const fixture = useNetwork({}, async (fixture) => {
  await fixture.joined(alice);
  await fixture.as(alice).signIn();
});
const { as, joined } = fixture;

const HOUR = 60 * 60;
const movedTo = (person: Person): Person => ({ ...person, phrase: newPerson(0, null).phrase });

async function member(person: Person) {
  const code = await as(alice).createInvite();
  assert.equal(await joined(person, code.code), "approved");
  assert.equal(await as(person).signIn(), "approved");
  return as(person);
}

describe("the hourly check", () => {
  test("ends an old owner's devices while the fname server is down, and keeps the username", async () => {
    const old = await member(newPerson(2201, "olive"));
    const moved = movedTo(newPerson(2201, "olive"));
    fixture.network.farcaster.add(moved);
    fixture.network.farcaster.fnamesDown = true;
    try {
      await fixture.network.runHourly(now() + 25 * HOUR);
      assert.equal(await old.signIn(), "refused");
      const fresh = await fixture.network.device(moved);
      assert.equal(await fresh.join(), "approved");
      assert.equal(await fresh.signIn(), "approved");
      assert.equal((await fresh.network()).you.username, "olive", "the last username stays");
    } finally {
      fixture.network.farcaster.fnamesDown = false;
    }
  });

  test("marks nothing checked while Optimism is down, and tries again a few hours later", async () => {
    const pia = newPerson(2202, "pia");
    const old = await member(pia);
    fixture.network.farcaster.add(movedTo(pia));
    fixture.network.farcaster.custodyDown.add(pia.fid);
    await fixture.network.runHourly(now() + 25 * HOUR);
    assert.equal(await old.signIn(), "approved", "nothing is known about the new owner yet");

    fixture.network.farcaster.custodyDown.delete(pia.fid);
    await fixture.network.runHourly(now() + 30 * HOUR);
    assert.equal(await old.signIn(), "refused");
  });

  test("members whose check keeps failing don't hold up everyone else", async () => {
    const failing = Array.from({ length: 13 }, (_, index) => newPerson(2300 + index, `stuck${index}`));
    for (const person of failing) await member(person);
    // Joined a second later, so checked after every failing member.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const quinn = newPerson(2203, "quinn");
    const old = await member(quinn);
    fixture.network.farcaster.add(movedTo(quinn));
    for (const person of failing) fixture.network.farcaster.custodyDown.add(person.fid);
    try {
      for (let run = 0; run < 3; run++) await fixture.network.runHourly(now() + (40 + run) * HOUR);
      assert.equal(await old.signIn(), "refused");
    } finally {
      fixture.network.farcaster.custodyDown.clear();
    }
  });
});
