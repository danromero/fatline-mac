import type { Context } from "./env.ts";

/** Whether a request comes from a Mac build older than MINIMUM_MAC_VERSION. Reads nothing. */
import { HttpError } from "./http.ts";
import { settings } from "./store.ts";

/**
 * The apps name their build in a `Fatline-App` header, such as `mac/0.3.91`. With MINIMUM_MAC_VERSION
 * set, older Mac builds get a request to update instead of an answer, and the app shows its text.
 * Mac builds from before the header, like the 0.3.90 pilot, only say `Fatline/<build>` in their user
 * agent, so they count as older than any minimum. Clients that send neither are never turned away.
 */
export function tooOld(context: Context, request: Request): boolean {
  const minimum = context.env.MINIMUM_MAC_VERSION?.trim();
  if (!minimum) return false;
  const version = macVersion(request);
  return version !== null && olderThan(version, minimum);
}

/** The 426 an old build gets, naming the network, which takes a read. */
export async function updateRequired(context: Context): Promise<HttpError> {
  const { name } = await settings(context);
  return new HttpError(426, `Update Fatline to keep using ${name}. Get it at fatline.tech.`);
}

/** The Mac app's version from its request, "0" for a Mac build too old to say, or null for anything else. */
export function macVersion(request: Request): string | null {
  const header = request.headers.get("fatline-app");
  if (header !== null) return /^mac\/(\d+(?:\.\d+){0,3})$/i.exec(header.trim())?.[1] ?? null;
  return /^Fatline\/\d/.test(request.headers.get("user-agent") ?? "") ? "0" : null;
}

/** Compares dotted versions number by number, so 0.3.10 is newer than 0.3.9. */
export function olderThan(version: string, minimum: string): boolean {
  const a = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference < 0;
  }
  return false;
}
