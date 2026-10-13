import { PublicKey } from "@solana/web3.js";
import { IRYS_GATEWAY, LATH_BILLING_IDL, LATH_IDL } from "@lath/sdk/browser";
import { browserRpc } from "./rpc-endpoint";

/**
 * Everything the app needs to talk to a cluster. All of it is public by construction — program
 * ids and a treasury admin are on-chain anyway — which is why this file is `NEXT_PUBLIC_*`
 * throughout: Next inlines every one of them into the JavaScript each visitor downloads. Every
 * write is a wallet-signed transaction; there is nothing here to keep secret.
 *
 * The RPC url is the exception, and it is why the browser does not get one by default. A
 * ZK-compression endpoint is a paid service whose url carries the key, and it is the same url the
 * server writes every chain with (`LATH_RPC_URL`). Inlined here, it would let any visitor copy the
 * key from devtools and spend the console's quota. The browser talks to `/api/rpc/<cluster>` on this origin (`app/api/rpc/proxy.ts`), which
 * forwards the methods the app sends and holds the key. `NEXT_PUBLIC_RPC_URL` still works, for a
 * deployment that has a url it means to publish — a key restricted to this site's origin at the
 * provider, or a local validator — and whatever it is set to is public.
 *
 * Missing values are collected rather than thrown: `next build` prerenders these pages, so a
 * throw here would turn "you forgot to fill in .env.local" into a build failure with a stack
 * trace instead of a banner that says which variable is missing.
 */
export type Cluster = "devnet" | "mainnet-beta";

const problems: string[] = [];

function key(name: string, value: string | undefined, fallback?: string): PublicKey {
  const raw = value && value.length > 0 ? value : fallback;
  if (!raw) {
    problems.push(name);
    return PublicKey.default;
  }
  try {
    return new PublicKey(raw);
  } catch {
    problems.push(`${name} (not a valid address)`);
    return PublicKey.default;
  }
}

/**
 * Anything but the two clusters this app talks to is reported, not silently read as devnet: an old
 * `.env.local` written by a seed script that once printed `localnet` would otherwise point the app at
 * a chain it was never set up for and show an empty one.
 */
function cluster(value: string | undefined): Cluster {
  if (!value || value === "devnet") return "devnet";
  if (value === "mainnet-beta") return value;
  problems.push(`NEXT_PUBLIC_CLUSTER (${value} is not a cluster this app runs on: use devnet or mainnet-beta)`);
  return "devnet";
}

const CLUSTER = cluster(process.env.NEXT_PUBLIC_CLUSTER);

/**
 * Each `process.env.NEXT_PUBLIC_*` is spelled out, because that literal is what Next replaces at
 * build time. `window` is absent during a server render, which gets a placeholder origin
 * (`rpc-endpoint.ts`); the browser's copy of this module builds the url on the page's own.
 */
const RPC = browserRpc(
  {
    rpc: process.env.NEXT_PUBLIC_RPC_URL,
    photon: process.env.NEXT_PUBLIC_PHOTON_URL,
    prover: process.env.NEXT_PUBLIC_PROVER_URL,
  },
  CLUSTER,
  typeof window === "undefined" ? null : window.location.origin
);

/** `/api/rpc/<cluster>`: what `lib/clients.ts` has the SDK's `Rpc` report as its endpoint. */
export const RPC_PROXY_PATH = RPC.proxyPath;

export const config = {
  rpcUrl: RPC.rpcUrl,
  /**
   * True when the browser's RPC is this origin's proxy, false when the deployment published a url.
   * Anything that shows the RPC to a reader asks this rather than parsing `rpcUrl`, whose origin
   * differs between the server render and the browser.
   */
  rpcProxied: RPC.proxied,
  /**
   * Photon and the prover. A hosted ZK-compression RPC (Helius) serves all three roles at one
   * url, which is why these default to `rpcUrl` — but a deployment may split them across
   * services, so they stay overridable. Set to the empty string they follow `rpcUrl` again, which is
   * how `scripts/dev-devnet.sh` overrides a stray `.env.local`. Through the proxy, Photon is its own
   * path and there is no prover route (`rpc-endpoint.ts` says why).
   */
  indexerUrl: RPC.indexerUrl,
  proverUrl: RPC.proverUrl,
  /** Ids are baked into the SDK's IDLs; the env vars exist only to point at a fork. */
  lathProgramId: key("NEXT_PUBLIC_LATH_PROGRAM_ID", process.env.NEXT_PUBLIC_LATH_PROGRAM_ID, LATH_IDL.address),
  billingProgramId: key(
    "NEXT_PUBLIC_BILLING_PROGRAM_ID",
    process.env.NEXT_PUBLIC_BILLING_PROGRAM_ID,
    LATH_BILLING_IDL.address
  ),
  /** Treasuries are namespaced by their admin, so this is what picks *which* treasury. */
  treasuryAdmin: key("NEXT_PUBLIC_TREASURY_ADMIN", process.env.NEXT_PUBLIC_TREASURY_ADMIN),
  usdcMint: key("NEXT_PUBLIC_USDC_MINT", process.env.NEXT_PUBLIC_USDC_MINT),
  cluster: CLUSTER,
  /**
   * Optional. The blob gateway behind the on-chain `sha256 → locator` map
   * (`sdk/src/locator.ts`). With it set, the app can expand an event to the
   * verbose material the chain only commits to; without it, the app is chain-only and says so.
   *
   * It is deliberately not a service of ours: the chain says which bytes, the gateway serves
   * them, and the SDK re-hashes the answer — so a wrong or hostile gateway shows as "bytes do
   * not match the hash", never as a wrong trace.
   */
  traceGateway: process.env.NEXT_PUBLIC_TRACE_GATEWAY ?? "",
  /** How the raw gateway spells a locator in its path. */
  traceEncoding: (process.env.NEXT_PUBLIC_TRACE_ENCODING ?? "hex") as "hex" | "base64url",
  /**
   * Which scheme the raw gateway above serves. It is `LocatorScheme.Raw` in every deployment
   * that has one; the setting stays because a development gateway can spell ids its own way.
   */
  traceScheme: Number(process.env.NEXT_PUBLIC_TRACE_SCHEME ?? "0"),
  /**
   * Where scheme-4 locators are read. Unlike the raw gateway this is never unset: a chain that
   * carries Irys locators has to resolve on a deployment with no environment at all, which is
   * the whole point of the chain carrying a scheme tag rather than a url (SPEC §14.1). The
   * variable exists for a mirror or a proxy, not for turning the reader off.
   */
  irysGateway: process.env.NEXT_PUBLIC_IRYS_GATEWAY || IRYS_GATEWAY,
  /** The registry structure's name, if the operator did not use the SDK default. */
  traceRegistry: process.env.NEXT_PUBLIC_TRACE_REGISTRY ?? "",
} as const;

/** Environment variables the app needs and does not have. Empty means it is configured. */
export const configProblems: readonly string[] = problems;

/** Solana Explorer link for a signature or an account, on whichever cluster this is. */
export function explorerUrl(kind: "tx" | "address", value: string): string {
  const suffix = config.cluster === "mainnet-beta" ? "" : `?cluster=${config.cluster}`;
  return `https://explorer.solana.com/${kind}/${value}${suffix}`;
}
