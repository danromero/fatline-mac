import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CastView, PersonView, View } from "../core/api.ts";
import { farcasterURL, fullDate, imageURL, imageURLs, linkedText, linkLabel, shortAge, webLinks } from "../core/cast.ts";
import { byteLength } from "../core/message.ts";
import { PostingError } from "../core/errors.ts";
import { onChanged, rpc, RpcError } from "../core/rpc.ts";
import { Alert, Chevron, Portal } from "../shared/ui.tsx";

const REFRESH_WHILE_VISIBLE_MS = 5 * 60 * 1000;
const parentOrigin = location.ancestorOrigins[0] ?? null;

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    // A frame may not be allowed the clipboard API, but a copy from a click still works.
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  });
}

function useView() {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    let running = false;
    let again = false;
    let port: chrome.runtime.Port | null = null;
    // Held only during long work. If the worker stops mid-way, no update would ever say it finished.
    const watch = (working: boolean) => {
      if (working && !port) {
        port = chrome.runtime.connect({ name: "view" });
        port.onDisconnect.addListener(() => {
          port = null;
          void load();
        });
      } else if (!working && port) {
        port.disconnect();
        port = null;
      }
    };
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const next = await rpc("view");
        setView(next);
        watch(next.busy || next.loading || next.refreshingPeople);
      } catch {}
      running = false;
      if (again) {
        again = false;
        void load();
      }
    };
    onChanged(load);
    void load();
    void rpc("start").catch(() => {});
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void rpc("refreshIfStale").catch(() => {});
      void rpc("checkKeyIfDue").catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, REFRESH_WHILE_VISIBLE_MS);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, []);
  return view;
}

function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

function Avatar({ cast }: { cast: CastView }) {
  const [failed, setFailed] = useState(false);
  const source = cast.avatar ? imageURL(cast.avatar) : null;
  return (
    <div class="avatar" aria-hidden="true">
      {source && !failed ? <img src={source} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setFailed(true)} /> : cast.handle.replace(/[^\p{L}]/gu, "").slice(0, 2).toUpperCase()}
    </div>
  );
}

function CastTime({ time }: { time: number }) {
  const [hovering, setHovering] = useState(false);
  return (
    <span class="time" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} aria-label={fullDate(time)}>
      {hovering ? fullDate(time) : shortAge(time)}
    </span>
  );
}

function Picture({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <a class="picture-link" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open image">
      {failed ? <span class="meta underline">Image unavailable</span> : <img class="picture" src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setFailed(true)} />}
    </a>
  );
}

function CastRow({ cast, onMenu, active }: { cast: CastView; onMenu: (event: MouseEvent, cast: CastView) => void; active: boolean }) {
  const pieces = useMemo(() => linkedText(cast.text), [cast.text]);
  return (
    <article class={active ? "row active" : "row"} onContextMenu={(event) => onMenu(event, cast)}>
      <Avatar cast={cast} />
      <div class="row-body">
        <div class="row-top">
          <span class="handle">{cast.handle}</span>
          <CastTime time={cast.time} />
        </div>
        {cast.text && (
          <p class="text">
            {pieces.map((piece, index) => piece.url
              ? <a key={index} href={piece.url} target="_blank" rel="noopener noreferrer">{piece.text}</a>
              : <span key={index}>{piece.text}</span>)}
          </p>
        )}
        {imageURLs(cast).map((url) => <Picture key={url} url={url} />)}
        {webLinks(cast).map((link) => <a key={link} class="link" href={link} target="_blank" rel="noopener noreferrer">{linkLabel(link)}</a>)}
        {cast.quote && (
          <div class="quote">
            <div class="meta-strong">{cast.quote.handle}</div>
            <div class="meta clamp">{cast.quote.text}</div>
          </div>
        )}
      </div>
    </article>
  );
}

