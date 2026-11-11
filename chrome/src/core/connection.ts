/** Where requests go and the one credential that goes with them. Mirrors the Mac app's Connection. */

export type ConnectionChoice =
  | { kind: "invite"; code: string; server: string }
  | { kind: "neynar"; key: string }
  | { kind: "custom"; url: string };

export type ConnectionKind = ConnectionChoice["kind"];

export interface Connection {
  /** Shown in Settings, so it never holds a key or an address. */
  name: string;
  feedBase: string;
  nodeBase: string;
  header: { name: string; value: string } | null;
  usesInvite: boolean;
}

const INVITE_HEADER = "X-Invite-Code";

export function connectionFor(choice: ConnectionChoice): Connection {
  switch (choice.kind) {
    case "invite":
      return {
        name: "Code",
        feedBase: `${choice.server}/v1/farcaster`,
        nodeBase: `${choice.server}/v1/node`,
        header: { name: INVITE_HEADER, value: choice.code },
        usesInvite: true,
      };
    case "neynar":
      return {
        name: "Neynar Key",
        feedBase: "https://api.neynar.com/v2/farcaster",
        nodeBase: "https://snapchain-api.neynar.com/v1",
        header: { name: "x-api-key", value: choice.key },
        usesInvite: false,
      };
    case "custom":
      return {
        name: "Custom Server",
        feedBase: `${choice.url}/v2/farcaster`,
        nodeBase: `${choice.url}/v1`,
        header: null,
        usesInvite: false,
      };
  }
}

/** Accepts an address with or without https://. A server gets only HTTPS, and only its address. */
export function httpsServer(text: string): string | null {
  let address = text.trim();
  if (address.length === 0 || /\s/.test(address)) return null;
  if (!address.includes("://")) address = `https://${address}`;
  address = address.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  return address.replace(/^https:\/\//i, "https://");
}

const CODE = /^[A-Za-z0-9\-._~]{1,128}$/;

/** Exactly one safe code and one HTTPS server, written as code@server.example. */
export function parseInvite(text: string): { code: string; server: string } | null {
  const parts = text.trim().split("@");
  if (parts.length !== 2 || !CODE.test(parts[0])) return null;
  const server = httpsServer(parts[1]);
  return server ? { code: parts[0], server } : null;
}

export const inviteAddress = (server: string) => server.replace(/^https:\/\//, "");

/** Nil for something that can't be a key, so it never reaches a request header. */
export function choiceFromTyped(kind: ConnectionKind, text: string): ConnectionChoice | null {
  if (kind === "invite") {
    const invite = parseInvite(text);
    return invite && { kind, ...invite };
  }
  if (kind === "neynar") {
    const key = text.trim();
    return key.length === 0 || /\s/.test(key) ? null : { kind, key };
  }
  const url = httpsServer(text);
  return url ? { kind, url } : null;
}

/** The origin Chrome has to allow before this choice can be used. Neynar's is in the manifest. */
export function originToAllow(choice: ConnectionChoice): string | null {
  if (choice.kind === "invite") return `${new URL(choice.server).origin}/*`;
  if (choice.kind === "custom") return `${new URL(choice.url).origin}/*`;
  return null;
}

export const malformedMessage: Record<ConnectionKind, string> = {
  neynar: "Invalid key.",
  invite: "Use the format code@server.example.",
  custom: "Enter an HTTPS URL.",
};
