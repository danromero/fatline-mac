import { withoutHidden } from "../protocol/text.ts";

/**
 * Reading a page for its link preview: its Open Graph title, description, and image, or its title
 * tag. The page is anyone's, so this finds tags by scanning forward once, never with a pattern that
 * can backtrack, and keeps nothing that would hide or reverse text.
 */

/** How much of a page is read, and how long a tag can be before it's skipped. */
const HEAD_BYTES = 256 * 1024;
const MAX_TAG = 4096;
const MAX_TEXT = 300;

export interface Preview {
  title?: string;
  description?: string;
  image?: string;
}

export function parsePreview(html: string, base: URL): Preview {
  const head = html.slice(0, HEAD_BYTES);
  // Every position in `lower` must be the same in `head`. Lowercasing keeps lengths except for U+0130
  // (İ), which becomes two characters, so it goes first. A letter-by-letter pass is the fallback.
  let lower = head.replaceAll("\u0130", "I").toLowerCase();
  if (lower.length !== head.length) lower = head.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const metas = new Map<string, string>();
  for (const { start, end } of tags(lower, "<meta")) {
    const [tag, lowerTag] = [head.slice(start, end), lower.slice(start, end)];
    const key = (attribute(tag, lowerTag, "property") ?? attribute(tag, lowerTag, "name"))?.toLowerCase();
    const content = attribute(tag, lowerTag, "content");
    if (key && content !== undefined && !metas.has(key)) metas.set(key, content);
  }
  const first = (names: string[]) => {
    for (const name of names) {
      const value = metas.has(name) ? clean(metas.get(name)!) : "";
      if (value) return value;
    }
    return undefined;
  };
  const imageLink = first(["og:image", "og:image:url", "twitter:image"]);
  let image: string | undefined;
  try {
    image = imageLink ? new URL(imageLink, base).toString() : undefined;
  } catch {
    image = undefined;
  }
  return {
    title: first(["og:title", "twitter:title"]) ?? (titleTag(head, lower) || undefined),
    description: first(["og:description", "twitter:description", "description"]),
    image,
  };
}

/**
 * Where each `<name …>` tag is, in order, up to just past its `>`. Found with plain searches, so a
 * page full of unclosed tags costs one pass. Tags longer than MAX_TAG are skipped.
 */
function* tags(lower: string, name: string): Generator<{ start: number; end: number }> {
  let at = 0;
  for (;;) {
    const start = lower.indexOf(name, at);
    if (start < 0) return;
    const close = lower.indexOf(">", start);
    if (close < 0) return;
    if (close - start <= MAX_TAG) yield { start, end: close + 1 };
    at = close + 1;
  }
}

const space = (character: string | undefined) => character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";

/**
 * A quoted attribute's value in a tag, found with plain searches: the name after a space, a quote,
 * or a slash, then `=` and a quoted value. Unquoted values aren't read.
 */
function attribute(tag: string, lowerTag: string, name: string): string | undefined {
  for (let found = lowerTag.indexOf(name); found >= 0; found = lowerTag.indexOf(name, found + name.length)) {
    const before = tag[found - 1];
    if (!space(before) && before !== '"' && before !== "'" && before !== "/") continue;
    let at = found + name.length;
    while (space(tag[at])) at++;
    if (tag[at] !== "=") continue;
    at++;
    while (space(tag[at])) at++;
    const quote = tag[at];
    if (quote !== '"' && quote !== "'") continue;
    const close = tag.indexOf(quote, at + 1);
    return close < 0 ? undefined : tag.slice(at + 1, close);
  }
  return undefined;
}

/** The text of the first `<title>`, if it closes. */
function titleTag(head: string, lower: string): string {
  const open = tags(lower, "<title").next();
  if (open.done) return "";
  const close = lower.indexOf("</title", open.value.end);
  return close < 0 ? "" : clean(head.slice(open.value.end, Math.min(close, open.value.end + MAX_TAG)));
}

/** Entities decoded, hidden and reversing characters taken out, spaces collapsed, and cut to length. */
function clean(text: string): string {
  return withoutHidden(decodeEntities(text)).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** A character from a numeric entity, or the replacement character for one that isn't a character. */
function character(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, hex: string) => character(parseInt(hex, 16)))
    .replace(/&#(\d{1,10});/g, (_, decimal: string) => character(Number(decimal)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