const age = (seconds: number) => {
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr`;
  const days = Math.floor(minutes / 1440);
  return days === 1 ? "1 day" : `${days} days`;
};

function Banner({ view }: { view: View }) {
  const problem = view.problem!;
  const ago = view.lastChecked === null ? null : age(Date.now() / 1000 - view.lastChecked);
  const showing = ago ? `Showing posts from ${ago} ago. ` : "";
  const title = { paused: "Feed paused", limitReached: "Feed paused", unreachable: "Can’t reach the server", refused: "Feed stopped" }[problem];
  const detail = {
    paused: `${ago ? `Last updated ${ago} ago. ` : ""}New posts will appear when it’s back. Click to check.`,
    unreachable: `${showing}Click to try again.`,
    limitReached: `${showing}Limit reached. Try again later.`,
    refused: `${showing}The server turned down the request. Check Connection in Settings.`,
  }[problem];
  return (
    <button class="banner" disabled={view.loading} onClick={() => void rpc("pull")}>
      <span class="banner-mark" aria-hidden="true">!</span>
      <span class="banner-body">
        <span class="body-strong">{title}</span>
        <span class="meta">{view.loading ? "Checking…" : detail}</span>
      </span>
    </button>
  );
}

function emptyMessage(view: View): string {
  if (view.loading) return "Loading…";
  if (view.problem) return "Couldn’t load the feed. Click to try again.";
  if (view.hasLoadedFeed && view.people.length > 0 && view.people.every((person) => person.hidden)) return "Everyone is hidden.";
  return "No recent casts.";
}

function Empty({ view }: { view: View }) {
  if (view.hasLoadedFeed && !view.loading && !view.problem && view.people.length === 0) {
    return (
      <div class="empty">
        <div>Signed in as <strong>{view.username}</strong></div>
        <div>Not following anyone</div>
      </div>
    );
  }
  if (view.problem) return <button class="empty empty-button" onClick={() => void rpc("pull")}>{emptyMessage(view)}</button>;
  return <div class="empty">{emptyMessage(view)}</div>;
}

interface Toast {
  id: number;
  title: string;
  detail?: string;
}

function Composer({ view, onClose, onSent }: { view: View; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState(view.draft);
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef(0);
  const bytes = byteLength(text);
  const valid = text.trim().length > 0 && bytes <= 320;
  const working = view.busy || sending;
  const disabled = working || (!view.hasPending && !valid);
  const canStopRetrying = view.hasPending && !working;

  useEffect(() => {
    area.current?.focus();
    const end = area.current?.value.length ?? 0;
    area.current?.setSelectionRange(end, end);
    return () => clearTimeout(saveTimer.current);
  }, []);

  const change = (next: string) => {
    setText(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void rpc("saveDraft", next), 500);
  };

  const cancel = () => {
    if (working) return;
    clearTimeout(saveTimer.current);
    void rpc("saveDraft", text);
    onClose();
  };

  const post = async () => {
    if (disabled) return;
    clearTimeout(saveTimer.current);
    setFailure(null);
    setSending(true);
    try {
      await rpc("saveDraft", text);
      const outcome = await rpc("post", text);
      if ("busy" in outcome) return;
      if (outcome.sent) onSent();
      else setFailure({ title: outcome.title, detail: outcome.detail });
    } catch {
      // The signed cast was saved before sending, so Retry can still finish it.
      setFailure({ title: "Post not confirmed", detail: new PostingError("unconfirmed").message });
    } finally {
      setSending(false);
    }
  };

  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel();
    if (event.key === "Enter" && event.metaKey) {
      event.preventDefault();
      void post();
    }
  };

  return (
    <div class="scrim">
      <div class="sheet" role="dialog" aria-label="Compose" onKeyDown={keys}>
        <textarea ref={area} class="editor" aria-label="Cast draft" placeholder="Write a cast…" value={text} onInput={(event) => change(event.currentTarget.value)} />
        {(failure || canStopRetrying) && (
          <div class="composer-notice">
            {failure && <span class="meta notice-text"><span class="danger">{failure.title}</span> {failure.detail}</span>}
            {canStopRetrying && <button class="stop-retrying" onClick={() => setStopping(true)}>Stop Retrying…</button>}
          </div>
        )}
        <div class="sheet-footer">
          <span class={bytes > 320 ? "meta danger status" : "meta status"}>{working ? "Sending…" : bytes >= 280 ? `${bytes} / 320` : ""}</span>
          <button class="plain" disabled={working} onClick={cancel}>Cancel</button>
          <button class="primary compact" disabled={disabled} onClick={() => void post()}>{view.hasPending ? "Retry" : "Post"}</button>
        </div>
      </div>
      {stopping && (
        <Alert
          title="Stop retrying this cast?"
          message="Snapchain may already have received it. Your draft stays here."
          cancel="Cancel"
          confirm="Stop Retrying"
          onCancel={() => setStopping(false)}
          onConfirm={() => {
            setStopping(false);
            setFailure(null);
            void rpc("discardRetry");
          }}
        />
      )}
    </div>
  );
}

interface Menu {
  cast: CastView;
  x: number;
  y: number;
}

function CastMenu({ menu, onClose, onDelete }: { menu: Menu; onClose: () => void; onDelete: (cast: CastView) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const url = farcasterURL(menu.cast, menu.cast.handle);

  useEffect(() => {
    const size = box.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, innerWidth - size.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - size.height - 8)) });
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [menu]);

  const act = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <div class="menu-layer" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div ref={box} class="menu" role="menu" style={position} onClick={(event) => event.stopPropagation()}>
        {menu.cast.text && <button role="menuitem" onClick={act(() => copy(menu.cast.text))}>Copy Text</button>}
        {url && <button role="menuitem" onClick={act(() => copy(url))}>Copy Link</button>}
        {url && <button role="menuitem" onClick={act(() => window.open(url, "_blank", "noopener,noreferrer"))}>Open in Farcaster</button>}
        {menu.cast.own && (
          <>
            <div class="menu-divider" />
            <button role="menuitem" class="danger" onClick={act(() => onDelete(menu.cast))}>Delete…</button>
          </>
        )}
      </div>
    </div>
  );
}

function Feed({ view, plusShift, onSettings }: { view: View; plusShift: number; onSettings: () => void }) {
  useMinuteTick();
  const [composing, setComposing] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirming, setConfirming] = useState<CastView | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.detail ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showMenu = useCallback((event: MouseEvent, cast: CastView) => {
    event.preventDefault();
    setMenu({ cast, x: event.clientX, y: event.clientY });
  }, []);

  const askDelete = (cast: CastView) => {
    if (view.keyCanDelete === false) setNotice({ title: "Sign in again to delete", message: new PostingError("postOnlyKey").message });
    else setConfirming(cast);
  };

  const remove = async (cast: CastView) => {
    setConfirming(null);
    setDeleting((current) => new Set(current).add(cast.hash));
    try {
      await rpc("deleteCast", cast.hash);
      setToast({ id: Date.now(), title: "Deleted" });
    } catch (error) {
      if (error instanceof RpcError && error.kind === "postOnlyKey") setNotice({ title: "Sign in again to delete", message: error.message });
      else setNotice({ title: "Couldn’t delete the cast", message: error instanceof Error ? error.message : "" });
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(cast.hash);
        return next;
      });
    }
  };

  return (
    <>
      <header class="bar">
        <Portal size={28} label="Fatline feed" circle />
        <button class="bar-button bar-right" aria-label="Settings" onClick={onSettings}>
          <svg width="18" height="4" viewBox="0 0 18 4" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1.6" /><circle cx="9" cy="2" r="1.6" /><circle cx="16" cy="2" r="1.6" /></svg>
        </button>
      </header>
      {view.problem && view.casts.length > 0 && <Banner view={view} />}
      <div class="feed" ref={list}>
        {view.keyInactive && <><p class="feed-message">{new PostingError("inactiveKey").message}</p><div class="divider" /></>}
        {view.saveFailed && view.casts.length > 0 && <><p class="feed-message">Couldn’t save the feed on this browser.</p><div class="divider" /></>}
        {view.casts.map((cast) => (
          <div key={cast.hash} class={deleting.has(cast.hash) ? "row-wrap deleting" : "row-wrap"}>
            <CastRow cast={cast} onMenu={showMenu} active={menu?.cast.hash === cast.hash} />
            <div class="divider" />
          </div>
        ))}
      </div>
      {view.casts.length === 0 && <Empty view={view} />}
      <button class="plus" style={{ right: `${16 + plusShift}px` }} aria-label="Compose" onClick={() => { setToast(null); setComposing(true); }}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M10 3v14M3 10h14" /></svg>
      </button>
      {toast && !composing && (
        <div class="toast-host" role="status">
          <div class="pill">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="var(--action)" /><path d="M4 7.2 6.1 9.3 10 5" fill="none" stroke="var(--action-ink)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <span>{toast.title}</span>
          </div>
        </div>
      )}
      {composing && (
        <Composer
          view={view}
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            setToast({ id: Date.now(), title: "Sent" });
            list.current?.scrollTo({ top: 0 });
          }}
        />
      )}
      {menu && <CastMenu menu={menu} onClose={() => setMenu(null)} onDelete={askDelete} />}
      {confirming && (
        <Alert
          title="Delete this cast?"
          message="Farcaster apps will stop showing it. This can’t be undone."
          cancel="Cancel"
          confirm="Delete"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void remove(confirming)}
        />
      )}
      {notice && <Alert title={notice.title} message={notice.message} cancel="OK" onCancel={() => setNotice(null)} />}
    </>
  );
}

function BackBar({ title, onBack, right }: { title: string; onBack: () => void; right?: preact.ComponentChildren }) {
  return (
    <header class="bar bar-title">
      <button class="bar-button bar-left" aria-label="Back" onClick={onBack}>
        <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 2 8l6 6" /></svg>
      </button>
      <span>{title}</span>
      {right}
    </header>
  );
}

function Settings({ view, onBack, onPeople }: { view: View; onBack: () => void; onPeople: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyDiagnostics = async () => {
    try {
      copy(await rpc("diagnostics"));
      setCopied(true);
    } catch {}
  };

  return (
    <>
      <BackBar title="Settings" onBack={onBack} />
      <div class="settings">
        <div class="settings-account"><span class="body-strong">{view.username}</span><span class="meta">Signed in</span></div>
        <div class="divider" />
        <button class="settings-row" onClick={onPeople}><span>People</span><Chevron /></button>
        <div class="divider" />
        <button class="settings-row" onClick={() => void rpc("openSetup", "connection")}>
          <span>Connection</span>
          <span class="settings-value"><span class="meta">{view.connectionName}</span><Chevron /></span>
        </button>
        <div class="divider" />
        <button class="settings-row" onClick={() => void copyDiagnostics()}><span aria-live="polite">{copied ? "Copied" : "Copy Diagnostics"}</span></button>
        <div class="divider" />
        <div class="meta settings-version">{view.version}</div>
      </div>
      <div class="sign-out">
        <div class="divider" />
        <button class={view.signOutBlock ? "sign-out-button blocked" : "sign-out-button"} disabled={view.signOutBlock !== null} onClick={() => setConfirming(true)}>Sign Out</button>
        {view.signOutBlock && <p class="meta sign-out-block">{view.signOutBlock}</p>}
      </div>
      {confirming && (
        <Alert
          title="Sign out of Fatline?"
          message="This removes the posting key from this browser and keeps this account’s draft."
          cancel="Cancel"
          confirm="Sign Out"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            rpc("signOut").catch((error: Error) => setFailed(error.message));
          }}
        />
      )}
      {failed && <Alert title="Couldn’t sign out" message={failed} cancel="OK" onCancel={() => setFailed(null)} />}
    </>
  );
}

function People({ view, onBack }: { view: View; onBack: () => void }) {
  const row = (person: PersonView) => (
    <div key={person.fid}>
      <div class="person">
        <span class={person.hidden ? "body-strong muted" : "body-strong"}>{person.handle}</span>
        <button class={person.hidden ? "person-action on" : "person-action"} aria-label={`${person.hidden ? "Unhide" : "Hide"} ${person.handle}`} onClick={() => void rpc("toggleHidden", person.fid)}>
          {person.hidden ? "Unhide" : "Hide"}
        </button>
      </div>
      <div class="divider" />
    </div>
  );
  return (
    <>
      <BackBar
        title="People"
        onBack={onBack}
        right={
          <button class="bar-button bar-right" aria-label="Refresh people you follow" disabled={view.refreshingPeople} onClick={() => void rpc("refreshPeople")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 11.8 4" /><path d="M13.5 1.5V5H10" /></svg>
          </button>
        }
      />
      {view.peopleRefreshFailed && <><p class="feed-message">Couldn’t refresh. Try again in a minute.</p><div class="divider" /></>}
      <div class="feed">
        {view.people.map(row)}
        <p class="meta people-footer">To change who you follow, use the Farcaster app.</p>
      </div>
    </>
  );
}

function Splash() {
  return (
    <div class="splash">
      <div class="splash-center">
        <Portal size={128} />
        <h1 class="display">Fatline</h1>
      </div>
      <div class="bottom-action">
        <button class="primary" onClick={() => void rpc("openSetup", "start")}>Continue</button>
      </div>
    </div>
  );
}

function App() {
  const view = useView();
  const [screen, setScreen] = useState<"feed" | "settings" | "people">("feed");
  const [plusShift, setPlusShift] = useState(0);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== parentOrigin || event.data?.fatline !== "layout") return;
      document.documentElement.dataset.theme = event.data.theme === "dark" ? "dark" : "light";
      setPlusShift(Math.max(0, Math.min(Number(event.data.plusShift) || 0, 175)));
    };
    window.addEventListener("message", listener);
    if (parentOrigin) window.parent.postMessage({ fatline: "ready" }, parentOrigin);
    return () => window.removeEventListener("message", listener);
  }, []);

  useEffect(() => {
    if (view && !view.signedIn) setScreen("feed");
  }, [view?.signedIn]);

  if (!view) return null;
  if (!view.signedIn) return <Splash />;
  if (screen === "settings") return <Settings view={view} onBack={() => setScreen("feed")} onPeople={() => setScreen("people")} />;
  if (screen === "people") return <People view={view} onBack={() => setScreen("settings")} />;
  return <Feed view={view} plusShift={plusShift} onSettings={() => setScreen("settings")} />;
}

render(<App />, document.getElementById("app")!);
