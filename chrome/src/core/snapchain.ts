import { farcasterTime } from "./message.ts";
import type { SignedCast, SignedRemoval } from "./message.ts";
import { PostingError } from "./errors.ts";
import type { Client, HTTPResponse } from "./http.ts";

export interface SignerRegistration {
  fid: number;
  deadline: number;
  bytes: Uint8Array;
}

export type SignerStatus = "active" | "expired" | "missing";

export interface SignerState {
  status: SignerStatus;
  /** Keys made before Fatline could delete can only post. */
  canDelete: boolean;
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const rejection = (text: string) => json<{ message?: string }>(text)?.message ?? "";

function matches(response: HTTPResponse, hash: string, fid: number): boolean {
  const receipt = json<{ hash?: string; data?: { fid?: number } }>(response.text);
  return receipt?.hash?.toLowerCase() === hash && receipt?.data?.fid === fid;
}

/** The node answers an address it doesn't know with a 400 after about 20 seconds. */
const ACCOUNT_LOOKUP_TIMEOUT = 45_000;

export class Snapchain {
  private readonly client: Client;
  private readonly sleep: Sleep;

  constructor(client: Client, sleep: Sleep = defaultSleep) {
    this.client = client;
    this.sleep = sleep;
  }

  async account(custodyAddress: string): Promise<{ fid: number; nonce: number }> {
    const found = await this.client.nodeGet("onChainIdRegistryEventByAddress", { address: custodyAddress }, ACCOUNT_LOOKUP_TIMEOUT);
    if (found.status === 404 || (found.status === 400 && found.text.includes("NotFound"))) throw new PostingError("accountNotFound");
    if (found.status !== 200) throw new PostingError("unavailable");
    const identity = json<{ fid?: number; idRegisterEventBody?: { to?: string } }>(found.text);
    if (!identity?.fid || identity.idRegisterEventBody?.to?.toLowerCase() !== custodyAddress) throw new PostingError("accountNotFound");
    const keys = await this.client.nodeGet("signersByFid", { fid: String(identity.fid), pageSize: "1" });
    if (keys.status !== 200) throw new PostingError("unavailable");
    const current = json<{ currentUserNonce?: number }>(keys.text)?.currentUserNonce;
    if (typeof current !== "number" || current >= 0xffffffff) throw new PostingError("unavailable");
    return { fid: identity.fid, nonce: current + 1 };
  }

  async register(registration: SignerRegistration, publicKey: string): Promise<void> {
    if ((await this.signerState(registration.fid, publicKey)).status === "active") return;
    if (farcasterTime() > registration.deadline) throw new PostingError("expiredAuthorization");
    let submission: HTTPResponse | null = null;
    try {
      submission = await this.client.nodePost(registration.bytes, 20_000);
    } catch {}
    if (submission && submission.status >= 400 && submission.status < 500 && submission.status !== 429) {
      const reason = rejection(submission.text).toLowerCase();
      if (reason && !reason.includes("duplicate") && !reason.includes("nonce")) {
        // Shown right under the recovery phrase, so a server's own words don't belong there.
        throw new PostingError("rejected", "The server rejected this request.");
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await this.sleep(1000);
      try {
        if ((await this.signerState(registration.fid, publicKey)).status === "active") return;
      } catch {}
    }
    throw new PostingError("awaitingSigner");
  }

  async signerState(fid: number, publicKey: string): Promise<SignerState> {
    const response = await this.client.nodeGet("signersByFid", { fid: String(fid), pageSize: "1000" });
    if (response.status !== 200) throw new PostingError("unavailable");
    return Snapchain.parseSignerState(response.text, fid, publicKey);
  }

  /** Keys with a time limit report `expiresAt` in Unix seconds, and it moves forward each time the key signs. */
  static parseSignerState(text: string, fid: number, publicKey: string, now = Date.now()): SignerState {
    const signers = json<{ signers?: { fid: number; key: string; expiresAt?: number; scopes?: string[] }[] }>(text)?.signers;
    if (!signers) throw new PostingError("unavailable");
    const signer = signers.find((entry) => entry.fid === fid && entry.key.toLowerCase() === publicKey);
    if (!signer) return { status: "missing", canDelete: false };
    const canDelete = signer.scopes?.includes("MESSAGE_TYPE_CAST_REMOVE") ?? true;
    if (signer.expiresAt === undefined) return { status: "active", canDelete };
    return { status: signer.expiresAt > now / 1000 ? "active" : "expired", canDelete };
  }

  async username(fid: number): Promise<string> {
    const response = await this.client.nodeGet("userDataByFid", { fid: String(fid), user_data_type: "USER_DATA_TYPE_USERNAME" });
    if (response.status !== 200) return String(fid);
    const messages = json<{ messages?: { data?: { userDataBody?: { type: string; value: string } } }[] }>(response.text)?.messages ?? [];
    const found = messages.map((message) => message.data?.userDataBody).find((body) => body?.type === "USER_DATA_TYPE_USERNAME" && body.value);
    return found?.value ?? String(fid);
  }

  async submit(cast: SignedCast, checkingExisting = false): Promise<void> {
    const confirmed = async () => {
      try {
        const found = await this.client.nodeGet("castById", { fid: String(cast.fid), hash: cast.hash }, 3000);
        return found.status === 200 && matches(found, cast.hash, cast.fid);
      } catch {
        return false;
      }
    };

    if (checkingExisting && (await confirmed())) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      let response: HTTPResponse | null = null;
      try {
        response = await this.client.nodePost(cast.bytes, 6000);
      } catch {}
      if (response?.status === 200 && matches(response, cast.hash, cast.fid)) return;
      if (await confirmed()) return;

      if (response) {
        const reason = rejection(response.text);
        const lowered = reason.toLowerCase();
        if (response.status === 409 || lowered.includes("duplicate") || lowered.includes("already exists")) {
          await this.sleep(600);
          if (await confirmed()) return;
          throw new PostingError("unconfirmed");
        }
        if (response.status === 429) throw new PostingError("unconfirmed");
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 425) {
          if (!checkingExisting && attempt === 0 && reason) throw new PostingError("rejected", reason.slice(0, 180));
          throw new PostingError("unconfirmed");
        }
      }
      if (attempt === 0) await this.sleep(600);
    }
    throw new PostingError("unconfirmed");
  }

  /** Sends a deletion once. If the answer is lost or unclear, the cast being gone settles it. */
  async remove(removal: SignedRemoval): Promise<void> {
    let response: HTTPResponse | null = null;
    try {
      response = await this.client.nodePost(removal.bytes, 10_000);
    } catch {}
    if (response?.status === 200 && matches(response, removal.hash, removal.fid)) return;
    try {
      const found = await this.client.nodeGet("castById", { fid: String(removal.fid), hash: removal.target }, 5000);
      if (found.status === 404) return;
    } catch {}
    if (response && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      const reason = rejection(response.text);
      if (reason) throw new PostingError("rejected", reason.slice(0, 180));
    }
    throw new PostingError("unavailable");
  }
}
