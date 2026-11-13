import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newPerson, TEST_PNG } from "../client/local.ts";
import { alice, now, useCabin } from "./fixtures.ts";

/** Long lists: big threads, many quotes, and many unused images. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("long lists", () => {
  test("posts quoting 100 others, and a thread of 101 replies with links, still load for everyone", async () => {
    const otto = newPerson(1501, "otto");
    assert.equal(await joined(otto, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(otto).signIn(), "approved");
    const quoted: string[] = [];
    for (let index = 0; index < 100; index++) quoted.push(await as(otto).post({ text: `Quoted ${index}` }));
    // Times are whole seconds, so the quoting posts come a second later and fill the first page by themselves.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (let index = 0; index < 50; index++) {
      await as(otto).post({ text: `Two quotes ${index}`, embeds: [0, 1].map((offset) => ({ post: { fid: otto.fid, hash: quoted[2 * index + offset]! } })) });
    }
    const feed = await as(alice).feed();
    assert.equal(feed.posts.length, 50);
    assert.ok(feed.posts.every((post) => post.embeds.length === 2 && post.embeds.every((embed) => embed.type === "post" && embed.post)));

    const root = await as(alice).post({ text: "Reply with a link" });
    for (let index = 0; index < 101; index++) await as(otto).reply({ fid: alice.fid, hash: root }, { text: `Link ${index}`, embeds: [{ url: `https://example.com/${index}` }] });
    assert.equal((await as(alice).thread(root)).replies.length, 101);
    assert.equal((await as(alice).activity()).items.length, 50);
  });

  test("the hourly cleanup takes more than 100 unused images at once", async () => {
    for (const [index, fid] of [1502, 1503, 1504].entries()) {
      const person = newPerson(fid, `uploader${index}`);
      assert.equal(await joined(person, (await as(alice).createInvite()).code), "approved");
      assert.equal(await as(person).signIn(), "approved");
      await Promise.all(Array.from({ length: 40 }, () => as(person).uploadImage(TEST_PNG, "image/png")));
    }
    // A day later all 120 are unused. The cleanup used to fail past 100, and then on every run after.
    await fixture.network.runHourly(now() + 25 * 60 * 60);
    await fixture.network.runHourly(now() + 26 * 60 * 60);
  });
});
