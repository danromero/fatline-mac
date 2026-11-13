/** Farcaster's fname server, which says which username belongs to which FID. */
export const DEFAULT_FNAMES = "https://fnames.farcaster.xyz";

type Fetch = typeof fetch;

interface Transfer {
  transfer?: { username?: unknown; to?: unknown };
}

async function currentTransfer(base: string, query: string, send: Fetch): Promise<Transfer["transfer"] | null> {
  const response = await send(`${base}/transfers/current?${query}`, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The fname server answered ${response.status}`);
  return ((await response.json()) as Transfer).transfer ?? null;
}

/**
 * The FID's fname, if the fname server says it's theirs now: the FID's current transfer names it,
 * and the name's current transfer points back to the FID. Null if they have none. Throws if the
 * server can't be reached.
 */
export async function usernameOf(fid: number, base = DEFAULT_FNAMES, send: Fetch = fetch): Promise<string | null> {
  const byFid = await currentTransfer(base, `fid=${fid}`, send);
  const name = byFid?.username;
  if (byFid?.to !== fid || typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,19}$/.test(name)) return null;
  const byName = await currentTransfer(base, `name=${encodeURIComponent(name)}`, send);
  return byName?.to === fid ? name : null;
}
