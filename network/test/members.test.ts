import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MessageType, signMessage } from "../src/protocol/messages.ts";
import { alice, bob, carol, castBody, erin, findPost, rejects, useCabin } from "./fixtures.ts";

/** Members, profiles, mutes, reports, and the admin removing someone. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("members", () => {
  test("the member list, profiles, and mutes", async () => {
    const names = (await as(bob).members()).map((member) => member.username);
    assert.deepEqual(names, ["alice", "bob", "carol", "!1005"]);
    const me = await as(bob).updateProfile({ displayName: "Bob B.", bio: "Cooks" });
    assert.deepEqual([me.displayName, me.bio], ["Bob B.", "Cooks"]);
    await rejects(as(bob).updateProfile({ displayName: "x".repeat(33) }), 400, /32/);

    const hello = await as(carol).post({ text: "Hello from carol" });
    await as(alice).mute(carol.fid);
    assert.ok(!findPost((await as(alice).feed()).posts, hello));
    assert.ok(findPost((await as(bob).feed()).posts, hello));
    assert.equal((await as(alice).members()).find((member) => member.fid === carol.fid)!.muted, true);
    await as(alice).unmute(carol.fid);
    assert.ok(findPost((await as(alice).feed()).posts, hello));
    await rejects(as(alice).mute(alice.fid), 400);
  });

  test("names, bios, and posts can't hide or reverse text", async () => {
    await rejects(as(bob).updateProfile({ displayName: "\u202Eecila" }), 400, /invisible characters/);
    await rejects(as(bob).updateProfile({ displayName: "al\u200Bice" }), 400, /invisible characters/);
    await rejects(as(bob).updateProfile({ displayName: "a\ud800b" }), 400, /isn't valid text/);
    await rejects(as(bob).updateProfile({ bio: "\udc00" }), 400, /isn't valid text/);
    await rejects(as(bob).updateProfile({ bio: "Cooks\u2066 \u2069" }), 400, /invisible characters/);
    assert.equal((await as(bob).updateProfile({ bio: "Cooks\nand bakes" })).bio, "Cooks\nand bakes");
    assert.equal((await as(bob).updateProfile({ displayName: "Bob 👨‍🍳" })).displayName, "Bob 👨‍🍳");
    const key = as(bob).membership.networkKey;
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("menu\u202Etxt.exe"), bob.fid, key)), 400, /reverse or hide/);
    await rejects(as(bob).submit(await signMessage(MessageType.castAdd, castBody("bob" + "\u{E0041}".repeat(20)), bob.fid, key)), 400, /reverse or hide/);
    await rejects(as(bob).post({ text: "Look", embeds: [{ url: "https://example.com/#\u202Egnp.exe" }] }), 400, /hide or reverse/);
    assert.ok(await as(bob).post({ text: "Chef 👨‍🍳 שלום\u200F" }));
    await as(bob).updateProfile({ displayName: "Bob B.", bio: "Cooks" });
  });

  test("the admin can delete one post, which goes as its author deleting it would", async () => {
    const post = await as(bob).post({ text: "The admin deletes this" });
    const answer = await fixture.network.fetch(`/api/v1/admin/posts/${post}/delete`, { method: "POST", headers: { authorization: `Bearer ${as(alice).membership.token}` } });
    assert.equal(answer.status, 204);
    assert.ok(!findPost((await as(bob).feed()).posts, post));
    assert.ok((await as(alice).log()).some((entry) => entry.action === "deleted a post by" && (entry.detail as { post?: string }).post === post));
    const again = await fixture.network.fetch(`/api/v1/admin/posts/${post}/delete`, { method: "POST", headers: { authorization: `Bearer ${as(alice).membership.token}` } });
    assert.equal(again.status, 404);
    const notAdmin = await fixture.network.fetch(`/api/v1/admin/posts/${post}/delete`, { method: "POST", headers: { authorization: `Bearer ${as(bob).membership.token}` } });
    assert.equal(notAdmin.status, 403);
  });

  test("a report reaches the admin", async () => {
    const post = (await as(bob).feed()).posts.find((candidate) => candidate.fid === carol.fid)!;
    await as(bob).report(post.hash, "Not okay");
    const [report] = await as(alice).reports();
    assert.deepEqual([report!.post, report!.postFid, report!.fid, report!.note, report!.here], [post.hash, carol.fid, bob.fid, "Not okay", true]);
    await as(alice).resolveReport(report!.id);
  });

  test("removing someone deletes what they posted, leaves placeholders, and blocks them", async () => {
    const alicePost = await as(alice).post({ text: "Alice's post" });
    const carolReply = await as(carol).reply({ fid: alice.fid, hash: alicePost }, { text: "Carol replies" });
    const carolPost = await as(carol).post({ text: "Carol's post" });
    const bobReply = await as(bob).reply({ fid: carol.fid, hash: carolPost }, { text: "Bob replies" });
    await as(bob).like({ fid: carol.fid, hash: carolPost });
    await as(carol).like({ fid: alice.fid, hash: alicePost });

    await as(alice).removeMember(carol.fid);

    const feed = (await as(bob).feed()).posts;
    assert.ok(!feed.some((post) => post.fid === carol.fid), "nothing of carol's in the feed");
    assert.equal(findPost(feed, alicePost)!.likes, 0);
    assert.deepEqual((await as(bob).thread(alicePost)).replies, []);
    const placeholder = await as(bob).thread(carolPost);
    assert.equal(placeholder.post.deleted, true);
    assert.deepEqual(placeholder.replies.map((post) => post.hash), [bobReply]);
    assert.ok(!(await as(bob).members()).some((member) => member.fid === carol.fid));
    void carolReply;

    await rejects(as(carol).feed(), 401);
    assert.equal(await as(carol).signIn(), "refused");
    assert.equal(await (await fixture.network.device(carol)).join(), "refused");
    assert.deepEqual((await as(alice).blocks()).map((block) => block.fid), [carol.fid]);
    const actions = (await as(alice).log()).map((entry) => entry.action);
    assert.ok(actions.includes("removed"));

    await as(alice).unblock(carol.fid);
    assert.equal(await joined(carol), "pending");
  });

  test("leaving deletes what you posted, and you can ask to join again", async () => {
    const goodbye = await as(erin).post({ text: "Goodbye" });
    await as(erin).leave();
    assert.ok(!findPost((await as(bob).feed()).posts, goodbye));
    assert.equal(await as(erin).signIn(), "refused");
    assert.equal(await (await fixture.network.device(erin)).join(), "pending");
  });

  test("the admin can't leave or remove themselves", async () => {
    await rejects(as(alice).leave(), 403);
    await rejects(as(alice).removeMember(alice.fid), 400);
  });
});
