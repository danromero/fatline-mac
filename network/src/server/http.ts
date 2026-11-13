import { byteLength, characterCount, hidesText } from "../protocol/text.ts";

/** Answers and errors, in the shape docs/NETWORK.md gives. */

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export const noContent = () => new Response(null, { status: 204, headers: BASE_HEADERS });

/** The code an error answers with when it has none of its own: the status, in words. */
const STATUS_CODES: Record<number, string> = {
  400: "bad-request", 401: "signed-out", 403: "forbidden", 404: "not-found", 405: "wrong-method", 413: "too-large",
  426: "update-required", 429: "too-many", 502: "upstream", 503: "unavailable",
};

/** Thrown anywhere in a request to answer with `{ message, code }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code ?? STATUS_CODES[status] ?? "error";
    this.extra = extra;
  }
}

/**
 * Errors with a code of their own, which apps and the admin pages act on whatever the words, and the
 * words they're shown with. The admin pages show these by code after a form, so no words come from a link.
 */
const PROBLEMS = {
  refused: [403, "You're not a member of this network."],
  "daily-limit": [429, "That's a lot for one day. Try again tomorrow."],
  "hidden-text": [400, "That has invisible characters, or ones that reverse text."],
  "no-person": [404, "No such person."],
  "no-request": [404, "Nobody with that FID has asked to join."],
  "no-member": [404, "No such member."],
  "not-the-admin": [400, "You can't remove the person who runs this network."],
  "code-exists": [400, "That code already exists."],
  "no-code": [404, "No such invite code."],
  "no-report": [404, "No such report."],
  "no-post": [404, "No such post."],
  "name-too-long": [400, "A name is at most 64 characters."],
  "no-storage": [400, "This network has nowhere to keep pictures."],
  "no-picture": [400, "Choose a picture first."],
  "picture-too-large": [400, "That picture is over 2 MB."],
  "not-an-image": [400, "Use a PNG, JPEG, or GIF."],
  "picture-too-small": [400, "Use a picture at least 32 pixels on each side."],
  "picture-too-wide": [400, "Pictures can be at most 4,096 pixels on a side."],
  "gif-too-wide": [400, "GIFs can be at most 1,280 pixels on a side."],
  "gif-too-long": [400, "That GIF has too many frames for its size."],
  "no-hub": [400, "This network has no Farcaster hub to ask."],
  "hub-failed": [502, "Farcaster didn't answer. Check HUB_URL and HUB_API_KEY, then try again."],
} as const satisfies Record<string, readonly [number, string]>;

export type ProblemCode = keyof typeof PROBLEMS;

/** The error for `code`, in its own words or in `message` when the case needs more. */
export const problem = (code: ProblemCode, message?: string) => new HttpError(PROBLEMS[code][0], message ?? PROBLEMS[code][1], code);

/** A code's words, or undefined for a code that isn't one. */
export const problemMessage = (code: string) => (Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code as ProblemCode][1] : undefined);

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);
/** Apps from before codes read `status`. */
export const refused = (message?: string) => new HttpError(403, message ?? PROBLEMS.refused[1], "refused", { status: "refused" });

export function errorResponse(error: HttpError) {
  return json({ message: error.message, code: error.code, ...error.extra }, error.status);
}

/** A path part with its % escapes undone, or null when one is malformed, such as `%E0%A4`. */
export function decodePart(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError(413, "Too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "Too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export async function readJSON(request: Request, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, limit);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest("Expected JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const now = () => Math.floor(Date.now() / 1000);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The kinds of text people write here, each with its rules: at most `characters` as people count them,
 * `units` UTF-16 units before anything counts (a cheap first cap), `bytes` stored, and whether it may
 * break lines. None may hide or reverse text.
 */
export const TEXT = {
  displayName: { label: "A display name", characters: 32, units: 200, lineBreaks: false },
  bio: { label: "A bio", characters: 160, units: 1000, lineBreaks: true },
  note: { label: "A note", characters: 280, units: 2000, bytes: 1024, lineBreaks: true },
  networkName: { label: "A name", characters: 64, units: 64, lineBreaks: false, tooLong: "name-too-long" },
  previewTitle: { label: "A preview's title", characters: 300, units: 1200, lineBreaks: false },
  previewDescription: { label: "A preview's description", characters: 300, units: 1200, lineBreaks: false },
} as const satisfies Record<string, TextKind>;

interface TextKind {
  label: string;
  characters: number;
  units: number;
  bytes?: number;
  lineBreaks: boolean;
  /** The code a text over its length answers with, for the admin pages. */
  tooLong?: ProblemCode;
}

/** `value` checked as `kind`, or undefined when it's missing. `name` is the field, for errors about its type. */
export function textField(value: unknown, name: string, kind: TextKind): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} should be text.`);
  // JSON can carry half a surrogate pair, which counts as one character here and is stored as three.
  if (LONE_SURROGATE.test(value)) throw badRequest(`${name} isn't valid text.`);
  const over = `${kind.label} is at most ${kind.characters} characters.`;
  if (value.length > kind.units || characterCount(value) > kind.characters || (kind.bytes !== undefined && byteLength(value) > kind.bytes)) {
    throw kind.tooLong ? problem(kind.tooLong, over) : badRequest(over);
  }
  if (hidesText(value, { lineBreaks: kind.lineBreaks })) {
    throw problem("hidden-text", `${kind.label} can't have invisible characters, or ones that reverse text.`);
  }
  return value;
}

/** `value` when it's one of `choices`, or undefined when it's missing. */
export function choiceField<T extends string>(value: unknown, name: string, choices: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (!choices.includes(value as T)) throw badRequest(`${name} should be ${choices.map((choice) => JSON.stringify(choice)).join(" or ")}.`);
  return value as T;
}

/** true or false, or undefined when it's missing. */
export function booleanField(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${name} should be true or false.`);
  return value;
}

/** Field checks for JSON bodies. Each throws a 400 naming the field. */
export const field = {
  /** Text of a kind in TEXT, with all its rules. */
  text(body: Record<string, unknown>, name: string, kind: TextKind): string | undefined {
    return textField(body[name], name, kind);
  },
  integer(body: Record<string, unknown>, name: string): number {
    const value = body[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw badRequest(`${name} should be a whole number.`);
    return value;
  },
  hex(body: Record<string, unknown>, name: string, bytes: number): string {
    const value = body[name];
    if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw badRequest(`${name} should be ${bytes} bytes of hex.`);
    return value.toLowerCase();
  },
  object(body: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = body[name];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest(`${name} should be an object.`);
    return value as Record<string, unknown>;
  },
  optionalString(body: Record<string, unknown>, name: string, maxLength: number): string | undefined {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > maxLength) throw badRequest(`${name} should be text of at most ${maxLength} characters.`);
    // JSON can carry half a surrogate pair, which counts as one character here and is stored as three.
    if (LONE_SURROGATE.test(value)) throw badRequest(`${name} isn't valid text.`);
    return value;
  },
};
