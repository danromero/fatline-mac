import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { newPerson, TEST_PNG } from "../client/local.ts";
import { gif } from "./handmade.ts";
import { alice, bob, INVITE_PATH, now, rejects, useCabin } from "./fixtures.ts";

/** The admin pages: sign-in links, cookies, forms, and settings. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("admin pages", () => {
  let cookie = "";
  let csrf = "";

  async function page(path: string) {
    const response = await fixture.network.fetch(path, { headers: { cookie }, redirect: "manual" });
    const html = await response.text();
    csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? csrf;
    return { status: response.status, html };
  }

  async function submit(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return fixture.network.fetch(path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${fixture.network.host}`, ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  test("only the admin gets a sign-in link, and it works once", async () => {
    await rejects(as(bob).adminLink(), 403);
    const link = await as(alice).adminLink();
    assert.ok(link.startsWith(`http://${fixture.network.host}/admin/login?token=`));
    const path = new URL(link).pathname + new URL(link).search;
    const first = await fixture.network.fetch(path, { redirect: "manual" });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get("location"), "/admin/requests");
    const setCookie = first.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(";")[0]!;
    assert.equal((await fixture.network.fetch(path, { redirect: "manual" })).status, 401);
  });

  test("the pages need the cookie", async () => {
    assert.equal((await fixture.network.fetch("/admin/requests")).status, 401);
    const { status, html } = await page("/admin/requests");
    assert.equal(status, 200);
    assert.match(html, /Waiting/);
    assert.ok(csrf.length > 10);
    for (const path of ["/admin/members", "/admin/invites", "/admin/reports", "/admin/settings", "/admin/log"]) {
      assert.equal((await page(path)).status, 200, path);
    }
  });

  test("forms need their token, and can't come from another site", async () => {
    // With no-referrer, browsers send Origin: null on form posts and every form would be refused.
    const response = await fixture.network.fetch("/admin/requests", { headers: { cookie } });
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.equal((await submit("/admin/invites", { uses: "1", expires: "never" })).status, 403);
    assert.equal((await submit("/admin/invites", { csrf, uses: "1", expires: "never" }, { origin: "https://evil.example" })).status, 403);
  });

  test("making a code, approving a request, and changing settings", async () => {
    const made = await submit("/admin/invites", { csrf, uses: "unlimited", expires: "7" });
    assert.equal(made.status, 303);
    assert.equal(made.headers.get("location"), "/admin/invites?message=made");
    assert.match((await page("/admin/invites?message=made")).html, /<p class="notice" role="status">Made a code\./);
    const invites = (await page("/admin/invites")).html;
    assert.match(invites, /Anyone with it|Unlimited uses/);
    assert.ok(invites.includes(`https://${fixture.network.host}/${INVITE_PATH}/invite`));

    // Someone with no fname, waiting.
    const lee = newPerson(1310, null);
    assert.equal(await joined(lee), "pending");
    assert.match((await page("/admin/requests")).html, /!1310/);
    const approved = await submit(`/admin/requests/${lee.fid}/approve`, { csrf });
    assert.equal(approved.status, 303);
    assert.ok((await as(alice).members()).some((member) => member.fid === lee.fid));

    assert.equal((await submit("/admin/settings", { csrf, name: "The Cabin", retention: "forever" })).status, 303);
    assert.equal((await as(alice).settings()).name, "The Cabin");
    const refused = await submit("/admin/settings", { csrf, name: "x".repeat(65), retention: "forever" });
    assert.equal(refused.headers.get("location"), "/admin/settings?error=name-too-long");
    assert.match((await page("/admin/settings?error=name-too-long")).html, /role="alert">A name is at most 64 characters\./);
  });

  test("Sign out everywhere, from the members page", async () => {
    const jude = newPerson(1302, "jude");
    const code = await as(alice).createInvite();
    assert.equal(await joined(jude, code.code), "approved");
    assert.equal(await as(jude).signIn(), "approved");
    const members = (await page("/admin/members")).html;
    for (const fid of [jude.fid, alice.fid]) assert.ok(members.includes(`action="/admin/members/${fid}/sign-out"`), `a button for ${fid}`);

    const done = await submit(`/admin/members/${jude.fid}/sign-out`, { csrf });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin/members?message=signed-out");
    assert.match((await page("/admin/members?message=signed-out")).html, /Signed out everywhere\./);
    await rejects(as(jude).feed(), 401);
    assert.equal(await as(jude).signIn(), "refused");
    assert.ok((await as(alice).members()).some((member) => member.fid === jude.fid));
  });

  test("notices come from fixed codes, so a link can't put its own words on a page", async () => {
    const made = "/admin/requests?message=Your+session+expired.+Sign+in+at+evil.example&error=Call+555-0100";
    const { status, html } = await page(made);
    assert.equal(status, 200);
    assert.ok(!html.includes("evil.example") && !html.includes("555-0100"), "the link's words aren't shown");
    assert.ok(!html.includes('class="notice'), "and nothing shows in their place");
    for (const code of ["constructor", "__proto__", "toString"]) {
      assert.ok(!(await page(`/admin/requests?message=${code}&error=${code}`)).html.includes('class="notice'), code);
    }
    const failed = await submit("/admin/requests/9999/approve", { csrf });
    assert.equal(failed.headers.get("location"), "/admin/requests?error=no-request");
  });

  test("Settings offers who gets in without waiting, and pulls who you follow only when asked", async () => {
    const before = fixture.network.farcaster.hubCalls;
    const settingsPage = (await page("/admin/settings")).html;
    assert.match(settingsPage, /People you follow on Farcaster get in at once/);
    assert.match(settingsPage, /Not pulled yet\./);
    assert.ok(settingsPage.includes('action="/admin/follows/pull"'));
    assert.equal(fixture.network.farcaster.hubCalls, before, "showing Settings doesn't ask the hub");

    fixture.network.farcaster.hubDown = true;
    assert.equal((await submit("/admin/follows/pull", { csrf })).headers.get("location"), "/admin/settings?error=hub-failed");
    fixture.network.farcaster.hubDown = false;
    assert.equal((await submit("/admin/follows/pull", { csrf })).headers.get("location"), "/admin/settings?message=follows-pulled");
    assert.match((await page("/admin/settings?message=follows-pulled")).html, /0 people, pulled just now\./);

    assert.equal((await submit("/admin/settings", { csrf, name: "The Cabin", retention: "forever", admitFollows: "off" })).status, 303);
    assert.equal((await as(alice).settings()).admitFollows, false);
    assert.equal((await submit("/admin/settings", { csrf, name: "The Cabin", retention: "forever", admitFollows: "on" })).status, 303);
    assert.equal((await as(alice).settings()).admitFollows, true);
  });

  test("the picture: uploaded on Settings, then in answers, at /icon, and on the invite page", async () => {
    const upload = (bytes: Uint8Array, type: string) => {
      const form = new FormData();
      form.set("csrf", csrf);
      form.set("icon", new File([bytes], "icon", { type }));
      return fixture.network.fetch("/admin/icon", { method: "POST", redirect: "manual", headers: { cookie, origin: `http://${fixture.network.host}` }, body: form });
    };
    assert.equal((await as(alice).network()).icon, null);
    assert.equal((await fixture.network.fetch("/icon")).status, 404);

    const wrong = await upload(new TextEncoder().encode("not a picture"), "image/png");
    assert.equal(wrong.headers.get("location"), "/admin/settings?error=not-an-image");

    const saved = await upload(TEST_PNG, "image/png");
    assert.equal(saved.headers.get("location"), "/admin/settings?message=picture-saved");
    const link = (await as(bob).network()).icon;
    assert.match(link ?? "", new RegExp(`^http://${fixture.network.host}/icon\\?v=\\w+$`));
    const code = await as(alice).createInvite();
    assert.equal(((await (await fixture.network.fetch(`/api/v1/invites/${code.code}`)).json()) as { icon: string | null }).icon, link);

    const served = await fixture.network.fetch(new URL(link!).pathname + new URL(link!).search);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.match(served.headers.get("cache-control") ?? "", /immutable/);
    assert.ok(!new TextDecoder().decode(new Uint8Array(await served.arrayBuffer())).includes("secret place"), "metadata is stripped");

    const invitePage = await fixture.network.fetch(`/${INVITE_PATH}/invite`);
    assert.match(invitePage.headers.get("content-security-policy") ?? "", /img-src 'self'/);
    assert.ok((await invitePage.text()).includes(`<img class="mark" src="${new URL(link!).pathname}${new URL(link!).search}"`));
    assert.match((await page("/admin/settings")).html, /Remove picture/);

    assert.equal((await submit("/admin/icon/remove", { csrf })).status, 303);
    assert.equal((await as(alice).network()).icon, null);
    assert.equal((await fixture.network.fetch("/icon")).status, 404);
    assert.match(await (await fixture.network.fetch(`/${INVITE_PATH}/invite`)).text(), /<div class="mark"/);
  });

  test("a GIF picture loses its comments and other application blocks", async () => {
    const file = gif(64);
    const form = new FormData();
    form.set("csrf", csrf);
    form.set("icon", new File([file.original], "icon.gif", { type: "image/gif" }));
    const saved = await fixture.network.fetch("/admin/icon", { method: "POST", redirect: "manual", headers: { cookie, origin: `http://${fixture.network.host}` }, body: form });
    assert.equal(saved.headers.get("location"), "/admin/settings?message=picture-saved");
    assert.deepEqual(new Uint8Array(await (await fixture.network.fetch("/icon")).arrayBuffer()), file.stripped);
    assert.equal((await submit("/admin/icon/remove", { csrf })).status, 303);
  });

  test("revoking a code with a broken % escape is not found, not a server error", async () => {
    const response = await submit("/admin/invites/%E0%A4/revoke", { csrf });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Not found/);
    assert.equal((await submit("/admin/nothing-here", { csrf })).status, 404);
  });

  test("signing out ends the cookie's session", async () => {
    const out = await submit("/admin/logout", { csrf });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await page("/admin/requests")).status, 401);
  });

  test("signing yourself out everywhere ends the admin pages too, and the phrase gets you back", async () => {
    const link = new URL(await as(alice).adminLink());
    cookie = ((await fixture.network.fetch(link.pathname + link.search, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await page("/admin/members")).status, 200);
    assert.equal((await submit(`/admin/members/${alice.fid}/sign-out`, { csrf })).status, 303);
    assert.equal((await page("/admin/members")).status, 401);
    assert.equal(await as(alice).signIn(), "refused");

    const fresh = await fixture.network.device(alice);
    devices.set(alice.fid, fresh);
    assert.equal(await fresh.join(), "approved");
    assert.equal(await fresh.signIn(), "approved");
    assert.equal((await fresh.network()).you.role, "admin");
  });
});
