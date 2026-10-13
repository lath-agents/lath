/**
 * What Lath's treasury paid on Tempo for one wallet's loops: the vault popover's _Paid for you on
 * Tempo_.
 *
 * "For you" is the owner's half of the money flow and nothing else: the agent's model calls,
 * OpenRouter via Tempo, and the reports stored on Tempo, both of which the owner is debited for in
 * USDC on Solana. Jev's decisions, the trace audit and the RPC ride the same treasury but are Lath's
 * spend, charged to nobody, so they are left out — a figure that included them would tell the owner
 * they had been paid for with money nobody debits them for.
 *
 * Pure and browser-safe, with relative imports only, so `tests/console-tempo-paid.ts` runs the same
 * function the popover renders from.
 */
import type { LoopView } from "../types/loop";
import { jevCostBase, traceCostBase } from "./loop-money";
import { baseOf, tempoServiceLines } from "./tempo-services";

/**
 * How many step rows the console keeps per loop (`HISTORY_KEPT` in `app/api/_lib/loop-terms.ts`, which a
 * browser module cannot import). A history this long may have lost its oldest rows, and the sum is
 * then labelled as the last this-many steps rather than the loop's whole spend.
 */
export const HISTORY_ROWS_KEPT = 50;

export interface PaidOnTempo {
  /** The agents' model calls, OpenRouter via Tempo: each step's channel spend less Lath's decisions. */
  model: bigint;
  /** The committed report PUTs, the ones whose receipt names a Tempo transaction. */
  storage: bigint;
  /** `model + storage`, USDC.e base units. */
  total: bigint;
  /** The loops that paid anything on Tempo. */
  paidLoops: number;
  /** Some loop's history is at the console's row cap, so older steps may be missing from the sum. */
  capped: boolean;
}

/**
 * The sum over every loop's history. A loop with Tempo services is read through `tempoServiceLines`,
 * the Costs card's own split, so the popover and the loop page cannot disagree; an older loop
 * that paid before those services has none, and its model spend is the same subtraction made row by row.
 */
export function paidOnTempo(loops: Pick<LoopView, "history" | "tempo">[]): PaidOnTempo {
  let model = BigInt(0);
  let storage = BigInt(0);
  let paidLoops = 0;
  let capped = false;
  for (const loop of loops) {
    if (loop.history.length >= HISTORY_ROWS_KEPT) capped = true;
    const lines = tempoServiceLines(loop);
    let m: bigint;
    let s = BigInt(0);
    if (lines) {
      m = lines.model;
      s = lines.storage;
    } else {
      m = BigInt(0);
      for (const h of loop.history) {
        const spent = baseOf(h.tempoSpent) ?? BigInt(0);
        const lath = (baseOf(jevCostBase(h)) ?? BigInt(0)) + (baseOf(traceCostBase(h)) ?? BigInt(0));
        if (spent > lath) m += spent - lath;
      }
    }
    if (m + s > BigInt(0)) paidLoops++;
    model += m;
    storage += s;
  }
  return { model, storage, total: model + storage, paidLoops, capped };
}
