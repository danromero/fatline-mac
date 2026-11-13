import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { booleanField, choiceField, errorResponse, HttpError, notFound, problem, problemMessage, refused, TEXT, textField } from "../src/server/http.ts";

/** Request fields checked by kind, and errors with stable codes. */

const fails = (work: () => unknown, code: string, message?: RegExp) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return;
  }
  assert.fail("didn't throw");
};

describe("text by kind", () => {
  test("each kind counts characters as people do, and caps bytes where it has a cap", () => {
    // Eleven UTF-16 units each, and one character as people count.
    assert.equal(textField("👩‍👩‍👧‍👦".repeat(18), "displayName", TEXT.displayName)?.length, 11 * 18);
    fails(() => textField("👩‍👩‍👧‍👦".repeat(19), "displayName", TEXT.displayName), "bad-request");
    fails(() => textField("a".repeat(33), "displayName", TEXT.displayName), "bad-request", /A display name is at most 32 characters/);
    fails(() => textField("a".repeat(201), "displayName", TEXT.displayName), "bad-request");
    // 280 characters, but 1,120 bytes.
    fails(() => textField("😀".repeat(280), "note", TEXT.note), "bad-request", /A note/);
    assert.equal(textField("😀".repeat(256), "note", TEXT.note)?.length, 512);
    assert.equal(textField(undefined, "bio", TEXT.bio), undefined);
    assert.equal(textField(null, "bio", TEXT.bio), undefined);
    fails(() => textField(7, "bio", TEXT.bio), "bad-request", /bio should be text/);
    fails(() => textField("a\uD800", "bio", TEXT.bio), "bad-request", /isn't valid text/);
  });

  test("none hides or reverses text, and only some break lines", () => {
    assert.equal(textField("two\nlines", "bio", TEXT.bio), "two\nlines");
    fails(() => textField("two\nlines", "displayName", TEXT.displayName), "hidden-text", /A display name can't/);
    fails(() => textField("safe‮txt.exe", "note", TEXT.note), "hidden-text", /A note can't/);
    fails(() => textField("Harbor​Crew", "name", TEXT.networkName), "hidden-text");
  });

  test("a network name over its length has the code the admin pages show", () => {
    fails(() => textField("a".repeat(65), "name", TEXT.networkName), "name-too-long");
    assert.equal(problemMessage("name-too-long"), "A name is at most 64 characters.");
  });

  test("choices and switches", () => {
    assert.equal(choiceField("forever", "retention", ["30 days", "forever"]), "forever");
    fails(() => choiceField("a year", "retention", ["30 days", "forever"]), "bad-request", /retention should be "30 days" or "forever"/);
    assert.equal(booleanField(false, "admitFollows"), false);
    fails(() => booleanField("on", "admitFollows"), "bad-request", /true or false/);
  });
});

describe("error codes", () => {
  test("every error answers with a code: its own, or its status's", async () => {
    assert.deepEqual(await errorResponse(problem("code-exists")).json(), { message: "That code already exists.", code: "code-exists" });
    assert.equal(errorResponse(problem("code-exists")).status, 400);
    assert.deepEqual(await errorResponse(problem("daily-limit", "That's 20 reports today.")).json(), { message: "That's 20 reports today.", code: "daily-limit" });
    const code = async (error: HttpError) => ((await errorResponse(error).json()) as { code: string }).code;
    assert.equal(await code(notFound()), "not-found");
    assert.equal(await code(new HttpError(429, "Slow down.")), "too-many");
  });

  test("refused keeps the field older apps read", async () => {
    assert.deepEqual(await errorResponse(refused()).json(), { message: "You're not a member of this network.", code: "refused", status: "refused" });
  });

  test("only codes in the list have words, so a link can't choose what the admin pages say", () => {
    assert.equal(problemMessage("bad-request"), undefined);
    assert.equal(problemMessage("toString"), undefined);
    assert.equal(problemMessage("constructor"), undefined);
  });
});
