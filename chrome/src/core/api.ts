import type { FeedCast } from "./cast.ts";
import type { ConnectionChoice } from "./connection.ts";
import type { Problem } from "./feedModel.ts";

export interface CastView extends FeedCast {
  handle: string;
  own: boolean;
}

export interface PersonView {
  fid: number;
  handle: string;
  hidden: boolean;
}

/** Everything a page draws. Pages hold no keys and never read the network themselves. */
export interface View {
  signedIn: boolean;
  username: string | null;
  connectionName: string | null;
  draft: string;
  hasPending: boolean;
  busy: boolean;
  keyInactive: boolean;
  keyCanDelete: boolean | null;
  casts: CastView[];
  people: PersonView[];
  hasLoadedFeed: boolean;
  loading: boolean;
  refreshingPeople: boolean;
  peopleRefreshFailed: boolean;
  problem: Problem | null;
  lastChecked: number | null;
  saveFailed: boolean;
  signOutBlock: string | null;
  version: string;
}

export type PostOutcome = { sent: true } | { sent: false; title: string; detail: string } | { busy: true };

export interface SetupState {
  signedIn: boolean;
  hasRegistration: boolean;
  saved: ConnectionChoice | null;
}

export interface ImportStart {
  fid: number;
  nonce: number;
  /** 0x-prefixed. The custody account authorizes this key. */
  publicKey: string;
}

export interface ImportFinish {
  fid: number;
  nonce: number;
  deadline: number;
  ttl: number;
  custodySignature: string;
  metadata: string;
}

export interface Api {
  view(): View;
  start(): void;
  refreshIfStale(): void;
  pull(): void;
  refreshPeople(): void;
  toggleHidden(fid: number): void;
  saveDraft(text: string): void;
  post(text: string): PostOutcome;
  discardRetry(): void;
  deleteCast(hash: string): void;
  checkKeyIfDue(): void;
  signOut(): void;
  openSetup(page: "start" | "connection"): void;
  setupState(): SetupState;
  useConnection(choice: ConnectionChoice): string | null;
  importBegin(address: string): ImportStart;
  importFinish(authorization: ImportFinish): void;
  retryRegistration(): void;
}

export type ApiName = keyof Api;
