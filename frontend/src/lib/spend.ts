/**
 * The arithmetic behind the billing spend chart, kept apart from the component that draws it.
 *
 * The chart needs no Helius webhook or `charges` table: `chargeHistory` replays the transactions that
 * touched the user's balance account, and bucketing them by day is this file. What an indexer would
 * actually buy is **depth** — the page reads a bounded number of signatures and says so, rather than
 * implying it is the whole story.
 *
 * The input is structural rather than `BillingActivity` from the SDK, so the Node test suite can
 * import this without resolving the app's bundler aliases.
 */
export interface ChargeLike {
  name: string;
  /** Unix **seconds**, or null when the RPC has no block time for the slot. */
  blockTime: number | null;
  amount: bigint;
}

export interface DayBucket {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  amount: bigint;
}

/**
 * Charges bucketed into the last `days` UTC days, **including the days with none**: a gap is
 * information, and plotting only the days that had charges silently compresses time.
 *
 * Only `Charged` counts. Deposits and withdrawals are the user moving their own money, and
 * `Reserved` / `Released` are holds that were never spent — folding either in would answer a
 * different question than the one the chart is titled with.
 */
export function spendByDay(activity: ChargeLike[], days = 14, now: Date = new Date()): DayBucket[] {
  const byDay = new Map<string, bigint>();
  for (const a of activity) {
    // An undated row is dropped rather than attributed to today: the RPC not knowing when
    // something happened is not evidence that it happened now.
    if (a.name !== "Charged" || a.blockTime === null) continue;
    const key = new Date(a.blockTime * 1000).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0n) + a.amount);
  }
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Date arithmetic, not `now - i*86400000`: `setUTCDate` rolls months and leap days for us.
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, amount: byDay.get(key) ?? 0n });
  }
  return out;
}
