import type { ImportFinish, ImportStart, PostOutcome, SetupState, View } from "../core/api.ts";
import type { FeedCast } from "../core/cast.ts";
import { connectionFor, originToAllow } from "../core/connection.ts";
import type { Connection, ConnectionChoice } from "../core/connection.ts";
import { PostingError } from "../core/errors.ts";
import { FeedModel } from "../core/feedModel.ts";
import type { FeedState } from "../core/feedModel.ts";
import { FeedReader } from "../core/feedReader.ts";
import { browserSend, Client, connectionProblem } from "../core/http.ts";
import { farcasterTime, fromHex, makeCast, makeKeyAdd, makeRemoval, toHex } from "../core/message.ts";
import type { SignedCast, Signer } from "../core/message.ts";
import { Snapchain } from "../core/snapchain.ts";
import type { SignerRegistration } from "../core/snapchain.ts";
import { read, remove, write } from "./store.ts";

interface StoredAccount {
  /** Non-extractable, so JavaScript can sign with it but can never read it. */
  privateKey: CryptoKey;
  publicKey: string;
  fid?: number;
  username?: string;
  pending?: SignedCast;
  registration?: SignerRegistration;
  keyInactive?: boolean;
  keyCanDelete?: boolean;
  lastKeyCheck?: number;
  signedInNow?: boolean;
}

const ACCOUNT = "account-v1";
const CONNECTION = "connection-v1";
const KEY_CHECK_GAP = 3600;
const draftKey = (fid: number) => `draft:${fid}`;
const feedKey = (fid: number) => `feed:${fid}`;

function signerFor(account: StoredAccount): Signer {
  const publicKey = fromHex(account.publicKey);
  if (!publicKey) throw new PostingError("missingKey");
  return {
    publicKey,
    sign: async (hash) => new Uint8Array(await crypto.subtle.sign("Ed25519", account.privateKey, hash as BufferSource)),
  };
}

const postedCast = (cast: SignedCast): FeedCast => ({ hash: cast.hash, fid: cast.fid, time: 1_609_459_200 + cast.timestamp, text: cast.text });

/** The signed-in account and everything done with it. A retry has to resend the exact signed bytes. */
export class Session {
  private account: StoredAccount | undefined;
  private choice: ConnectionChoice | undefined;
  private connection: Connection | undefined;
  private node: Snapchain | undefined;
  private model: FeedModel | undefined;
  private draft = "";
  private busy = false;
  private readonly changed: () => void;
  private readonly ready: Promise<void>;

  constructor(changed: () => void) {
    this.changed = changed;
    this.ready = this.restore();
  }

  private async restore() {
    this.choice = await read<ConnectionChoice>(CONNECTION);
    this.account = await read<StoredAccount>(ACCOUNT);
    this.connect();
    await this.openModel();
  }

  private connect() {
    if (!this.choice) {
      this.connection = this.node = undefined;
      return;
    }
    this.connection = connectionFor(this.choice);
    this.node = new Snapchain(new Client(this.connection, browserSend));
  }

  private async openModel() {
    const fid = this.account?.fid;
    if (!fid || !this.connection) {
      this.model = undefined;
      return;
    }
    this.draft = (await read<string>(draftKey(fid))) ?? "";
    this.model = new FeedModel({
      fid,
      handle: this.account?.username ?? String(fid),
      reader: new FeedReader(new Client(this.connection, browserSend)),
      source: this.connection.feedBase,
      usesInvite: this.connection.usesInvite,
      load: () => read<FeedState>(feedKey(fid)),
      save: (state) => write(feedKey(fid), state),
      changed: this.changed,
    });
    await this.model.load();
  }

  private async saveAccount() {
    if (!this.account) return;
    try {
      await write(ACCOUNT, this.account);
    } catch {
      throw new PostingError("storage");
    }
  }

  private get signOutBlock(): string | null {
    if (this.busy) return "Wait for Fatline to finish.";
    if (this.account?.pending && !this.account.keyInactive) return "You have an unsent cast. Open the composer to retry or discard it.";
    return null;
  }

