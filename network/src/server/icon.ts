import { networkOrigin } from "../protocol/approvals.ts";
import type { Context, Env, Viewer } from "./env.ts";
import { notFound, problem } from "./http.ts";
import { sizeProblem, sniff, stripMetadata } from "./imagebytes.ts";
import { logStatement } from "./store.ts";

/**
 * The network's picture, which the apps and the invite page show in place of its first letter. The
 * admin sets it on the Settings page. It lives at `network/icon` in the media bucket, and anyone can
 * load it at `/icon`: it's on the invite page, which people see before they join.
 */

const KEY = "network/icon";
export const MAX_ICON_BYTES = 2_000_000;

/** `/icon?v=…`, where the version changes with the picture, or null when there's none. */
export async function iconPath(context: Context): Promise<string | null> {
  const object = await context.env.MEDIA?.head(KEY);
  if (!object) return null;
  return `/icon?v=${encodeURIComponent(object.httpEtag.replace(/\W/g, "").slice(0, 16))}`;
}

/** The full link answers carry, or null. */
export async function iconLink(context: Context): Promise<string | null> {
  const path = await iconPath(context);
  return path && `${networkOrigin(context.host)}${path}`;
}

/** GET /icon. A versioned link never changes, so it can be kept for a year. */
export async function serveIcon(env: Env, request: Request): Promise<Response> {
  const object = await env.MEDIA?.get(KEY);
  if (!object) throw notFound();
  const versioned = new URL(request.url).searchParams.has("v");
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Sets the picture from an uploaded JPEG, PNG, or GIF, without its metadata. */
export async function saveIcon(context: Context, viewer: Viewer, file: unknown) {
  if (!context.env.MEDIA) throw problem("no-storage");
  if (!(file instanceof File) || file.size === 0) throw problem("no-picture");
  if (file.size > MAX_ICON_BYTES) throw problem("picture-too-large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniff(bytes);
  if (!image) throw problem("not-an-image");
  if (Math.min(image.width, image.height) < 32) throw problem("picture-too-small");
  const tooBig = sizeProblem(bytes, image);
  if (tooBig) throw problem(tooBig);
  await context.env.MEDIA.put(KEY, stripMetadata(bytes, image.type), { httpMetadata: { contentType: image.type } });
  await logStatement(context, viewer.fid, "changed the picture", {}).run();
}

export async function removeIcon(context: Context, viewer: Viewer) {
  await context.env.MEDIA?.delete(KEY);
  await logStatement(context, viewer.fid, "removed the picture", {}).run();
}
