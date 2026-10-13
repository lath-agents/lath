"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, ConnectionConfig, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createRpc, Rpc } from "@lightprotocol/stateless.js";
import { BillingClient, LathClient, LathSigner, noteRpcQuotaSpent } from "@lath/sdk/browser";
import { useMemo } from "react";
import { config, RPC_PROXY_PATH } from "./config";
import { quotaBody } from "./read-error";

/**
 * One endpoint, three roles. `createRpc(rpc, indexer, prover)` is how the SDK reaches Photon
 * and the prover; Helius serves all three at the same url, and a cluster that does not is
 * simply unusable here. In the browser that endpoint is this origin's
 * `/api/rpc/<cluster>` unless the deployment published one (`lib/config.ts`), so the key the
 * server writes with is never in a page.
 *
 * Created once per process rather than per render: an `Rpc` holds a websocket, and React 18's
 * strict mode would otherwise open two.
 */
let rpcSingleton: Rpc | undefined;

/** Five attempts in all, 500 ms doubling — the same schedule web3.js uses, without its logging. */
const RATE_LIMIT_RETRIES = 4;

/**
 * `fetch` with the 429 retry done here, quietly.
 *
 * web3.js retries a rate-limited request on its own, but announces every attempt with
 * `console.error("Server responded with 429 …  Retrying after 500ms delay...")`. In development
 * Next intercepts `console.error` and raises it as an error overlay, so a paid devnet endpoint
 * throttling a page that is loading nine records and four epochs at once — routine on Helius, and
 * certain when two consoles share one key — put a red toast over a page that was in fact
 * recovering. Nothing was wrong; the log was. So the retry moves here, on the same schedule and
 * silent, and `disableRetryOnRateLimit` below keeps web3.js from doing it a second time. A 429
 * that survives these attempts is returned as the response it is: web3.js turns it into an error,
 * and react-query's `retry: 1` (`app/providers.tsx`) is the one retry left after that.
 */
async function fetchRetryingRateLimit(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let wait = 500;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
    // A spent plan answers 429 to every call until it resets, so backing off only holds a page on
    // its skeleton for the whole schedule before it says anything. Returned at once instead; the
    // body is read from a clone so web3.js still gets the response whole. Seeing it is also
    // remembered (`noteRpcQuotaSpent`): stateless.js's Photon reads get the same 429 without the
    // body, and for the next minute the SDK's read retry and the page's error text count those as
    // the spent plan too, instead of retrying them and calling the indexer silent.
    const body = await res
      .clone()
      .text()
      .catch(() => "");
    if (quotaBody(body)) {
      noteRpcQuotaSpent();
      return res;
    }
    await new Promise((r) => setTimeout(r, wait));
    wait *= 2;
  }
}

/** Shared by the SDK's `Rpc` and the wallet adapter's `ConnectionProvider`: one endpoint, one policy. */
export const CONNECTION_CONFIG: ConnectionConfig = {
  commitment: "confirmed",
  fetch: fetchRetryingRateLimit as ConnectionConfig["fetch"],
  disableRetryOnRateLimit: true,
};

export function getRpc(): Rpc {
  if (!rpcSingleton) {
    rpcSingleton = createRpc(config.rpcUrl, config.indexerUrl, config.proverUrl, CONNECTION_CONFIG);
    if (config.rpcProxied) reportProxyEndpoint(rpcSingleton);
  }
  return rpcSingleton;
}

/**
 * stateless.js decides it is talking to a local validator by finding `localhost` or `127.0.0.1` in
 * `rpcEndpoint`, and then answers `getStateTreeInfos` from the localnet trees baked into it rather
 * than from the chain. Through the same-origin proxy (`lib/config.ts`) that string is the page's own
 * origin — `http://localhost:3000` on every development machine and in the Playwright run — while the
 * cluster behind it is devnet, so every write would be built against trees devnet does not have. The
 * `Rpc` therefore reports the proxy's path, which names the cluster and no host. Only the report
 * changes: web3.js bound its requests to the real url when the `Connection` was built. A deployment
 * whose cluster really is a local validator publishes that url through `NEXT_PUBLIC_RPC_URL`, and
 * this does not run.
 */
function reportProxyEndpoint(rpc: Rpc): void {
  Object.defineProperty(rpc, "rpcEndpoint", { value: RPC_PROXY_PATH, configurable: true });
}

function useRpc(): Rpc {
  return getRpc();
}

/**
 * A signer for reads. Every `LathClient` wants one, but a read never signs anything, so a
 * page that is not connected still gets a working client — and any accidental write fails loudly
 * here rather than silently sending from the wrong key.
 */
export const READ_ONLY_SIGNER: LathSigner = {
  publicKey: PublicKey.default,
  async signTransaction<T extends Transaction | VersionedTransaction>(): Promise<T> {
    throw new Error("connect a wallet to sign");
  },
};

/**
 * The connected wallet as a `LathSigner`, or the read-only signer when there is none.
 *
 * `LathSigner` was defined as exactly `{ publicKey, signTransaction }` so that a
 * wallet-adapter wallet satisfies it with no adapter layer (`sdk/src/signer.ts`). This is that
 * claim, cashed in.
 */
export function useSigner(): { signer: LathSigner; connected: boolean } {
  const { publicKey, signTransaction } = useWallet();
  return useMemo(() => {
    if (!publicKey || !signTransaction) return { signer: READ_ONLY_SIGNER, connected: false };
    return {
      signer: { publicKey, signTransaction: (tx) => signTransaction(tx) },
      connected: true,
    };
  }, [publicKey, signTransaction]);
}

export function useLath(): LathClient {
  const rpc = useRpc();
  const { signer } = useSigner();
  return useMemo(() => LathClient.fromIdl(rpc, signer), [rpc, signer]);
}

export function useBilling(): BillingClient {
  const { connection } = useConnection();
  const { signer } = useSigner();
  return useMemo(
    () => BillingClient.fromIdl(connection, signer, { admin: config.treasuryAdmin }),
    [connection, signer]
  );
}

/** The plain `Connection` the wallet adapter provides, for SPL-token and confirmation calls. */
export function useSolana(): Connection {
  return useConnection().connection;
}
