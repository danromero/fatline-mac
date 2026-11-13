import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CastType, FarcasterNetwork, HashScheme, Message, MessageData, MessageType, ReactionType, SignatureScheme } from "@farcaster/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { Ed25519Key } from "../client/keys.ts";
import { DraftError, farcasterTime, imageURL, makeLike, makePost, makeRemoval, makeUnlike } from "../src/protocol/messages.ts";
import type { SignedMessage } from "../src/protocol/messages.ts";
import { fromHex, toHex } from "../src/protocol/protobuf.ts";

const key = Ed25519Key.random();
const date = new Date("2026-11-11T12:00:00Z");
const timestamp = farcasterTime(date);
const target = { fid: 12, hash: "0x" + "ab".repeat(20) };
const targetId = { fid: 12, hash: fromHex(target.hash)! };

/**
 * Decodes with the Farcaster SDK, an encoder these messages don't share code with, and checks what
 * every network message must be: hash, signature, signer, and no network.
 */
function decode(signed: SignedMessage) {
  const message = Message.decode(signed.bytes);
  assert.ok(message.dataBytes && message.data);
  assert.deepEqual(message.data.network, FarcasterNetwork.NONE);
  assert.deepEqual([...message.hash], [...blake3(message.dataBytes, { dkLen: 20 })]);
  assert.equal(toHex(message.hash), signed.hash);
  assert.equal(message.hashScheme, HashScheme.BLAKE3);
  assert.equal(message.signatureScheme, SignatureScheme.ED25519);
  assert.deepEqual([...message.signer], [...key.publicKey]);
  assert.ok(ed25519.verify(message.signature, message.hash, message.signer));
  // `data` and `data_bytes` carry the same bytes, as the apps send them.
  assert.deepEqual([...MessageData.encode(message.data).finish()], [...message.dataBytes]);
  return { message, data: message.data };
}

/** The field numbers of one protobuf message, in order. */
function fieldNumbers(data: Uint8Array): number[] {
  const numbers: number[] = [];
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    while (true) {
      if (at >= data.length) throw new Error("Ran past the end");
      const byte = data[at++]!;
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
  };
  while (at < data.length) {
    const tag = varint();
    numbers.push(Math.floor(tag / 8));
    if (tag % 8 === 0) {
      varint();
    } else {
      const length = varint();
      at += length;
    }
  }
  return numbers;
}

/** The SDK encodes `expected` byte for byte the way these messages do. */
function assertSameBytes(signed: SignedMessage, expected: Record<string, unknown>) {
  const { message } = decode(signed);
  // The SDK's generated types reject plain partial objects, though fromPartial takes them.
  const partial = { fid: 1, timestamp, network: FarcasterNetwork.NONE, ...expected } as never;
  const theirs = MessageData.encode(MessageData.fromPartial(partial)).finish();
  assert.equal(toHex(theirs), toHex(message.dataBytes!));
}

