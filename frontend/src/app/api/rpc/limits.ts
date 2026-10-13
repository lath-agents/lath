/**
 * What the two RPC routes hand `proxyRpc` beyond the urls: the programs a scan may name, the
 * caller's bucket key and the one set of buckets both routes charge. Here rather than in
 * `proxy.ts`, which reads no environment so that its suite can drive it with a clock of its own.
 */
import { LATH_BILLING_IDL } from "@lath/sdk";
import { LOCAL_CALLERS, callerIp } from "../_lib/runner";
import { tokenBuckets, type ProxyOptions, type RpcBuckets } from "./proxy";

/**
 * Call units one address may send a minute, and so also the most it holds at once. 1 200 is twenty
 * a second sustained: a page's first burst of reads, a charge history's batch of a hundred and a
 * wallet's two weighted allowance scans fit with room, and a script draining the provider's quota
 * from one address is held to it. The number to raise if a busy page is told to retry.
 */
const UNITS_PER_MINUTE = Number(process.env.LATH_RPC_UNITS_PER_MINUTE ?? 1200);

/**
 * The programs the browser scans with `getProgramAccounts`: the billing program, at the id the
 * browser's own `lib/config.ts` reads (`NEXT_PUBLIC_BILLING_PROGRAM_ID` for a fork, else the IDL's).
 * The oracle is not in this build, so a scan of it is refused like any other program's. Nothing
 * else in `frontend/src` or the SDK's browser paths scans, and stateless.js never does.
 */
export const SCANNED_PROGRAMS: ReadonlySet<string> = new Set([
  process.env.NEXT_PUBLIC_BILLING_PROGRAM_ID?.trim() || LATH_BILLING_IDL.address,
]);

/**
 * On `globalThis`, keyed by `Symbol.for`, for the reason `runner.ts`'s rate-limit map is: each
 * route is its own module graph, and a module-level set would give the Solana and Photon routes a
 * bucket each.
 */
const BUCKETS_KEY = Symbol.for("lath.rpcBuckets");
const LOCAL_BUCKETS_KEY = Symbol.for("lath.rpcBuckets.local");
function buckets(local: boolean): RpcBuckets {
  const g = globalThis as any;
  const key = local ? LOCAL_BUCKETS_KEY : BUCKETS_KEY;
  if (g[key] === undefined) g[key] = tokenBuckets(UNITS_PER_MINUTE * (local ? LOCAL_CALLERS : 1));
  return g[key] as RpcBuckets;
}

/**
 * The bucket options for this request. Only an address a trusted proxy vouched for is a caller of
 * its own (`callerIp`, `LATH_TRUST_PROXY=1`); untrusted, every request is `"local"`. One per-address
 * bucket for everybody would let one client's burst refuse every other visitor's reads — one caller
 * spending a shared limit for everybody — and charging nothing would leave the provider's quota open
 * to any script. So `local` has a bucket of its own holding `LOCAL_CALLERS` addresses' worth, the
 * policy `/api/run` applies to its `local` caller too.
 */
export function proxyLimits(req: Request): Pick<ProxyOptions, "caller" | "buckets"> {
  const caller = callerIp(req);
  return { caller, buckets: buckets(caller === "local") };
}