  async view(): Promise<View> {
    await this.ready;
    const account = this.account;
    const model = this.model;
    const hidden = model?.hidden ?? new Set<number>();
    return {
      signedIn: account?.fid !== undefined,
      username: account?.username ?? null,
      connectionName: this.connection?.name ?? null,
      draft: this.draft,
      hasPending: account?.pending !== undefined,
      busy: this.busy,
      keyInactive: account?.keyInactive === true,
      keyCanDelete: account?.keyCanDelete ?? null,
      casts: (model?.casts ?? []).map((cast) => ({ ...cast, handle: model!.handle(cast.fid), own: cast.fid === account?.fid })),
      people: (model?.people ?? []).map((person) => ({ ...person, hidden: hidden.has(person.fid) })),
      hasLoadedFeed: model?.hasLoadedFeed ?? false,
      loading: model?.loading ?? false,
      refreshingPeople: model?.refreshingPeople ?? false,
      peopleRefreshFailed: model?.peopleRefreshFailed ?? false,
      problem: model?.problem ?? null,
      lastChecked: model?.lastChecked ?? null,
      saveFailed: model?.saveFailed ?? false,
      signOutBlock: this.signOutBlock,
      version: `Fatline ${chrome.runtime.getManifest().version}`,
    };
  }

  /** The first read after a sign-in also reads who the account follows. */
  async start() {
    await this.ready;
    const account = this.account;
    if (!this.model || !account) return;
    const signedIn = account.signedInNow === true;
    if (signedIn) {
      account.signedInNow = false;
      await this.saveAccount();
    }
    void this.checkKeyIfDue();
    await this.model.start(signedIn);
  }

  async refreshIfStale() {
    await this.ready;
    await this.model?.refreshIfStale();
  }

  async pull() {
    await this.ready;
    await this.model?.refresh("pull");
  }

  async refreshPeople() {
    await this.ready;
    await this.model?.refreshPeople();
  }

  async toggleHidden(fid: number) {
    await this.ready;
    await this.model?.toggleVisibility(fid);
  }

  async saveDraft(text: string) {
    await this.ready;
    const fid = this.account?.fid;
    if (!fid || text === this.draft) return;
    this.draft = text;
    await write(draftKey(fid), text);
    this.changed();
  }

  /** A failed lookup says nothing about the key, so only a clear answer changes the state. */
  private async checkKey(): Promise<boolean> {
    const account = this.account;
    if (!account?.fid || !this.node) return false;
    account.lastKeyCheck = Math.floor(Date.now() / 1000);
    let state;
    try {
      state = await this.node.signerState(account.fid, account.publicKey);
    } catch {
      await this.saveAccount();
      return false;
    }
    account.keyInactive = state.status !== "active";
    account.keyCanDelete = state.canDelete;
    await this.saveAccount();
    this.changed();
    return account.keyInactive;
  }

  async checkKeyIfDue() {
    await this.ready;
    if (Math.floor(Date.now() / 1000) - (this.account?.lastKeyCheck ?? 0) >= KEY_CHECK_GAP) await this.checkKey();
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.changed();
  }

  async post(text: string): Promise<PostOutcome> {
    await this.ready;
    const account = this.account;
    const fid = account?.fid;
    const node = this.node;
    if (this.busy) return { busy: true };
    if (!account || !fid || !node) return { sent: false, title: "Post not confirmed", detail: new PostingError("missingKey").message };
    const hadPending = account.pending !== undefined;
    this.setBusy(true);
    let submitted = false;
    try {
      const cast = account.pending ?? (await makeCast(fid, text, signerFor(account)));
      // Saved before sending, so a retry after any interruption resends these same bytes.
      account.pending = cast;
      await this.saveAccount();
      await node.submit(cast, hadPending);
      submitted = true;
      if (this.draft === cast.text) await this.saveDraft("");
      account.pending = undefined;
      await this.saveAccount();
      await this.model?.addPosted(postedCast(cast));
      void this.model?.refresh("post");
      return { sent: true };
    } catch (error) {
      if (!submitted && (await this.checkKey())) {
        // This key can never send the cast, so stop offering Retry. The draft stays.
        account.pending = undefined;
        await this.saveAccount().catch(() => {});
        return { sent: false, title: "Post not confirmed", detail: new PostingError("inactiveKey").message };
      }
      if (!hadPending && error instanceof PostingError && error.kind === "rejected") {
        account.pending = undefined;
        await this.saveAccount().catch(() => {});
      }
      const detail = error instanceof Error ? error.message : new PostingError("unavailable").message;
      return { sent: false, title: "Post not confirmed", detail };
    } finally {
      this.setBusy(false);
    }
  }

