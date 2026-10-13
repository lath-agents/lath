/**
 * `GET /api/tempo/stats` — the operator treasury's lifetime figures on Tempo mainnet, the Tempo tab's
 * source. The contract between the route (`api/tempo/stats/route.ts`) and the screens;
 * `useTempoStats` in `lib/tempo-stats.ts` reads it.
 *
 * The figures are `scripts/tempo-stats.ts`'s `Stats` (`summarize`), served rather than printed: the
 * treasury's public activity feed on `api.tempo.xyz`, and each channel's `getChannelState` on the
 * escrow. Both are public, so this is shown to every wallet, and the route holds no key. Every amount
 * is USDC.e base units (six decimals) as a decimal string, because a `bigint` does not survive JSON
 * and a `number` loses cents past 2^53 base units.
 *
 * What it cannot say, and the screen must not imply: how many model calls those channels paid
 * (vouchers never reach Tempo; the Solana records count them), or whose loops spent it (the figures
 * are the treasury's, whoever ran the loops; quoted, they say who ran them).
 */

/** About how many feed rows `recent` carries, newest first. */
export const TEMPO_STATS_RECENT_LIMIT = 20;

/**
 * One feed row worth a line on the Tempo tab, from `Activity` (`scripts/tempo-stats.ts`) as the
 * script classifies it:
 *
 * - `open` — a `channel-opened` row: the treasury deposited `amountBase` into a new channel.
 * - `close` — a `refund` row, the escrow sending a channel's unspent deposit back at its close. It is
 *   the only feed row a close leaves on the treasury, so its `txHash` is the close transaction;
 *   `amountBase` is what came **back**, not what was paid, and the feed may not name the channel. A
 *   close that refunded nothing leaves no row, so this is not every close.
 * - `storage` — an outgoing transfer attributed _Object Storage_: a report stored on Tempo.
 * - `topup` — USDC.e anyone but the escrow sent the treasury (the operator funding it).
 *
 * `channel-funded` rows (a deposit added to an open channel) are counted in `depositedBase` and are
 * not listed; rows in another token are neither.
 */
export interface TempoStatsActivity {
  kind: "open" | "close" | "storage" | "topup";
  /** The Tempo transaction, for `tempoTxUrl`. */
  txHash: string;
  channelId?: string;
  amountBase?: string;
  /** ISO 8601, the feed's `timestamp`. */
  at: string;
}

export interface TempoStats {
  /** The payer the figures are for: the operator's Tempo treasury, for `tempoAddressUrl`. */
  treasury: string;
  /** The first feed row's time (ISO 8601), or `null` for a treasury with no rows. */
  since: string | null;
  /** The last feed row's time. */
  until: string | null;
  /** Whole days from `since` to `until`, at least 1 when there are rows, 0 when there are none. */
  days: number;
  channels: {
    opened: number;
    /** Closed: the escrow reads the channel as zeros, which is what a settled channel reads as. */
    settled: number;
    /** Still holding a deposit at the escrow. */
    open: number;
    /** Channels whose escrow state could not be read: neither settled nor open. */
    unread: number;
  };
  /** Into channels: every open's deposit plus every top-up of an open channel. */
  depositedBase: string;
  /** What the channels paid the services: deposited, less refunded, less still parked in open channels. */
  channelPaidBase: string;
  /** What the escrow sent back at closes. */
  refundedBase: string;
  /** Deposited in channels still open and not yet settled: parked, not paid. */
  parkedBase: string;
  /** True when a channel's state was unread, so `channelPaidBase` counts its parked money as paid. */
  approximate: boolean;
  storage: { count: number; amountBase: string };
  /** `channelPaidBase` plus `storage.amountBase`: paid to MPP services in all. */
  paidBase: string;
  /** When the route computed these figures (ISO 8601); it caches them for about ten minutes. */
  computedAt: string;
  /** The newest feed rows, at most about `TEMPO_STATS_RECENT_LIMIT`, newest first. */
  recent: TempoStatsActivity[];
}

/** The route's answer when it has no figures: no treasury configured, or Tempo did not answer. */
export interface TempoStatsError {
  error: string;
}
