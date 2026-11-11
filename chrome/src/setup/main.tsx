import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SetupState } from "../core/api.ts";
import { choiceFromTyped, inviteAddress, malformedMessage, originToAllow, parseInvite } from "../core/connection.ts";
import type { ConnectionChoice, ConnectionKind } from "../core/connection.ts";
import { PostingError } from "../core/errors.ts";
import { farcasterTime } from "../core/message.ts";
import { rpc } from "../core/rpc.ts";

declare const recoverFarcasterAccount: (phrase: string) => {
  address: string;
  authorize(fid: string, key: string, deadline: number, nonce: number, ttl: number): { metadata: string; custodySignature: string };
} | null;

const KEY_PAGE = "https://dev.neynar.com";
const SETUP_GUIDE = "https://fatline.tech/custom-server.md";
const AGENT_PROMPT = `Read the instructions for setting up a Fatline custom server at ${SETUP_GUIDE}. Tell me what you plan to do and ask me before running any commands.`;
const TTL = 30 * 24 * 60 * 60;
const MAX_PHRASE_BYTES = 1024;

const copy: Record<ConnectionKind, { title: string; instruction: string; placeholder: string; switchLabel: string }> = {
  neynar: { title: "Connect to Farcaster", instruction: "Paste your Neynar API key.", placeholder: "API key", switchLabel: "Neynar Key" },
  invite: { title: "Use a code", instruction: "Enter the code and server you were given.", placeholder: "CODE@server.example", switchLabel: "Code" },
  custom: { title: "Connect your server", instruction: "Enter your server’s HTTPS base URL.", placeholder: "https://example.com", switchLabel: "Advanced" },
};

async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  else window.close();
}

function Arrow() {
  return <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 7.5 7.5 1.5M3 1.5h4.5V6" /></svg>;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button class="bar-button" aria-label="Back" onClick={onClick}>
      <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 2 8l6 6" /></svg>
    </button>
  );
}

function savedValues(saved: ConnectionChoice | null): Record<ConnectionKind, string> {
  return {
    neynar: saved?.kind === "neynar" ? saved.key : "",
    invite: saved?.kind === "invite" ? `${saved.code}@${inviteAddress(saved.server)}` : "",
    custom: saved?.kind === "custom" ? saved.url : "",
  };
}

