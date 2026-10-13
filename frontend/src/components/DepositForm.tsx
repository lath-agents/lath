"use client";

/**
 * The one deposit into the escrow vault, shared by the vault popover and /billing, so that the
 * popover's form and the page's are the same transaction — one wallet
 * prompt, the same `deposit` instruction over the same accounts, preceded by the token account's
 * creation only when the wallet has none — and not two copies that could drift apart.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TransactionInstruction } from "@solana/web3.js";
import { Button, ErrorNote, ExplorerLink, Note } from "@/components/ui";
import { useBilling } from "@/lib/clients";
import { config } from "@/lib/config";
import { formatUsdc, parseUsdc } from "@/lib/format";
import { keys, useBalance, useWalletUsdc } from "@/lib/queries";
import { explainError, useSendTransaction } from "@/lib/writes";

/** The amount typed, what it parses to, what the wallet holds, and the send. */
export function useDeposit() {
  const { publicKey } = useWallet();
  const billing = useBilling();
  const send = useSendTransaction();
  const queryClient = useQueryClient();
  const balance = useBalance(publicKey ?? null);
  const wallet = useWalletUsdc(publicKey ?? null);

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const micro = parseUsdc(amount);
  // The vault is deposit-only (the program has no `withdraw`), so the one ceiling is what the
  // wallet's token account holds.
  // `amount` is null for a wallet with no token account, which does hold 0; `data` undefined is a
  // read still loading or failed, which establishes nothing, so the 0n fallback is never compared
  // against: a wallet holding funds would read "more than the 0.000000 USDC in your wallet" while it loaded.
  const ceilingRead = wallet.data !== undefined;
  const available = wallet.data?.amount ?? 0n;
  const overCap = ceilingRead && micro !== null && micro > available;
  // Whether the ceiling failed to read, so the note below can say it has none to quote.
  const ceilingUnread = !ceilingRead && wallet.isError;
  const firstDeposit = balance.data === null && !balance.isLoading;

  async function submit() {
    if (!publicKey || micro === null || micro === 0n) return;
    setBusy(true);
    setError(null);
    setSignature(null);
    try {
      const ata = getAssociatedTokenAddressSync(config.usdcMint, publicKey);
      const instructions: TransactionInstruction[] = [];
      if (wallet.data?.amount === null || wallet.data === undefined) {
        const info = await billing.connection.getAccountInfo(ata);
        if (!info) {
          instructions.push(createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, config.usdcMint));
        }
      }
      instructions.push(await billing.depositIx({ amount: micro, usdcMint: config.usdcMint, userToken: ata }));

      const sig = await send(instructions);
      setSignature(sig);
      setAmount("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.balance(publicKey.toBase58()) }),
        queryClient.invalidateQueries({ queryKey: keys.walletUsdc(publicKey.toBase58()) }),
        queryClient.invalidateQueries({ queryKey: keys.history(publicKey.toBase58()) }),
        queryClient.invalidateQueries({ queryKey: keys.treasury() }),
      ]);
    } catch (e) {
      setError(explainError(e, "billing"));
    } finally {
      setBusy(false);
    }
  }

  return {
    amount,
    setAmount,
    micro,
    available,
    overCap,
    ceilingUnread,
    firstDeposit,
    wallet,
    busy,
    error,
    signature,
    submit,
    // Held until the ceiling is read: a deposit is checked against it before the wallet is asked.
    canSubmit: !busy && micro !== null && micro !== 0n && ceilingRead && !overCap,
  };
}

/**
 * The form: an amount, Max, the preset chips and Deposit, with the notes a deposit can need — the
 * first deposit's rent, a refusal over what the wallet holds, the error, the confirmed signature.
 * `compact` is the popover's size; the page's is the full one with the in-wallet line beside the chips.
 */
export function DepositForm({
  presets,
  compact = false,
  testId,
}: {
  presets: string[];
  compact?: boolean;
  testId?: string;
}) {
  const d = useDeposit();

  return (
    <div className={compact ? "space-y-2" : "space-y-4"} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <div className={`relative flex-1 ${compact ? "min-w-0" : "sm:max-w-xs"}`}>
          <input
            value={d.amount}
            onChange={(e) => d.setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.000000"
            aria-label="Amount to deposit"
            className={`input-mono pr-14 ${compact ? "h-8 text-sm" : "h-10 text-base"}`}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-2xs font-semibold text-ink-3">
            USDC
          </span>
        </div>
        {!compact && (
          <Button variant="ghost" size="lg" onClick={() => d.setAmount(formatUsdc(d.available))}>
            Max
          </Button>
        )}
        <Button
          size={compact ? "sm" : "lg"}
          onClick={d.submit}
          loading={d.busy}
          disabled={!d.canSubmit}
          variant="primary"
        >
          {d.busy ? (compact ? "Confirming…" : "Confirming on Solana…") : "Deposit"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => d.setAmount(preset)}
            aria-pressed={d.amount === preset}
            className="chip"
          >
            {compact ? preset.replace(/\.00$/, "") : preset}
          </button>
        ))}
        {/* In the popover Max is a chip beside the presets, since a row of 320 px has no room for a
            third button; it sets the same figure the page's button does. */}
        {compact && (
          <button type="button" onClick={() => d.setAmount(formatUsdc(d.available))} className="chip">
            Max
          </button>
        )}
        <span className="ml-auto text-xs text-ink-3">
          {d.wallet.data?.amount === null ? (
            <>
              {compact ? "No token account yet. " : "No token account for this mint yet; depositing creates one. "}
              {config.cluster === "devnet" && (
                <a
                  className="text-accent underline underline-offset-[3px] hover:text-accent-strong"
                  href="https://faucet.circle.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Devnet USDC faucet ↗
                </a>
              )}
            </>
          ) : (
            <>
              {compact ? "wallet" : "In wallet"}{" "}
              <span className="num text-ink-1">{formatUsdc(d.wallet.data?.amount ?? 0n)}</span>
              {compact ? "" : " USDC"}
            </>
          )}
        </span>
      </div>

      {d.firstDeposit && (
        <Note tone="warn">
          The first deposit also pays about 0.0016 SOL of rent to create your{" "}
          <code className="text-amber-100">UserBalance</code> account.
        </Note>
      )}
      {/* Only a ceiling that was actually read can be quoted. `available` falls back to 0n on a
          read that failed or is still loading, which turned an unreadable balance (or an unreadable wallet token account)
          into "that is more than the 0.000000 USDC available" for a wallet that is holding funds. */}
      {d.micro !== null && d.overCap && (
        <ErrorNote>That is more than the {formatUsdc(d.available)} USDC in your wallet.</ErrorNote>
      )}
      {d.micro !== null && d.ceilingUnread && (
        <ErrorNote>
          How much your wallet holds could not be read from the RPC, so this is held rather than refused.
        </ErrorNote>
      )}
      {d.error && <ErrorNote>{d.error}</ErrorNote>}
      {d.signature && (
        <Note tone="good">
          Confirmed · <ExplorerLink kind="tx" value={d.signature} />
        </Note>
      )}
    </div>
  );
}
