import type { Api, ApiName } from "../core/api.ts";
import { Session } from "./session.ts";

function broadcast() {
  chrome.runtime.sendMessage({ fatline: "changed" }).catch(() => {});
}

const session = new Session(broadcast);

const handlers: { [Name in ApiName]: (...args: Parameters<Api[Name]>) => unknown } = {
  view: () => session.view(),
  start: () => session.start(),
  refreshIfStale: () => session.refreshIfStale(),
  pull: () => session.pull(),
  refreshPeople: () => session.refreshPeople(),
  toggleHidden: (fid) => session.toggleHidden(fid),
  saveDraft: (text) => session.saveDraft(text),
  post: (text) => session.post(text),
  discardRetry: () => session.discardRetry(),
  deleteCast: (hash) => session.deleteCast(hash),
  checkKeyIfDue: () => session.checkKeyIfDue(),
  signOut: () => session.signOut(),
  diagnostics: () => session.diagnostics(),
  openSetup: (page) => {
    chrome.tabs.create({ url: chrome.runtime.getURL(page === "connection" ? "setup.html#connection" : "setup.html") });
  },
  setupState: () => session.setupState(),
  useConnection: (choice) => session.useConnection(choice),
  importBegin: (address) => session.importBegin(address),
  importFinish: (authorization) => session.importFinish(authorization),
  retryRegistration: () => session.retryRegistration(),
};

// Pages hold a port during long work. It closes if this worker stops, so they can ask again.
chrome.runtime.onConnect.addListener(() => {});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const name = message?.rpc as ApiName | undefined;
  if (!name || !Object.hasOwn(handlers, name)) return;
  // Only this extension's own pages. A content script runs beside x.com, so it gets nothing here.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
    respond({ ok: false, error: { kind: "refused", message: "Not allowed." } });
    return;
  }
  (async () => (handlers[name] as (...args: unknown[]) => unknown)(...(message.args ?? [])))().then(
    (value) => respond({ ok: true, value: value ?? null }),
    (error) => respond({ ok: false, error: { kind: error?.kind ?? "unavailable", message: error?.message ?? "Couldn’t reach the service. Try again." } }),
  );
  return true;
});
