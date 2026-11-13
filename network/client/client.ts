import type {
  ActivityPage, FeedPage, JoinRequest, JoinStatus, LinkPreview, Member, NetworkInfo, ProfileChange, Session, SessionRequest, Thread, UploadedImage,
} from "../src/protocol/api.ts";
import { networkOrigin } from "../src/protocol/approvals.ts";
import { makeLike, makePost, makeRemoval, makeUnlike } from "../src/protocol/messages.ts";
import type { Draft, PostRef, SignedMessage } from "../src/protocol/messages.ts";
import { toHex } from "../src/protocol/protobuf.ts";
import { approveNetworkKey, Ed25519Key, signSession } from "./keys.ts";
import type { Identity, NetworkApproval } from "./keys.ts";

export class NetworkError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message = typeof body === "object" && body && "message" in body ? String(body.message) : `The server answered ${status}`;
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface NetworkMembership {
  host: string;
  networkKey: Ed25519Key;
  approval: NetworkApproval;
  token?: string;
  expires?: number;
}

type Fetch = typeof fetch;

/** Talks to one network as one person, the way the apps will. For scripts and tests. */
export class NetworkClient {
  readonly identity: Identity;
  readonly membership: NetworkMembership;
  private readonly send: Fetch;
  private readonly now: () => Date;

