/**
 * What a decision-model call costs and what a checkpoint debits for one: the numbers the console's
 * Jev budget and every checkpoint's charge are held to.
 *
 * They are the gated loop's prices, and they apply without it: the console prices a Jev call at
 * `GATE_ASK_BASE` when it sizes a loop's decision share, and `verify-channel` holds a per-event
 * call's debit to `gateChargeMicroUsdc` at the operator's margin. The names say "gate" because the
 * console, the runtime and the tests import them by those names.
 *
 * Pure: no Anchor and no Node built-in, because `browser.ts` re-exports this file.
 */

/** What one ask costs at or under the gate's 2 048-byte state, in base units of USDC.e. */
export const GATE_ASK_BASE = 42;

/**
 * The operator margin `LATH_MARGIN` defaults to, in bps (`runtime/src/billing.ts`, 0.10). The
 * margin is the operator's and is not committed anywhere on the chain, so an auditor states the
 * one it holds the charge to; this is the one to state when the operator named none.
 */
export const DEFAULT_MARGIN_BPS = 1_000;

/**
 * What a checkpoint debits for a summed `costBase`, micro-USDC:
 * `ceil(costBase × (10 000 + marginBps) / 10 000)`, applied **once** to the summed `costBase` and
 * not per ask — 84 base units at 0.10 is 93, where two asks of 42 charged apart would be 94.
 * The runtime charges through `toMicroUsdcFromBase(costBase, margin)`, which turns the margin into
 * bps the same way and rounds up the same way. `0n` for nothing paid, which is a checkpoint with no
 * charge instruction at all.
 */
export function gateChargeMicroUsdc(costBase: bigint, marginBps: number = DEFAULT_MARGIN_BPS): bigint {
  if (costBase <= 0n) return 0n;
  const scaled = costBase * (10_000n + BigInt(Math.max(0, Math.round(marginBps))));
  return scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n);
}
