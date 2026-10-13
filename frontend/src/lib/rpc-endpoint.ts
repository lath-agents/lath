/**
 * Which RPC urls the browser is given, as a pure function of the public environment.
 *
 * Kept apart from `config.ts` and free of imports — no SDK, no web3.js, no DOM — so the root
 * tsconfig can load it and `tests/console-rpc-proxy.ts` can pin the one property that matters here:
 * with no `NEXT_PUBLIC_RPC_URL`, nothing the browser is handed is the server's keyed url.
 * `config.ts` is its only caller.
 */

export type BrowserRpcEnv = {
  /** `NEXT_PUBLIC_RPC_URL`: a url the deployment chose to publish — origin-restricted, or a local validator. */
  rpc?: string;
  /** `NEXT_PUBLIC_PHOTON_URL` / `NEXT_PUBLIC_PROVER_URL`: the split-stack overrides. */
  photon?: string;
  prover?: string;
};

export type BrowserRpc = {
  rpcUrl: string;
  indexerUrl: string;
  proverUrl: string;
  /** True when `rpcUrl` is this origin's proxy rather than a url the deployment published. */
  proxied: boolean;
  /** The proxy's path, `/api/rpc/<cluster>`, whether or not it is the one in use. */
  proxyPath: string;
};

/**
 * The origin a server render builds the proxy url on. `ConnectionProvider` constructs a `Connection`
 * as the tree renders, including on the server, and web3.js refuses anything but an absolute
 * http(s) url — `new Connection("/api/rpc/devnet")` throws, which during `next build` would fail the
 * prerender of every page. Nothing is fetched during a render (queries run in the browser), so this
 * origin is only ever parsed; the browser's copy of the module builds its url from the page's origin.
 */
export const SERVER_RENDER_ORIGIN = "http://server-render.invalid";

/**
 * Empty means unset. `scripts/dev-devnet.sh` beats a stray `.env.local` by exporting the RPC, Photon
 * and prover urls as empty strings — Next only fills in variables the environment does not already
 * have — so an empty value has to fall through to the next one.
 */
function set(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * `origin` is the page's (`window.location.origin`), or `null` during a server render.
 *
 * The proxy's path names the cluster because two readers of the endpoint's *text* decide things from
 * it: the wallet adapter signs for `solana:devnet` only when `devnet` is in the url
 * (`getChainForEndpoint`, which reads a bare `localhost` as localnet), and stateless.js treats any
 * url containing `localhost` as a local validator — `lib/clients.ts` covers that one.
 *
 * Photon has its own path, and the prover shares it: stateless.js's `Rpc` never calls the prover (the
 * indexer's `getValidityProof` carries the proof), so the proxy has no prover route, and a call that
 * ever did reach `<photon>/prove` would be a 404 rather than a door onto the endpoint's most
 * expensive work.
 */
export function browserRpc(env: BrowserRpcEnv, cluster: string, origin: string | null): BrowserRpc {
  const published = set(env.rpc);
  const proxyPath = `/api/rpc/${cluster}`;
  const base = `${origin ?? SERVER_RENDER_ORIGIN}${proxyPath}`;
  return {
    rpcUrl: published || base,
    indexerUrl: set(env.photon) || published || `${base}/photon`,
    proverUrl: set(env.prover) || published || `${base}/photon`,
    proxied: published === "",
    proxyPath,
  };
}
