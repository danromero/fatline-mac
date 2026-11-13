import { ID_REGISTRY } from "./approvals.ts";

/**
 * Public Optimism RPCs, from different providers, tried in this order. A server takes an owner only
 * when two of them agree (`custodyAgreed`), and any one can turn requests away for a while, so there are five.
 */
export const PUBLIC_RPCS = [
  "https://mainnet.optimism.io",
  "https://optimism-rpc.publicnode.com",
  "https://optimism.drpc.org",
  "https://1rpc.io/op",
  "https://op-pokt.nodies.app",
];

/** Optimism's own public RPC. Fine for joins and occasional checks. A busy server can use its own. */
export const DEFAULT_RPC = PUBLIC_RPCS[0]!;

// The first four bytes of keccak256 of each signature.
const CUSTODY_OF = "0x65269e47"; // custodyOf(uint256)
const ID_OF = "0xd94fe832"; // idOf(address)

type Fetch = typeof fetch;

async function call(rpc: string, data: string, send: Fetch): Promise<string> {
  const response = await send(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ID_REGISTRY, data }, "latest"] }),
  });
  if (!response.ok) throw new Error(`Optimism answered ${response.status}`);
  const answer = (await response.json()) as { result?: string; error?: { message?: string } };
  if (typeof answer.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(answer.result)) {
    throw new Error(`Optimism couldn't answer: ${answer.error?.message ?? "no result"}`);
  }
  return answer.result;
}

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** The address that owns an FID, lowercase, or null if nobody does. */
export async function custodyOf(fid: number, rpc = DEFAULT_RPC, send: Fetch = fetch): Promise<string | null> {
  const result = await call(rpc, CUSTODY_OF + word(BigInt(fid)), send);
  const address = "0x" + result.slice(-40).toLowerCase();
  return /^0x0{40}$/.test(address) ? null : address;
}

/** A setting that lists RPCs separated by commas, or else the public ones. */
export function rpcList(setting: string | undefined): string[] {
  const listed = (setting ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  return listed.length ? listed : PUBLIC_RPCS;
}

/** `custodyOf`, asking each RPC in turn until one answers. */
export async function custodyFromFirst(fid: number, rpcs: string[], send: Fetch = fetch): Promise<string | null> {
  let failure: unknown = new Error("No RPC to ask");
  for (const rpc of rpcs) {
    try {
      return await custodyOf(fid, rpc, send);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * `custodyOf`, as two RPCs agree. The first two are asked at once, then the rest one at a time,
 * until one answer has two votes and more than any other. One wrong or lagging RPC can't decide who
 * owns an FID. A single listed RPC is trusted alone, since whoever runs the server chose it.
 */
export async function custodyAgreed(fid: number, rpcs: string[], send: Fetch = fetch): Promise<string | null> {
  if (rpcs.length === 1) return custodyOf(fid, rpcs[0]!, send);
  const votes = new Map<string | null, number>();
  let failure: unknown = new Error("No RPC to ask");
  const count = (results: PromiseSettledResult<string | null>[]) => {
    for (const result of results) {
      if (result.status === "fulfilled") votes.set(result.value, (votes.get(result.value) ?? 0) + 1);
      else failure = result.reason;
    }
  };
  const decided = (): { owner: string | null } | null => {
    const [first, second] = [...votes].sort((a, b) => b[1] - a[1]);
    return first && first[1] >= 2 && first[1] > (second?.[1] ?? 0) ? { owner: first[0] } : null;
  };
  count(await Promise.allSettled(rpcs.slice(0, 2).map((rpc) => custodyOf(fid, rpc, send))));
  for (const rpc of rpcs.slice(2)) {
    if (decided()) break;
    count(await Promise.allSettled([custodyOf(fid, rpc, send)]));
  }
  const answer = decided();
  if (answer) return answer.owner;
  throw votes.size > 1 ? new Error(`Optimism RPCs disagree about who owns FID ${fid}`) : failure;
}

/** The FID an address owns, or null. */
export async function fidOf(address: string, rpc = DEFAULT_RPC, send: Fetch = fetch): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Not an address");
  const result = await call(rpc, ID_OF + word(BigInt(address)), send);
  const fid = BigInt(result);
  return fid === 0n ? null : Number(fid);
}
