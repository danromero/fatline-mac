/** Limits from docs/NETWORK.md. */
export const MAX_CHARACTERS = 280;
export const MAX_TEXT_BYTES = 1024;
export const MAX_MENTIONS = 10;
export const MAX_EMBEDS = 2;
export const MAX_URL_BYTES = 256;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Characters as a person sees them. "👍🏽" and "é" are one each. */
export function characterCount(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * Characters that reorder the text around them: bidi embeddings, overrides, and isolates. In a post
 * they make a link or a name read backward. The marks right-to-left writing uses, like U+200F, aren't
 * among them.
 */
const REORDERING = /[\u202A-\u202E\u2066-\u2069]/u;

/**
 * Characters a name has no use for, which hide it or change how it reads: control characters, every
 * bidi control, and characters that show as nothing. The zero-width joiner and non-joiner stay,
 * since emoji and Persian need them.
 */
const HIDING = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0]/u;

/** Tags spell a region's flag after 🏴, as in 🏴󠁧󠁢󠁳󠁣󠁴󠁿: a country and a subdivision, 3 to 6 letters and digits, then the end tag. */
const FLAG_TAGS = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{3,6}\u{E007F}/gu;
const TAG = /[\u{E0000}-\u{E007F}]/u;
/** A variation selector picks how the character before it looks. One with no character of its own before it is just hidden. */
const STRAY_SELECTOR = /(?:^|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u200C\u200D])[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/** Joiners join two characters; two in a row join nothing. */
const JOINER_RUN = /[\u200C\u200D]{2,}/u;

/** Whether text has characters that reverse what's around them. Posts can't. */
export const reversesText = (text: string) => REORDERING.test(text);

/**
 * Whether text has marks that show as nothing and count as no characters: tags outside a flag, and
 * variation selectors with nothing before them to vary. Nothing can have them.
 */
export function hasStrayMarks(text: string): boolean {
  return TAG.test(text.replace(FLAG_TAGS, "")) || STRAY_SELECTOR.test(text) || JOINER_RUN.test(text);
}

const HIDING_ALL = new RegExp(HIDING.source, "gu");
const SELECTORS = "\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}";

/**
 * Text with what hides or reverses it taken out, for text from elsewhere, like a linked page's title:
 * line breaks and tabs become spaces, and hiding characters, tags outside a flag, and selectors with
 * nothing to vary go.
 */
export function withoutHidden(text: string): string {
  const flags = text.match(FLAG_TAGS) ?? [];
  return text
    .split(FLAG_TAGS)
    .map((part) => part.replace(/[\n\r\t]/g, " ").replace(HIDING_ALL, "").replace(/[\u{E0000}-\u{E007F}]/gu, ""))
    .reduce((joined, part, index) => joined + (index > 0 ? flags[index - 1] : "") + part, "")
    .replace(new RegExp(`(^|[${SELECTORS}\\u200C\\u200D])[${SELECTORS}]+`, "gu"), "$1")
    .replace(/([\u200C\u200D])[\u200C\u200D]+/gu, "$1");
}

/** Whether text has characters that hide or reverse it. Display names can't, and bios can't except for line breaks. */
export function hidesText(text: string, options: { lineBreaks?: boolean } = {}): boolean {
  return HIDING.test(options.lineBreaks ? text.replaceAll("\n", "") : text) || hasStrayMarks(text);
}

/**
 * A draft split the way messages store it: each mention leaves the text, and is kept as an FID with
 * the byte offset where its name goes back in. The same rules as `CastMentions` in
 * apple/Shared/Snapchain.swift.
 */
export interface SplitText {
  text: string;
  fids: number[];
  positions: number[];
}

const nameCharacter = /^[a-z0-9\-_.]$/;
const wordCharacter = /^[\p{L}\p{N}_]/u;

/** `handles` maps a lowercase username to its FID. An @username not found there stays plain text. */
export function splitMentions(draft: string, handles: Map<string, number>): SplitText {
  const characters = Array.from(segmenter.segment(draft), (piece) => piece.segment);
  let text = "";
  const fids: number[] = [];
  const positions: number[] = [];
  let previous: string | undefined;
  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    // An @ in the middle of a word is an email address or the like, not a mention.
    const startsName = character === "@" && !(previous !== undefined && wordCharacter.test(previous));
    if (!startsName || fids.length >= MAX_MENTIONS) {
      text += character;
      previous = character;
      index++;
      continue;
    }
    let end = index + 1;
    while (end < characters.length && nameCharacter.test(characters[end]!.toLowerCase())) end++;
    // "Thanks @dwr." ends with a full stop that isn't part of the name.
    let nameEnd = end;
    let found: number | undefined;
    while (nameEnd > index + 1) {
      found = handles.get(characters.slice(index + 1, nameEnd).join("").toLowerCase());
      if (found !== undefined) break;
      if (!".-_".includes(characters[nameEnd - 1]!)) break;
      nameEnd--;
    }
    if (found !== undefined) {
      fids.push(found);
      positions.push(byteLength(text));
      text += characters.slice(nameEnd, end).join("");
    } else {
      text += characters.slice(index, end).join("");
    }
    previous = characters[end - 1];
    index = end;
  }
  return { text, fids, positions };
}

/** Puts each mention back as @username, the way a person sees the post. */
export function joinMentions(split: SplitText, usernames: Map<number, string>): string {
  const bytes = new TextEncoder().encode(split.text);
  const decoder = new TextDecoder();
  let out = "";
  let at = 0;
  split.positions.forEach((position, index) => {
    out += decoder.decode(bytes.slice(at, position)) + "@" + (usernames.get(split.fids[index]!) ?? `!${split.fids[index]}`);
    at = position;
  });
  return out + decoder.decode(bytes.slice(at));
}