describe("messages", () => {
  test("a post", async () => {
    const post = await makePost(1, { text: "Dinner at 7?" }, key, date);
    assertSameBytes(post, { type: MessageType.CAST_ADD, castAddBody: { text: "Dinner at 7?", type: CastType.CAST } });
  });

  test("a post with mentions takes the names out and keeps byte offsets", async () => {
    const handles = new Map([["alice", 2], ["bob.eth", 3]]);
    const post = await makePost(1, { text: "Thanks @Alice and @bob.eth. Café @nobody", handles }, key, date);
    assertSameBytes(post, {
      type: MessageType.CAST_ADD,
      castAddBody: { text: "Thanks  and . Café @nobody", mentions: [2, 3], mentionsPositions: [7, 12] },
    });
  });

  test("a post with two images", async () => {
    const embeds = [{ url: imageURL("friends.example.com", "a1") }, { url: imageURL("friends.example.com", "b2") }];
    const post = await makePost(1, { text: "", embeds }, key, date);
    assertSameBytes(post, {
      type: MessageType.CAST_ADD,
      castAddBody: { text: "", embeds: [{ url: "https://friends.example.com/m/a1" }, { url: "https://friends.example.com/m/b2" }] },
    });
  });

  test("a post with an image and a link", async () => {
    const embeds = [{ url: imageURL("friends.example.com", "a1") }, { url: "https://example.com/menu" }];
    const post = await makePost(1, { text: "Menu", embeds }, key, date);
    assertSameBytes(post, {
      type: MessageType.CAST_ADD,
      castAddBody: { text: "Menu", embeds: [{ url: "https://friends.example.com/m/a1" }, { url: "https://example.com/menu" }] },
    });
  });

  test("a quote", async () => {
    const post = await makePost(1, { text: "This one", embeds: [{ post: target }] }, key, date);
    assertSameBytes(post, { type: MessageType.CAST_ADD, castAddBody: { text: "This one", embeds: [{ castId: targetId }] } });
  });

  test("a reply", async () => {
    const reply = await makePost(1, { text: "In", parent: target }, key, date);
    assertSameBytes(reply, { type: MessageType.CAST_ADD, castAddBody: { text: "In", parentCastId: targetId } });
  });

  test("a deletion", async () => {
    const removal = await makeRemoval(1, target.hash.toUpperCase().replace("0X", "0x"), key, date);
    assertSameBytes(removal, { type: MessageType.CAST_REMOVE, castRemoveBody: { targetHash: targetId.hash } });
  });

  test("a like and an unlike", async () => {
    const like = await makeLike(1, target, key, date);
    assertSameBytes(like, { type: MessageType.REACTION_ADD, reactionBody: { type: ReactionType.LIKE, targetCastId: targetId } });
    const unlike = await makeUnlike(1, target, key, date);
    assertSameBytes(unlike, { type: MessageType.REACTION_REMOVE, reactionBody: { type: ReactionType.LIKE, targetCastId: targetId } });
  });

  test("no message carries a network, so Farcaster refuses them", async () => {
    // Snapchain's validate_message (src/core/validations/message.rs) refuses network None on every
    // network. Here, the network field (4, tag 0x20) is simply absent from MessageData.
    const messages = [
      await makePost(1, { text: "Dinner at 7?" }, key, date),
      await makePost(1, { text: "In", parent: target }, key, date),
      await makeRemoval(1, target.hash, key, date),
      await makeLike(1, target, key, date),
    ];
    for (const signed of messages) {
      assert.deepEqual(fieldNumbers(Message.decode(signed.bytes).dataBytes!).slice(0, 3), [1, 2, 3]);
      assert.ok(!fieldNumbers(Message.decode(signed.bytes).dataBytes!).includes(4));
    }
  });

  test("the same text signed twice at the same second gives the same bytes", async () => {
    const first = await makePost(1, { text: "Same" }, key, date);
    const second = await makePost(1, { text: "Same" }, key, date);
    assert.equal(first.hash, second.hash);
  });
});

describe("drafts a client refuses", () => {
  const refuse = (draft: Parameters<typeof makePost>[1], message: RegExp) =>
    assert.rejects(makePost(1, draft, key, date), (error: Error) => error instanceof DraftError && message.test(error.message));

  test("over 280 characters, counted as a person sees them", async () => {
    // 👍🏽 is 8 bytes and one character.
    await makePost(1, { text: "👍🏽".repeat(100) + "a".repeat(180) }, key, date);
    await refuse({ text: "👍🏽".repeat(100) + "a".repeat(181) }, /280/);
    await refuse({ text: "a".repeat(281) }, /280/);
    // Mentions count as @username even though the name leaves the signed text.
    const handles = new Map([["alice", 2]]);
    await makePost(1, { text: "a".repeat(274) + "@alice", handles }, key, date);
    await refuse({ text: "a".repeat(275) + "@alice", handles }, /280/);
  });

  test("over 1,024 bytes", async () => {
    await refuse({ text: "𝕏".repeat(257) }, /too long/i);
  });

  test("more than 2 attachments", async () => {
    const url = "https://example.com/";
    await refuse({ text: "x", embeds: [{ url }, { url }, { url }] }, /2 attachments/);
  });

  test("nothing at all", async () => {
    await refuse({ text: "  " }, /nothing/i);
  });

  test("links that aren't https, or are too long", async () => {
    await refuse({ text: "x", embeds: [{ url: "http://example.com" }] }, /https/);
    await refuse({ text: "x", embeds: [{ url: "https://example.com/" + "a".repeat(240) }] }, /too long/i);
  });

  test("a hash that isn't 20 bytes", async () => {
    await assert.rejects(makeRemoval(1, "0x1234", key, date), DraftError);
    await refuse({ text: "x", parent: { fid: 1, hash: "0x12" } }, /20 bytes/);
  });
});
