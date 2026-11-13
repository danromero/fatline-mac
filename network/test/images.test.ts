import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imageURL } from "../src/protocol/messages.ts";
import { newPerson, TEST_PNG } from "../client/local.ts";
import { animation, gif, jpeg } from "./handmade.ts";
import { alice, bob, carol, findPost, now, rejects, useCabin } from "./fixtures.ts";

/** Uploads, signed image links, previews, avatars, and deleting pictures. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("images", () => {
  const gina = newPerson(1007, "gina");
  const text = new TextDecoder();

  /** Polls until `check` gives something, for work the server finishes after answering. */
  async function eventually<T>(check: () => Promise<T | null | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("It never happened");
  }

  /** Loads a signed link through the local server, as a device would. */
  const load = (link: string, accept = "image/webp,image/*") => fetch(link, { headers: { accept } });

  test("an upload is checked, and loses the text a camera or editor wrote", async () => {
    const image = await as(bob).uploadImage(TEST_PNG, "image/png");
    assert.deepEqual([image.url, image.width, image.height], [imageURL(fixture.network.host, image.id), 64, 48]);
    await rejects(as(bob).uploadImage(new TextEncoder().encode("not a picture"), "image/png"), 400, /JPEG, PNG, or GIF/);
    await rejects(as(bob).uploadImage(TEST_PNG, "image/jpeg"), 400, /type/);
    const huge = TEST_PNG.slice();
    new DataView(huge.buffer).setUint32(16, 4097);
    await rejects(as(bob).uploadImage(huge, "image/png"), 400, /4,096/);
    await rejects(as(bob).uploadImage(animation(1000, 51), "image/gif"), 400, /too many frames/);
  });

  test("a GIF loses its comments and other application blocks, and a JPEG what follows its end", async () => {
    for (const [file, type] of [[gif(), "image/gif"], [jpeg(), "image/jpeg"]] as const) {
      const image = await as(bob).uploadImage(file.original, type);
      const hash = await as(bob).post({ text: `Cleaned ${type}`, embeds: [{ url: image.url }] });
      const embed = findPost((await as(bob).feed()).posts, hash)!.embeds[0] as { full: string };
      assert.deepEqual(new Uint8Array(await (await load(embed.full)).arrayBuffer()), file.stripped, type);
      await as(bob).remove(hash);
    }
  });

  test("a member can upload 50 pictures a day", async () => {
    const nora = newPerson(1401, "nora");
    assert.equal(await joined(nora, (await as(alice).createInvite()).code), "approved");
    assert.equal(await as(nora).signIn(), "approved");
    for (let index = 0; index < 50; index++) await as(nora).uploadImage(TEST_PNG, "image/png");
    await rejects(as(nora).uploadImage(TEST_PNG, "image/png"), 429, /50 pictures in a day/);
    // A link's preview picture is a copy too, so past the day's pictures it comes without one.
    const linked = await as(nora).post({ text: "Menu", embeds: [{ url: "https://nora.example/test/page.html" }] });
    const preview = await eventually(async () => {
      const embed = findPost((await as(nora).feed()).posts, linked)?.embeds[0];
      return embed?.type === "link" ? embed.preview : null;
    });
    assert.deepEqual([preview.title, preview.image], ["The Cabin Kitchen menu", undefined]);
    assert.ok(await as(bob).uploadImage(TEST_PNG, "image/png"), "it's per member");
  });

  test("a post with two images shows their sizes through signed links", async () => {
    const [first, second] = [await as(bob).uploadImage(TEST_PNG, "image/png"), await as(bob).uploadImage(TEST_PNG, "image/png")];
    const hash = await as(bob).post({ text: "Two pictures", embeds: [{ url: first.url }, { url: second.url }] });
    const post = findPost((await as(alice).feed()).posts, hash)!;
    assert.equal(post.embeds.length, 2);
    const [embed] = post.embeds;
    assert.ok(embed?.type === "image");
    assert.deepEqual([embed.url, embed.width, embed.height], [first.url, 64, 48]);

    const display = await load(embed.src);
    assert.equal(display.status, 200);
    assert.match(display.headers.get("content-type") ?? "", /^image\/(webp|png)$/);
    const original = await load(embed.full);
    assert.equal(original.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await original.arrayBuffer());
    assert.ok(!text.decode(bytes).includes("secret place"), "the text chunk is gone");
    assert.equal((await load(embed.src)).status, 200, "a size made once is kept");

    await rejects(as(alice).post({ text: "Not mine", embeds: [{ url: first.url }] }), 400, /image/);
  });

  test("an expired or altered link is refused", async () => {
    const post = (await as(alice).feed()).posts.find((candidate) => candidate.embeds[0]?.type === "image")!;
    const embed = post.embeds[0] as { src: string };
    const link = new URL(embed.src);
    const expired = new URL(link);
    expired.searchParams.set("e", String(now() - 10));
    assert.equal((await load(expired.toString())).status, 403);
    const altered = new URL(link);
    altered.pathname = altered.pathname.replace("/display", "/original");
    assert.equal((await load(altered.toString())).status, 403);
  });

  test("an image and a link, with the link's preview read by the server", async () => {
    const image = await as(bob).uploadImage(TEST_PNG, "image/png");
    const page = "https://menu.example/test/page.html";
    const hash = await as(bob).post({ text: "Menu", embeds: [{ url: image.url }, { url: page }] });
    const preview = await eventually(async () => {
      const link = findPost((await as(alice).feed()).posts, hash)!.embeds[1];
      return link?.type === "link" ? link.preview : null;
    });
    assert.deepEqual([preview.title, preview.description], ["The Cabin Kitchen menu", "Breakfast from 7, dinner on Saturdays & Sundays."]);
    assert.equal((await load(preview.image!)).status, 200);
  });

  test("a joining member's Farcaster picture is copied in, and anyone can upload their own", async () => {
    const code = await as(alice).createInvite({ code: "PICTURES" });
    fixture.network.farcaster.add(gina);
    const client = await fixture.network.device(gina);
    devices.set(gina.fid, client);
    assert.equal(await client.join({ invite: code.code, avatar: "https://pictures.example/test/avatar.png" }), "approved");
    assert.equal(await client.signIn(), "approved");
    const copied = await eventually(async () => (await as(alice).members()).find((member) => member.fid === gina.fid)?.avatar);
    assert.equal((await load(copied, "image/png")).status, 200);

    const picture = await as(bob).uploadImage(TEST_PNG, "image/png");
    const me = await as(bob).updateProfile({ avatar: picture.id });
    assert.ok(me.avatar && me.ownAvatar);
    assert.equal((await load(me.avatar)).status, 200);
    await rejects(as(gina).updateProfile({ avatar: picture.id }), 400, /image/);
    const back = await as(bob).updateProfile({ avatar: "farcaster" });
    assert.deepEqual([back.avatar, back.ownAvatar], [null, false]);
  });

  test("replacing an avatar deletes the old picture", async () => {
    const first = await as(bob).updateProfile({ avatar: (await as(bob).uploadImage(TEST_PNG, "image/png")).id });
    assert.equal((await load(first.avatar!)).status, 200);
    const second = await as(bob).updateProfile({ avatar: (await as(bob).uploadImage(TEST_PNG, "image/png")).id });
    assert.equal((await load(first.avatar!)).status, 404, "the old one is gone");
    assert.equal((await load(second.avatar!)).status, 200);
    await as(bob).updateProfile({ avatar: "farcaster" });
    assert.equal((await load(second.avatar!)).status, 404);
  });

  test("a link that redirects somewhere broken has no preview, and doesn't stop the post's other link", async () => {
    const hash = await as(bob).post({ text: "Two links", embeds: [{ url: "https://broken.example/test/bad-redirect" }, { url: "https://good.example/test/page.html" }] });
    const preview = await eventually(async () => {
      const embed = findPost((await as(alice).feed()).posts, hash)!.embeds[1];
      return embed?.type === "link" ? embed.preview : null;
    });
    assert.equal(preview.title, "The Cabin Kitchen menu");
    const broken = findPost((await as(alice).feed()).posts, hash)!.embeds[0];
    assert.deepEqual(broken, { type: "link", url: "https://broken.example/test/bad-redirect", preview: null });
  });

  test("an app that reads its own links sends their previews, and the server fetches nothing", async () => {
    // A page no other test links, so only a fetch for this post could read it.
    const page = "https://menu.example/test/page.html?supper";
    const loads = fixture.network.farcaster.pageLoads;
    const hash = await as(bob).post({ text: "Supper", embeds: [{ url: page }] }, { readsLinks: true });
    const linkOf = async (viewer: typeof alice, post: string) => {
      const embed = findPost((await as(viewer).feed()).posts, post)!.embeds[0]!;
      return embed.type === "link" ? embed : null;
    };
    assert.equal((await linkOf(alice, hash))!.preview, null);

    const picture = await as(bob).uploadImage(TEST_PNG, "image/png");
    await as(bob).sendPreviews(hash, [{ url: page, title: "Supper at the Cabin", description: "Soup, then pie.", image: picture.id }]);
    const preview = (await linkOf(alice, hash))!.preview!;
    assert.deepEqual([preview.title, preview.description], ["Supper at the Cabin", "Soup, then pie."]);
    assert.equal((await load(preview.image!)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fixture.network.farcaster.pageLoads, loads, "the server never read the page");

    // Only its author, only its own links, and nobody else's post of the same link shows it.
    await rejects(as(carol).sendPreviews(hash, [{ url: page, title: "Not yours" }]), 403);
    await rejects(as(bob).sendPreviews(hash, [{ url: "https://elsewhere.example/", title: "Elsewhere" }]), 400, /own links/);
    await rejects(as(bob).sendPreviews(hash, [{ url: page, image: (await as(carol).uploadImage(TEST_PNG, "image/png")).id }]), 400, /isn't on this network/);
    await rejects(as(bob).sendPreviews(hash, [{ url: page, title: "Hidden\u200Btext" }]), 400, /invisible/);
    const same = await as(carol).post({ text: "Same link", embeds: [{ url: page }] }, { readsLinks: true });
    assert.equal((await linkOf(alice, same))!.preview, null);

    // Deleting the post lets its preview's picture go.
    await as(bob).remove(hash);
    assert.equal((await load(preview.image!)).status, 404);
  });

  test("an app can upload its member's Farcaster picture itself", async () => {
    const picture = await as(carol).uploadImage(TEST_PNG, "image/png");
    const member = await as(carol).updateProfile({ farcasterPicture: picture.id });
    assert.ok(member.avatar);
    assert.equal(member.ownAvatar, false, "it's their Farcaster picture, not one they chose here");
    await rejects(as(carol).updateProfile({ farcasterPicture: (await as(bob).uploadImage(TEST_PNG, "image/png")).id }), 400, /isn't on this network/);
    // Replacing it lets the old one go.
    await as(carol).updateProfile({ farcasterPicture: (await as(carol).uploadImage(TEST_PNG, "image/png")).id });
    assert.equal((await load(member.avatar!)).status, 404);
  });

  test("a link's preview and its picture go with the last post that has the link", async () => {
    const link = "https://cafe.example/test/page.html";
    const [first, second] = [await as(bob).post({ text: "Cafe", embeds: [{ url: link }] }), await as(gina).post({ text: "Same cafe", embeds: [{ url: link }] })];
    const picture = await eventually(async () => {
      const embed = findPost((await as(alice).feed()).posts, first)!.embeds[0];
      return embed?.type === "link" ? embed.preview?.image : null;
    });
    assert.equal((await load(picture)).status, 200);
    await as(bob).remove(first);
    assert.equal((await load(picture)).status, 200, "gina's post still has the link");
    await as(gina).remove(second);
    assert.equal((await load(picture)).status, 404);
  });

  test("deleting a post deletes its images", async () => {
    const image = await as(bob).uploadImage(TEST_PNG, "image/png");
    const hash = await as(bob).post({ text: "Short-lived", embeds: [{ url: image.url }] });
    const embed = findPost((await as(bob).feed()).posts, hash)!.embeds[0] as { full: string };
    await as(bob).remove(hash);
    assert.equal((await load(embed.full)).status, 404);
  });

  test("removing a member deletes their files", async () => {
    const image = await as(gina).uploadImage(TEST_PNG, "image/png");
    const hash = await as(gina).post({ text: "Mine", embeds: [{ url: image.url }] });
    const embed = findPost((await as(alice).feed()).posts, hash)!.embeds[0] as { full: string };
    const avatar = (await as(alice).members()).find((member) => member.fid === gina.fid)!.avatar!;
    await as(alice).removeMember(gina.fid);
    assert.equal((await load(embed.full)).status, 404);
    assert.equal((await load(avatar)).status, 404);
  });
});
