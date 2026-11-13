import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sizeProblem, sniff, stripMetadata } from "../src/server/imagebytes.ts";
import { animation, gif, jpeg, png, SECRET } from "./handmade.ts";

/** Taking out what a camera or editor wrote, on files built byte by byte. */

const holds = (file: Uint8Array, value: string) => new TextDecoder("latin1").decode(file).includes(value);

describe("cleaning images", () => {
  test("a JPEG loses its EXIF and everything after its end marker", () => {
    const { original, stripped } = jpeg();
    assert.deepEqual(sniff(original), { type: "image/jpeg", width: 3, height: 2 });
    const cleaned = stripMetadata(original, "image/jpeg");
    assert.deepEqual(cleaned, stripped);
    assert.ok(!holds(cleaned, SECRET));
    assert.deepEqual(sniff(cleaned), { type: "image/jpeg", width: 3, height: 2 });
  });

  test("a JPEG with no end marker keeps all of its picture", () => {
    const { stripped } = jpeg();
    const cut = stripped.subarray(0, stripped.length - 2);
    assert.deepEqual(stripMetadata(cut, "image/jpeg"), cut);
  });

  test("a PNG loses its text chunks and anything after IEND", () => {
    const { original, stripped } = png();
    assert.equal(sniff(original)?.type, "image/png");
    assert.deepEqual(stripMetadata(original, "image/png"), stripped);
  });

  test("a GIF keeps its frames, timing, and loop count, and loses comments, other application blocks, and its tail", () => {
    const { original, stripped } = gif();
    assert.deepEqual(sniff(original), { type: "image/gif", width: 1, height: 1 });
    const cleaned = stripMetadata(original, "image/gif");
    assert.deepEqual(cleaned, stripped);
    assert.ok(!holds(cleaned, SECRET) && !holds(cleaned, "XMP"));
    assert.ok(holds(cleaned, "NETSCAPE2.0"));
    assert.deepEqual(stripMetadata(cleaned, "image/gif"), cleaned, "cleaning twice changes nothing");
  });

  test("a GIF stops at anything it can't read, and still ends with a trailer", () => {
    const { stripped } = gif();
    const body = stripped.subarray(0, stripped.length - 1);
    const garbage = Uint8Array.from([...body, 0x99, ...Array.from(SECRET, (character) => character.charCodeAt(0))]);
    assert.deepEqual(stripMetadata(garbage, "image/gif"), stripped);

    // A comment cut off before its last block goes, with whatever follows.
    const cut = Uint8Array.from([...body, 0x21, 0xfe, 20, ...Array.from(SECRET, (character) => character.charCodeAt(0))]);
    assert.deepEqual(stripMetadata(cut, "image/gif"), stripped);
  });

  test("pictures are at most 4,096 pixels a side, and GIFs 1,280 and 50 million pixels of frames", () => {
    const problem = (bytes: Uint8Array) => sizeProblem(bytes, sniff(bytes)!);
    const tall = png().stripped.slice();
    new DataView(tall.buffer).setUint32(20, 4097);
    assert.equal(problem(tall), "picture-too-wide");
    new DataView(tall.buffer).setUint32(20, 4096);
    assert.equal(problem(tall), null);

    assert.equal(problem(animation(1280, 30)), null);
    assert.equal(problem(animation(1281, 1)), "gif-too-wide");
    assert.equal(problem(animation(1000, 50)), null, "exactly 50 million");
    assert.equal(problem(animation(1000, 51)), "gif-too-long");
    assert.equal(problem(animation(500, 201)), "gif-too-long");

    // A frame bigger than the GIF it's in counts at its own size.
    const sneaky = animation(100, 1);
    new DataView(sneaky.buffer).setUint16(13 + 6 + 5, 4000, true);
    assert.equal(problem(sneaky), "gif-too-wide");
  });
});
