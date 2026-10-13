/**
 * The storage profile the product runs on, and what a chain write costs.
 *
 * Two tiers, one chain: *critical* events (genesis, delegation, resolution) are written as
 * their own records the moment they happen, so they are indexable and pair across chains;
 * *standard* events (tool calls, LLM steps) are batched into epochs and anchored as one root
 * (`rollup.ts`). The runtime does that routing itself; `scripts/dynamic-storage-engine.ts` is a
 * bench harness that does it standalone. The numbers below are the single source of truth — the
 * docs and the web app import them rather than restating them.
 */

import type { ChainSignals } from "./rollup";

type StorageMode = "dynamic" | "interactive" | "batch";

export interface DynamicStorageConfig {
  /** `dynamic` classifies by kind; `interactive` treats everything as critical; `batch` everything as standard. */
  mode: StorageMode;
  /** Steps per epoch before a flush. */
  standardBatchSize: number;
  /** Longest an incomplete epoch waits, ms. */
  standardFlushDelayMs: number;
  /** Window for the ingestion-rate metric, ms. */
  rateSampleWindowMs: number;
  /** Fee- and balance-aware batching (`ChainSignals` in `rollup.ts`). Off when absent. */
  signals?: ChainSignals;
}

/** A single agent: an epoch every 100 steps or two minutes. */
export const DEFAULT_AGENT_DYNAMIC_CONFIG: DynamicStorageConfig = {
  mode: "dynamic",
  standardBatchSize: 100,
  standardFlushDelayMs: 120_000,
  rateSampleWindowMs: 5_000,
};

/**
 * Measured on devnet (docs/ARCHITECTURE.md §11): a chain write that creates a new address costs 15 000
 * lamports; one that only rewrites the header (compact event, epoch commit) costs 10 000.
 */
export const LAMPORTS_PER_RECORD = 15_000;
export const LAMPORTS_PER_HEADER_WRITE = 10_000;
