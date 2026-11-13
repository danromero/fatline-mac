import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INVITE_PATH, useCabin } from "./fixtures.ts";

/** Pages outside the API, and old Mac builds. Against the real Worker on a local D1, with a network of this file's own. */

const fixture = useCabin();
const { as, joined, devices } = fixture;

describe("the invite page", () => {
  test("shows the network's address and how to join, at its secret path only", async () => {
    const response = await fixture.network.fetch(`/${INVITE_PATH}/invite`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    const html = await response.text();
    assert.ok(html.includes(`data-copy="${fixture.network.host}"`));
    assert.match(html, /Download for macOS<\/a>/, "no version until a pilot is uploaded");
    assert.match(html, /Wait until you’re approved\./);
    assert.equal((await fixture.network.fetch("/not-the-invite-path-000000/invite")).status, 404);
    assert.equal((await fixture.network.fetch(`/${INVITE_PATH}/nothing`)).status, 404);
  });

  test("serves its fonts, and the latest public release until the admin uploads a build", async () => {
    const font = await fixture.network.fetch(`/${INVITE_PATH}/Inter-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.ok((await font.arrayBuffer()).byteLength > 10_000);
    const download = await fixture.network.fetch(`/${INVITE_PATH}/Fatline.dmg`, { redirect: "manual" });
    assert.equal(download.status, 302);
    assert.equal(download.headers.get("location"), "https://github.com/danromero/fatline-monorepo/releases/latest/download/Fatline.dmg");
    assert.equal(download.headers.get("cache-control"), "no-store");
  });
});

describe("old Mac builds", () => {
  const ask = (headers: Record<string, string>) => fixture.network.fetch("/api/v1/", { headers });

  test("are asked to update once the network sets a minimum", async () => {
    for (const version of ["0.3.90", "0.3.10", "0.2"]) {
      const response = await ask({ "fatline-app": `mac/${version}` });
      assert.equal(response.status, 426, version);
      assert.match(((await response.json()) as { message: string }).message, /^Update Fatline to keep using .+\. Get it at fatline\.tech\.$/);
    }
    for (const version of ["0.3.91", "0.4.0", "1.0"]) assert.equal((await ask({ "fatline-app": `mac/${version}` })).status, 200, version);
  });

  test("count as too old when only their user agent says Fatline", async () => {
    assert.equal((await ask({ "user-agent": "Fatline/6 CFNetwork/3826.400.110 Darwin/27.0.0" })).status, 426);
    assert.equal((await ask({ "user-agent": "Fatline/6 CFNetwork/3826.400.110 Darwin/27.0.0", "fatline-app": "iphone/0.1.1" })).status, 200);
    assert.equal((await ask({})).status, 200, "other clients aren't turned away");
  });
});

describe("the pilot feed", () => {
  test("is missing until a pilot build is uploaded", async () => {
    assert.equal((await fixture.network.fetch(`/${INVITE_PATH}/latest.json`)).status, 404);
    assert.equal((await fixture.network.fetch("/not-the-invite-path-000000/latest.json")).status, 404);
  });
});

describe("links to posts", () => {
  test("a post's page shows nothing from the post", async () => {
    const hash = "0x" + "ab".repeat(20);
    const response = await fixture.network.fetch(`/p/${hash}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Open in Fatline/);
    assert.ok(html.includes(`href="fatline://open?network=${encodeURIComponent(fixture.network.host)}&amp;post=${hash}"`));
    assert.equal((await fixture.network.fetch("/m/anything")).status, 404);
  });
});
