"use client";

import { ReactNode, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { LathMark } from "@/components/LathMark";

const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), {
  ssr: false,
  loading: () => <div className="h-10 w-36 rounded-lg bg-line/[0.05]" aria-hidden />,
});

/**
 * How long a page waits for `autoConnect` before it asks for a wallet. A returning visitor's wallet
 * reconnects on its own a moment after hydration; without the wait they would see the prompt flash
 * over a page that was about to open.
 */
const SETTLE_MS = 900;

/**
 * Whether this build says the console is a closed beta. Spelled out as the literal so Next inlines
 * it when the pages build; it only adds a line here. What admits a wallet is the server's list
 * (`LATH_BETA_WALLETS` / `LATH_BETA_FILE`, `app/api/_lib/beta.ts`), whose refusals carry the same
 * waitlist link, so a build without this flag still tells an uninvited wallet where to go.
 */
const CLOSED_BETA = process.env.NEXT_PUBLIC_LATH_CLOSED_BETA === "1";
const WAITLIST_URL = "https://getlath.xyz";

/**
 * Every page asks for a wallet before it shows anything: without one, a blurred
 * outline of the app sits behind a prompt in the middle of the screen, and the nav — with its own
 * *Select Wallet* — stays usable above it. The reads are still public chain data
 * (`app/providers.tsx`); the gate is about what the app shows, not who may read the chain.
 *
 * The page itself is not mounted until a wallet connects. Drawing it blurred underneath would run
 * every read the page makes — the landing page's scan of every agent included — for a visitor who
 * can see none of it, on an RPC key whose quota is the thing a demo runs out of. The outline below is
 * static and reads nothing; connecting mounts the real page in its place.
 */
export function WalletGate({ children }: { children: ReactNode }) {
  const { connected, connecting } = useWallet();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  if (connected) return <>{children}</>;
  const asking = settled && !connecting;
  return (
    <div className="relative">
      <GateBackdrop />
      {asking && (
        <div className="fixed inset-x-0 bottom-0 top-14 z-30 flex items-center justify-center px-4">
          <div
            role="dialog"
            aria-modal="false"
            aria-labelledby="wallet-gate-title"
            data-testid="wallet-gate"
            className="surface w-full max-w-md animate-rise space-y-4 p-6 text-center shadow-float"
          >
            <div className="flex justify-center">
              <LathMark size={32} />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-accent">
                Every action recorded on Solana, every model call paid on Tempo
              </p>
              <h2 id="wallet-gate-title" className="text-base font-semibold tracking-tight text-ink-1">
                Connect a wallet to continue
              </h2>
              <p className="text-sm leading-relaxed text-ink-2">
                Lath shows each wallet its agents, their loops and what they spent. Connect a Solana wallet to see yours
                and the public ones.
              </p>
            </div>
            <div className="flex justify-center">
              <WalletMultiButton />
            </div>
            {/* Most wallets open on mainnet, and this deployment reads devnet: a wallet on the wrong
                cluster connects fine and then shows nothing, so the switch is said before it is needed. */}
            <p className="text-2xs leading-relaxed text-ink-3" data-testid="wallet-gate-devnet">
              This deployment runs on Solana devnet. In Phantom: Settings → Developer Settings → Testnet Mode, then
              Solana Devnet.
            </p>
            {CLOSED_BETA && (
              <p className="text-2xs leading-relaxed text-ink-3" data-testid="wallet-gate-beta">
                Lath is in closed beta: anyone can read, and invited wallets can run agents.{" "}
                <a href={WAITLIST_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                  Join the waitlist
                </a>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The app's outline, blurred: a header, the Record / Pay / Verify strip, and a card with a spine
 * and a budget beside it — the shapes of the pages behind the gate, with no data in them.
 */
function GateBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none select-none space-y-6 blur-[5px]" data-testid="wallet-gated">
      <div className="space-y-3">
        <div className="skeleton h-7 w-[30rem] max-w-full" />
        <div className="skeleton h-4 w-[38rem] max-w-full opacity-70" />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="surface space-y-2 p-4">
            <div className="skeleton h-3 w-16 opacity-60" />
            <div className="skeleton h-4 w-full opacity-80" />
          </div>
        ))}
      </div>
      <div className="surface grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="relative space-y-5 pl-7">
          <span className="absolute bottom-2 left-[9px] top-2 w-px bg-spine-blue/50" />
          {["border-spine-green", "border-spine-green", "border-spine-green", "border-spine-volt"].map((ring, i) => (
            <div key={i} className="relative space-y-1.5">
              <span
                className={`absolute -left-[26px] top-0.5 h-3 w-3 rounded-full border-2 bg-canvas ${ring} ${
                  i === 3 ? "shadow-[0_0_12px_rgb(var(--spine-volt)/0.7)]" : ""
                }`}
              />
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-3 w-72 max-w-full opacity-60" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="well space-y-2 p-4">
            <div className="skeleton h-3 w-24 opacity-60" />
            <div className="skeleton h-6 w-40" />
            <div className="h-1.5 w-full rounded-full bg-line/[0.08]">
              <div className="h-full w-1/4 rounded-full bg-accent/70" />
            </div>
          </div>
          <div className="well h-16" />
        </div>
      </div>
    </div>
  );
}
