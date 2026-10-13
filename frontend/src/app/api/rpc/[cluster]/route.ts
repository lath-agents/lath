/**
 * The browser's Solana JSON-RPC (`/api/rpc/<cluster>`), forwarded to `LATH_RPC_URL` so the keyed url
 * stays on the server. What is forwarded, and what is refused, is `../proxy.ts`; the programs a scan
 * may name and the caller's bucket are `../limits.ts`.
 *
 * The cluster is in the path on purpose: the wallet adapter picks the chain it signs for from the
 * endpoint's text (`getChainForEndpoint`: `devnet` in the url means devnet), and a same-origin path
 * has no cluster in its host.
 */
import { CLUSTER, RPC_URL } from "../../_lib/runner";
import { SCANNED_PROGRAMS, proxyLimits } from "../limits";
import { proxyRpc } from "../proxy";

export async function POST(req: Request, ctx: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await ctx.params;
  // Empty is devnet, as `lib/config.ts` reads it: `NEXT_PUBLIC_CLUSTER=""` must not 404 every read.
  return proxyRpc(
    req,
    { role: "rpc", upstream: RPC_URL, cluster, servedCluster: CLUSTER || "devnet", programIds: SCANNED_PROGRAMS },
    proxyLimits(req)
  );
}
