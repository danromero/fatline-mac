import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { NetworkClient, NetworkError } from "../client/client.ts";
import { approveDevice, Ed25519Key } from "../client/keys.ts";
import { makeRemoval } from "../src/protocol/messages.ts";
import { newPerson } from "../client/local.ts";
import { alice, bob, handles, now, rejects, useCabin } from "./fixtures.ts";

/** What one account can add, read, and spend in a day. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("what one account can add", () => {
  const call = (device: NetworkClient, method: string, path: string, body?: unknown) =>
    fixture.network.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${device.membership.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  test("a waiting person keeps only their 10 newest network keys, and 10 devices", async () => {
    const pat = newPerson(1601, "pat");
    fixture.network.farcaster.add(pat);
    const identity = await approveDevice(pat.phrase, pat.fid, Ed25519Key.random());
    const keys = Array.from({ length: 12 }, () => NetworkClient.forNetwork(identity, fixture.network.host));
    for (const key of keys) assert.equal(await key.join(), "pending");
    await rejects(keys[0]!.signIn(), 401, /doesn't know that key/);
    assert.equal(await keys[11]!.signIn(), "pending");

    for (let device = 1; device < 10; device++) assert.equal(await (await fixture.network.device(pat)).join(), "pending");
    await rejects((await fixture.network.device(pat)).join(), 429, /too many devices/);
  });

  test("an account keeps its 20 newest sessions", async () => {
    const client = as(bob);
    assert.equal(await client.signIn(), "approved");
    const oldest = client.membership.token!;
    for (let index = 0; index < 20; index++) assert.equal(await client.signIn(), "approved");
    assert.equal((await fixture.network.fetch("/api/v1/network", { headers: { authorization: `Bearer ${oldest}` } })).status, 401);
    assert.equal((await call(client, "GET", "/network")).status, 200);
  });

  test("a member can file 20 reports a day", async () => {
    const quinn = newPerson(1602, "quinn");
    assert.equal(await joined(quinn, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(quinn).signIn(), "approved");
    const post = await as(bob).post({ text: "Report me" });
    for (let index = 0; index < 20; index++) await as(quinn).report(post, `Report ${index}`);
    await rejects(as(quinn).report(post), 429, /20 reports/);
    // One character to the eye, but 1,201 bytes.
    await rejects(as(bob).report(post, "x" + "\u0301".repeat(600)), 400, /at most 280/);
  });

  test("a member's changes are charged by the rows they write, 5,000 a day", async () => {
    const rae = newPerson(1603, "rae");
    assert.equal(await joined(rae, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(rae).signIn(), "approved");
    const early = await as(rae).post({ text: "Posted before the limit" });
    // Ten mentions a post, each a row and an index entry, so a few hundred posts reach it, not thousands.
    const names = await handles(as(rae));
    const mentions = [...names.keys()].filter((name) => /^[a-z]/.test(name) && name !== "rae").slice(0, 10).map((name) => `@${name}`).join(" ");
    let posted = 0;
    let refused: unknown;
    for (; posted < 1000; posted++) {
      try {
        await as(rae).post({ text: `${mentions} ${posted}`, handles: names });
      } catch (error) {
        refused = error;
        break;
      }
    }
    assert.ok(refused instanceof NetworkError && refused.status === 429 && /changes for one day/.test(refused.message), String(refused));
    assert.ok(posted > 50 && posted < 500, `posted ${posted}`);
    assert.equal((await call(as(rae), "GET", "/feed")).status, 200, "reading still works");
    assert.equal((await call(as(rae), "PUT", `/mutes/${bob.fid}`)).status, 429, "other changes stop too");
    // Deleting and signing out still work, so a stolen device that spent the day can't keep its owner from them.
    await as(rae).remove(early);
    assert.equal((await call(as(rae), "DELETE", "/session")).status, 204);
    assert.equal((await call(as(bob), "DELETE", `/mutes/${rae.fid}`)).status, 204, "it's per member");
  });

  test("an account can sign in 100 times a day", async () => {
    const tess = newPerson(1604, "tess");
    assert.equal(await joined(tess, (await as(alice).createInvite()).code), "approved");
    for (let index = 0; index < 100; index++) assert.equal(await as(tess).signIn(), "approved");
    await rejects(as(tess).signIn(), 429, /signing in/);
    assert.equal(await as(bob).signIn(), "approved", "it's per account");

    // A device signed out everywhere keeps failing, without spending its owner's sign-ins.
    const uma = newPerson(1605, "uma");
    assert.equal(await joined(uma, (await as(alice).createInvite()).code), "approved");
    const stolen = as(uma);
    assert.equal(await stolen.signIn(), "approved");
    await fixture.network.fetch(`/api/v1/admin/members/${uma.fid}/sign-out`, { method: "POST", headers: { authorization: `Bearer ${as(alice).membership.token}` } });
    for (let index = 0; index < 101; index++) assert.equal(await stolen.signIn(), "refused");
    const fresh = await fixture.network.device(uma);
    assert.equal(await fresh.join(), "approved");
    assert.equal(await fresh.signIn(), "approved");
  });

  test("the admin is never shut out by the device limit", async () => {
    for (let index = 0; index < 11; index++) assert.equal(await (await fixture.network.device(alice)).join(), "approved");
  });

  test("an unchanged feed answers 304, and any change makes a new tag", async () => {
    // The device-limit test added 11 of the admin's devices, so the first one's key was let go. Sign in again.
    const fresh = await fixture.network.device(alice);
    assert.equal(await fresh.join(), "approved");
    assert.equal(await fresh.signIn(), "approved");
    devices.set(alice.fid, fresh);
    const read = (path: string, tag?: string) =>
      fixture.network.fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${as(alice).membership.token}`, ...(tag ? { "if-none-match": tag } : {}) } });
    for (const path of ["/feed", "/activity"]) {
      const first = await read(path);
      const tag = first.headers.get("etag")!;
      assert.equal(first.status, 200, path);
      assert.equal((await read(path, tag)).status, 304, path);
      await as(bob).like({ fid: alice.fid, hash: await as(alice).post({ text: `Changes ${path}` }) });
      const changed = await read(path, tag);
      assert.equal(changed.status, 200, path);
      assert.notEqual(changed.headers.get("etag"), tag, path);
    }
  });

  test("a delete sent again changes nothing, and doesn't make a new tag", async () => {
    const removal = await makeRemoval(bob.fid, await as(bob).post({ text: "Deleted twice" }), as(bob).membership.networkKey);
    await as(bob).submit(removal);
    const read = (tag?: string) =>
      fixture.network.fetch("/api/v1/feed", { headers: { authorization: `Bearer ${as(alice).membership.token}`, ...(tag ? { "if-none-match": tag } : {}) } });
    const tag = (await read()).headers.get("etag")!;
    for (let attempt = 0; attempt < 3; attempt++) await as(bob).submit(removal);
    assert.equal((await read(tag)).status, 304);
  });

  test("someone waiting to join can't make members' feeds read again", async () => {
    const read = (tag?: string) =>
      fixture.network.fetch("/api/v1/feed", { headers: { authorization: `Bearer ${as(alice).membership.token}`, ...(tag ? { "if-none-match": tag } : {}) } });
    const tag = (await read()).headers.get("etag")!;
    const vic = newPerson(1606, "vic");
    assert.equal(await joined(vic), "pending");
    for (let index = 0; index < 3; index++) assert.equal(await as(vic).signIn(), "pending");
    assert.equal((await read(tag)).status, 304);
    await as(alice).approve(vic.fid);
    assert.equal((await read(tag)).status, 200, "a new member does change it");
  });

  test("a thread's replies come 200 to a page, and an unchanged thread answers 304", async () => {
    const wes = newPerson(1607, "wes");
    assert.equal(await joined(wes, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(wes).signIn(), "approved");
    const root = await as(wes).post({ text: "Long thread" });
    for (let index = 0; index < 205; index++) await as(wes).reply({ fid: wes.fid, hash: root }, { text: `Reply ${index}` });
    const read = (query = "", tag?: string) =>
      fixture.network.fetch(`/api/v1/posts/${root}${query}`, { headers: { authorization: `Bearer ${as(wes).membership.token}`, ...(tag ? { "if-none-match": tag } : {}) } });
    const first = await read();
    const page = (await first.json()) as { post: { replies: number }; replies: { text: string }[]; next: string | null };
    assert.deepEqual([page.post.replies, page.replies.length], [205, 200]);
    const second = (await (await read(`?cursor=${page.next}`)).json()) as { replies: { text: string }[]; next: string | null };
    assert.deepEqual([second.replies.length, second.next], [5, null]);
    // Replies in the same second sort by hash, so the pages hold each reply once, in that order rather than as sent.
    const texts = [...page.replies, ...second.replies].map((reply) => reply.text);
    assert.deepEqual(new Set(texts).size, 205);
    assert.deepEqual(texts.slice().sort(), Array.from({ length: 205 }, (_, index) => `Reply ${index}`).sort());
    // The first page is the newest 200, oldest first within it; the next page goes back to older ones.
    const order = (reply: { time: number; hash: string }) => `${String(reply.time).padStart(12, "0")}${reply.hash}`;
    const [newest, older] = [page.replies as unknown as { time: number; hash: string }[], second.replies as unknown as { time: number; hash: string }[]];
    assert.deepEqual(newest.map(order), newest.map(order).slice().sort(), "oldest first within the page");
    assert.ok(older.every((reply) => order(reply) < order(newest[0]!)), "the next page is older");
    assert.equal((await read("", first.headers.get("etag")!)).status, 304);
    // Read twice without a tag: the same answer, the second time from the cache.
    assert.deepEqual(await (await read()).json(), page);
  });

  test("only what feeds show makes a new tag: not profiles, reports, or someone else's mutes", async () => {
    const read = (tag?: string) =>
      fixture.network.fetch("/api/v1/feed", { headers: { authorization: `Bearer ${as(alice).membership.token}`, ...(tag ? { "if-none-match": tag } : {}) } });
    const tag = (await read()).headers.get("etag")!;
    await as(bob).updateProfile({ bio: "Unchanged feeds" });
    await as(bob).mute(alice.fid);
    await as(bob).unmute(alice.fid);
    await as(bob).report((await as(alice).feed()).posts[0]!.hash, "Fine");
    assert.equal((await read(tag)).status, 304);
    await as(alice).mute(bob.fid);
    const muted = await read(tag);
    assert.equal(muted.status, 200, "the muter's own feed changes");
    await as(alice).unmute(bob.fid);
    assert.equal((await read(tag)).status, 304, "and unmuting brings the same tag back");
  });

  test("a member's reads past a hundred rows count against 200,000 a day", async () => {
    const yan = newPerson(1608, "yan");
    assert.equal(await joined(yan, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(yan).signIn(), "approved");
    // A new cursor each time misses the cache, so each read reads the feed.
    const cursor = (index: number) => Buffer.from(`${now() + 3600 - index}:0x${"f".repeat(40)}`).toString("base64url");
    const read = (index: number) => fixture.network.fetch(`/api/v1/feed?cursor=${cursor(index)}`, { headers: { authorization: `Bearer ${as(yan).membership.token}` } });
    let index = 0;
    let status = 200;
    for (; index < 5000 && status === 200; index++) {
      const answers = await Promise.all(Array.from({ length: 50 }, (_, offset) => read(index * 50 + offset)));
      status = answers.find((answer) => answer.status !== 200)?.status ?? 200;
      await Promise.all(answers.map((answer) => answer.arrayBuffer()));
    }
    assert.equal(status, 429);
    assert.ok(index > 2, `refused after ${index * 50} reads`);
    assert.ok(await as(yan).post({ text: "Changes still work" }));
    assert.equal((await fixture.network.fetch("/api/v1/feed", { headers: { authorization: `Bearer ${as(bob).membership.token}` } })).status, 200, "it's per member");
  });
});
