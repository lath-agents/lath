/**
 * The lath-billing debit a record's transaction carried: what `verify-channel --refetch` holds each
 * per-event voucher Action's charge to. No other verifier reads it, so it is here on its own.
 */
import { LATH_BILLING_IDL, LATH_BILLING_PROGRAM_ID } from "../idl";

/** lath-billing's `charge` discriminator, out of the bundled IDL rather than typed in. */
const CHARGE_DISCRIMINATOR: readonly number[] =
  (LATH_BILLING_IDL.instructions as readonly { name: string; discriminator: readonly number[] }[]).find(
    (i) => i.name === "charge"
  )?.discriminator ?? [];

/**
 * What one transaction debited through lath-billing `charge`, micro-USDC: the `amount: u64` of
 * every top-level instruction to `programId` whose data opens with `charge`'s discriminator,
 * summed. `chargeAndLog` composes the charge beside the `log_event` as a top-level instruction
 * (never a CPI), so inner instructions are not read. Other billing instructions in the same
 * transaction — the allowance migration `withMigration` may add — are not debits and are skipped.
 * Pure over the instruction list, so the CLI's transaction read and the tests share it.
 */
export function billingChargeDebit(
  instructions: readonly { programId: string; data: Uint8Array }[],
  programId: string = LATH_BILLING_PROGRAM_ID
): bigint {
  let total = 0n;
  for (const ix of instructions) {
    if (ix.programId !== programId || ix.data.length < 16 || CHARGE_DISCRIMINATOR.length !== 8) continue;
    if (!CHARGE_DISCRIMINATOR.every((b, i) => ix.data[i] === b)) continue;
    let amount = 0n;
    for (let i = 15; i >= 8; i--) amount = (amount << 8n) | BigInt(ix.data[i]);
    total += amount;
  }
  return total;
}
