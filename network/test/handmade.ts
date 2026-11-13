/**
 * Image files built byte by byte, each with something a camera or editor might leave in it, and the
 * file as it should be once that's taken out. None of them decode to a real picture; the server only
 * reads their structure.
 */

const text = (value: string) => Array.from(value, (character) => character.charCodeAt(0));
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));

export const SECRET = "secret place";

/** A JPEG marker segment: FF, the marker, a two-byte length that counts itself, and the payload. */
function segment(marker: number, payload: number[]) {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/**
 * A 3 by 2 JPEG with EXIF up front, two scans with tables between them, and a gain map after its end
 * marker carrying EXIF of its own. Its tables hold FF D9, which isn't the end when it's inside a segment.
 */
export function jpeg() {
  const start = [0xff, 0xd8];
  const jfif = segment(0xe0, [...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const exif = segment(0xe1, [...text("Exif\0\0"), ...text(SECRET)]);
  const frame = segment(0xc0, [8, 0, 2, 0, 3, 1, 1, 0x11, 0]);
  const tables = segment(0xc4, [0, 1, 0xff, 0xd9, 2, 3]);
  const scan = segment(0xda, [1, 1, 0, 0, 63, 0]);
  // Scan data: a stuffed FF 00 and a restart marker, neither of them the end.
  const data = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
  const moreTables = segment(0xc4, [0x10, 0xff, 0xd9, 0xff, 0xd9]);
  const secondScan = segment(0xda, [1, 1, 0, 1, 63, 0]);
  const moreData = [0x78, 0xff, 0x00, 0x9a];
  const end = [0xff, 0xd9];
  const gainMap = [...start, ...segment(0xe1, [...text("Exif\0\0"), ...text(SECRET)]), ...frame, ...end];
  const picture = [...frame, ...tables, ...scan, ...data, ...moreTables, ...secondScan, ...moreData, ...end];
  return {
    original: bytes(start, jfif, exif, picture, gainMap),
    stripped: bytes(start, jfif, picture),
  };
}

/** A PNG chunk: length, name, data, and a CRC, which nothing here checks. */
function chunk(name: string, data: number[]) {
  const length = data.length;
  return [length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...text(name), ...data, 0, 0, 0, 0];
}

/** A 1 by 1 PNG with a text chunk, and another after its last chunk. */
export function png() {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const header = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const comment = chunk("tEXt", text(`Comment\0${SECRET}`));
  const data = chunk("IDAT", [1, 2, 3]);
  const end = chunk("IEND", []);
  return {
    original: bytes(signature, header, comment, data, end, chunk("tEXt", text(`After\0${SECRET}`))),
    stripped: bytes(signature, header, data, end),
  };
}

/** A GIF sub-block run: each piece with its length, then the empty block that ends them. */
const blocks = (...pieces: number[][]) => [...pieces.flatMap((piece) => [piece.length, ...piece]), 0];

/**
 * A GIF `side` pixels square with two frames, a loop block with an extra sub-block, a comment, an XMP
 * block, and text after its trailer. The second frame's color table holds 21 FE, which isn't a comment there.
 */
export function gif(side = 1) {
  const header = [...text("GIF89a"), side, 0, side, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff];
  const loop = [0x21, 0xff, ...blocks(text("NETSCAPE2.0"), [1, 0, 0], text(SECRET))];
  const cleanLoop = [0x21, 0xff, ...blocks(text("NETSCAPE2.0"), [1, 0, 0])];
  const comment = [0x21, 0xfe, ...blocks(text(SECRET))];
  const xmp = [0x21, 0xff, ...blocks(text("XMP DataXMP"), text(`<x:xmpmeta>${SECRET}</x:xmpmeta>`))];
  const timing = [0x21, 0xf9, ...blocks([0, 10, 0, 0])];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, ...blocks([0x44, 0x01])];
  const framed = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x21, 0xfe, 0, 1, 2, 3, 2, ...blocks([0x44, 0x01])];
  return {
    original: bytes(header, loop, comment, xmp, timing, frame, timing, framed, [0x3b], text(SECRET)),
    stripped: bytes(header, cleanLoop, timing, frame, timing, framed, [0x3b]),
  };
}

/** A GIF `side` pixels square with `frames` frames, each filling it, with almost no picture data. */
export function animation(side: number, frames: number) {
  const header = [...text("GIF89a"), side & 0xff, side >> 8, side & 0xff, side >> 8, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff];
  const frame = [0x2c, 0, 0, 0, 0, side & 0xff, side >> 8, side & 0xff, side >> 8, 0, 2, ...blocks([0x44, 0x01])];
  return bytes(header, ...Array.from({ length: frames }, () => frame), [0x3b]);
}
