"use client";

import Link from "next/link";
import { ReactNode } from "react";
import { ExplorerLink } from "@/components/ui";
import { SolanaMark, TempoLink, TempoMark } from "@/components/Tempo";
import { useBilling } from "@/lib/clients";
import { config } from "@/lib/config";
import { useTreasury } from "@/lib/queries";
import { TEMPO_ESCROW_ADDRESS, useTempoTreasury } from "@/lib/tempo";

/**
 * `Solana · devnet` in the nav: which chain and cluster this deployment runs on, the cluster half of
 * the account chip, right of the vault pill, and the way to the Solana tab (`/?tab=solana`). The nav
 * has no _Solana_ and _Tempo_ tabs of its own: the two pills already name the two chains, so they are
 * the links, lit while their tab is open. The tab lists the programs and the vault, and every address
 * is `DeploymentFacts`, in the vault popover's _This deployment_.
 *
 * Nothing here is the wallet's, so unlike the vault pill it shows with no wallet connected.
 */
export function DeploymentPill({ active = false }: { active?: boolean }) {
  return (
    <Link
      href="/?tab=solana"
      data-testid="nav-solana"
      aria-current={active ? "page" : undefined}
      title="Where Lath records agents and holds their budgets, on Solana"
      className={`flex h-full items-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors ${
        active ? "bg-line/[0.06] text-ink-1" : "text-ink-2 hover:bg-line/[0.04] hover:text-ink-1"
      }`}
    >
      {/* `Solana · devnet`, as the Tempo pill reads `Tempo · mainnet`: the cluster alone did not say
          which chain it was a cluster of. Under `sm` the mark alone, as the Tempo pill does. */}
      <span className="flex items-center gap-1.5">
        <SolanaMark />
        <span className="hidden sm:inline">Solana</span>
        <span className="hidden text-ink-3 md:inline">· {config.cluster}</span>
      </span>
    </Link>
  );
}

/**
 * Every address this deployment runs on, each in full and each a link to its own chain's explorer:
 * the two programs, the treasury admin and the vault PDA on Solana, then the Tempo treasury, the
 * USDC.e token it pays in and the payment-channel escrow on Tempo. Solana's are `ExplorerLink`s and
 * Tempo's `TempoLink`s, so the mark on a link says which chain it opens.
 *
 * The escrow is Tempo's own precompile, not a setting of this deployment, so it is listed even when
 * the treasury route has not answered; the token is the route's answer, so it is listed when the
 * route names it.
 */
export function DeploymentFacts({ className = "", testId }: { className?: string; testId?: string }) {
  const treasury = useTreasury();
  const billing = useBilling();
  const tempo = useTempoTreasury();
  const t = tempo.data;

  const solana = (value: string) => (
    <ExplorerLink kind="address" value={value}>
      <span className="break-all">{value}</span>
    </ExplorerLink>
  );
  const tempoMissing = tempo.isLoading
    ? "…"
    : t?.unreachable !== undefined
    ? "the treasury route did not answer"
    : "none configured: calls run scripted";

  return (
    <dl className={`space-y-3 ${className}`} data-testid={testId}>
      <AddressRow label="Lath program">{solana(config.lathProgramId.toBase58())}</AddressRow>
      <AddressRow label="Billing program">{solana(config.billingProgramId.toBase58())}</AddressRow>
      <AddressRow label="Treasury admin">{solana(config.treasuryAdmin.toBase58())}</AddressRow>
      <AddressRow
        label="Vault (USDC)"
        missing={treasury.isLoading ? "…" : treasury.isError ? "could not be read" : "no treasury at this admin"}
      >
        {treasury.data ? solana(billing.vaultAddress().toBase58()) : null}
      </AddressRow>
      <AddressRow
        label="Tempo treasury"
        tempo
        hint="pays every model call, OpenRouter via Tempo; shared by every user of this deployment"
        missing={tempoMissing}
        testId="deployment-tempo"
      >
        {t?.address ? <TempoLink kind="address" value={t.address} full /> : null}
      </AddressRow>
      <AddressRow
        label="USDC.e token"
        tempo
        hint="what the treasury pays in, with 6 decimals"
        missing={tempo.isLoading ? "…" : tempoMissing}
      >
        {t?.token ? <TempoLink kind="token" value={t.token} full /> : null}
      </AddressRow>
      <AddressRow
        label="Payment-channel escrow"
        tempo
        hint="holds each channel's deposit; closing a channel pays OpenRouter and refunds the rest"
      >
        <TempoLink kind="address" value={TEMPO_ESCROW_ADDRESS} full />
      </AddressRow>
    </dl>
  );
}

/** One address in full; or the reason there is none. */
function AddressRow({
  label,
  tempo = false,
  hint,
  missing,
  testId,
  children,
}: {
  label: string;
  /** A Tempo row: its label carries the mark, so the list reads as two chains at a glance. */
  tempo?: boolean;
  hint?: string;
  missing?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <dt className="flex items-center gap-1 text-2xs text-ink-3">
        {tempo && <TempoMark />}
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0">
        {children ? children : <span className="text-xs text-ink-3">{missing ?? "—"}</span>}
        {hint && children && <div className="mt-0.5 text-2xs text-ink-3">{hint}</div>}
      </dd>
    </div>
  );
}
