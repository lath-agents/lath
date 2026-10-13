/**
 * The trace audit's config: what a loop that runs it commits in its policy as `traceAudit`, the
 * behaviours the decision model reads each step's trace for and what each one does at its bar.
 *
 * The trace audit is on the roadmap: this build neither writes nor audits one, and has no span
 * renderer, presets, code checks, confirm or decoder of its blob. What is here is `TraceAuditConfig`,
 * the type of `RuntimePolicy.traceAudit`, so a policy that commits one keeps hashing as it did
 * (`runtime/src/policy.ts`).
 *
 * Pure: no Anchor and no Node built-in, because `browser.ts` re-exports this file and CI fails the
 * browser bundle on either.
 */

/** What a behaviour at or above its bar does: marks the step, or vetoes it. */
export type TraceOnPresent = "flag" | "stop";

/** One behaviour's terms as the policy commits them: `traceAudit.behaviours[id]`. */
export interface TraceTerm {
  /** The probability at or above which the behaviour counts as present, in (0, 1]. */
  bar: number;
  onPresent: TraceOnPresent;
}

/** `traceAudit.behaviours`: the ids an owner picked, each with its bar and action. */
export type TraceTerms = Record<string, TraceTerm>;

/** The policy's `traceAudit` key. No confirm model: the confirm is the loop's own. */
export interface TraceAuditConfig {
  model: string;
  behaviours: TraceTerms;
}
