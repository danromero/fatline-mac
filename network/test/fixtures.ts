import assert from "node:assert/strict";
import { after, before } from "node:test";
import { NetworkClient, NetworkError } from "../client/client.ts";
import type { Post } from "../src/protocol/api.ts";
import { Protobuf } from "../src/protocol/protobuf.ts";
import { newPerson, startNetwork } from "../client/local.ts";
import type { Person, TestNetwork } from "../client/local.ts";

/**
 * People and helpers for the server tests, and a network of its own for each test file, so no file
 * depends on what another did first. Files run side by side.
 */

export const alice = newPerson(1001, "alice"); // runs the network
export const bob = newPerson(1002, "bob");
export const carol = newPerson(1003, "carol");
export const dave = newPerson(1004, "dave");
export const erin = newPerson(1005, null); // has no fname
export const frank = newPerson(1006, "frank");

export const INVITE_PATH = "test-invite-path-0123456789";
export const now = () => Math.floor(Date.now() / 1000);

export async function rejects(promise: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof NetworkError, `expected a NetworkError, got ${error}`);
    assert.equal(error.status, status, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

/** Members' usernames, for mentions, the way an app would get them. */
export async function handles(client: NetworkClient) {
  return new Map((await client.members()).map((member) => [member.username, member.fid]));
}

export const findPost = (posts: Post[], hash: string) => posts.find((post) => post.hash === hash);

/** A post body, built by hand so tests can send what the client would refuse. */
export function castBody(text: string, extra: (body: Protobuf) => void = () => {}) {
  const body = new Protobuf();
  body.bytes(2, new Uint8Array());
  body.string(4, text);
  body.bytes(5, new Uint8Array());
  extra(body);
  return body.data;
}

/** A test file's own network, run by alice, and each person's latest device on it. */
export interface Fixture {
  network: TestNetwork;
  devices: Map<number, NetworkClient>;
  as(person: Person): NetworkClient;
  /** A new device for `person`, which asks to join, with `invite` if given. */
  joined(person: Person, invite?: string): Promise<string>;
}

/**
 * Starts a network before the file's tests, runs `setup` on it, and stops it after. One hook does it
 * all: node runs a file's top-level hooks without waiting for each other.
 */
export function useNetwork(vars: Record<string, string> = {}, setup?: (fixture: Fixture) => Promise<void>): Fixture {
  const devices = new Map<number, NetworkClient>();
  const fixture: Fixture = {
    network: undefined as unknown as TestNetwork,
    devices,
    as: (person) => devices.get(person.fid)!,
    async joined(person, invite) {
      fixture.network.farcaster.add(person);
      const client = await fixture.network.device(person);
      devices.set(person.fid, client);
      return client.join({ invite });
    },
  };
  before(async () => {
    fixture.network = await startNetwork(alice, { vars: { INVITE_PATH, MINIMUM_MAC_VERSION: "0.3.91", ...vars } });
    await setup?.(fixture);
  });
  after(async () => {
    await fixture.network?.stop();
  });
  return fixture;
}

/**
 * A network named Cabin: alice runs it, bob, carol, and erin are members, signed in, and dave asked
 * and was refused. The state the joining tests leave, for every other file to start from.
 */
export function useCabin(vars: Record<string, string> = {}): Fixture {
  return useNetwork(vars, async (fixture) => {
    await fixture.joined(alice);
    await fixture.as(alice).signIn();
    await fixture.as(alice).updateSettings({ name: "Cabin" });
    const code = await fixture.as(alice).createInvite({ uses: null });
    for (const person of [bob, carol, erin]) {
      await fixture.joined(person, code.code);
      await fixture.as(person).signIn();
    }
    await fixture.joined(dave);
    await fixture.as(alice).refuse(dave.fid);
  });
}