  async discardRetry() {
    await this.ready;
    // Discarding during a send would let the next Post sign the same text as a new cast.
    if (!this.account || this.busy) return;
    this.account.pending = undefined;
    await this.saveAccount();
    this.changed();
  }

  async deleteCast(hash: string) {
    await this.ready;
    const account = this.account;
    const cast = this.model?.casts.find((candidate) => candidate.hash === hash);
    if (!account?.fid || !this.node || !cast || cast.fid !== account.fid) throw new PostingError("missingKey");
    if (account.keyCanDelete === false) throw new PostingError("postOnlyKey");
    const removal = await makeRemoval(account.fid, hash, signerFor(account));
    try {
      await this.node.remove(removal);
    } catch (error) {
      // A refusal may come from the key, so the next answer reflects what it can do now.
      if (await this.checkKey()) throw new PostingError("inactiveKey");
      if (this.account?.keyCanDelete === false) throw new PostingError("postOnlyKey");
      throw error;
    }
    await this.model?.removeDeleted(cast);
  }

  async signOut() {
    await this.ready;
    if (this.signOutBlock) return;
    // Cleared first, so a key check finishing now can't write the account back after it's removed.
    const previous = this.account;
    this.account = undefined;
    try {
      await remove(ACCOUNT);
    } catch {
      this.account = previous;
      throw new PostingError("storage");
    }
    this.model = undefined;
    this.draft = "";
    this.changed();
  }

  async setupState(): Promise<SetupState> {
    await this.ready;
    return {
      signedIn: this.account?.fid !== undefined,
      hasRegistration: this.account?.registration !== undefined,
      saved: this.choice ?? null,
    };
  }

  async useConnection(choice: ConnectionChoice): Promise<string | null> {
    await this.ready;
    const origin = originToAllow(choice);
    if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) return "Chrome needs permission to reach that server.";
    const problem = await connectionProblem(choice, new Client(connectionFor(choice), browserSend));
    if (problem) return problem;
    await write(CONNECTION, choice);
    this.choice = choice;
    this.connect();
    await this.openModel();
    this.changed();
    void this.model?.start(false);
    return null;
  }

  async importBegin(address: string): Promise<ImportStart> {
    await this.ready;
    if (!this.node || this.account?.fid !== undefined) throw new PostingError("unavailable");
    this.setBusy(true);
    try {
      const { fid, nonce } = await this.node.account(address);
      const pair = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
      const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      this.account = { privateKey: pair.privateKey, publicKey };
      await this.saveAccount();
      return { fid, nonce, publicKey };
    } finally {
      this.setBusy(false);
    }
  }

  async importFinish(authorization: ImportFinish) {
    await this.ready;
    const account = this.account;
    if (!account || account.fid !== undefined) throw new PostingError("missingKey");
    const custodySignature = fromHex(authorization.custodySignature);
    const metadata = fromHex(authorization.metadata);
    if (custodySignature?.length !== 65 || !metadata?.length) throw new PostingError("rejected", "Couldn’t authorize the posting key.");
    if (farcasterTime() > authorization.deadline) throw new PostingError("expiredAuthorization");
    const message = await makeKeyAdd({ ...authorization, custodySignature, metadata }, signerFor(account));
    account.registration = { fid: authorization.fid, deadline: authorization.deadline, bytes: message.bytes };
    await this.saveAccount();
    await this.register();
  }

  async retryRegistration() {
    await this.ready;
    await this.register();
  }

  private async register() {
    const account = this.account;
    const registration = account?.registration;
    if (!account || !registration || !this.node) throw new PostingError("missingKey");
    this.setBusy(true);
    try {
      await this.node.register(registration, account.publicKey);
      account.fid = registration.fid;
      account.username = await this.node.username(registration.fid).catch(() => String(registration.fid));
      account.registration = undefined;
      account.signedInNow = true;
      account.keyInactive = false;
      await this.saveAccount();
      await this.openModel();
      void this.start();
    } finally {
      this.setBusy(false);
    }
  }
}
