import interRegular from "./fonts/Inter-Regular.woff2";
import interSemiBold from "./fonts/Inter-SemiBold.woff2";
import type { Context } from "./env.ts";
import { notFound } from "./http.ts";
import { iconPath } from "./icon.ts";
import { timingSafeEqual } from "./media.ts";
import { settings } from "./store.ts";

/**
 * An invite page at `/<INVITE_PATH>/invite`, for people the admin sends the link to: download the Mac
 * app, copy this network's address, and wait to be let in. The long path keeps it from being found.
 * The download is `downloads/Fatline.dmg` in the media bucket, which only the admin puts there, for a
 * build that isn't public yet. Without one it's the latest public release, the same file the app's
 * updater installs, so deleting the admin's copy is all it takes to move the page onto public builds.
 */

const DOWNLOAD_KEY = "downloads/Fatline.dmg";
/** `{ "tag_name": "v0.3.91" }`, the version of that build, which pilot builds of the app check for updates. */
const FEED_KEY = "downloads/latest.json";
export const PUBLIC_DOWNLOAD = "https://github.com/danromero/fatline-monorepo/releases/latest/download/Fatline.dmg";
const FONTS: Record<string, ArrayBuffer> = { "Inter-Regular.woff2": interRegular, "Inter-SemiBold.woff2": interSemiBold };

/** The secret path segment, or null when there's none or it's too short to stay unguessed. */
export function invitePath(value: string | undefined): string | null {
  const path = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(path) ? path : null;
}

