import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { byteLength, characterCount, hasStrayMarks, hidesText, joinMentions, reversesText, splitMentions } from "../src/protocol/text.ts";

// The same cases as the mention tests in apple/Tests/SnapchainTests.swift, so both apps split alike.
const handles = new Map([["dwr", 3], ["v", 5650], ["vitalik.eth", 5650], ["a-b", 9]]);
const split = (draft: string) => splitMentions(draft, handles);

describe("mentions", () => {
  test("a mention leaves the text and keeps its place", () => {
    assert.deepEqual(split("Hi @dwr and @vitalik.eth!"), { text: "Hi  and !", fids: [3, 5650], positions: [3, 8] });
  });

  test("positions count bytes, not characters", () => {
    const found = split("Café ☕️ @DWR");
    assert.equal(found.text, "Café ☕️ ");
    assert.deepEqual(found.fids, [3]);
    assert.deepEqual(found.positions, [byteLength("Café ☕️ ")]);
  });

  test("punctuation after a name stays in the text", () => {
    assert.equal(split("Thanks @dwr.").text, "Thanks .");
    assert.equal(split("(@dwr)").text, "()");
    assert.equal(split("@a-b- yes").text, "- yes");
    assert.deepEqual(split("@dwr's").fids, [3]);
  });

  test("only known whole names are mentions", () => {
    for (const draft of ["Hi @nobody", "mail me@dwr", "@dwrx", "@dwr.eth", "@ dwr", "dwr", "@"]) {
      assert.deepEqual(split(draft), { text: draft, fids: [], positions: [] }, draft);
    }
  });

  test("only so many mentions are made", () => {
    const found = split(Array(12).fill("@dwr").join(" "));
    assert.equal(found.fids.length, 10);
    assert.ok(found.text.endsWith(" @dwr @dwr"));
  });

  test("joining puts each name back", () => {
    const usernames = new Map([[3, "dwr"], [5650, "v"]]);
    assert.equal(joinMentions(split("Café ☕️ @DWR and @v!"), usernames), "Café ☕️ @dwr and @v!");
    assert.equal(joinMentions({ text: "hi ", fids: [77], positions: [3] }, usernames), "hi @!77");
  });
});

describe("counting", () => {
  test("characters as a person sees them", () => {
    assert.equal(characterCount("abc"), 3);
    assert.equal(characterCount("👍🏽"), 1);
    assert.equal(characterCount("👨‍👩‍👧‍👦"), 1);
    assert.equal(characterCount("é"), 1);
    assert.equal(characterCount("漢字"), 2);
  });
});

describe("invisible and reversing characters", () => {
  test("names can't hide or reverse, but emoji and other scripts are fine", () => {
    for (const name of ["Alice", "Dan R.", "👨‍👩‍👧 family", "می‌خواهم", "שלום", "Zoë 🇺🇸", "❤️"]) assert.equal(hidesText(name), false, name);
    for (const name of ["Al\u200Bice", "\u202Eecila", "bob\u2066x\u2069", "Bob\u00AD", "\u3164", "a\u200Fb", "a\nb", "a\u0000b", "\uFEFFbob"]) {
      assert.equal(hidesText(name), true, JSON.stringify(name));
    }
    assert.equal(hidesText("line one\nline two", { lineBreaks: true }), false);
    assert.equal(hidesText("line one\u200Bline two", { lineBreaks: true }), true);
  });

  test("posts can't reverse text, but keep the marks right-to-left writing uses", () => {
    assert.equal(reversesText("Look at https://example.com/\u202Egnp.exe"), true);
    assert.equal(reversesText("an \u2067isolate\u2069"), true);
    for (const text of ["שלום\u200F", "Hi 👋🏽", "a\u200Bb", "line\nbreak"]) assert.equal(reversesText(text), false, JSON.stringify(text));
  });
});

describe("stray marks", () => {
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";

  test("tags only in a flag, and variation selectors only after something to vary", () => {
    for (const text of [`Go ${scotland}!`, "❤️ heart", "☺︎ text style", "a\u{E0100}", "👨‍👩‍👧", "می‌خواهم", "1️⃣", "👩🏽‍💻"]) assert.equal(hasStrayMarks(text), false, JSON.stringify(text));
    const longFlag = "\u{1F3F4}" + "\u{E0061}".repeat(29) + "\u{E007F}";
    for (const text of ["alice" + "\u{E0041}".repeat(15), "\u{E007F}", "alice" + "\uFE0F".repeat(15), "\uFE0Falice", "a\u200D\uFE0F", "x\u{E0100}\u{E0101}",
      "alice" + "\u200C\uFE0F".repeat(28), "a\u200C\u200Cb", "a\u200D\u200D\u200Db", longFlag]) {
      assert.equal(hasStrayMarks(text), true, JSON.stringify(text));
    }
  });

  test("names can't have line or paragraph separators, blank braille, or stray marks", () => {
    for (const name of ["a\u2028b", "a\u2029b", "\u2800", "bob" + "\uFE0F".repeat(3)]) assert.equal(hidesText(name), true, JSON.stringify(name));
    assert.equal(hidesText(`Dan ${scotland}`), false);
  });
});

