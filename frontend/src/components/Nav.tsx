"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ReactNode, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DeploymentPill } from "@/components/DeploymentPill";
import { LathMark } from "@/components/LathMark";
import { TempoMark } from "@/components/Tempo";
import { VaultPill } from "@/components/VaultPill";
import { useTempoTreasury } from "@/lib/tempo";
import { WorkspaceTab, parseWorkspaceParams, workspaceHref } from "@/lib/workspace";

const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), {
  ssr: false,
  loading: () => <div className="h-9 w-32 rounded-lg bg-line/[0.05]" aria-hidden />,
});

/**
 * The workspace's views, which are the whole app: the
 * wallet's agents with their runs under them, what Lath records on Solana, and what Lath Tempo pays on
 * Tempo. Each is `/?tab=…`, so a view is a link that can be shared and the Back button leaves it like
 * any page. `/agents` and `/loops` are redirects into it.
 *
 * The nav has no tabs: Agents is the default view, `/`, behind the
 * Lath mark (`nav-home`), and the _Solana · devnet_ and _Tempo · mainnet_ pills are the links to the
 * other two (`nav-solana`, `nav-tempo`), lit while their view is open. The deep pages (an agent's or a
 * run's page, its sandbox proof, an authority's agents) belong to Agents; `/billing` and `/create`
 * light nothing.
 */
function activeTab(path: string, query: URLSearchParams | null): WorkspaceTab | null {
  if (path === "/") return parseWorkspaceParams(query).tab;
  if (["/agent", "/loop", "/zeroclaw", "/authority"].some((p) => path.startsWith(p))) return "yours";
  return null;
}

/**
 * The open view, for the pills to light by. `useSearchParams` needs a Suspense boundary on a page that
 * is rendered statically, and the nav is on every page; each pill's fallback is itself unlit.
 */
function WithActiveTab({ children }: { children: (tab: WorkspaceTab | null) => ReactNode }) {
  const query = useSearchParams();
  const path = usePathname() ?? "/";
  return <>{children(activeTab(path, query ? new URLSearchParams(query.toString()) : null))}</>;
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/[0.08] bg-canvas/80 backdrop-blur-md">
      {/* Under `sm` the tabs take a second row: the logo, the Tempo pill, the vault and the wallet button
          fill a 390 px phone on their own, and one row would make the page scroll sideways. */}
      <div className="mx-auto flex min-h-14 max-w-[83rem] flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:h-14 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-0">
        {/* A 44 px mark and a 30 px wordmark: the mark is the way to Agents, since the nav has no tabs, and
            still fits the 56 px bar. */}
        <Link href="/" className="flex items-center gap-3" aria-label="Lath home" data-testid="nav-home">
          <LathMark size={44} />
          <span className="hidden font-mono text-[30px] font-medium tracking-tight text-ink-1 min-[420px]:inline">
            Lath
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {/* One account chip: the wallet's balance, with the cluster as its suffix, joined so they read
              as one thing; the cluster half stands alone when no wallet is connected. The vault half
              opens its breakdown, the cluster half the Solana view. Both live in their own files
              (`VaultPill.tsx`, `DeploymentPill.tsx`); the nav only places them. */}
          <div className="flex h-9 items-stretch rounded-lg border border-line/[0.1] bg-surface-2">
            <VaultPill />
            {/* On every width since it is the way to the Solana view; under `sm` it is the mark alone. */}
            <Suspense fallback={<DeploymentPill />}>
              <WithActiveTab>{(tab) => <DeploymentPill active={tab === "solana"} />}</WithActiveTab>
            </Suspense>
          </div>
          {/* Right of _Solana · devnet_: the two chains read left to
              right in the order a paid call crosses them, the cap on Solana, then the payment on Tempo. */}
          <Suspense fallback={<TempoPill />}>
            <WithActiveTab>{(tab) => <TempoPill active={tab === "tempo"} />}</WithActiveTab>
          </Suspense>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}

/**
 * Tempo's presence in the shell: `[T] Tempo · mainnet`, with a live dot while the treasury holds
 * a payment channel open, and the way to the Tempo view (`/?tab=tempo`), since the nav has no tabs.
 * It has no hover popover of the treasury's balance, address and token: the view says all of it. Public — the treasury route reads Tempo's chain and holds no
 * key — so it is shown with or without a wallet.
 *
 * The dot is this console's count of the channels it holds open (`openChannels`), which is a model
 * call being paid now or a run between steps with its channel still open; nothing is drawn when the
 * route did not answer, rather than a dot that would claim a channel nobody read.
 */
function TempoPill({ active = false }: { active?: boolean }) {
  const treasury = useTempoTreasury();
  const open = treasury.data?.openChannels ?? 0;
  const live = open > 0;
  return (
    <Link
      href={workspaceHref({ tab: "tempo" })}
      data-testid="nav-tempo"
      data-live={live ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      title="What Lath Tempo pays, for everyone to check"
      aria-label={live ? `Tempo mainnet, ${open} payment channel${open === 1 ? "" : "s"} open` : "Tempo mainnet"}
      className={`flex h-9 items-center gap-1.5 rounded-lg border border-line/[0.1] px-2.5 text-xs font-medium transition-colors sm:px-3 ${
        active ? "bg-line/[0.06] text-ink-1" : "bg-surface-2 text-ink-2 hover:bg-line/[0.04] hover:text-ink-1"
      }`}
    >
      <span className="text-accent">
        <TempoMark />
      </span>
      <span className="hidden sm:inline">Tempo</span>
      <span className="hidden text-ink-3 md:inline">· mainnet</span>
      {live && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent)/0.8)] motion-safe:animate-pulse"
          aria-hidden
          data-testid="tempo-pill-live"
        />
      )}
    </Link>
  );
}
