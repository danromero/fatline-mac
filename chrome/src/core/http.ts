import { PostingError } from "./errors.ts";
import type { Connection, ConnectionChoice } from "./connection.ts";

export interface HTTPRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
}

export interface HTTPResponse {
  status: number;
  text: string;
}

export type Send = (request: HTTPRequest) => Promise<HTTPResponse>;

/** Far above any real page. The server is chosen by the person, so its answers aren't trusted. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export const browserSend: Send = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit | undefined,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      // A redirect could carry the credential somewhere else.
      redirect: "error",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: response.status, text: new TextDecoder().decode(joined) };
  } finally {
    clearTimeout(timer);
  }
};

const sameServer = (left: string, right: string) => new URL(left).origin === new URL(right).origin;

function url(base: string, path: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return `${base}/${path}${search ? `?${search}` : ""}`;
}

/** Sends requests for one connection, adding its credential only to its own servers. */
export class Client {
  readonly connection: Connection;
  private readonly transport: Send;

  constructor(connection: Connection, transport: Send) {
    this.connection = connection;
    this.transport = transport;
  }

  private headers(target: string): Record<string, string> {
    const { feedBase, nodeBase, header } = this.connection;
    const authorized = header && (sameServer(feedBase, target) || sameServer(nodeBase, target));
    return authorized ? { [header.name]: header.value } : {};
  }

  /** Keeps the status as it came, so the feed can report what went wrong. */
  raw(base: string, path: string, query: Record<string, string>, timeoutMs = 15_000): Promise<HTTPResponse> {
    const target = url(base, path, query);
    return this.transport({ url: target, method: "GET", headers: this.headers(target), timeoutMs });
  }

  /** Reading a node directly returns its own errors. The app expects a `message` and a real status. */
  private async node(request: HTTPRequest): Promise<HTTPResponse> {
    let response: HTTPResponse;
    try {
      response = await this.transport(request);
    } catch {
      throw new PostingError("unavailable");
    }
    return this.nodeAnswer(response);
  }

  nodeGet(path: string, query: Record<string, string>, timeoutMs = 10_000): Promise<HTTPResponse> {
    const target = url(this.connection.nodeBase, path, query);
    return this.node({ url: target, method: "GET", headers: this.headers(target), timeoutMs });
  }

  nodePost(bytes: Uint8Array, timeoutMs: number): Promise<HTTPResponse> {
    const target = url(this.connection.nodeBase, "submitMessage", {});
    return this.node({
      url: target,
      method: "POST",
      headers: { ...this.headers(target), "Content-Type": "application/octet-stream" },
      body: bytes,
      timeoutMs,
    });
  }

  private nodeAnswer(response: HTTPResponse): HTTPResponse {
    const { status, text } = response;
    if (this.connection.usesInvite || (status >= 200 && status < 300)) return response;
    const failure = (message: string, next: number) => ({ status: next, text: JSON.stringify({ message }) });
    // These describe the key or its credits, not the request.
    if ([401, 402, 403].includes(status)) return failure("Couldn't reach the network.", 503);
    let parsed: { message?: string; error?: string; error_detail?: string } = {};
    try {
      parsed = JSON.parse(text) ?? {};
    } catch {}
    const detail = parsed.error_detail ?? "";
    const quoted = detail.match(/message: "((?:[^"\\]|\\.)*)"/)?.[1];
    const message = parsed.message ?? quoted ?? parsed.error ?? "The network rejected this request.";
    return failure(message.slice(0, 300), detail.includes("status: NotFound") ? 404 : status);
  }
}

type Route = "feed" | "node";

const missingRoute: Record<Route, string> = {
  feed: "That server can’t build a feed. Fatline needs one that answers Neynar’s feed routes.",
  node: "That server doesn’t answer Snapchain’s routes, so Fatline can’t post through it.",
};

function statusProblem(status: number, route: Route, kind: ConnectionChoice["kind"]): string | null {
  if (status === 200) return null;
  if (status === 429) return "Too many requests. Try again in a minute.";
  if (kind === "invite") {
    if (status === 401 || status === 403) return "Invalid code.";
    if (status === 402) return "Limit reached. Try again later.";
    if (status === 404) return missingRoute[route];
  }
  if (kind === "neynar") {
    if (status === 401 || status === 403) return route === "node" ? "This key can’t use Neynar’s Snapchain node." : "Invalid key.";
    if (status === 402) return "This key is out of credits.";
  }
  if (kind === "custom") {
    if (status === 401 || status === 403) return "That server requires a key. Fatline can’t send one.";
    if (status === 404) return missingRoute[route];
  }
  return `That server answered with an error (HTTP ${status}). Try again.`;
}

/** Tries the cheapest read of each kind this connection depends on. Returns what's wrong, if anything. */
export async function connectionProblem(choice: ConnectionChoice, client: Client): Promise<string | null> {
  const { feedBase, nodeBase } = client.connection;
  const read = async (base: string, path: string, query: Record<string, string>, route: Route, key: string, needsNonce = false) => {
    const response = await client.raw(base, path, query);
    const problem = statusProblem(response.status, route, choice.kind);
    if (problem) return problem;
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(response.text);
    } catch {}
    return Array.isArray(body?.[key]) && (!needsNonce || typeof body?.currentUserNonce === "number") ? null : missingRoute[route];
  };
  try {
    const feed = await read(feedBase, "feed/following/", { fid: "1", limit: "1", with_recasts: "false" }, "feed", "casts");
    if (feed) return feed;
    const node = await read(nodeBase, "userDataByFid", { fid: "1", user_data_type: "USER_DATA_TYPE_USERNAME" }, "node", "messages");
    if (node) return node;
    // Only a custom server can pass those reads and still be unable to sign in.
    if (choice.kind !== "custom") return null;
    return await read(nodeBase, "signersByFid", { fid: "1", pageSize: "1" }, "node", "signers", true);
  } catch {
    return "Couldn’t reach that server. Check the address and your internet connection.";
  }
}
