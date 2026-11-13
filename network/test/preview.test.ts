import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeEntities, parsePreview } from "../src/server/preview.ts";

/** Link previews, read from pages anyone can write. */

const base = new URL("https://menu.example/today/page.html");

function quickly<T>(work: () => T, limitMs: number): T {
  const started = performance.now();
  const result = work();
  const took = performance.now() - started;
  assert.ok(took < limitMs, `took ${took.toFixed(0)} ms`);
  return result;
}

describe("link previews", () => {
  test("Open Graph first, then the title tag, with entities decoded and the picture made absolute", () => {
    const page = `<html><head><title>Ignored</title>
      <META Property="og:title" CONTENT="The Cabin &amp; Kitchen">
      <meta name='description' content='Breakfast from 7&#x2C; dinner &#38; drinks'>
      <meta property="og:image" content="/img/menu.png"></head></html>`;
    assert.deepEqual(parsePreview(page, base), {
      title: "The Cabin & Kitchen",
      description: "Breakfast from 7, dinner & drinks",
      image: "https://menu.example/img/menu.png",
    });
    assert.deepEqual(parsePreview("<title>Just a title</title>", base), { title: "Just a title", description: undefined, image: undefined });
    assert.deepEqual(parsePreview("<p>Nothing</p>", base), { title: undefined, description: undefined, image: undefined });
  });

  test("attribute names only count as whole names", () => {
    const page = `<meta data-name="og:title" property="og:description" content="Real" data-content="Fake">`;
    assert.equal(parsePreview(page, base).description, "Real");
    assert.equal(parsePreview(page, base).title, undefined);
  });

  test("positions stay right after letters that change length when lowercased", () => {
    assert.equal(parsePreview(`<title>${"İ".repeat(50)}</title><meta property="og:title" content="Right">`, base).title, "Right");
    assert.equal(parsePreview(`<p>${"İ".repeat(50)}</p><title>Also right</title>`, base).title, "Also right");
  });

  test("text that would hide or reverse goes, and spacing is tidied", () => {
    const page = `<meta property="og:title" content="Safe‮exe.gnp  menu​\nnow">`;
    assert.equal(parsePreview(page, base).title, "Safeexe.gnp menu now");
  });

  test("entities that aren't characters don't throw", () => {
    assert.equal(decodeEntities("a&#x110000;b&#xD800;c&#0;d&#99999999999;e"), "a�b�c�d&#99999999999;e");
    assert.equal(parsePreview(`<meta property="og:title" content="x&#x110000;y">`, base).title, "x�y");
  });

  test("pages built to be slow to read are read in one pass", () => {
    quickly(() => parsePreview("<meta ".repeat(50_000), base), 250);
    quickly(() => parsePreview("A".repeat(256 * 1024), base), 50);
    quickly(() => parsePreview('<META PROPERTY="X" CONTENT="Y">'.repeat(8_000), base), 100);
    quickly(() => parsePreview("<title".repeat(50_000), base), 250);
    quickly(() => parsePreview(`<meta ${"a".repeat(4000)}>`.repeat(60), base), 250);
    quickly(() => parsePreview(`<meta ${'content="'.repeat(400)}>`.repeat(60), base), 250);
    quickly(() => parsePreview(`<meta property="og:title" content="${"&#x41;".repeat(40_000)}">`, base), 250);
  });
});
