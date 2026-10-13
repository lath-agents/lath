/**
 * One row of the loop registry, `LATH_TRACE_DIR/loops.json` (`_lib/loops.ts` re-exports it).
 * Reading and writing the file is `loop-registry.ts`.
 */
import type { GateConfig, TraceAuditConfig, Grants, LoopReceipt, LoopReceiptPointer } from "@lath/sdk";
import type { LoopSnapshot } from "@lath/runtime";
import type {
  LoopDiscard,
  LoopSandboxRecord,
  LoopPostureIrys,
  LoopStepSummary,
  LoopTrialArm,
  LoopWorkers,
} from "../../../types/loop";
import type { TemplateLink } from "./templates";
import type { LoopKeyChannelRow, LoopTempoKey } from "./tempo-keys";
import type { LifecycleState } from "./lifecycle";
import type { ConsoleLoopTrigger, VerifyTerms } from "./loop-terms";

// ─── The registry ───────────────────────────────────────────────────────────

export interface LoopRecord {
  id: string;
  /** Hex id of the deployed agent this loop runs. */
  agentId: string;
  agentName: string;
  /** Base58 of the wallet that owns the agent and started the loop. */
  owner: string;
  /** The standing instruction. Every step runs it. */
  prompt: string;
  /** `sha256(prompt)`, hex — what the step manifest commits to. */
  promptHash: string;
  intervalMs: number;
  maxSteps: number;
  /**
   * The loop's one overall budget, micro-USDC: what its steps draw down until it is spent,
   * `maxSteps` is reached or the goal is met. It is also each step's policy `maxCost`, and the runner
   * enforces what is left of it as an unhashed ceiling on every session of a step. Set on every row
   * `readLoops` hands out: an older row that names only a per-step budget has none on disk, and
   * `withBudgetKeys` derives it as `stepCeiling × maxSteps`. Optional in the type for that reason —
   * such rows, and fixtures of them, are still written — so read it through `loopBudgetKeys`, which
   * derives it the same way when it is absent.
   */
  budgetMicroUsdc?: string;
  /**
   * `floor(budgetMicroUsdc / maxSteps)`, written on every new row for an older reader whose
   * `isLoopRecord` requires the key. Nothing enforces it on a new row. On a row without a whole
   * budget (`legacyStepBudget`) it is the per-step spend ceiling and each step's `maxCost`.
   */
  budgetMicroUsdcPerStep: string;
  /**
   * Set by the read shim on an older row that names only a per-step budget, and never on a new one.
   * Such a loop keeps running exactly as it started: each step's policy `maxCost` stays its per-step budget —
   * moving it mid-run would make two steps of one loop commit two policies — and its whole budget is
   * the derived `stepCeiling × maxSteps`, which the per-step ceiling and `maxSteps` already bound.
   */
  legacyStepBudget?: true;
  /**
   * What Lath may spend on Jev for this loop, USDC.e base units (6 decimals, like µUSDC): the
   * loop budget × `LATH_JEV_BUDGET_PERCENT` / 100, **frozen at start** so a later change of
   * the rate does not retro-apply. Filled by the read shim on an older row, at the rate then set;
   * optional in the type for the reason `budgetMicroUsdc` is, and read through `loopBudgetKeys`.
   */
  jevBudgetBase?: string;
  /**
   * What Lath has spent on Jev for this loop so far, base units: the actual voucher delta of every
   * paid gate ask, verify decision and goal check, added the moment the voucher is signed — so an
   * ask paid for and then discarded (a timeout, a Discard) still counts. Persisted on every such
   * call; `"0"` on a new row and on an older row without it (read through `loopBudgetKeys`).
   */
  jevSpentBase?: string;
  model: string;
  /**
   * The operator's `LATH_FALLBACK_MODEL` as it was when the loop started, **frozen** like the Jev
   * rate: every step's policy commits it as `fallbackModel`, so a change of the setting mid-run
   * would make two steps of one loop commit two policies. Absent when none was set, or when it named
   * the loop's own model — and then every step's policy hash is that of a policy without the key.
   * Older rows may have none.
   */
  fallbackModel?: string;
  /** Unix ms the loop was created — `startedAt` in every step manifest. */
  createdAt: number;
  /**
   * What decides a step, and what the step publishes when it is done.
   * Absent on older runs, and absent means `schedule` — read it
   * through `triggerOf`, never off the record, so an old row never reaches a `kind` that is
   * `undefined`. Written on every new run.
   */
  trigger?: ConsoleLoopTrigger;
  status: "running" | "paused" | "stopped";
  /** Why it is not running, in the `LoopStopReason` vocabulary or a sentence. */
  stopReason?: string;
  stopDetail?: string;
  /**
   * A Retry answered _head diverged_ (`LoopView.anchorDiverged`). Set by `retryLoopAnchor` and
   * cleared by the discard; absent on every run whose journal never diverged.
   */
  anchorDiverged?: boolean;
  /** What `discardLoopAnchor` dropped, kept on the run so its page can say what was lost. */
  discarded?: LoopDiscardRow;
  /**
   * When a Discard began (`discardUnderSlot`), written before the queue drops anything and cleared by
   * the same write that clears the run's deferred checkpoints. Still set means the journal may have
   * dropped this run's records while the row kept their plans: `payDeferredCheckpoints` then writes no
   * `loop.step` over them, and Retry is refused until a Discard finishes the row. Absent on every
   * other run.
   */
  discardingAt?: number;
  /** What `LoopRunner` needs to carry on where it left off. */
  snapshot: LoopSnapshot;
  /** Unix ms the next step is due, when one is. */
  nextStepAt?: number;
  /** Set while a step is in flight, so the list can say so. */
  steppingSince?: number;
  /**
   * The template version this run was started from — `{ id, version, hash }`. Absent on older
   * runs, so `isLoopRecord` does not require it; written on every
   * new run, including the ad-hoc case, where the server writes an implicit template first.
   */
  template?: TemplateLink;
  /**
   * Unix ms the owner archived this run. Archived loops are hidden from `GET /api/loops`'s list
   * and never deleted: `?id=` still resolves one, because a run's steps stay on chain and the
   * audit links to them have to keep working. Absent on every run
   * that has not been archived, which is most of them.
   */
  archivedAt?: number;
  /**
   * Why the last step ran scripted and unbilled although the agent's config asked for `tempo` —
   * a treasury that could not cover the step's deposit, or one that could not be read.
   * Absent on every loop that has never degraded, and re-written each time a step decides.
   */
  tempoNote?: string;
  /**
   * The rail this loop's records commit, decided once at its first billed step and sticky.
   * `"vault"` only on older rows; absent on a loop whose steps were never paid for, which is what
   * `policy_version_hash` carries for one.
   */
  rail?: "vault" | "tempo";
  /**
   * The channel this loop pays through while one is open. Present from the first paid call until
   * the settlement that closes it; absent on an unbilled loop and between channels. Survives a
   * restart on disk so the row can name what must be settled; the process that reads it back
   * holds no mppx session for it and settles it through `closeChannelById` before the next step.
   */
  channel?: {
    channelId: string;
    payer: string;
    openedAt: number;
    /** `snapshot.steps` when the channel opened; the first step it paid for is this + 1. */
    openedAtStep: number;
    /** The channel's cumulative after the last paid call, base units, as a decimal string. */
    cumulative: string;
  };
  /**
   * The second model each step's output is judged by before it becomes memory, and the bar its
   * confidence must clear. Resolved once at the start and never a
   * `true`: the values are what `policy_version_hash` commits on every step.
   *
   * **Absent** when the loop did not ask for one, rather than `false` or a default. A run in
   * `loops.json` without a judge has no key here, `canonicalJson` drops `undefined`, and so a loop
   * without verify hashes its policy exactly as a policy that never names it — which is the same
   * absent-when-off rule `goal` follows.
   */
  verify?: VerifyTerms;
  /**
   * What this run is working toward, in the owner's words. A step
   * whose answer says the goal is reached is the run's last one, and the loop stops with
   * `stopReason: "goal-reached"`.
   *
   * **Absent** when the run has none, by the same absent-when-off rule `verify` follows: a loop
   * without a goal must be byte-for-byte a loop that never names one, down to the template hash
   * its ad-hoc start reuses. Written on every new run that has one.
   */
  goal?: string;
  /**
   * `sha256(goal)`, hex — the tenth key of every step manifest, so `args_hash` commits to the
   * goal. Persisted beside `goal` the way `promptHash` is persisted beside `prompt`: the record
   * is what the console reports, and re-deriving it per read would let the two drift.
   */
  goalHash?: string;
  /**
   * Jev's goal check: after each step Jev answers whether the goal is
   * achieved, and its `achieved` at the bar — not the agent's `GOAL REACHED` — ends the run.
   * Resolved at the start, committed under `goalCheck` in every step's `policy_version_hash`.
   * **Absent** when the run has no goal or its owner turned the check off, so such a run is
   * byte-for-byte the record, policy and template of a run that never names the check.
   */
  goalCheck?: VerifyTerms;
  /**
   * The trace audit (on the roadmap), on a row started with it: after each step Jev reads the step's
   * trace, and a confirmed `stop` behaviour keeps the step out of memory and stops the run. Committed
   * under `traceAudit` in every step's `policy_version_hash`, so it stays on the row for the policy,
   * the page and the audit. This build writes it on no row and steps no row carrying it
   * (`asksForTraceAudit`). **Absent** on every other row.
   */
  traceAudit?: TraceAuditConfig;
  /**
   * The team a run hands each step's tasks to (teams are on the roadmap; this build starts and steps
   * none): the roster resolved to agent ids, the one model they all run on, and the per-task ceiling
   * each member session runs under. The `source` beside them is how the roster was filled.
   *
   * **Absent** when the run has no team, by the same absent-when-off rule `verify` and `goal`
   * follow: a loop without one must be byte-for-byte a loop that never names one, down to the
   * policy hash each of its steps commits and the implicit template its ad-hoc start reuses.
   */
  workers?: LoopWorkers;
  /**
   * The gate a gated run looks through before each step, committed under `gate` in every step's
   * `policy_version_hash`. Set exactly when the trigger is `gate`. Read only: gated loops are on the
   * roadmap, so this build gives no row one, and a running row that carries one is stopped before it
   * steps (`tickOnce`).
   *
   * **Absent** on every other run, by the absent-when-off rule `verify`, `goal` and `workers`
   * follow.
   */
  gate?: GateConfig;
  // A gated row also carries `gatePending` and `gateEvents`, the gate's saved log and the strip it
  // drew. Nothing in this build reads either: the page says only that the run used a gate
  // (`earlierBuildFeatures`), and this build does not audit the steps that log committed. They stay on
  // disk untouched, since a write keeps the keys a row has.
  /** How the last step was paid for and inferred. */
  billing?: "charged" | "unfunded";
  inference?: "openrouter" | "scripted";
  history: LoopStepSummary[];
  /**
   * Where each posture this loop's sandboxes committed is on Irys in clear, keyed by its
   * `postureHash`: session A's, and each member's, whose tool lists make theirs a posture of its
   * own. Uploaded after the first step that ran under it and never again (`publishStepPostures`), so
   * a loop whose posture never changes has one entry. Absent on a console that does not anchor to
   * Irys and on older rows; the ZeroClaw page then verifies the posture from
   * this console's copy. Nothing here is hashed: the object's bytes are the posture's.
   */
  postures?: Record<string, LoopPostureIrys>;
  /**
   * The sandbox the loop was started with and, when it had sources, the manifest's hash. Absent on
   * every loop started without a Sandbox section, which runs under the host's defaults.
   */
  sandbox?: LoopSandboxRecord;
  /**
   * This run is one arm of an Improve. Only the Improve loop sets it, and Improve is on the roadmap,
   * so no run this build starts carries it. Still read, because stored rows may, and their page must
   * not offer _Run again_ of a trial's terms. Such a row may also carry the source's `improve` state,
   * which nothing in this build reads.
   */
  trial?: LoopTrialArm;
  /**
   * The loop's Tempo access key: authorized at the
   * end of the start path when `LATH_TEMPO_LOOP_KEYS` is on, and the source of the policy's
   * `tempoKey`. Never the file path (`LoopKey.file`): this row is what the API reads. Absent on
   * every loop started with the switch off, whose channels the treasury signs.
   */
  tempoKey?: LoopTempoKey;
  /**
   * Everything the loop's access key has signed that is finished: each channel it opened and that
   * has since been settled, with its deposit and what the close paid, and each owner storage charge
   * it signed, as a row whose deposit and settled amount are both the charge. Written at
   * each settle and each charge, and read by every reconcile, whose target is `limitBase − Σ settled`
   * over these less the deposit of the channels still open.
   *
   * Kept on the row because nothing else keeps it: the channel ledger forgets a channel the moment
   * it closes (`forgetOpenChannel`), and a reconcile that could not see a settled channel would hand
   * its spend back to the key — a limit above what the loop's budget allows, which is the one thing
   * the key exists to make impossible. A charge is a row of its own for the same reason: Tempo never
   * returns it, so a reconcile that forgot one would restore it. Absent on a loop without a key, and
   * on one whose key has signed nothing yet.
   */
  tempoKeyClosed?: LoopKeyChannelRow[];
  /**
   * Every channel the loop's key is known to have opened, with the largest deposit seen on it
   * (`noteKeyChannels`). The other half of `tempoKeyClosed`: a channel noted here and found neither
   * open nor among the finished rows was closed by a path that never reported what it settled, and
   * the reconcile counts its whole deposit rather than hand back a refund it cannot show. Absent
   * on a loop without a key, and on one whose key has opened nothing yet.
   */
  tempoKeyChannels?: { channelId: string; deposit: string }[];
  /**
   * The key's revoke after the loop stopped and its channel closed: when it landed
   * and its transaction, or why it did not. A failed revoke never holds the stop up; it stays here,
   * and the next settle of this loop or the next console start tries again. Absent until the first
   * try, and on every loop without a key.
   */
  tempoKeyRevoke?: {
    /** Set only beside `txHash`: a revoke that sent nothing never reads as revoked. */
    revokedAt?: number;
    txHash?: string;
    error?: string;
    triedAt?: number;
    /**
     * The key file was gone when the revoke was asked, so nothing could sign it: the key is still
     * live on the treasury's keychain until someone revokes `tempoKey.address` from the treasury by
     * hand. Never retried, because nothing here can do it.
     */
    byHand?: true;
  };
  /**
   * The protocol plugins the owner permitted this loop (on the roadmap), on a row started with grants:
   * the start body's `grants`, each item's `spendingLimit` filled from the loop's own key. No start on
   * this build carries any (`grantsRefusal`): kept for what such a row still does — commit them in its
   * policy (`policyDocument`, so a settlement's Genesis matches its steps') and refuse its steps, resume
   * and Retry. Its page says only that the run used grants.
   */
  grants?: Grants;
  /**
   * That row's own Solana key, as its policy commits it (`solanaKey`: `address`, `createdAt`);
   * `fundTx` was its funding transfer, never hashed. Present exactly when `grants` is. This build neither
   * makes, funds nor sweeps one.
   */
  solanaKey?: { address: string; createdAt: number; fundTx?: string };
  // That row may also carry `pluginLedger` and `pluginAttested`, what its plugins paid and attested.
  // Nothing in this build reads either.
  /**
   * Where the loop's receipt goes and which key signs it: the
   * start body's `receipt`, which the "Lath loop" signature binds, checked equal to this console's demo
   * pointer. The source of every step's policy `receipt`. Absent on every loop that asked for none,
   * which therefore hashes and runs as a loop without a receipt.
   */
  receipt?: LoopReceiptPointer;
  /**
   * Set on every run this console starts: its traces are written in the clear. Absent on an older
   * run, whose blobs may be ciphertext (owner encryption, on the roadmap); the audit opens those with
   * `--trace-key`, and the console does not.
   */
  plainTraces?: true;
  /**
   * The receipt's publish, after a goal-reached stop's settle: the attestation and its
   * transaction, or `found` when a restart found it already there, or why it failed (`error`; the
   * console's first pass tries a failed one again). `values` is what was or would have been published.
   * Absent until the publish runs, and on every loop without a receipt.
   */
  receiptResult?: {
    at: number;
    attestation?: string;
    signature?: string;
    slot?: number;
    found?: true;
    error?: string;
    values?: LoopReceipt;
  };
  /**
   * The loop's lifecycle records on its agent's chain (`_lib/lifecycle.ts`): what is written, what is
   * decided and still owed, and whether the row was rebuilt from the chain. Set by `startLoop` on
   * every loop started with `LATH_LIFECYCLE` on; absent on any other row, which owes nothing for its
   * later transitions either, since its chain carries no start for them to follow.
   */
  lifecycle?: LifecycleState;
}

/**
 * `LoopDiscard` as the row keeps it: with the part of `chargedMicroUsdc` whose landing nobody
 * confirmed (`DiscardResult.inDoubtMicroUsdc`), so `discardDetail` can say "may have been charged"
 * for it. Absent on a discard with nothing in doubt and on older rows.
 */
export type LoopDiscardRow = LoopDiscard & { inDoubtMicroUsdc?: string };
