import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { newPerson, startNetwork } from "../client/local.ts";
import type { TestNetwork } from "../client/local.ts";
import { realWalkthrough } from "../client/real.ts";

/**
 * `npm run real` walks through a network with real Farcaster accounts. This runs the same walkthrough
 * with made-up ones, since tests can't use a real recovery phrase.
 */

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await work();
  } finally {
    console.log = log;
  }
};

describe("the real-account walkthrough", () => {
  let network: TestNetwork;
  const me = newPerson(2001, "owner");
  const second = newPerson(2002, "friend");

  before(async () => {
    network = await startNetwork(me);
    network.farcaster.add(second);
  });

  after(() => network.stop());

  test("with one account", async () => {
    const clients = await quietly(() => realWalkthrough(network, me, null));
    assert.deepEqual([...clients.keys()], ["me"]);
  });

  test("with a second account, and with no fname for the first", async () => {
    const noName = newPerson(3001, null);
    const other = await startNetwork(noName);
    try {
      other.farcaster.add(second);
      const clients = await quietly(() => realWalkthrough(other, noName, second));
      assert.deepEqual([...clients.keys()].sort(), ["me", "second"]);
      assert.equal((await clients.get("second")!.network()).you.fid, second.fid);
    } finally {
      await other.stop();
    }
  });

  test("with a second account, both with fnames", async () => {
    const clients = await quietly(async () => {
      // A fresh network, so the first test's posts don't change what this one counts.
      const host = newPerson(4001, "host");
      const fresh = await startNetwork(host);
      try {
        fresh.farcaster.add(second);
        return await realWalkthrough(fresh, host, second);
      } finally {
        await fresh.stop();
      }
    });
    assert.deepEqual([...clients.keys()].sort(), ["me", "second"]);
  });
});