function ConnectionForm({ initial, settings, saved, onBack, onDone, onOpen }: {
  initial: ConnectionKind;
  settings: boolean;
  saved: ConnectionChoice | null;
  onBack?: () => void;
  onDone: () => void;
  onOpen?: (kind: ConnectionKind) => void;
}) {
  const [kind, setKind] = useState(initial);
  const [values, setValues] = useState(() => savedValues(saved));
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const value = values[kind];
  const invite = kind === "invite" ? parseInvite(value) : null;
  const unchanged = settings && JSON.stringify(choiceFromTyped(kind, value)) === JSON.stringify(saved);

  useEffect(() => {
    field.current?.focus();
    setError(null);
  }, [kind]);

  const submit = async () => {
    if (!value.trim() || checking) return;
    const choice = choiceFromTyped(kind, value);
    if (!choice) {
      setError(malformedMessage[kind]);
      return;
    }
    const origin = originToAllow(choice);
    setChecking(true);
    setError(null);
    try {
      // Has to come first, because Chrome only asks during the click itself.
      if (origin && !(await chrome.permissions.request({ origins: [origin] }))) {
        setError("Chrome needs permission to reach that server.");
        return;
      }
      const problem = await rpc("useConnection", choice);
      if (problem) setError(problem);
      else onDone();
    } catch {
      setError("Couldn’t reach that server. Check the address and your internet connection.");
    } finally {
      setChecking(false);
    }
  };

  const copyPrompt = () => {
    void navigator.clipboard.writeText(AGENT_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main class="step">
      <div class="step-bar">{onBack && !checking && <BackButton onClick={onBack} />}</div>
      <div class="step-body">
        {settings ? (
          <>
            <h1 class="screen-title">Connection</h1>
            <div class="mode-switch">
              {(["neynar", "invite", "custom"] as const).map((option) => (
                <button key={option} class={option === kind ? "selected" : ""} aria-pressed={option === kind} onClick={() => setKind(option)}>{copy[option].switchLabel}</button>
              ))}
            </div>
            <p class="instruction spaced">{copy[kind].instruction}</p>
          </>
        ) : (
          <>
            <h1 class="screen-title">{copy[kind].title}</h1>
            <p class="instruction">{copy[kind].instruction}</p>
          </>
        )}
        <input
          ref={field}
          class={settings ? "field near" : "field"}
          type={(kind === "neynar" ? "password" : "text") as "text"}
          aria-label={kind === "neynar" ? "Neynar API key" : kind === "invite" ? "Code" : "Server URL"}
          autocomplete="off"
          spellcheck={false}
          placeholder={copy[kind].placeholder}
          value={value}
          onInput={(event) => {
            const next = event.currentTarget.value;
            setValues((current) => ({ ...current, [kind]: next }));
            setError(null);
          }}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
        />
        {kind === "neynar" && (
          <div class="outline-row">
            <a class="outline" href={KEY_PAGE} target="_blank" rel="noopener noreferrer">Get a key <Arrow /></a>
            {onOpen && <button class="outline" onClick={() => onOpen("invite")}>Use code</button>}
            {onOpen && <button class="outline" onClick={() => onOpen("custom")}>Advanced</button>}
          </div>
        )}
        {invite && <p class="meta under-field">Your reads and posts will go through {inviteAddress(invite.server)}.</p>}
        {kind === "custom" && (
          <div class="outline-row">
            <button class="outline" onClick={copyPrompt}>{copied ? "Copied" : "Copy agent prompt"}</button>
            <a class="outline" href={SETUP_GUIDE} target="_blank" rel="noopener noreferrer">View setup guide <Arrow /></a>
          </div>
        )}
        {error && <p class="meta danger under-field">{error}</p>}
      </div>
      <div class="bottom-action step-action">
        <button class="primary" disabled={checking || !value.trim() || unchanged} data-working={checking} onClick={() => void submit()}>{checking ? "Checking…" : settings ? "Save" : "Continue"}</button>
      </div>
    </main>
  );
}

function Import({ onBack, hasRegistration, onDone }: { onBack: () => void; hasRegistration: boolean; onDone: () => void }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(hasRegistration);
  const words = text.split(/\s+/).filter(Boolean);
  const valid = words.length === 12 || words.length === 24;
  const tooLong = new TextEncoder().encode(text).length > MAX_PHRASE_BYTES;
  const feedback = tooLong || (!editing && words.length > 0 && !valid) ? "Enter 12 or 24 words." : text === "" ? error : null;
  const pasted = useRef(false);

  // A pasted phrase shouldn't stay one paste away from anywhere else, like X's composer.
  const clearClipboard = () => {
    if (!pasted.current) return;
    pasted.current = false;
    navigator.clipboard.writeText("").catch(() => {});
  };

  useEffect(() => {
    window.addEventListener("pagehide", clearClipboard);
    return () => {
      window.removeEventListener("pagehide", clearClipboard);
      clearClipboard();
    };
  }, []);

  const clearField = () => {
    clearClipboard();
    setText("");
  };

  const importPhrase = async () => {
    if (!valid || tooLong || busy) return;
    const phrase = text;
    let account;
    try {
      account = recoverFarcasterAccount(phrase);
    } catch {
      account = null;
    }
    if (!account) {
      setError(new PostingError("invalidPhrase").message);
      clearField();
      return;
    }
    setBusy(true);
    setError(null);
    clearField();
    try {
      const { fid, nonce, publicKey } = await rpc("importBegin", account.address);
      const deadline = farcasterTime() + 3600;
      const { metadata, custodySignature } = account.authorize(String(fid), publicKey, deadline, nonce, TTL);
      await rpc("importFinish", { fid, nonce, deadline, ttl: TTL, custodySignature, metadata });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : new PostingError("unavailable").message);
      setCanRetry((await rpc("setupState")).hasRegistration);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    clearField();
    setBusy(true);
    setError(null);
    try {
      await rpc("retryRegistration");
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : new PostingError("unavailable").message);
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <main class="step importing">
        <p class="body-strong">Importing…</p>
        <p class="meta">May take a minute</p>
      </main>
    );
  }

  return (
    <main class="step">
      <div class="step-bar"><BackButton onClick={onBack} /></div>
      <div class="step-body">
        <h1 class="screen-title">Import your account</h1>
        <p class="instruction">Enter your Farcaster recovery phrase, not another wallet’s.</p>
        <textarea
          class="phrase"
          aria-label="Farcaster recovery phrase"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder="12 or 24 words"
          value={text}
          onInput={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            if (next === "") clearClipboard();
          }}
          onPaste={() => { pasted.current = true; }}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void importPhrase();
            }
          }}
        />
        <p class="meta danger feedback">{feedback ?? " "}</p>
      </div>
      <div class="bottom-action step-action">
        {canRetry && <button class="text-button body" onClick={() => void retry()}>Retry Connection</button>}
        <button class="primary" disabled={!valid || tooLong} onClick={() => void importPhrase()}>Import</button>
      </div>
    </main>
  );
}

function App() {
  const settings = location.hash === "#connection";
  const [state, setState] = useState<SetupState | null>(null);
  const [path, setPath] = useState<(ConnectionKind | "import")[]>([]);

  useEffect(() => {
    void rpc("setupState").then((next) => {
      setState(next);
      if (!settings && next.hasRegistration) setPath(["neynar", "import"]);
      else if (!settings) setPath(["neynar"]);
    });
  }, []);

  if (!state) return null;
  if (settings) {
    const initial = state.saved?.kind ?? "neynar";
    return <ConnectionForm initial={initial} settings saved={state.saved} onDone={() => void closeTab()} />;
  }
  const step = path.at(-1);
  if (!step) return null;
  const back = () => setPath((current) => current.slice(0, -1));
  if (step === "import") return <Import hasRegistration={state.hasRegistration} onBack={back} onDone={() => void closeTab()} />;
  return (
    <ConnectionForm
      key={step}
      initial={step}
      settings={false}
      saved={state.saved}
      onBack={path.length > 1 ? back : undefined}
      onOpen={(next) => setPath((current) => [...current, next])}
      onDone={() => setPath((current) => [...current, "import"])}
    />
  );
}

render(<App />, document.getElementById("app")!);
