// Runs the built extension in a throwaway headless Chrome, on a local page that sends x.com's real
// Content-Security-Policy, against a mock network that verifies every signature it receives.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHTTP } from "node:http";
import { createServer as createHTTPS } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CSP = readFileSync(join(HERE, "x-csp.txt"), "utf8").trim();
const PAGE_PORT = 8931;
const API_PORT = 8943;
// A well-known public test phrase. It belongs to no real account.
const PHRASE = "test test test test test test test test test test test junk";
const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FID = 4242;
const FOLLOWED = 77;

const temp = mkdtempSync(join(tmpdir(), "fatline-e2e-"));
const results = [];
const check = (name, passed, detail = "") => {
  results.push(passed);
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail && !passed ? ` — ${JSON.stringify(detail)}` : ""}`);
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// The mock network.
const signers = [];
const received = [];
const attempts = [];
let failSubmits = false;
const now = () => new Date().toISOString();
const remote = (hash, fid, username, text, timestamp = now()) => ({ hash, timestamp, text, author: { fid, username, pfp_url: "https://fatline.tech/og.png" }, embeds: [] });
const network = [remote("a".repeat(40), FOLLOWED, "mika", "See example.com/page for the plan.")];

function fields(data) {
  const found = new Map();
  let index = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = data[index++];
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
  };
  while (index < data.length) {
    const tag = varint();
    if ((tag & 7) === 0) found.set(tag >> 3, varint());
    else {
      const length = varint();
      found.set(tag >> 3, data.subarray(index, index + length));
      index += length;
    }
  }
  return found;
}

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

async function accept(body) {
  const message = fields(body);
  const dataBytes = message.get(1);
  const data = fields(dataBytes);
  const hash = message.get(2);
  const hashOk = hex(blake3(dataBytes, { dkLen: 20 })) === hex(hash);
  const key = await crypto.subtle.importKey("raw", message.get(6), "Ed25519", false, ["verify"]);
  const signatureOk = await crypto.subtle.verify("Ed25519", key, message.get(4), hash);
  const type = data.get(1);
  const entry = { type, fid: data.get(2), hash: hex(hash), hashOk, signatureOk, key: hex(message.get(6)) };
  if (type === 16) {
    const add = fields(data.get(19));
    entry.scopes = [...add.get(9)];
    entry.ttl = add.get(10);
    entry.custodySignatureBytes = add.get(3).length;
    signers.push({ fid: entry.fid, key: hex(add.get(1)), expiresAt: Math.floor(Date.now() / 1000) + entry.ttl, scopes: ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE"] });
  }
  if (type === 1) {
    entry.text = Buffer.from(fields(data.get(5)).get(4)).toString();
    network.unshift(remote(entry.hash.slice(2), entry.fid, "tester", entry.text));
  }
  if (type === 2) {
    entry.target = hex(fields(data.get(6)).get(1));
    const index = network.findIndex((cast) => `0x${cast.hash}` === entry.target);
    if (index >= 0) network.splice(index, 1);
  }
  received.push(entry);
  return { hash: entry.hash, data: { fid: entry.fid } };
}

function route(url) {
  const query = url.searchParams;
  switch (url.pathname) {
    case "/v2/farcaster/feed/following/": return { casts: network.slice(0, Number(query.get("limit"))), next: {} };
    case "/v2/farcaster/user/bulk/": return { users: query.get("fids").split(",").map((fid) => ({ fid: Number(fid), username: Number(fid) === FOLLOWED ? "mika" : "tester", pfp_url: "https://fatline.tech/og.png" })) };
    case "/v1/userDataByFid": return { messages: [{ data: { userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: "tester" } } }] };
    case "/v1/signersByFid": return { signers: signers.filter((signer) => signer.fid === Number(query.get("fid"))), currentUserNonce: 0 };
    case "/v1/onChainIdRegistryEventByAddress": return query.get("address") === ADDRESS ? { fid: FID, idRegisterEventBody: { to: ADDRESS } } : null;
    case "/v1/linksByFid": return { messages: [FOLLOWED, FID].map((targetFid) => ({ data: { type: "MESSAGE_TYPE_LINK_ADD", linkBody: { type: "follow", targetFid } } })) };
    case "/v1/castById": return network.some((cast) => `0x${cast.hash}` === query.get("hash")) ? { hash: query.get("hash"), data: { fid: FID } } : null;
    default: return null;
  }
}

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(temp, "key.pem"), "-out", join(temp, "cert.pem")], { stdio: "ignore" });

const api = createHTTPS({ key: readFileSync(join(temp, "key.pem")), cert: readFileSync(join(temp, "cert.pem")) }, async (request, response) => {
  const url = new URL(request.url, "https://localhost");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (url.pathname === "/v1/submitMessage" && failSubmits) {
    attempts.push(hex(fields(Buffer.concat(chunks)).get(2)));
    response.writeHead(500, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  const answer = url.pathname === "/v1/submitMessage" ? await accept(Buffer.concat(chunks)) : route(url);
  response.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(answer ?? { message: "not found" }));
}).listen(API_PORT, "127.0.0.1");

const PAGE = `<!doctype html><title>replica</title>
<body style="margin:0;background-color:rgb(255,255,255)"><div id="root" style="display:flex;justify-content:center;gap:30px">
<main style="width:600px;height:3000px"></main>
<div id="railSlot" style="width:350px"><div data-testid="sidebarColumn" style="width:350px;position:relative;z-index:0">
  <div id="stack">
    <div style="height:53px;position:fixed;width:350px;top:0"><form role="search" style="height:44px;margin-top:7px;background:#eee"></form></div>
    <section id="first" style="height:200px;margin-top:65px;background:#ddd"></section>
    <section id="second" style="height:300px;background:#ccc"></section>
  </div>
