"use client";

/**
 * The vault pill and its popover: the one place a wallet's money is read from every page.
 *
 * It sits in its own file, apart from `Nav.tsx`, and holds the wallet's USDC on Solana with the
 * deposit form and the 14-day spend, then what Lath's treasury paid on Tempo for the wallet's loops,
 * then a link to the full activity and, behind an `Info`, the deployment's addresses.
 *
 * Two ledgers, said apart on purpose. The top half is USDC on Solana — the wallet's own escrow,
 * which a session debits. The Tempo half is USDC.e that Lath's treasury paid to OpenRouter's gateway
 * on Tempo; it is never added to the Solana figures, because it is a different token on a different
 * chain, and the debit that covers it is already in _spent_ above.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { formatUsdc } from "@/lib/format";
import { spendable, useBalance, useChargeHistory } from "@/lib/queries";
import { useLoops } from "@/lib/loops";
import { formatBaseUnits } from "@/lib/tempo";
import { HISTORY_ROWS_KEPT, paidOnTempo } from "@/lib/tempo-paid";
import { Badge, Info } from "@/components/ui";
import { OpenRouterMark, TempoMark } from "@/components/Tempo";
import { DepositForm } from "@/components/DepositForm";
import { DeploymentFacts } from "@/components/DeploymentPill";
import { SpendChart } from "@/components/SpendChart";

/** The popover's chips: a smaller set than /billing's, for a row 320 px wide. */
const POPOVER_PRESETS = ["5.00", "25.00", "100.00"];

/** The connected wallet's spendable escrow, with the breakdown one click, tap or Enter away. */
export function VaultPill() {
  const { publicKey } = useWallet();
  const balance = useBalance(publicKey ?? null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: one rule for a mouse, a pen and a tap. A press inside any other
    // dialog is not outside this one — the `Info` popovers in the footer and on each Tempo address
    // are portalled to the body, so they are outside this element's tree while being part of it.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest?.('[role="dialog"]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An `Info` open inside the popover takes this Escape for itself; the popover the next one.
      if (ref.current?.querySelector('[role="dialog"] [aria-expanded="true"]')) return;
      close(!!ref.current?.contains(document.activeElement));
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!publicKey) return null;
  const data = balance.data;
  const full = balance.isLoading || balance.isError ? null : formatUsdc(spendable(data));

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? "vault-popover" : undefined}
        data-testid="vault-pill"
        title={full ? `${full} USDC spendable` : undefined}
        className="flex h-full items-center gap-2 rounded-l-lg border-r border-line/[0.1] px-3 transition-colors hover:bg-line/[0.04]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        {/* _Balance_ and two decimals: a bare 4.973706 reads as a code, not as money. The exact figure is
            the pill's hover and the popover's headline. */}
        {/* _Lath balance_ from `sm`: the vault's figure, not the wallet's own,
            which the wallet button beside it can show. A phone keeps _Balance_ so the nav stays one row. */}
        <span className="text-2xs font-medium text-ink-3">
          <span className="hidden sm:inline">Lath </span>
          <span className="sm:hidden">Balance</span>
          <span className="hidden sm:inline">balance</span>
        </span>
        <span className="num text-xs font-semibold text-ink-1" data-testid="vault-pill-figure">
          {balance.isLoading ? "…" : balance.isError ? "—" : cents(full!)}
        </span>
        <span className="text-2xs font-medium text-ink-3">USDC</span>
      </button>
      {open && <VaultPopover onClose={() => close(false)} />}
    </div>
  );
}

/**
 * `4.973706` as `4.97`: cut, not rounded, so the pill never shows a cent the wallet does not have.
 * String work on `formatUsdc`'s exact digits, never a float.
 */
function cents(exact: string): string {
  const dot = exact.indexOf(".");
  return dot < 0 ? `${exact}.00` : exact.slice(0, dot + 3).padEnd(dot + 3, "0");
}

/**
 * The popover's body, mounted only while it is open: the spend history and the loop registry are
 * read for it, and a pill drawn on every page should not make either read until someone looks.
 */
