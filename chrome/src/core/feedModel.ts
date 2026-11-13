import { isReadable } from "./cast.ts";
import type { FeedCast } from "./cast.ts";
import { FeedHTTPError } from "./errors.ts";
import type { FeedReader, Person, Read } from "./feedReader.ts";

export type Problem = "paused" | "unreachable" | "refused" | "limitReached";

/**
 * One feed refresh, as reported by Copy Diagnostics. It holds counts, ages, and a public cast hash,
 * and never cast text or anything related to keys.
 */
export interface RefreshRecord {
  reason: string;
  /** Unix milliseconds. */
  started: number;
  seconds: number;
  outcome: string;
  newestOwnCast: string | null;
}

/** Everything kept for one account. It's stored whole, because a service worker can stop at any time. */
export interface FeedState {
  source?: string;
  hasList: boolean;
  people?: Person[];
  casts: FeedCast[];
  checkedAt?: number;
  latestSeen: number;
  lastRead?: number;
  lastFull?: number;
  lastPeople?: number;
  lastRefresh?: number;
  ownAvatar?: string;
  lastAvatar?: number;
  hidden: number[];
  ownPosts: FeedCast[];
  deleted: Record<string, number>;
  /** The node can accept a cast before a read returns it. Each stays here until one does. */
  held: { cast: FeedCast; added: number }[];
  /** Newest first. Saved, because the worker usually stops between a refresh and Copy Diagnostics. */
  history?: RefreshRecord[];
}

export const emptyFeedState = (): FeedState => ({ hasList: false, casts: [], latestSeen: 0, hidden: [], ownPosts: [], deleted: {}, held: [] });

export const STALE_AFTER_SECONDS = 10 * 60;
const SIGN_IN = "sign-in";
const PEOPLE_BUTTON = "people";
const READ_GAP = 45;
const REFRESH_GAP = 20;
const PEOPLE_GAP = 30;
const FOREGROUND_GAP = 60;
const FULL_READ_EVERY = 24 * 60 * 60;
const WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_CASTS = 1000;
const POST_HOLD = 120;
const AVATAR_EVERY = 24 * 60 * 60;
const HISTORY_LIMIT = 8;

/** Like Swift's ISO8601Format(), which leaves out fractions of a second. */
const isoTime = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Only the kind of failure, since an error's message can quote what the server sent. */
function describeError(error: unknown): string {
  if (error instanceof FeedHTTPError) return `HTTP ${error.status}`;
  if (error instanceof Error) return error.name;
  return typeof error;
}

const recordLine = (record: RefreshRecord) =>
  `${isoTime(record.started)} ${record.reason} ${record.seconds.toFixed(1)}s ${record.outcome}${record.newestOwnCast ? `, yours ${record.newestOwnCast}` : ""}`;

export const newer =(left: FeedCast, right: FeedCast) =>
  left.time === right.time ? (left.hash < right.hash ? -1 : 1) : right.time - left.time;

export interface FeedModelOptions {
  fid: number;
  handle: string;
  reader: Pick<FeedReader, "poll" | "window" | "follows" | "avatar">;
  /** Identifies the server, because servers don't hold the same casts. */
  source: string;
  usesInvite: boolean;
  load(): Promise<FeedState | undefined>;
  save(state: FeedState): Promise<void>;
  changed(): void;
  now?(): number;
}

/** One account's feed. Reads the network when asked and keeps at most one refresh running. */
export class FeedModel {
  private state = emptyFeedState();
  private readonly options: FeedModelOptions;
  private loaded: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private queued: string | null = null;
  problem: Problem | null = null;
  loading = false;
  refreshingPeople = false;
  peopleRefreshFailed = false;
  saveFailed = false;

  constructor(options: FeedModelOptions) {
    this.options = options;
  }

  private get nowMilliseconds() {
    return this.options.now?.() ?? Date.now();
  }

  private get nowSeconds() {
    return Math.floor(this.nowMilliseconds / 1000);
  }

