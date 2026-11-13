/**
 * Reading and cleaning image files byte by byte: what a JPEG, PNG, or GIF says it is, and the same
 * file without what a camera or editor wrote alongside the picture. Nothing here decodes pixels.
 */

export type ImageType = "image/jpeg" | "image/png" | "image/gif";

/** The longest side a picture can have. The Mac app sends 2,048 at most. */
export const MAX_SIDE = 4096;
/** GIFs are never resized, so every app gets the whole file, avatars included. */
export const MAX_GIF_SIDE = 1280;
/** Every frame's pixels added up: about 200 frames of a 500-pixel GIF. Past this, playing it takes too much memory. */
export const MAX_GIF_PIXELS = 50_000_000;

/** The format and size an image's header gives, or null if it isn't a JPEG, PNG, or GIF. */
export function sniff(bytes: Uint8Array): { type: ImageType; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length > 10 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) {
    return { type: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      const length = view.getUint16(at + 2);
      // Start-of-frame markers carry the size. C4, C8, and CC are other things.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

/** Why a picture is too large to take, as an error code (http.ts), or null when it isn't. */
export function sizeProblem(bytes: Uint8Array, image: { type: ImageType; width: number; height: number }): "picture-too-wide" | "gif-too-wide" | "gif-too-long" | null {
  if (image.width > MAX_SIDE || image.height > MAX_SIDE) return "picture-too-wide";
  if (image.type !== "image/gif") return null;
  const tooWide = "gif-too-wide";
  if (image.width > MAX_GIF_SIDE || image.height > MAX_GIF_SIDE) return tooWide;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pixels = 0;
  for (const block of gifBlocks(bytes)) {
    if (block.label !== IMAGE) continue;
    const [width, height] = [view.getUint16(block.start + 5, true), view.getUint16(block.start + 7, true)];
    if (width > MAX_GIF_SIDE || height > MAX_GIF_SIDE) return tooWide;
    pixels += width * height;
    if (pixels > MAX_GIF_PIXELS) return "gif-too-long";
  }
  return null;
}

/**
 * Takes out what a camera or editor wrote alongside the picture: EXIF and XMP in a JPEG, which can
 * hold where it was taken, text and EXIF chunks in a PNG, and comments and application blocks in a
 * GIF. Anything after the end of the picture goes too. Apps should turn a photo upright before
 * uploading, since the EXIF orientation goes.
 */
export function stripMetadata(bytes: Uint8Array, type: ImageType): Uint8Array {
  if (type === "image/jpeg") return stripJPEG(bytes);
  if (type === "image/png") return stripPNG(bytes);
  return stripGIF(bytes);
}

// MARK: JPEG

function stripJPEG(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    // Start of scan: the rest is the picture.
    if (marker === 0xda) break;
    const end = at + 2 + view.getUint16(at + 2);
    // APP1 holds EXIF and XMP, APP13 Photoshop's IPTC, COM comments.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(bytes.subarray(at, end));
    at = end;
  }
  // The picture, through its end marker. What follows, such as a gain map, can carry EXIF of its own.
  parts.push(bytes.subarray(at, pictureEnd(bytes, at)));
  return concat(parts);
}

/**
 * Where a JPEG's picture ends, just past its end-of-image marker, reading from its first scan. Inside
 * scan data a 0xFF is followed by a zero or a restart marker, so it can't be mistaken for the end. Any
 * other marker before the end has a length, like the next scan's header or tables between scans, and
 * is skipped whole. Without an end marker, the picture runs to the end of the file.
 */
function pictureEnd(bytes: Uint8Array, from: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = from;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1]!;
    if (marker === 0xd9) return at + 2;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (at + 4 > bytes.length) break;
    at += 2 + view.getUint16(at + 2);
  }
  return bytes.length;
}

// MARK: PNG