/** Answers `/<segment>/<file>` when the segment is the invite path, or returns null so other routes run. */
export async function invite(context: Context, request: Request, pathname: string): Promise<Response | null> {
  const secret = invitePath(context.env.INVITE_PATH);
  const parts = /^\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!secret || !parts || !timingSafeEqual(parts[1]!, secret)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") throw notFound();
  const file = parts[2]!;
  if (file === "invite") return page(context, secret);
  if (file === "Fatline.dmg") return download(context);
  if (file === "latest.json") return feed(context);
  const font = FONTS[file];
  if (font) {
    return new Response(font, {
      headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  }
  throw notFound();
}

/** The uploaded pilot's version, from the pilot feed, or null when there's none and Download serves the public release. */
async function pilotVersion(context: Context): Promise<string | null> {
  const object = await context.env.MEDIA?.get(FEED_KEY);
  if (!object) return null;
  try {
    const tag = ((await object.json()) as { tag_name?: unknown }).tag_name;
    return typeof tag === "string" && /^v?\d+(\.\d+){0,3}$/.test(tag) ? tag.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

async function feed(context: Context) {
  const object = await context.env.MEDIA?.get(FEED_KEY);
  if (!object) throw notFound();
  return new Response(object.body, {
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function download(context: Context) {
  const object = await context.env.MEDIA?.get(DOWNLOAD_KEY);
  if (!object) {
    return new Response(null, { status: 302, headers: { location: PUBLIC_DOWNLOAD, "cache-control": "no-store" } });
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/x-apple-diskimage",
      "content-disposition": 'attachment; filename="Fatline.dmg"',
      "content-length": String(object.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

// Swaps the copy button to "Copied" for two seconds. Its hash goes in the page's CSP.
const SCRIPT = `const button = document.querySelector(".copy");
let timer;
button.addEventListener("click", async () => {
  const value = button.dataset.copy;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  button.classList.add("copied");
  button.querySelector(".label").textContent = "Copied";
  clearTimeout(timer);
  timer = setTimeout(() => {
    button.classList.remove("copied");
    button.querySelector(".label").textContent = "Copy";
  }, 2000);
});`;

let scriptHash: Promise<string> | undefined;
function hashOfScript() {
  scriptHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(SCRIPT)).then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
  return scriptHash;
}

async function page(context: Context, secret: string) {
  const { name } = await settings(context);
  const host = context.host;
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "";
  const icon = await iconPath(context);
  const version = await pilotVersion(context);
  const base = `/${secret}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(name)}</title>
<style>
@font-face { font-family: Inter; src: url("${base}/Inter-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: Inter; src: url("${base}/Inter-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: swap; }
/* The app's colors, as on fatline.tech. */
:root { color-scheme: light dark; --paper: #FDFBF7; --ink: #0A2F1D; --secondary: #54635A; --action: #0A2F1D; --action-ink: #FDFBF7; --quiet: #ECEFE8; }
@media (prefers-color-scheme: dark) {
  :root { --paper: #121B16; --ink: #F0F1E9; --secondary: #AAB8AF; --action: #C0D8C7; --action-ink: #0A2F1D; --quiet: #25342B; }
}
* { box-sizing: border-box; margin: 0; }
body { min-height: 100vh; min-height: 100svh; display: flex; align-items: center; justify-content: center; padding: 48px 16px;
  background: var(--paper); color: var(--ink); font: 400 16px/1.4 Inter, -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 432px; display: flex; flex-direction: column; align-items: center; }
.mark { width: 128px; height: 128px; border-radius: 32px; background: var(--action); color: var(--action-ink);
  display: flex; align-items: center; justify-content: center; font-size: 64px; font-weight: 600; line-height: 1; }
img.mark { display: block; object-fit: cover; background: none; }
h1 { margin-top: 16px; font-size: 34px; font-weight: 600; line-height: 1.2; letter-spacing: -0.8px; text-align: center; }
ol { list-style: none; margin-top: 32px; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 16px; }
/* Each step is a quiet card. Its corners are no rounder than its padding, so the capsules inside sit right. */
li { display: flex; gap: 16px; padding: 16px; border: 1px solid var(--quiet); border-radius: 16px; }
.number { flex: none; width: 24px; height: 24px; border-radius: 12px; background: var(--quiet);
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; }
.step { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.step > p:first-child { line-height: 24px; }
.note { font-size: 13px; color: var(--secondary); }
.download + .note { text-align: center; }
.download { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; border-radius: 22px;
  background: var(--action); color: var(--action-ink); font-weight: 600; text-decoration: none; }
/* The version, as on fatline.tech. */
.download span { font-weight: 400; opacity: 0.72; }
.address { display: flex; align-items: center; min-height: 44px; border-radius: 22px; background: var(--quiet); padding-left: 16px; }
.address code { flex: 1; min-width: 0; font: inherit; font-weight: 600; overflow-wrap: anywhere; }
.copy { flex: none; height: 44px; min-width: 44px; padding: 0 16px; border: 0; border-radius: 22px; background: transparent;
  color: var(--ink); font: inherit; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; cursor: pointer; }
.copy svg { width: 16px; height: 16px; }
.copy .check, .copy.copied .squares { display: none; }
.copy.copied .check { display: block; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style></head>
<body><main>
${icon ? `<img class="mark" src="${escape(icon)}" width="128" height="128" alt="">` : `<div class="mark" aria-hidden="true">${escape(letter)}</div>`}
<h1>${escape(name)}</h1>
<ol>
<li><span class="number" aria-hidden="true">1</span><div class="step">
<p>Download Fatline.</p>
<a class="download" href="${base}/Fatline.dmg">Download for macOS${version ? ` <span>${escape(version)}</span>` : ""}</a>
<p class="note">macOS 27 or later</p>
</div></li>
<li><span class="number" aria-hidden="true">2</span><div class="step">
<p>Open it, choose Private network, and paste:</p>
<div class="address"><code>${escape(host)}</code><button class="copy" type="button" data-copy="${escape(host)}" aria-label="Copy ${escape(host)}">
<svg class="squares" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.25" y="5.25" width="9" height="9" rx="2"/><path d="M10.75 5.25V3.75a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1.5"/></svg>
<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>
<span class="label">Copy</span></button></div>
</div></li>
<li><span class="number" aria-hidden="true">3</span><div class="step">
<p>Wait until you’re approved.</p>
</div></li>
</ol>
</main>
<script>${SCRIPT}</script>
</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'sha256-${await hashOfScript()}'`,
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
