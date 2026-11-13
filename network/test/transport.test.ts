import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { insecure, secured } from "../src/server/transport.ts";

describe("HTTPS only", () => {
  test("plain HTTP moves pages to HTTPS and refuses the rest", async () => {
    const page = insecure(new Request("http://friends.example.com/admin/requests?message=x"))!;
    assert.equal(page.status, 301);
    assert.equal(page.headers.get("location"), "https://friends.example.com/admin/requests?message=x");

    const api = insecure(new Request("http://friends.example.com/api/v1/feed", { headers: { authorization: "Bearer x" } }))!;
    assert.equal(api.status, 403);
    assert.match((await api.json() as { message: string }).message, /HTTPS/);

    const form = insecure(new Request("http://friends.example.com/admin/settings", { method: "POST", body: "name=x" }))!;
    assert.equal(form.status, 403);
  });

  test("HTTPS and this computer go on", () => {
    assert.equal(insecure(new Request("https://friends.example.com/api/v1/feed")), null);
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      assert.equal(insecure(new Request(`http://${host}/api/v1/`)), null, host);
    }
  });

  test("answers over HTTPS carry Strict-Transport-Security", async () => {
    const answer = secured(new Request("https://friends.example.com/api/v1/"), Response.json({ fatline: "network" }, { status: 201 }));
    assert.equal(answer.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(answer.status, 201);
    assert.deepEqual(await answer.json(), { fatline: "network" });
    const local = secured(new Request("http://localhost:8787/api/v1/"), new Response("ok"));
    assert.equal(local.headers.get("strict-transport-security"), null);
  });
});
