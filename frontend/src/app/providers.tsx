"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
// Imported from the individual packages rather than the `-wallets` aggregate: that one pulls
// in WalletConnect, viem and a chain registry for wallets this app does not offer.
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useMemo, useState } from "react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { CONNECTION_CONFIG } from "@/lib/clients";
import { config } from "@/lib/config";
import { e2eWallet } from "@/lib/e2e-wallet";
import { isRpcQuotaError } from "@/lib/read-error";
import { BalanceWatcher } from "@/lib/live";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * There is no session. A wallet connection is the whole of "signing in": reads are public chain
 * data and every write is a transaction the wallet signs, so there is nothing for a server to
 * authenticate. The server's part in a read is only to hold the RPC key.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Photon scans are not free and chain state is not chatty; refetch on demand.
            // What makes a page move on its own is not a shorter stale time here — it is the
            // header watch in `lib/live.ts`, which polls one compressed account and invalidates
            // these queries only when `seq` actually moved.
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // One retry, except for an RPC whose plan has run out: it will refuse the retry too,
            // and the page should say why now rather than after it (`lib/read-error.ts`).
            retry: (failures, error) => failures < 1 && !isRpcQuotaError(error),
          },
        },
      })
  );

  // Wallets that implement the Wallet Standard (Phantom, Backpack, Solflare's extension…) are
  // discovered by the adapter on their own. These two are listed for the mobile deep links and
  // for browsers where nothing is installed.
  // `e2eWallet()` is `null` unless all three of its conditions hold — see the module note. It
  // is listed first so `autoConnect` picks it up in a test run and nothing else changes.
  const wallets = useMemo(() => {
    const test = e2eWallet();
    return [...(test ? [test] : []), new PhantomWalletAdapter(), new SolflareWalletAdapter()];
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* This origin's `/api/rpc/<cluster>` unless the deployment published a url: the keyed one the
          server writes with never reaches the page (`lib/config.ts`). */}
      <ConnectionProvider endpoint={config.rpcUrl} config={CONNECTION_CONFIG}>
        <WalletProvider wallets={wallets} autoConnect onError={quietWalletError}>
          <WalletModalProvider>
            {/* Renders nothing: it holds the `UserBalance` account subscription for the app. */}
            <BalanceWatcher />
            {children}
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

/**
 * The adapter's default `onError` is `console.error(error, adapter)`, and in development Next
 * raises every `console.error` as a red *Issue* over the page. What reaches it is almost always
 * the wallet saying no — an autoconnect to an extension that is locked or not installed, a prompt
 * the user closed — which the page already handles by staying disconnected. So it is logged as
 * what it is, a warning, the way `lib/clients.ts` quiets web3.js's 429 retries for the same reason.
 */
function quietWalletError(error: WalletError) {
  console.warn(`wallet: ${error.name}${error.message ? ` — ${error.message}` : ""}`);
}