</div></div></div></body>`;

const page = createHTTP((request, response) => {
  response.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP });
  response.end(PAGE);
}).listen(PAGE_PORT, "127.0.0.1");

const chrome = spawn(CHROME, [
  `--user-data-dir=${join(temp, "profile")}`, "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-size=1440,900", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let nextId = 1;
let buffer = "";
const pending = new Map();
const frames = new Map();
const contexts = new Map();
const closedTargets = new Set();

fromChrome.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result);
    } else if (message.method === "Target.attachedToTarget" && message.params.targetInfo.type === "iframe") {
      frames.set(message.params.sessionId, message.params.targetInfo.url);
      send("Runtime.enable", {}, message.params.sessionId).catch(() => {});
    } else if (message.method === "Target.detachedFromTarget") {
      frames.delete(message.params.sessionId);
    } else if (message.method === "Target.targetDestroyed") {
      closedTargets.add(message.params.targetId);
    } else if (message.method === "Runtime.executionContextCreated") {
      const { auxData, origin, id } = message.params.context;
      if (auxData?.type === "isolated" && origin?.startsWith("chrome-extension://")) contexts.set(message.sessionId, id);
    }
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((done, fail) => pending.set(id, { done, fail }));
}

async function evaluate(sessionId, expression, extra = {}) {
  const answer = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...extra }, sessionId);
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
  return answer.result.value;
}

async function until(read, label, timeout = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await pause(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

// The page has one frame, and a new one replaces it when the rail is rebuilt.
const railSession = () => [...frames.keys()].at(-1);
const inRail = (expression) => evaluate(railSession(), expression);
const text = "document.body.innerText";
const click = (label) => `(() => { const b = [...document.querySelectorAll('button,a')].find((e) => e.innerText.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) throw new Error('no button ${label}'); b.click(); return true; })()`;
const fill = (selector, value) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

// Set FATLINE_SHOTS to a folder to save pictures of each screen.
async function shot(name, session) {
  if (!process.env.FATLINE_SHOTS) return;
  await pause(300);
  const { data } = await send("Page.captureScreenshot", { format: "png" }, session);
  writeFileSync(join(process.env.FATLINE_SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

let exit = 1;
try {
  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: join(ROOT, "dist-test") });
  await send("Target.setDiscoverTargets", { discover: true });

  // Before setup.
  const { targetId: pageTarget } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: pageSession } = await send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await send("Runtime.enable", {}, pageSession);
  await send("Page.enable", {}, pageSession);
  await send("Page.navigate", { url: `http://localhost:${PAGE_PORT}/home` }, pageSession);
  await until(railSession, "the rail frame");
  await until(async () => (await inRail(text)).includes("Continue"), "the splash");
  check("first run shows only Fatline and Continue", (await inRail(text)).replace(/\s+/g, " ").trim() === "Fatline Continue", await inRail(text));
  const hiddenState = `[...document.querySelectorAll('[data-testid=sidebarColumn] section')].map((s) => getComputedStyle(s).visibility).join()`;
  check("X's widgets are hidden and search stays", (await until(async () => (await evaluate(pageSession, hiddenState)) === "hidden,hidden", "hidden widgets")) && (await evaluate(pageSession, "getComputedStyle(document.querySelector('form[role=search]')).visibility")) === "visible");
  const frameSource = await evaluate(pageSession, `document.querySelector('[data-testid=sidebarColumn] iframe').src`);
  check("the page sees a per-session address, not the extension's ID", frameSource.startsWith("chrome-extension://") && !frameSource.includes(extensionId), frameSource);

  await shot("1-first-run", pageSession);

  // The content script gets nothing from the service worker.
  const isolated = await until(() => contexts.get(pageSession), "the content script context");
  const refused = await evaluate(pageSession, `chrome.runtime.sendMessage({ rpc: 'view', args: [] })`, { contextId: isolated, userGesture: false });
  check("a content script is refused", refused?.ok === false && refused.error.kind === "refused", refused);
  const reach = await evaluate(pageSession, `(async () => { const f = document.querySelector('[data-testid=sidebarColumn] iframe'); let w = 'blocked'; try { void f.contentWindow.document; w = 'READABLE'; } catch {} return { doc: f.contentDocument === null, w, db: (await indexedDB.databases()).some((d) => d.name === 'fatline') }; })()`);
  check("page scripts can't read the frame or its database", reach.doc && reach.w === "blocked" && !reach.db, reach);

  // Setup, in its own tab.
  const { targetId: setupTarget } = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/setup.html` });
  const { sessionId: setup } = await send("Target.attachToTarget", { targetId: setupTarget, flatten: true });
  await send("Runtime.enable", {}, setup);
  await until(async () => (await evaluate(setup, text)).includes("Connect to Farcaster"), "the connection step");
  check("connection step matches the Mac", ["Paste your Neynar API key.", "Get a key", "Use code", "Advanced", "Continue"].every(((body) => (needle) => body.includes(needle))(await evaluate(setup, text))));
  await send("Page.enable", {}, setup);
  await send("Page.bringToFront", {}, setup);
  await shot("2-connection", setup);
  await evaluate(setup, click("Advanced"));
  await until(async () => (await evaluate(setup, text)).includes("Connect your server"), "the server step");
  await evaluate(setup, fill("input", `https://localhost:${API_PORT}`));
  await pause(50);
  await evaluate(setup, click("Continue"));
  await until(async () => (await evaluate(setup, text)).includes("Import your account"), "the import step");
  check("import step matches the Mac", (await evaluate(setup, text)).includes("Enter your Farcaster recovery phrase, not another wallet’s."));
  await shot("3-import", setup);
  await evaluate(setup, `window.__clipboard = []; navigator.clipboard.writeText = async (value) => { window.__clipboard.push(value); }; document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true }));`);
  await evaluate(setup, fill("textarea", Array(12).fill("zebra").join(" ")));
  await pause(50);
  await evaluate(setup, click("Import"));
  await until(async () => (await evaluate(setup, text)).includes("Check the spelling"), "the invalid phrase message");
  check("a pasted phrase is cleared from the clipboard", (await evaluate(setup, `window.__clipboard.join('|') === '' && window.__clipboard.length === 1 && document.querySelector('textarea').value === ''`)));
  await evaluate(setup, fill("textarea", PHRASE));
  await pause(50);
  await evaluate(setup, click("Import"));
  await until(() => closedTargets.has(setupTarget), "the setup tab to close", 30_000);
  check("setup tab closes after import", true);
  const added = received.find((entry) => entry.type === 16);
  check("key authorization is valid", added?.hashOk && added.signatureOk && added.fid === FID, added);
  check("key can post and delete, for 30 days", added?.scopes.join() === "1,2" && added.ttl === 2592000 && added.custodySignatureBytes === 65, added);

  // The feed appears on its own.
  await until(async () => (await inRail(text)).includes("mika"), "the feed");
  const row = await inRail(text);
  check("the feed shows casts", row.includes("See example.com/page for the plan."), row);
  check("links in text are links", await inRail(`document.querySelector('.text a').href === 'https://example.com/page'`));

  await send("Page.bringToFront", {}, pageSession);
  await shot("4-feed", pageSession);

  // Drafts survive closing and reopening the composer.
  const composerOpen = () => until(() => inRail(`!!document.querySelector('textarea')`), "the composer");
  const composerClosed = () => until(() => inRail(`!document.querySelector('textarea')`), "the composer to close");
  await inRail(click("Compose"));
  await composerOpen();
  await inRail(fill("textarea", "keep this"));
  await pause(50);
  await inRail(click("Cancel"));
  await composerClosed();
  await pause(300);
  for (let round = 0; round < 2; round++) {
    await inRail(click("Compose"));
    await composerOpen();
    await until(() => inRail(`document.querySelector('textarea').value === 'keep this'`), "the saved draft");
    await inRail(click("Cancel"));
    await composerClosed();
    await pause(300);
  }
  check("reopening the composer keeps the draft", true);

  // Posting.
  await inRail(click("Compose"));
  await until(() => inRail(`!!document.querySelector('textarea')`), "the composer");
  await inRail(fill("textarea", "Hello from Chrome café"));
  await pause(50);
  await shot("5-composer", pageSession);
  await inRail(click("Post"));
  await until(async () => (await inRail(text)).includes("Sent"), "the Sent pill");
  const cast = received.find((entry) => entry.type === 1);
  check("a post is signed correctly", cast?.hashOk && cast.signatureOk && cast.text === "Hello from Chrome café", cast);
  check("the post leads the feed", await until(() => inRail(`document.querySelector('.row .handle').innerText === 'tester' && document.querySelector('.row .time').innerText === 'Now'`), "own post first"));
  check("the post used the registered key", cast?.key === added?.key);
  check("your own post shows your picture", await inRail(`document.querySelector('.row .avatar img')?.src === 'https://fatline.tech/og.png'`));

  // Deleting.
  await inRail(`document.querySelector('.row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }))`);
  await until(() => inRail(`!!document.querySelector('[role=menu]')`), "the menu");
  const items = await inRail(`[...document.querySelectorAll('[role=menuitem]')].map((e) => e.innerText).join()`);
  check("the menu matches the Mac", items === "Copy Text,Copy Link,Open in Farcaster,Delete…", items);
  await shot("6-menu", pageSession);
  await inRail(click("Delete…"));
  await until(async () => (await inRail(text)).includes("This can’t be undone."), "the delete alert");
  await shot("7-delete", pageSession);
  await inRail(click("Delete"));
  await until(async () => (await inRail(text)).includes("Deleted"), "the Deleted pill");
  const removal = received.find((entry) => entry.type === 2);
  check("a deletion is signed correctly", removal?.hashOk && removal.signatureOk && removal.target === cast.hash, removal);
  check("the deleted cast leaves the feed", !(await inRail(text)).includes("Hello from Chrome café"));

  // A failed post can be abandoned, or retried with the same signed bytes.
  const stopWorker = async () => {
    const { targetInfos } = await send("Target.getTargets");
    const worker = targetInfos.find((target) => target.type === "service_worker" && target.url.includes(extensionId));
    if (worker) await send("Target.closeTarget", { targetId: worker.targetId });
    return worker !== undefined;
  };
  const postText = async (value) => {
    await inRail(click("Compose"));
    await composerOpen();
    await inRail(fill("textarea", value));
    await pause(50);
    await inRail(click("Post"));
  };
  failSubmits = true;
  await postText("Stop this one");
  await until(async () => (await inRail(text)).includes("Post not confirmed"), "the failure", 20_000);
  check("a failed post offers Retry and Stop Retrying", ["Retry", "Stop Retrying…"].every(((body) => (needle) => body.includes(needle))(await inRail(text))));
  await inRail(click("Stop Retrying…"));
  await until(async () => (await inRail(text)).includes("Your draft stays here."), "the stop alert");
  await inRail(`[...document.querySelectorAll('.alert button')].find((b) => b.innerText === 'Stop Retrying').click()`);
  check("Stop Retrying returns to Post", await until(() => inRail(`[...document.querySelectorAll('.sheet button')].some((b) => b.innerText === 'Post')`), "Post"));
  await inRail(click("Cancel"));
  await composerClosed();

  await postText("Retry this one");
  await until(async () => (await inRail(text)).includes("Post not confirmed"), "the second failure", 20_000);
  const tried = attempts.at(-1);
  await inRail(click("Cancel"));
  await composerClosed();
  await inRail(click("Compose"));
  await composerOpen();
  check("a reopened composer still offers Stop Retrying", await until(async () => (await inRail(text)).includes("Stop Retrying…"), "Stop Retrying"));
  failSubmits = false;
  await inRail(click("Retry"));
  await until(async () => (await inRail(text)).includes("Sent"), "the retried post", 20_000);
  const retried = received.filter((entry) => entry.type === 1 && entry.text === "Retry this one");
  check("a retry sends the same signed bytes, once", retried.length === 1 && retried[0].hash === tried, { retried, tried });

  // The worker can stop at any time, and deleting has to work when it wakes back up.
  await until(() => inRail(`document.querySelector('.row .handle').innerText === 'tester'`), "the retried cast");
  const stopped = await stopWorker();
  check("the service worker was stopped", stopped);
  await pause(500);
  await inRail(`document.querySelector('.row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }))`);
  await until(() => inRail(`!!document.querySelector('[role=menu]')`), "the menu after restart");
  await inRail(click("Delete…"));
  await until(async () => (await inRail(text)).includes("This can’t be undone."), "the delete alert after restart");
  await inRail(click("Delete"));
  await until(async () => (await inRail(text)).includes("Deleted"), "the deletion after restart");
  const secondRemoval = received.filter((entry) => entry.type === 2).at(-1);
  check("deleting works right after the worker restarts", secondRemoval?.target === retried[0].hash && secondRemoval.signatureOk, secondRemoval);

  // How it sits on the page.
  const hostBox = `(() => { const h = document.querySelector('[data-testid=sidebarColumn] iframe').parentElement.getBoundingClientRect(); return [h.left, h.top, h.width].map(Math.round).join(); })()`;
  const railLeft = await evaluate(pageSession, `Math.round(document.querySelector('[data-testid=sidebarColumn]').getBoundingClientRect().left)`);
  check("the frame lines up under search", (await evaluate(pageSession, hostBox)) === `${railLeft},63,350`, await evaluate(pageSession, hostBox));
  await evaluate(pageSession, `document.querySelector('[data-testid=sidebarColumn]').style.width = '290px'`);
  check("the frame follows a 290 wide rail", await until(async () => (await evaluate(pageSession, hostBox)).endsWith(",63,290"), "290 wide"));
  await until(() => inRail(`innerWidth === 290`), "the frame at 290");
  check("nothing overflows at 290", await inRail(`document.querySelector('.feed').scrollWidth <= document.querySelector('.feed').clientWidth`));
  await evaluate(pageSession, `document.querySelector('[data-testid=sidebarColumn]').style.width = '350px'`);
  await until(async () => (await evaluate(pageSession, hostBox)).endsWith(",63,350"), "350 wide");

  await evaluate(pageSession, `(() => { const r = document.querySelector('[data-testid=sidebarColumn] iframe').parentElement.getBoundingClientRect(); const c = document.createElement('div'); c.dataset.testid = 'chat-drawer-main'; c.style.cssText = 'position:fixed;width:55px;height:55px;left:' + (r.right - 40) + 'px;top:' + (r.bottom - 60) + 'px'; document.body.append(c); })()`);
  check("the plus moves clear of X's Chat button", await until(() => inRail(`parseInt(document.querySelector('.plus').style.right) > 16`), "the plus to move"));
  await evaluate(pageSession, `document.querySelector('[data-testid=chat-drawer-main]').remove()`);
  await until(() => inRail(`parseInt(document.querySelector('.plus').style.right) === 16`), "the plus to return");

  await evaluate(pageSession, `document.body.style.backgroundColor = 'rgb(0, 0, 0)'`);
  check("a dark X makes a dark rail", await until(() => inRail(`document.documentElement.dataset.theme === 'dark'`), "dark theme"));
  await shot("10-dark", pageSession);
  await evaluate(pageSession, `document.body.style.backgroundColor = 'rgb(255, 255, 255)'`);
  await until(() => inRail(`document.documentElement.dataset.theme === 'light'`), "light theme");

  await evaluate(pageSession, `history.pushState({}, '', '/compose/post'); document.body.append(Object.assign(document.createElement('div'), { id: 'modal', ariaModal: 'true' })); document.getElementById('modal').setAttribute('aria-modal', 'true');`);
  await pause(400);
  check("X's compose window leaves Fatline alone", await evaluate(pageSession, `!!document.querySelector('[data-testid=sidebarColumn] iframe')`));
  await evaluate(pageSession, `document.getElementById('modal').remove(); history.replaceState({}, '', '/home'); document.body.append(document.createElement('i'));`);

  const frameCount = `!!document.querySelector('[data-testid=sidebarColumn] iframe')`;
  await evaluate(pageSession, `history.pushState({}, '', '/explore'); document.body.append(document.createElement('i'));`);
  await until(async () => !(await evaluate(pageSession, frameCount)), "the frame to leave");
  check("leaving home brings X's rail back", (await evaluate(pageSession, hiddenState)) === "visible,visible");
  await evaluate(pageSession, `history.pushState({}, '', '/home'); document.body.append(document.createElement('i'));`);
  await until(() => evaluate(pageSession, frameCount), "the frame to return");
  check("returning home brings Fatline back", await until(async () => (await evaluate(pageSession, hiddenState)) === "hidden,hidden", "hidden again"));

  // X replaces the rail element when it navigates.
  await evaluate(pageSession, `(() => { const old = document.querySelector('[data-testid=sidebarColumn]'); const copy = old.cloneNode(true); copy.querySelector('iframe')?.parentElement.remove(); copy.querySelectorAll('section').forEach((s) => s.style.removeProperty('visibility')); old.replaceWith(copy); })()`);
  check("a replaced rail gets a new frame", await until(() => evaluate(pageSession, frameCount), "a new frame"));
  await until(railSession, "the new rail frame");
  await until(async () => (await inRail(text)).includes("mika"), "the feed after remount");

  // Settings and People.
  await inRail(click("Settings"));
  await until(async () => (await inRail(text)).includes("Signed in"), "Settings");
  await shot("8-settings", pageSession);
  const settings = await inRail(text);
  check("Settings matches the Mac", ["tester", "Signed in", "People", "Connection", "Custom Server", "Copy Diagnostics", "Fatline 0.1.0", "Sign Out"].every((needle) => settings.includes(needle)), settings);
  await inRail(`window.__copied = []; navigator.clipboard.writeText = async (value) => { window.__copied.push(value); }; true`);
  await inRail(click("Copy Diagnostics"));
  await until(async () => (await inRail(text)).includes("Copied"), "Copied");
  const diagnostics = await inRail(`window.__copied.join('|')`);
  const expected = [/^Fatline 0\.1\.0, \S.* \d/, /\nConnection Custom Server\n/, `\nAccount FID ${FID}\n`, "\nRefreshes, newest first:\n", /\n\S+Z sign-in \d+\.\ds /];
  const leaked = ["See example.com/page", "Hello from Chrome", "Retry this one", "keep this"];
  check("Copy Diagnostics copies the report, without cast text", expected.every((needle) => (typeof needle === "string" ? diagnostics.includes(needle) : needle.test(diagnostics))) && !leaked.some((needle) => diagnostics.includes(needle)), diagnostics);
  await until(async () => (await inRail(text)).includes("Copy Diagnostics"), "the label to return", 5000);
  await inRail(click("People"));
  await until(async () => (await inRail(text)).includes("To change who you follow"), "People");
  await shot("9-people", pageSession);
  await inRail(click("Hide mika"));
  await until(() => inRail(`[...document.querySelectorAll('button')].some((b) => b.innerText === 'Unhide')`), "Unhide");
  check("Hide changes to Unhide", true);
  await inRail(click("Back"));
  await until(async () => (await inRail(text)).includes("Signed in"), "back to Settings");
  await inRail(click("Back"));
  await until(() => inRail(`!!document.querySelector('.plus')`), "back to the feed");
  check("hidden people leave the feed", !(await inRail(text)).includes("See example.com/page"));
  await inRail(click("Settings"));
  await until(async () => (await inRail(text)).includes("Signed in"), "Settings again");
  await inRail(click("Sign Out"));
  await until(async () => (await inRail(text)).includes("This removes the posting key from this browser"), "the sign-out alert");
  await inRail(`[...document.querySelectorAll('.alert button')].find((b) => b.innerText === 'Sign Out').click()`);
  await until(async () => (await inRail(text)).includes("Continue"), "the splash after sign-out");
  check("signing out returns to the splash", true);

  exit = results.every(Boolean) ? 0 : 1;
} catch (error) {
  console.log(`FAIL ${error.message}`);
} finally {
  chrome.kill();
  api.close();
  page.close();
  await pause(500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
process.exit(exit);
