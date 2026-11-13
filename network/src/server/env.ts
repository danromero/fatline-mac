export interface Env {
  DB: D1Database;
  /** The FID of the person who runs this network. They're let in at once, as its admin. */
  ADMIN_FID?: string;
  /** The host signatures name. Set it when the network has more than one address, such as a custom domain. */
  NETWORK_HOST?: string;
  /** Optimism RPCs to ask who owns an FID, separated by commas and tried in order. Without it, three public ones. */
  OPTIMISM_RPC_URL?: string;
  FNAME_URL?: string;
  /** A Snapchain HTTP API, such as `https://hub.example/v1`, for whom the admin follows. Without it, everyone waits for approval. */
  HUB_URL?: string;
  /** Sent to HUB_URL as `x-api-key`. Set it as a secret. */
  HUB_API_KEY?: string;
  REQUESTS?: RateLimit;
  MESSAGES?: RateLimit;
  JOINS?: RateLimit;
  /** Optimism lookups for joins, counted for the whole network under one key. */
  CUSTODY?: RateLimit;
  /** Image links and the network's picture, by address. */
  PICTURES?: RateLimit;
  /** A member's reads, by FID. */
  READS?: RateLimit;
  /** Uploaded images and the sizes made from them. */
  MEDIA?: R2Bucket;
  /** Cloudflare's Images binding, which makes the smaller sizes. Without it, each size is the original. */
  IMAGES?: ImagesBinding;
  /** A long random path for the invite page, `/<INVITE_PATH>/invite`. Without it, there's no invite page. */
  INVITE_PATH?: string;
  /** Mac builds older than this, such as `0.4.0`, are asked to update instead of answered. Empty means any build. */
  MINIMUM_MAC_VERSION?: string;
  /** Signs image links. Without it, the network makes one and keeps it in its settings. */
  MEDIA_SECRET?: string;
  /** Local tests only: where every fetch for avatars and previews goes instead, keeping its path. */
  TEST_FETCH_ORIGIN?: string;
  /**
   * Local tests only, and only on this computer: "1" puts each answer's D1 rows and statements in
   * x-rows-read, x-rows-written, and x-sql, and runs the hourly job at POST /__test/hourly?at=.
   */
  COST_HEADERS?: string;
}

/** What every handler gets. */
export interface Context {
  env: Env;
  db: D1Database;
  /** The host signed text must name, as in docs/NETWORK.md. */
  host: string;
  now: number;
  adminFid: number | null;
  /** Keeps work going after the answer is sent, like fetching a link's preview. */
  waitUntil: (work: Promise<unknown>) => void;
  /** The rows this request's database work has read and written so far, when it's being charged for them. */
  usage?: import("./meter.ts").Usage;
}

export interface Viewer {
  fid: number;
  role: "admin" | "member";
  networkKey: string;
}

/**
 * A member's role, from ADMIN_FID on every request. The role stored with a member is only what it was
 * when they joined, so changing ADMIN_FID demotes the old admin at once.
 */
export function roleOf(context: Context, fid: number): Viewer["role"] {
  return fid === context.adminFid ? "admin" : "member";
}

export function adminFid(env: Env): number | null {
  const value = Number(env.ADMIN_FID ?? "");
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function hostFor(env: Env, request: Request): string {
  return (env.NETWORK_HOST?.trim() || new URL(request.url).host).toLowerCase();
}
