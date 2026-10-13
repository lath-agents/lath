/**
 * The gate's config: what a gated loop commits in its policy as `gate`.
 *
 * Gated loops are on the roadmap: this build neither writes nor audits one, and has no state
 * renderer, rule, `verifyGate` or decoder of the gate's log and decision blobs. What is here is
 * `GateConfig` and `WatchSource`, the types of `RuntimePolicy.gate`, because a policy document that
 * commits one must keep hashing as it did (`runtime/src/policy.ts`).
 *
 * What a decision costs and what a checkpoint debits for it are in `decision-pricing.ts`.
 *
 * Pure: no Anchor and no Node built-in, because `browser.ts` re-exports this file and CI fails the
 * browser bundle on either.
 */

/**
 * One entry of a gated loop's watch list. `routineCalls` on an `agent` source is the routine-call
 * norm: the owner's declared tool calls per session for that agent, which the filter counts
 * against rather than asking a model to weigh.
 *
 * A `solana` source is any account on the cluster the console reads: the transactions that touched
 * `address` since the last step, one line each. It is appended as the last member, so an older
 * list, which carries none, hashes exactly as it did.
 */
export type WatchSource =
  | { kind: "store"; keys: string[] }
  | { kind: "agent"; agentId: string; label: string; routineCalls?: number }
  | { kind: "pyth"; feedId: string; label: string; minMoveBps: number }
  | { kind: "solana"; address: string; label: string };

/** What a gated loop commits in its policy document as `gate`. Integers in bps. */
export interface GateConfig {
  model: string;
  barBps: number;
  watch: WatchSource[];
  failMode: "closed" | "open";
  heartbeatMs: number;
}
