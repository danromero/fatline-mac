import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blake3 } from "@noble/hashes/blake3.js";
import { Ed25519Key } from "../client/keys.ts";
import type { Post } from "../src/protocol/api.ts";
import { imageURL, makePost, MessageType, signMessage } from "../src/protocol/messages.ts";
import { Protobuf } from "../src/protocol/protobuf.ts";
import { alice, bob, carol, castBody, dave, findPost, handles, now, rejects, useCabin } from "./fixtures.ts";

/** Posting, replying, quoting, liking, and deleting. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;
const pick = (post: Post) => [post.likes, post.liked];

describe("posting", () => {
  let dinner: string;
  let reply: string;
  let quote: string;

  test("a post with a mention reaches everyone, with the name shown", async () => {
    dinner = await as(bob).post({ text: "Dinner at 7? @carol", handles: await handles(as(bob)) });
    const post = findPost((await as(carol).feed()).posts, dinner)!;
    assert.equal(post.text, "Dinner at 7? @carol");
    assert.deepEqual(post.mentions, [{ fid: carol.fid, username: "carol" }]);
    assert.deepEqual([post.replies, post.likes, post.liked, post.deleted, post.parent], [0, 0, false, false, null]);
    assert.ok(post.message);
  });

  test("a reply shows under its post and in the author's activity", async () => {
    reply = await as(carol).reply({ fid: bob.fid, hash: dinner }, { text: "In!" });
    const thread = await as(alice).thread(dinner);
    assert.deepEqual(thread.replies.map((post) => [post.hash, post.text, post.parent]), [[reply, "In!", dinner]]);
    assert.equal(thread.post.replies, 1);
    assert.ok(!findPost((await as(alice).feed()).posts, reply), "replies stay out of the feed");
    const bobs = await as(bob).activity();
    assert.deepEqual(bobs.items.map((item) => [item.kind, item.post.hash, item.parent?.hash]), [["reply", reply, dinner]]);
    assert.equal(bobs.items[0]!.parent!.embeds.length, 0, "the answered post comes without its embeds");
    const carols = await as(carol).activity();
    assert.deepEqual(carols.items.map((item) => [item.kind, item.post.hash, item.parent]), [["mention", dinner, null]]);
  });

  test("a quote and a link travel as embeds", async () => {
    quote = await as(alice).post({ text: "Bring wine", embeds: [{ post: { fid: bob.fid, hash: dinner } }, { url: "https://example.com/menu" }] });
    const post = findPost((await as(bob).feed()).posts, quote)!;
    assert.equal(post.embeds.length, 2);
    const [quoted, link] = post.embeds;
    assert.ok(quoted?.type === "post" && quoted.hash === dinner && quoted.post?.text === "Dinner at 7? @carol");
    assert.deepEqual(link, { type: "link", url: "https://example.com/menu", preview: null });
  });

  test("likes count, and show whether you liked it", async () => {
    await as(alice).like({ fid: bob.fid, hash: dinner });
    await as(alice).like({ fid: bob.fid, hash: dinner });
    await as(carol).like({ fid: bob.fid, hash: dinner });
    assert.deepEqual(pick(findPost((await as(alice).feed()).posts, dinner)!), [2, true]);
    assert.deepEqual(pick(findPost((await as(bob).feed()).posts, dinner)!), [2, false]);
    await as(alice).unlike({ fid: bob.fid, hash: dinner });
    assert.deepEqual(pick(findPost((await as(alice).feed()).posts, dinner)!), [1, false]);
  });

  test("sending the same bytes again changes nothing", async () => {
    const message = await makePost(bob.fid, { text: "Same twice" }, as(bob).membership.networkKey);
    assert.equal(await as(bob).submit(message), message.hash);
    assert.equal(await as(bob).submit(message), message.hash);
    assert.equal((await as(bob).feed()).posts.filter((post) => post.hash === message.hash).length, 1);
  });

  test("replies go only on posts, not on replies", async () => {
    await rejects(as(alice).reply({ fid: carol.fid, hash: reply }, { text: "Nested" }), 400, /not on other replies/);
  });

  test("only members can be mentioned, and only images on this network can be attached", async () => {
    await rejects(as(bob).post({ text: "Hi @dave", handles: new Map([["dave", dave.fid]]) }), 400, /members/);
    await rejects(as(bob).post({ text: "Look", embeds: [{ url: imageURL(fixture.network.host, "nothere") }] }), 400, /image/);
  });

  test("the server holds the 280-character and 2-attachment limits itself", async () => {
    const key = as(bob).membership.networkKey;
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("a".repeat(281)), bob.fid, key)), 400, /280/);
    assert.ok(await as(bob).submit(await signMessage(MessageType.castAdd, castBody("👍🏽".repeat(100) + "a".repeat(180)), bob.fid, key)));
    const threeLinks = castBody("x", (body) => {
      for (let index = 0; index < 3; index++) {
        const embed = new Protobuf();
        embed.string(1, `https://example.com/${index}`);
        body.bytes(6, embed.data);
      }
    });
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, threeLinks, bob.fid, key)), 400, /2 attachments/);
  });

  test("messages for someone else, from an unknown key, or out of time are refused", async () => {
    const key = as(bob).membership.networkKey;
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("as carol"), carol.fid, key)), 403, /your own account/);
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("stranger"), bob.fid, Ed25519Key.random())), 400, /your keys/);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("old"), bob.fid, key, old)), 400, /time/);
  });

  test("tampered bytes and a Farcaster network field are refused", async () => {
    const key = as(bob).membership.networkKey;
    const message = await makePost(bob.fid, { text: "Tamper" }, key);
    const tampered = message.bytes.slice();
    tampered[tampered.length - 1] ^= 1;
    await rejects(as(bob).submit({ ...message, bytes: tampered }), 400);

    // The same post, but marked for Farcaster's mainnet.
    const data = new Protobuf();
    data.integer(1, 1);
    data.integer(2, bob.fid);
    data.integer(3, Math.floor(Date.now() / 1000) - 1_609_459_200);
    data.integer(4, 1);
    data.bytes(5, castBody("Mainnet"));
    const digest = blake3(data.data, { dkLen: 20 });
    const signed = new Protobuf();
    signed.bytes(1, data.data);
    signed.bytes(2, digest);
    signed.integer(3, 1);
    signed.bytes(4, await key.sign(digest));
    signed.integer(5, 1);
    signed.bytes(6, key.publicKey);
    await rejects(as(bob).submit({ ...message, bytes: signed.data }), 400, /isn't one this network takes/);
  });

  test("deleting a post with replies leaves a placeholder, and the reply stays under it", async () => {
    const original = await makePost(bob.fid, { text: "Delete me" }, as(bob).membership.networkKey);
    await as(bob).submit(original);
    await as(carol).reply({ fid: bob.fid, hash: original.hash }, { text: "Too late" });
    await rejects(as(carol).remove(original.hash), 403, /your own/);
    await as(bob).remove(original.hash);
    await as(bob).remove(original.hash);
    assert.ok(!findPost((await as(alice).feed()).posts, original.hash), "out of the feed");
    const thread = await as(alice).thread(original.hash);
    assert.deepEqual([thread.post.deleted, thread.post.text, thread.post.message], [true, "", undefined]);
    assert.deepEqual(thread.replies.map((post) => post.text), ["Too late"]);
    await rejects(as(bob).submit(original), 400, /was deleted/);

    await as(carol).remove(thread.replies[0]!.hash);
    await rejects(as(alice).thread(original.hash), 404);
  });

  test("a deleted post's quote shows as gone", async () => {
    await as(bob).remove(dinner);
    const post = findPost((await as(alice).feed()).posts, quote)!;
    assert.deepEqual(post.embeds[0], { type: "post", hash: dinner, post: null });
  });
});