function stripPNG(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!["eXIf", "tEXt", "iTXt", "zTXt", "tIME"].includes(name)) parts.push(bytes.subarray(at, end));
    // IEND is the last chunk. Anything after it isn't part of the picture.
    if (name === "IEND") break;
    at = end;
  }
  return concat(parts);
}

// MARK: GIF

const NETSCAPE = Array.from("NETSCAPE2.0", (character) => character.charCodeAt(0));
const TRAILER = Uint8Array.of(0x3b);

/**
 * A GIF without its comments or application blocks, which carry XMP, color profiles, and whatever
 * else an editor puts there. The NETSCAPE2.0 block, which says how many times to loop, stays, rebuilt
 * from its loop count alone. Anything after the trailer goes, and so does anything this can't read,
 * where a decoder would stop too.
 */
function stripGIF(bytes: Uint8Array) {
  const parts: Uint8Array[] = [bytes.subarray(0, gifHeaderEnd(bytes))];
  for (const block of gifBlocks(bytes)) {
    if (block.label === APPLICATION) {
      const loop = loopBlock(bytes.subarray(block.start + 2, block.end));
      if (loop) parts.push(loop);
    } else if (block.label !== COMMENT) {
      // Images, graphic control, which times each frame, and plain text, which draws on the picture.
      parts.push(bytes.subarray(block.start, block.end));
    }
  }
  parts.push(TRAILER);
  return concat(parts);
}

/** Where a GIF's header and logical screen descriptor end, with the global color table when there is one. */
const gifHeaderEnd = (bytes: Uint8Array) => 13 + colorTableSize(bytes[10] ?? 0);

/** An image block's label here, which no extension uses. */
const IMAGE = -1;
const COMMENT = 0xfe;
const APPLICATION = 0xff;

/**
 * A GIF's blocks after its header, each whole: images, labelled IMAGE, and extensions, labelled with
 * their own label. Stops at the trailer, at a block cut off by the end of the file, or at anything
 * that isn't a GIF block, where a decoder would stop too.
 */
function* gifBlocks(bytes: Uint8Array): Generator<{ label: number; start: number; end: number }> {
  let at = gifHeaderEnd(bytes);
  while (at < bytes.length) {
    let block: { label: number; start: number; end: number | null };
    if (bytes[at] === 0x2c && at + 10 <= bytes.length) {
      // An image: its descriptor, a local color table, the LZW code size, then its data.
      block = { label: IMAGE, start: at, end: blocksEnd(bytes, at + 10 + colorTableSize(bytes[at + 9]!) + 1) };
    } else if (bytes[at] === 0x21 && at + 2 <= bytes.length) {
      block = { label: bytes[at + 1]!, start: at, end: blocksEnd(bytes, at + 2) };
    } else {
      return;
    }
    if (block.end === null) return;
    yield { label: block.label, start: block.start, end: block.end };
    at = block.end;
  }
}

/** The bytes a color table takes, from the packed field that says whether there is one and its size. */
function colorTableSize(packed: number) {
  return packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
}

/** Where a run of data sub-blocks ends, just past the empty one that closes it, or null if the file ends first. */
function blocksEnd(bytes: Uint8Array, from: number): number | null {
  let at = from;
  while (at < bytes.length) {
    const size = bytes[at]!;
    at += 1 + size;
    if (size === 0) return at;
  }
  return null;
}

/** The NETSCAPE2.0 block made again from just its loop count, or null for any other application block. */
function loopBlock(blocks: Uint8Array): Uint8Array | null {
  // An 11-byte name, then a 3-byte sub-block: 1, and the count, low byte first.
  if (blocks[0] !== 11 || NETSCAPE.some((byte, index) => blocks[1 + index] !== byte)) return null;
  if (blocks[12] !== 3 || blocks[13] !== 1) return null;
  return Uint8Array.of(0x21, 0xff, 11, ...NETSCAPE, 3, 1, blocks[14]!, blocks[15]!, 0);
}

export function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
