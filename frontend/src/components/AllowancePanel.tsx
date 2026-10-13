"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Allowance } from "@lath/sdk/browser";
import { Button, ErrorNote, ExplorerLink, FactRow, Field, Note } from "@/components/ui";
import { grantPolicyHash, readAllowance } from "@/lib/allowance-grant";
import { useBilling } from "@/lib/clients";
import { isNoExpiry, parseUsdc, relativeToNow } from "@/lib/format";
import { trimUsdc } from "@/lib/tiles";
import { keys, useAllowance } from "@/lib/queries";
import { explainError, useSendTransaction } from "@/lib/writes";

const DAY = 24 * 60 * 60;
const PRESETS = ["5.00", "25.00", "100.00"];
/** What the Duration field opens on. */
const DEFAULT_DAYS = 365;

/**
 * The agent page's _Budget_ row: what this wallet's grant to the agent's authority has spent of its
 * cap, a short meter and the expiry, on one line of the header rather than a section of its own. _Change_ (or
 * _Approve_, with no grant) opens the grant form under the figure; nothing of the form is on screen
 * until then. Only the owner gets the button: a session is the owner's alone, so another wallet's
 * grant to this authority meters nothing, and the row is read-only for it.
 */
export function AllowancePanel({
  agentAuthority,
  canChange,
}: {
  agentAuthority: PublicKey;
  /** The connected wallet deployed the agent, so a grant from it is one its sessions draw on. */
  canChange: boolean;
}) {
  const { publicKey } = useWallet();
  const billing = useBilling();
  const send = useSendTransaction();
  const queryClient = useQueryClient();

  const grant = useAllowance(publicKey ?? null, agentAuthority);

  const [cap, setCap] = useState("");
  // A year: long enough that a grant made here does not lapse under a running agent, short enough
  // that the field reads as a duration. The cap is still the bound that matters; typing 36500
  // gives the wizard's "no expiry" grant for anyone who wants it.
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [busy, setBusy] = useState<"approve" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  // The cap and duration fields, folded behind _Change_: the meter is what a reader came for, and a
  // form under it is an action they take. Folded with no grant too: the row says _none_ and _Approve_
  // opens the same form.
  const [editing, setEditing] = useState(false);

  // Every page is behind `WalletGate`, so this renders with a wallet; a *connect a wallet* card here
  // would be unreachable. The guard is only the type's.
  if (!publicKey) return null;

  // A read that failed is not an allowance of none. Collapsing the two would badge this card **none**,
  // state that sessions run *unbilled*, relabel the button *Approve allowance*, and — because
  // `policyVersionHash` would then be read off the same absent value — send `ZERO32`. `approve_agent`
  // writes `spent = 0` and the hash verbatim, so one press against an RPC blip would reset a live spend
  // meter and zero the field the genesis record has to match for the pair to audit. A read that
  // has not come back is the same hazard for longer: on devnet it can stay pending for seconds
  // of 429 backoff, time enough to press a preset and approve. Neither state offers anything to
  // press; only a read that answered "no account" is *none* (`lib/allowance-grant.ts`).
  const read = readAllowance(grant);
  if (read.kind === "unreadable" || read.kind === "reading") {
    return (
      <FactRow label="Budget" id="allowance" className="scroll-mt-20" testId="agent-budget">
        {read.kind === "unreadable" ? (
          <span className="text-ink-3">
            could not be read from the RPC; nothing can be granted or revoked until it can, because a grant from here
            overwrites whatever is on chain
          </span>
        ) : (
          <span className="text-ink-3">
            <span data-testid="allowance-reading">reading…</span> nothing can be granted or revoked until the read comes
            back
          </span>
        )}
      </FactRow>
    );
  }

  const current: Allowance | null = read.kind === "granted" ? read.allowance : null;
  const capMicro = parseUsdc(cap);
  const dayCount = Number(days);
  // Whole days only: rounding with `max(1, round(days))` would grant a typed 0.4 as one day with
  // nothing on screen saying so. A fraction disables the grant and says why instead.
  const validDays = Number.isInteger(dayCount) && dayCount > 0;
  const expiresAt = Math.floor(Date.now() / 1000) + (validDays ? dayCount : 1) * DAY;
  const expired = current ? Number(current.expiresAt) * 1000 < Date.now() : false;

  const spentPercent =
    current && current.cap > 0n ? Math.min(100, Math.round((Number(current.spent) / Number(current.cap)) * 100)) : 0;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: keys.allowance(publicKey!.toBase58(), agentAuthority.toBase58()),
      }),
      queryClient.invalidateQueries({ queryKey: keys.allowances(publicKey!.toBase58()) }),
      queryClient.invalidateQueries({ queryKey: keys.myOwners(publicKey!.toBase58()) }),
    ]);
  }

  async function approve() {
    if (capMicro === null || capMicro === 0n || !validDays) return;
    // The render above already hides this button unless the read answered; this is the same rule at
    // the point the instruction is built, so no later path can send zeros over a grant it never saw.
    const policyVersionHash = grantPolicyHash(read);
    if (!policyVersionHash) return;
    setBusy("approve");
    setError(null);
    setSignature(null);
    try {
      const ix = await billing.approveAgentIx({
        agentAuthority,
        cap: capMicro,
        expiresAt,
        policyVersionHash,
      });
      setSignature(await send([ix]));
      setCap("");
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(explainError(e, "billing"));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    setError(null);
    setSignature(null);
    try {
      setSignature(await send([await billing.revokeAgentIx({ agentAuthority })]));
      await refresh();
    } catch (e) {
      setError(explainError(e, "billing"));
    } finally {
      setBusy(null);
    }
  }

  const about = `Grants the authority ${agentAuthority.toBase58()} the right to meter charges into your escrow, up to a cap, until it expires.`;

  return (
    <FactRow label="Budget" id="allowance" className="scroll-mt-20" testId="agent-budget">
      {current ? (
        <>
          <span className="num" title={`Spent so far, of the cap this wallet granted. ${about}`}>
            {trimUsdc(current.spent)} <span className="text-xs text-ink-3">of {trimUsdc(current.cap)} USDC</span>
          </span>
          <span aria-hidden className="h-1 w-20 overflow-hidden rounded-full bg-line/[0.08]">
            <span
              className={`block h-full transition-all duration-300 ${
                expired ? "bg-rose-400" : spentPercent > 85 ? "bg-amber-400" : "bg-accent"
              }`}
              style={{ width: `${spentPercent}%` }}
            />
          </span>
          <span suppressHydrationWarning className={`text-xs ${expired ? "font-medium text-rose-300" : "text-ink-3"}`}>
            {expired
              ? `expired ${relativeToNow(current.expiresAt)}`
              : isNoExpiry(current.expiresAt)
              ? "no expiry"
              : `expires ${relativeToNow(current.expiresAt)}`}
          </span>
        </>
      ) : (
        <span className="text-ink-3" title={about}>
          none from this wallet{canChange ? "; sessions run unbilled until you approve one" : ""}
        </span>
      )}
      {canChange && !editing && (
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => setEditing(true)}
          testId="allowance-change"
        >
          {current ? "Change" : "Approve"}
        </Button>
      )}

      {/* The answer of the last grant or revoke stays under the row once the form folds, so
          _Confirmed_ with its transaction link is still on screen. */}
      {!editing && (error || signature) && (
        <div className="w-full space-y-2 pt-1">
          {error && <ErrorNote>{error}</ErrorNote>}
          {signature && (
            <Note tone="good">
              Confirmed · <ExplorerLink kind="tx" value={signature} />
            </Note>
          )}
        </div>
      )}

      {canChange && editing && (
        <div className="w-full space-y-3 pt-2" data-testid="allowance-form">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <Field label="Cap" right="USDC">
              <input
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                inputMode="decimal"
                placeholder="25.000000"
                className="input-mono"
              />
            </Field>
            <Field label="Duration" right="days">
              <input
                value={days}
                onChange={(e) => setDays(e.target.value)}
                inputMode="numeric"
                className="input-mono"
              />
            </Field>
          </div>
          {days.trim() !== "" && !validDays && (
            <p className="text-2xs text-ink-3" data-testid="allowance-days-whole">
              Duration is a whole number of days, 1 or more.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCap(preset)}
                aria-pressed={cap === preset}
                className="chip"
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              onClick={approve}
              loading={busy === "approve"}
              disabled={busy !== null || capMicro === null || capMicro === 0n || !validDays}
            >
              {busy === "approve" ? "Confirming…" : current ? "Re-grant" : "Approve allowance"}
            </Button>
            {current && (
              <Button variant="danger" onClick={revoke} loading={busy === "revoke"} disabled={busy !== null}>
                {busy === "revoke" ? "Confirming…" : "Revoke"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
          {/* `approve_agent` writes `spent = 0`, so a re-grant is a new grant and not a top-up.
            The row shows the meter just above; saying it here is cheaper than the surprise of
            watching it go back to zero. */}
          {current && current.spent > 0n && (
            <p className="text-xs text-ink-3">
              Re-granting starts the meter again: the {trimUsdc(current.spent)} USDC already spent against this
              allowance is not carried over, and the cap below is what it may spend from now.
            </p>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          {signature && (
            <Note tone="good">
              Confirmed · <ExplorerLink kind="tx" value={signature} />
            </Note>
          )}
        </div>
      )}
    </FactRow>
  );
}
