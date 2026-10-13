/**
 * The browser's Photon index (`/api/rpc/<cluster>/photon`), forwarded to the server's Photon url —
 * `LATH_PHOTON_URL`, else `LATH_RPC_URL`, the same hosted endpoint on devnet. What is forwarded is
 * `../../proxy.ts`; the prover has no route, because stateless.js's `Rpc` never calls it. The
 * caller's bucket is the one the Solana route charges (`../../limits.ts`).
 */
import { CLUSTER, PHOTON_URL } from "../../../_lib/runner";
import { proxyLimits } from "../../limits";
import { proxyRpc } from "../../proxy";

export async function POST(req: Request, ctx: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await ctx.params;
  // Empty is devnet, as `lib/config.ts` reads it.
  return proxyRpc(
    req,
    { role: "photon", upstream: PHOTON_URL, cluster, servedCluster: CLUSTER || "devnet" },
    proxyLimits(req)
  );
}