  constructor(identity: Identity, membership: NetworkMembership, options: { fetch?: Fetch; now?: () => Date } = {}) {
    this.identity = identity;
    this.membership = membership;
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** A new network key for `host`, approved by this device. */
  static forNetwork(identity: Identity, host: string, options: { fetch?: Fetch; now?: () => Date } = {}) {
    const networkKey = Ed25519Key.random();
    const approval = approveNetworkKey(identity, host, networkKey, (options.now ?? (() => new Date()))());
    return new NetworkClient(identity, { host, networkKey, approval }, options);
  }

  get host() {
    return this.membership.host;
  }

  get fid() {
    return this.identity.fid;
  }

  joinRequest(options: { invite?: string; avatar?: string } = {}): JoinRequest {
    return {
      fid: this.fid,
      deviceKey: toHex(this.identity.device.publicKey),
      deviceApproval: this.identity.approval,
      networkKey: toHex(this.membership.networkKey.publicKey),
      networkApproval: this.membership.approval,
      ...(options.invite ? { invite: options.invite } : {}),
      ...(options.avatar ? { avatar: options.avatar } : {}),
    };
  }

  async join(options: { invite?: string; avatar?: string } = {}): Promise<JoinStatus> {
    const answer = await this.request<{ status: JoinStatus }>("POST", "/join", { json: this.joinRequest(options), signedIn: false });
    return answer.status;
  }

  /** Gets a session token once the admin has let this person in. */
  async signIn(): Promise<JoinStatus> {
    const signed = signSession(this.fid, this.host, this.membership.networkKey, this.now());
    const body: SessionRequest = { fid: this.fid, networkKey: toHex(this.membership.networkKey.publicKey), ...signed };
    const response = await this.fetch("POST", "/session", { json: body, signedIn: false });
    const answer = await readJSON(response);
    if (response.status === 200) {
      const session = answer as Session;
      this.membership.token = session.token;
      this.membership.expires = session.expires;
      return "approved";
    }
    if (response.status === 202) return "pending";
    if (response.status === 403) return "refused";
    throw new NetworkError(response.status, answer);
  }

  /** With `readsLinks`, this app reads its links' pages itself and sends previews, so the network fetches nothing. */
  async submit(message: SignedMessage, options: { readsLinks?: boolean } = {}): Promise<string> {
    const headers: Record<string, string> = options.readsLinks ? { "fatline-previews": "app" } : {};
    const answer = await this.request<{ hash: string }>("POST", "/messages", { bytes: message.bytes, type: "application/octet-stream", headers });
    return answer.hash;
  }

  async post(draft: Draft, options: { readsLinks?: boolean } = {}) {
    return this.submit(await makePost(this.fid, draft, this.membership.networkKey, this.now()), options);
  }

  /** Previews of a post's own links, read by this app, with any picture uploaded first. */
  async sendPreviews(hash: string, previews: LinkPreview[]) {
    await this.request("PUT", `/posts/${hash}/previews`, { json: { previews } });
  }

  async reply(parent: PostRef, draft: Omit<Draft, "parent">) {
    return this.post({ ...draft, parent });
  }

  async like(target: PostRef) {
    return this.submit(await makeLike(this.fid, target, this.membership.networkKey, this.now()));
  }

  async unlike(target: PostRef) {
    return this.submit(await makeUnlike(this.fid, target, this.membership.networkKey, this.now()));
  }

  async remove(hash: string) {
    return this.submit(await makeRemoval(this.fid, hash, this.membership.networkKey, this.now()));
  }

  uploadImage(bytes: Uint8Array, type: "image/jpeg" | "image/png" | "image/gif") {
    return this.request<UploadedImage>("POST", "/media", { bytes, type });
  }

  network() {
    return this.request<NetworkInfo>("GET", "/network");
  }

  feed(cursor?: string) {
    return this.request<FeedPage>("GET", "/feed" + query({ cursor }));
  }

  thread(hash: string) {
    return this.request<Thread>("GET", `/posts/${hash}`);
  }

  activity(cursor?: string) {
    return this.request<ActivityPage>("GET", "/activity" + query({ cursor }));
  }

  async members() {
    return (await this.request<{ members: Member[] }>("GET", "/members")).members;
  }

  updateProfile(change: ProfileChange) {
    return this.request<Member>("PATCH", "/me", { json: change });
  }

  async mute(fid: number) {
    await this.request("PUT", `/mutes/${fid}`);
  }

  async unmute(fid: number) {
    await this.request("DELETE", `/mutes/${fid}`);
  }

  async report(post: string, note?: string) {
    await this.request("POST", "/reports", { json: note ? { post, note } : { post } });
  }

  async leave() {
    await this.request("POST", "/leave");
  }

  // The admin's JSON routes.

  async requests() {
    return (await this.request<{ requests: { fid: number; username: string | null; requested: number; status: string }[] }>("GET", "/admin/requests")).requests;
  }

  async approve(fid: number) {
    await this.request("POST", `/admin/requests/${fid}/approve`);
  }

  async refuse(fid: number) {
    await this.request("POST", `/admin/requests/${fid}/refuse`);
  }

  async removeMember(fid: number) {
    await this.request("POST", `/admin/members/${fid}/remove`);
  }

  async blocks() {
    return (await this.request<{ blocks: { fid: number; username: string | null; blocked: number }[] }>("GET", "/admin/blocks")).blocks;
  }

  async unblock(fid: number) {
    await this.request("DELETE", `/admin/blocks/${fid}`);
  }

  async invites() {
    return (await this.request<{ invites: Invite[] }>("GET", "/admin/invites")).invites;
  }

  createInvite(options: { code?: string; uses?: number | null; expires?: number | null } = {}) {
    return this.request<Invite>("POST", "/admin/invites", { json: options });
  }

  async revokeInvite(code: string) {
    await this.request("DELETE", `/admin/invites/${encodeURIComponent(code)}`);
  }

  settings() {
    return this.request<{ name: string; retention: "30 days" | "forever"; admitFollows: boolean }>("GET", "/admin/settings");
  }

  updateSettings(change: { name?: string; retention?: "30 days" | "forever"; admitFollows?: boolean }) {
    return this.request<{ name: string; retention: "30 days" | "forever"; admitFollows: boolean }>("PATCH", "/admin/settings", { json: change });
  }

  /** Takes the admin's follows from the network's hub, which joins then check against. */
  pullFollows() {
    return this.request<{ count: number; pulled: number | null; complete: boolean }>("POST", "/admin/follows/pull");
  }

  async reports() {
    return (await this.request<{ reports: { id: number; post: string; postFid: number; fid: number; note: string; here: boolean }[] }>("GET", "/admin/reports")).reports;
  }

  async resolveReport(id: number) {
    await this.request("POST", `/admin/reports/${id}/resolve`);
  }

  async log() {
    return (await this.request<{ entries: { id: number; time: number; admin: number | null; action: string; detail: unknown }[] }>("GET", "/admin/log")).entries;
  }

  async adminLink() {
    return (await this.request<{ url: string }>("POST", "/admin-link")).url;
  }

  private async request<Answer>(method: string, path: string, body: RequestBody = {}): Promise<Answer> {
    const response = await this.fetch(method, path, body);
    const answer = await readJSON(response);
    if (!response.ok) throw new NetworkError(response.status, answer);
    return answer as Answer;
  }

  private fetch(method: string, path: string, body: RequestBody) {
    const headers: Record<string, string> = { ...body.headers };
    if (body.signedIn !== false) {
      if (!this.membership.token) throw new Error("Not signed in to this network");
      headers.authorization = `Bearer ${this.membership.token}`;
    }
    let payload: RequestInit["body"];
    if (body.json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body.bytes) {
      headers["content-type"] = body.type ?? "application/octet-stream";
      payload = body.bytes as RequestInit["body"];
    }
    return this.send(`${networkOrigin(this.host)}/api/v1${path}`, { method, headers, body: payload, redirect: "error" });
  }
}

export interface Invite {
  code: string;
  usesLeft: number | null;
  expires: number | null;
  created: number;
  used: number;
  revoked: number | null;
}

interface RequestBody {
  json?: unknown;
  bytes?: Uint8Array;
  type?: string;
  signedIn?: boolean;
  headers?: Record<string, string>;
}

async function readJSON(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function query(parameters: Record<string, string | undefined>) {
  const entries = Object.entries(parameters).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length ? "?" + new URLSearchParams(entries).toString() : "";
}