function VaultPopover({ onClose }: { onClose: () => void }) {
  const { publicKey } = useWallet();
  const balance = useBalance(publicKey ?? null);
  const history = useChargeHistory(publicKey ?? null);
  const data = balance.data;
  // A read that rejected is not a balance of zero: the figures say so rather than 0.000000.
  const unread = balance.isError;
  const figure = (v: bigint) => (unread ? "—" : formatUsdc(v));

  return (
    <div
      id="vault-popover"
      role="dialog"
      aria-label="Your USDC"
      data-testid="vault-popover"
      className="absolute right-0 top-full z-50 mt-2 max-h-[calc(100dvh-5rem)] w-80 max-w-[calc(100vw-2rem)] animate-rise overflow-y-auto rounded-xl border border-line/[0.1] bg-surface-2 p-4 shadow-float"
    >
      <section aria-labelledby="vault-solana" data-testid="vault-solana">
        <div className="flex items-center justify-between gap-2">
          <h2 id="vault-solana" className="text-xs font-semibold text-ink-1">
            Your USDC on Solana
          </h2>
          <Badge tone={unread ? "warn" : data ? "good" : "neutral"} dot={!!data}>
            {unread ? "could not be read" : data ? "on chain" : "no balance yet"}
          </Badge>
        </div>
        <div className="mt-2 flex items-baseline gap-1.5" data-testid="vault-spendable">
          <span className="num text-2xl font-semibold text-ink-1">{figure(spendable(data))}</span>
          <span className="text-xs text-ink-3">USDC spendable</span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-2xs">
          <Figure label="Deposited" value={figure(data?.deposited ?? 0n)} />
          <Figure label="Spent" value={figure(data?.spent ?? 0n)} />
          <Figure label="Reserved" value={figure(data?.reserved ?? 0n)} />
        </dl>
        {unread && (
          <p className="mt-1.5 text-2xs leading-relaxed text-ink-3">
            The RPC did not answer for your balance, so these are unknown rather than zero.
          </p>
        )}

        <div className="mt-3">
          <DepositForm presets={POPOVER_PRESETS} compact testId="vault-deposit" />
        </div>

        <div className="mt-3" data-testid="vault-spend">
          {history.isLoading ? (
            <div className="h-[5.25rem] animate-pulse rounded-lg bg-line/[0.04]" aria-label="Reading spend" />
          ) : history.isError ? (
            <p className="text-2xs leading-relaxed text-ink-3">
              The charge history could not be read, so the 14-day spend is unknown. The figures above are read from the
              account itself.
            </p>
          ) : (
            <SpendChart activity={history.data ?? []} compact />
          )}
        </div>
      </section>

      <PaidOnTempoSection owner={publicKey?.toBase58() ?? null} onNavigate={onClose} />

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/[0.08] pt-3">
        {/* The full page, kept as the deep link: the activity table, the larger chart and, for the
            treasury admin, the operator's float are on /billing and nowhere else. */}
        <Link
          href="/billing"
          data-testid="manage-billing"
          onClick={onClose}
          className="text-xs font-medium text-accent transition-colors hover:text-accent-strong"
        >
          All activity →
        </Link>
        <Info
          label="This deployment"
          wide
          testId="vault-deployment"
          triggerTestId="vault-deployment-trigger"
          trigger={
            <span className="text-2xs text-ink-3 underline decoration-dotted underline-offset-2">This deployment</span>
          }
        >
          <div className="text-sm font-medium text-ink-1">This deployment</div>
          <p className="text-2xs text-ink-3">
            The programs and treasuries every read and write on this site goes through. Each opens in its explorer.
          </p>
          <DeploymentFacts />
        </Info>
      </div>
    </div>
  );
}

/**
 * _Paid for you on Tempo_: the USDC.e Lath's treasury paid OpenRouter for this wallet's loops,
 * summed from the console's loop rows. Labelled as the last 50 steps per loop when a row is at the
 * console's cap, since older steps are then not in the sum.
 */
function PaidOnTempoSection({ owner, onNavigate }: { owner: string | null; onNavigate: () => void }) {
  const loops = useLoops(owner);
  const paid = loops.data ? paidOnTempo(loops.data.loops) : null;

  return (
    <section aria-labelledby="vault-tempo" data-testid="vault-tempo" className="mt-3 border-t border-line/[0.08] pt-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="vault-tempo" className="flex items-center gap-1.5 text-xs font-semibold text-ink-1">
          <TempoMark />
          Paid for you on Tempo
        </h2>
        <Info label="How Tempo payments reach you" testId="vault-tempo-info">
          <p>
            Each model call your loops make is paid on Tempo, call by call, from Lath&apos;s treasury to OpenRouter, in
            a payment channel Tempo settles on chain. Reports your loops store on Tempo are paid the same way.
          </p>
          <p>
            You are debited for both in USDC on Solana, from the balance above, up to the cap you set. The decision
            model and the RPC are Lath&apos;s and are not counted here.
          </p>
        </Info>
      </div>
      {loops.isLoading ? (
        <div className="mt-2 text-2xs text-ink-3">reading your loops…</div>
      ) : loops.isError || !paid ? (
        <div className="mt-2 text-2xs text-ink-3" data-testid="vault-tempo-unread">
          Your loops could not be read from this console, so what was paid on Tempo is unknown.
        </div>
      ) : (
        <>
          <Link
            href="/?tab=tempo"
            onClick={onNavigate}
            data-testid="vault-tempo-paid"
            className="group mt-2 flex items-baseline gap-1.5"
          >
            <span className="num text-lg font-semibold text-ink-1 group-hover:text-accent-strong">
              {formatBaseUnits(paid.total)}
            </span>
            <span className="text-xs text-ink-3">USDC.e</span>
            <span className="ml-auto text-2xs text-accent group-hover:text-accent-strong">Tempo tab →</span>
          </Link>
          <p className="mt-1 text-2xs leading-relaxed text-ink-3" data-testid="vault-tempo-line">
            {paid.total > 0n ? (
              <>
                Paid by Lath&apos;s treasury to <OpenRouterMark /> OpenRouter via Tempo for {paid.paidLoops}{" "}
                {paid.paidLoops === 1 ? "loop" : "loops"}
                {paid.storage > 0n ? ` (${formatBaseUnits(paid.storage)} of it report storage)` : ""}, and debited to
                you in USDC on Solana
              </>
            ) : (
              <>
                None of your loops has paid on Tempo yet. When one does, Lath&apos;s treasury pays OpenRouter via Tempo
                and you are debited in USDC on Solana
              </>
            )}
            {paid.capped ? <> · the last {HISTORY_ROWS_KEPT} steps per loop</> : null}.
          </p>
        </>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="num text-xs text-ink-2">{value}</dd>
    </div>
  );
}
