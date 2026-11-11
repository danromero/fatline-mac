/**
 * Runs beside x.com, so it holds nothing. It finds X's rail on the home feed, puts the extension's frame
 * over it, and hides X's widgets only once that frame has said it loaded. If anything is off, X is untouched.
 */
const FRAME_URL = chrome.runtime.getURL("rail.html");
const FRAME_ORIGIN = new URL(FRAME_URL).origin;
const READY_TIMEOUT_MS = 5000;
const GAP = 12;
const PLUS_SIZE = 48;
const PLUS_INSET = 16;

let host: HTMLDivElement | null = null;
let frame: HTMLIFrameElement | null = null;
let ready = false;
let readyTimer = 0;
let hidden: HTMLElement[] = [];
let lastSent = "";
let syncTimer = 0;

const findRail = () => document.querySelector<HTMLElement>('[data-testid="sidebarColumn"]');
const findSearch = (rail: HTMLElement | null) => rail?.querySelector<HTMLElement>('form[role="search"]') ?? null;
// X's compose window changes the address and leaves the rail in place, so it shouldn't take Fatline away.
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null;

function theme(): "light" | "dark" {
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  return channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114 < 128 ? "dark" : "light";
}

/** The search box's own block, found by walking up until it has siblings to hide. */
function widgets(rail: HTMLElement, search: HTMLElement): HTMLElement[] {
  let node = search;
  while (node.parentElement && node.parentElement !== rail) {
    const parent: HTMLElement = node.parentElement;
    const others = ([...parent.children] as HTMLElement[]).filter((child) => child !== node && child !== host);
    if (others.some((child) => child.getBoundingClientRect().height > 40)) return others;
    node = parent;
  }
  return [];
}

function restoreRail() {
  hidden.forEach((element) => element.style.removeProperty("visibility"));
  hidden = [];
}

const railSize = new ResizeObserver(() => schedule(0));

function unmount() {
  clearTimeout(readyTimer);
  railSize.disconnect();
  restoreRail();
  host?.remove();
  host = frame = null;
  ready = false;
  lastSent = "";
}

function mount(rail: HTMLElement) {
  host = document.createElement("div");
  // Inside the rail so X's own windows and drawers stack above it, as they do over the rail.
  Object.assign(host.style, { position: "fixed", zIndex: "1", borderRadius: "16px", overflow: "hidden", visibility: "hidden" });
  frame = document.createElement("iframe");
  Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block" });
  frame.allow = "clipboard-write";
  frame.src = `${FRAME_URL}?theme=${theme()}`;
  host.append(frame);
  rail.append(host);
  railSize.observe(rail);
  readyTimer = window.setTimeout(unmount, READY_TIMEOUT_MS);
}

/** Moves the plus just clear of X's Chat and Grok buttons when they land on it. */
function plusShift(box: DOMRect): number {
  const right = box.right - PLUS_INSET;
  const left = right - PLUS_SIZE;
  const bottom = box.bottom - PLUS_INSET;
  const top = bottom - PLUS_SIZE;
  let shift = 0;
  for (const id of ["chat-drawer-main", "GrokDrawerHeader"]) {
    const floating = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    if (!floating || floating.width === 0 || floating.width > 100) continue;
    if (floating.left < right && floating.right > left && floating.top < bottom && floating.bottom > top) {
      shift = Math.max(shift, right - floating.left + 8);
    }
  }
  return Math.min(Math.ceil(shift), box.width / 2);
}

function place(rail: HTMLElement, search: HTMLElement) {
  if (!host) return;
  const railBox = rail.getBoundingClientRect();
  const top = Math.round(search.getBoundingClientRect().bottom + GAP);
  Object.assign(host.style, {
    left: `${Math.round(railBox.left)}px`,
    top: `${top}px`,
    width: `${Math.round(railBox.width)}px`,
    height: `${Math.max(0, Math.round(window.innerHeight - top - GAP))}px`,
  });
  if (!ready) return;
  const message = { fatline: "layout", theme: theme(), plusShift: plusShift(host.getBoundingClientRect()) };
  const encoded = JSON.stringify(message);
  if (encoded !== lastSent) {
    lastSent = encoded;
    frame?.contentWindow?.postMessage(message, FRAME_ORIGIN);
  }
}

function hideWidgets(rail: HTMLElement, search: HTMLElement) {
  for (const element of widgets(rail, search)) {
    if (hidden.includes(element)) continue;
    element.style.setProperty("visibility", "hidden");
    hidden.push(element);
  }
}

function sync() {
  syncTimer = 0;
  const rail = findRail();
  const search = findSearch(rail);
  const wanted = rail !== null && search !== null && (location.pathname === "/home" || (host !== null && modalOpen()));
  // X replaces the rail element when it navigates, which takes the frame with it.
  if (host && (!wanted || !host.isConnected || host.parentElement !== rail)) unmount();
  if (!wanted) return;
  if (!host) mount(rail);
  place(rail, search);
  if (ready) hideWidgets(rail, search);
}

function schedule(delay = 80) {
  if (syncTimer) return;
  syncTimer = window.setTimeout(sync, delay);
}

window.addEventListener("message", (event) => {
  if (!frame || event.source !== frame.contentWindow || event.origin !== FRAME_ORIGIN || event.data?.fatline !== "ready") return;
  clearTimeout(readyTimer);
  ready = true;
  if (host) host.style.visibility = "visible";
  schedule(0);
});

new MutationObserver(() => schedule()).observe(document.documentElement, { childList: true, subtree: true });
// X sets its theme as an inline style on the body.
new MutationObserver(() => schedule()).observe(document.body, { attributes: true, attributeFilter: ["style"] });

// X lays itself out again after a resize, so one measurement right away can be out of date.
window.addEventListener("resize", () => {
  for (const delay of [0, 120, 300, 700, 1500]) window.setTimeout(sync, delay);
});
window.addEventListener("scroll", () => schedule(), { passive: true });
schedule(0);