  private isDue(last: number | undefined, gap: number) {
    return this.nowSeconds - (last ?? 0) >= gap;
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const saved = await this.options.load();
      if (saved) this.state = { ...emptyFeedState(), ...saved };
      if (this.state.source !== this.options.source) {
        // One server's answers shouldn't outlive it.
        this.state = { ...this.state, source: this.options.source, casts: [], latestSeen: 0, lastRead: undefined, lastFull: undefined, lastRefresh: undefined };
      }
    })();
    return this.loaded;
  }

  private async persist() {
    try {
      await this.options.save(this.state);
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
    }
  }

  get people(): Person[] {
    return this.state.people ?? [];
  }

  get hasLoadedFeed() {
    return this.state.people !== undefined;
  }

  get lastChecked() {
    return this.state.checkedAt;
  }

  get hidden() {
    return new Set(this.state.hidden);
  }

  private get names(): Map<number, string> {
    const hidden = this.hidden;
    return new Map(this.people.filter((person) => !hidden.has(person.fid)).map((person) => [person.fid, person.handle]));
  }

  private isInPeople(fid: number) {
    return this.people.some((person) => person.fid === fid);
  }

  handle(fid: number): string {
    return this.names.get(fid) ?? (fid === this.options.fid ? this.options.handle : String(fid));
  }

  get casts(): FeedCast[] {
    const allowed = new Set(this.names.keys());
    if (!this.isInPeople(this.options.fid)) allowed.add(this.options.fid);
    const seen = new Set<string>();
    const { ownAvatar } = this.state;
    return [...this.state.casts, ...this.state.held.map((held) => held.cast), ...this.state.ownPosts]
      .filter((cast) => {
        if (!allowed.has(cast.fid) || this.state.deleted[cast.hash] !== undefined || !isReadable(cast) || seen.has(cast.hash)) return false;
        seen.add(cast.hash);
        return true;
      })
      .map((cast) => (cast.fid === this.options.fid && !cast.avatar && ownAvatar ? { ...cast, avatar: ownAvatar } : cast))
      .sort(newer);
  }

  /** A new sign-in reads who the account follows. Anything else uses the list it has. */
  async start(signedIn: boolean) {
    await this.load();
    this.options.changed();
    // A frame loads every time someone returns to the home feed, and a failed read isn't remembered as one.
    if (!signedIn && !this.isDue(this.state.lastRefresh, FOREGROUND_GAP)) return;
    await this.refresh(signedIn ? SIGN_IN : "launch");
  }

  /** Returning to the feed refreshes it, but quick tab switches don't ask again. */
  async refreshIfStale() {
    await this.load();
    if (this.loading || !this.isDue(this.state.lastRefresh, FOREGROUND_GAP)) return;
    await this.refresh("foreground");
  }

  async refreshPeople() {
    this.refreshingPeople = true;
    this.options.changed();
    try {
      await this.refresh(PEOPLE_BUTTON);
    } finally {
      this.refreshingPeople = false;
      this.options.changed();
    }
  }

  async toggleVisibility(fid: number) {
    await this.load();
    const hidden = this.hidden;
    if (!hidden.delete(fid)) hidden.add(fid);
    this.state.hidden = [...hidden];
    await this.persist();
    this.options.changed();
  }

  /** Shows a cast the node has accepted. An account outside its own follows keeps it on this browser. */
  async addPosted(cast: FeedCast) {
    await this.load();
    if (this.hasLoadedFeed && cast.fid === this.options.fid && !this.isInPeople(cast.fid)) {
      if (!this.state.ownPosts.some((own) => own.hash === cast.hash)) this.state.ownPosts.push(cast);
    } else if (!this.state.held.some((held) => held.cast.hash === cast.hash)) {
      this.state.held.push({ cast, added: this.nowSeconds });
    }
    await this.persist();
    this.options.changed();
  }

  /** A read can lag behind a deletion, so deleted casts stay filtered while the feed could still have them. */
  async removeDeleted(cast: FeedCast) {
    await this.load();
    this.state.held = this.state.held.filter((held) => held.cast.hash !== cast.hash);
    this.state.ownPosts = this.state.ownPosts.filter((own) => own.hash !== cast.hash);
    this.state.deleted[cast.hash] = cast.time;
    await this.persist();
    this.options.changed();
  }

  /** A refresh requested while another runs happens again afterward, since the first may have already read. */
  refresh(reason: string): Promise<void> {
    if (this.running) {
      if (!this.queued || !this.rebuildsPeople(this.queued)) this.queued = reason;
      return this.running;
    }
    this.loading = true;
    this.options.changed();
    this.running = (async () => {
      await this.load();
      let next: string | null = reason;
      while (next) {
        await this.read(next);
        next = this.queued;
        this.queued = null;
      }
      this.running = null;
      this.loading = false;
      this.options.changed();
    })();
    return this.running;
  }

  private rebuildsPeople(reason: string) {
    return reason === SIGN_IN || reason === PEOPLE_BUTTON;
  }

  private async fetchLatest(reason: string): Promise<number> {
    if (this.rebuildsPeople(reason)) return this.rebuildPeople();
    if (this.hasLoadedFeed && this.people.length === 0) {
      try {
        return await this.rebuildPeople();
      } catch (error) {
        if (!(error instanceof FeedHTTPError && error.status === 429)) throw error;
      }
    }
    try {
      return await this.fetchFeed(reason === "pull" || reason === "post");
    } catch (error) {
      if (error instanceof FeedHTTPError && error.status === 404) return this.rebuildPeople();
      throw error;
    }
  }

  private async read(reason: string) {
    const started = this.nowMilliseconds;
    const lastRead = this.state.lastRead;
    let outcome: string;
    try {
      const age = await this.fetchLatest(reason);
      this.state.checkedAt = this.nowSeconds - age;
      this.problem = age >= STALE_AFTER_SECONDS && this.people.length > 0 ? "paused" : null;
      this.releaseHeld();
      if (reason === PEOPLE_BUTTON) this.peopleRefreshFailed = false;
      outcome = `${this.state.lastRead !== lastRead ? `updated ${this.state.casts.length} casts` : "unchanged"}, age ${age}s`;
    } catch (error) {
      if (reason === PEOPLE_BUTTON) this.peopleRefreshFailed = true;
      else this.problem = this.problemFor(error);
      outcome = `failed: ${describeError(error)}`;
    }
    await this.readOwnAvatar();
    this.state.lastRefresh = this.nowSeconds;
    this.prune();
    const record = { reason, started, seconds: (this.nowMilliseconds - started) / 1000, outcome, newestOwnCast: this.newestOwnCast };
    this.state.history = [record, ...(this.state.history ?? [])].slice(0, HISTORY_LIMIT);
    await this.persist();
    this.options.changed();
  }

  private get newestOwnCast(): string | null {
    const cast = this.state.casts.filter((candidate) => candidate.fid === this.options.fid).sort(newer)[0];
    return cast ? `${cast.hash.slice(0, 10)} at ${isoTime(cast.time * 1000)}` : null;
  }

  /** Text someone can paste into a bug report. See `RefreshRecord` for what it may contain. */
  diagnostics(about: { app: string; connection: string }): string {
    const history = this.state.history ?? [];
    return [
      about.app,
      `Now ${isoTime(this.nowMilliseconds)}`,
      `Connection ${about.connection}`,
      `Account FID ${this.options.fid}`,
      `People ${this.people.length}, hidden ${this.state.hidden.length}`,
      `Casts in feed ${this.casts.length}, problem ${this.problem ?? "none"}`,
      `Last checked ${this.state.checkedAt === undefined ? "never" : isoTime(this.state.checkedAt * 1000)}`,
      `Refreshing ${this.loading ? "yes" : "no"}, save failed ${this.saveFailed ? "yes" : "no"}`,
      "Refreshes, newest first:",
      ...(history.length === 0 ? ["none yet"] : history.map(recordLine)),
    ].join("\n");
  }

  private async readOwnAvatar() {
    if (!this.isDue(this.state.lastAvatar, AVATAR_EVERY)) return;
    try {
      const avatar = await this.options.reader.avatar(this.options.fid);
      if (avatar) this.state.ownAvatar = avatar;
      this.state.lastAvatar = this.nowSeconds;
    } catch {
      // Initials are a fine stand-in, and the next read tries again.
    }
  }

  private problemFor(error: unknown): Problem {
    if (!(error instanceof FeedHTTPError)) return "unreachable";
    if (error.status === 402 && this.options.usesInvite) return "limitReached";
    return [401, 402, 403].includes(error.status) ? "refused" : "unreachable";
  }

  private releaseHeld() {
    const read = new Set(this.state.casts.map((cast) => cast.hash));
    this.state.held = this.state.held.filter((held) => this.nowSeconds - held.added < POST_HOLD && !read.has(held.cast.hash));
  }

  private prune() {
    const oldest = this.nowSeconds - WINDOW_SECONDS;
    this.state.ownPosts = this.state.ownPosts.filter((cast) => cast.time > oldest);
    this.state.deleted = Object.fromEntries(Object.entries(this.state.deleted).filter(([, time]) => time > oldest));
  }

  private age() {
    // A list with no successful read yet counts as stale, so the app says the feed is behind.
    return this.state.checkedAt === undefined ? STALE_AFTER_SECONDS : Math.max(0, this.nowSeconds - this.state.checkedAt);
  }

  private async fetchFeed(refreshing: boolean): Promise<number> {
    if (!this.state.hasList) throw new FeedHTTPError(404);
    if (this.isDue(this.state.lastRead, refreshing ? REFRESH_GAP : READ_GAP)) {
      await this.readNetwork(this.isDue(this.state.lastFull, FULL_READ_EVERY));
    }
    return this.age();
  }

  /** Only a failed read of the list throws, and it keeps the old list. */
  private async rebuildPeople(): Promise<number> {
    if (!this.isDue(this.state.lastPeople, PEOPLE_GAP)) throw new FeedHTTPError(429);
    this.state.lastPeople = this.nowSeconds;
    await this.persist();
    const people = await this.options.reader.follows(this.options.fid);
    const before = new Set(this.people.map((person) => person.fid));
    const added = !this.state.hasList || people.some((person) => !before.has(person.fid));
    this.state.hasList = true;
    this.state.people = people;
    this.state.casts = this.tidy(this.state.casts);
    await this.persist();
    try {
      // Someone new on the list has casts a poll wouldn't reach.
      if (added) await this.readNetwork(true);
      else if (this.isDue(this.state.lastRead, READ_GAP)) await this.readNetwork(this.isDue(this.state.lastFull, FULL_READ_EVERY));
    } catch {
      // The list is still good. The feed's age shows it's behind.
    }
    return this.age();
  }

  private async readNetwork(full: boolean) {
    if (this.people.length === 0) return;
    const time = this.nowSeconds;
    const follows = new Set(this.people.map((person) => person.fid));
    let result: Read;
    if (full) {
      result = await this.options.reader.window(this.options.fid, time - WINDOW_SECONDS, follows);
      const replacement = this.tidy(result.casts);
      // An unusually short read is treated as a bad one, because real deletions can wait.
      const trusted = result.complete && (this.state.casts.length < 20 || replacement.length * 2 >= this.state.casts.length);
      this.state.casts = trusted ? replacement : this.tidy([...this.state.casts, ...result.casts]);
      this.state.lastFull = time;
    } else {
      result = await this.options.reader.poll(this.options.fid, this.state.latestSeen, follows);
      this.state.casts = this.tidy([...this.state.casts, ...result.casts]);
    }
    this.state.people = this.people.map((person) => ({ handle: result.handles[person.fid] ?? person.handle, fid: person.fid }));
    this.state.latestSeen = Math.max(this.state.latestSeen, Math.min(result.latestSeen, this.latestAllowed));
    this.state.lastRead = time;
    this.state.checkedAt = time;
    await this.persist();
  }

  /** A little past now, for clocks that disagree. Anything later would sit at the top of the feed for good. */
  private get latestAllowed() {
    return this.nowSeconds + 300;
  }

  private tidy(casts: FeedCast[]): FeedCast[] {
    const oldest = this.nowSeconds - WINDOW_SECONDS;
    const follows = new Set(this.people.map((person) => person.fid));
    const byHash = new Map<string, FeedCast>();
    for (const cast of casts) {
      if (cast.time >= oldest && cast.time <= this.latestAllowed && follows.has(cast.fid)) byHash.set(cast.hash, cast);
    }
    return [...byHash.values()].sort(newer).slice(0, MAX_CASTS);
  }
}
