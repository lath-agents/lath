/**
 * A loop is an agent that keeps running.
 *
 * `AgentRuntime` is single-shot by design: `start()` opens a session, resolves it, and holds no
 * state afterwards. `LoopRunner` is the thing that calls it again — on a schedule, with a
 * standing instruction, under a per-step budget — and turns the sequence of sessions into
 * something a reader can follow without replaying every step:
 *
 * ```text
 * step n:  genesis · [ steps … ] → one epoch · resolution · Action{tool_id: "loop.step"}
 * ```
 *
 * The last write is the point. Its `args_hash` commits to the step's manifest (`loopId`, the
 * step index, the interval, the step ceiling, the hash of the standing prompt, when the loop
 * was created, and the hash of the memory the step ended with) and its `result_hash` is the
 * step leaf `loopStepLeaf` = `sha256(agent_id ‖ seq_le ‖ head)` over the chain **as it stood
 * when the step finished**. So:
 *
 * - `listByTool(agentId, "loop.step")` is the loop's history, one record per step, cheap to
 *   query because the reference is `sha256(tool_id)`;
 * - anyone with an RPC rebuilds each leaf from the chain — `seq` is the step record's own seq,
 *   `head` is the head at `seq - 1` — and checks it against what the record commits to
 *   (`sdk/src/loops.ts`, `verifyStep`);
 * - the cost of the anchor scales with **wall-clock**, not with step count: a step writes one
 *   epoch and three records whatever the agent did inside it.
 *
 * **Memory.** A step remembers for the next one: the text a successful step ends with is put in
 * the trace store and its hash goes into the manifest as `memoryHash`. The next step fetches
 * those bytes by that hash, re-hashes them, and only then hands them to the session (which
 * commits the hash again in its genesis `input`, so the chain shows what it resumed from). A
 * store that has nothing under the hash, or something else, does not get a step that quietly
 * starts fresh: the step is a logged failure with no session and no checkpoint, and enough of
 * them in a row stop the loop. A step that produced nothing new carries the previous memory
 * forward under the same hash.
 *
 * What this class does *not* own is persistence. Step count, last seq, last head and the reason
 * a loop stopped are the caller's to store — a console in a file, a script in memory — through
 * `snapshot()` and the `resume` option. A `LoopRunner` is therefore cheap to build per step,
 * which is exactly what a scheduler that survives a process restart wants.
 *
 * **Anchoring.** A loop stays synchronous even when its runtime journals: it is built with
 * `anchor.drain` on, so `start()` waits for the writer queue before it resolves and the
 * checkpoint is taken over a settled chain —
 * `verifyStep` is unchanged, and one code path produces records in both modes. What the queue
 * adds is a way for the *writes* to fail while the work succeeded, and that is its own stop
 * reason: `anchor-failed`, with no checkpoint for the step it stopped on, because a leaf over a
 * head that never landed is a commitment nobody can rebuild.
 *
 * Steps never overlap: `step()` refuses while one is in flight, and `run()` sleeps *after* a
 * step rather than on a fixed cadence, so a step that runs longer than the interval delays the
 * next one instead of racing it for seqs.
 *
 * **Only the clock steps a loop in this build.** The oracle triggers (a step woken by a
 * the oracle program's `Request`, or one that publishes to a `Feed`) and gated loops (a step woken by a
 * second model) are on the roadmap: this build neither writes nor verifies them. A step's manifest
 * keeps the keys they set (`requestAddress`, `gateHash`), so an older step that carries one still
 * re-derives its leaf here, and `verify-step` names such a step as one this build does not verify.
 */
import { PublicKey } from "@solana/web3.js";
import {
  AgentLogger,
  Bytes32,
  EpochCommit,
  EventKind,
  LOOP_STEP_TOOL,
  LathClient,
  goalHash,
  parseGoalPlan,
  LoopStepManifest,
  LoopStepStatus,
  VERIFY_QUESTIONS,
  VERIFY_GOAL_QUESTIONS,
  GOAL_CHECK_QUESTIONS,
  applyGoalCheck,
  goalReachedIn,
  applyVerdict,
  decisionBlobBytes,
  hex,
  loopLeafPreimage,
  loopManifestBytes,
  loopMemoryBytes,
  loopStepLeaf,
  memoryMatches,
  sha256,
  toBytes32,
  utf8,
  verifyState,
  type DecisionBlob,
  type GoalCheckBlob,
  type GoalCheckOutcome,
  type TempoPaymentRecord,
  type VerifyAnswers,
  type VerifyOutcome,
  payloadPreimage,
  hashPayload,
  type ActionPayload,
  type LogResult,
} from "@lath/sdk";
import { AnchorFailed, chargeRefusal } from "./anchor";
import { toMicroUsdcFromBase } from "./billing";
import {
  STORAGE_PUT_TOOL,
  TEMPO_CARRY_VERSION,
  storageArgsBytes,
  storageReceiptBytes,
  tempoCarryBytes,
  type CarriedStorage,
  type LoopTempoServices,
  type StoragePut,
  type StorageReportFile,
  type TempoCarry,
} from "./loop-tempo";
import type { ChatTransport, DecideRequest, DecideResult } from "./openrouter";
import { canonicalJson, promptHash } from "./policy";
import {
  AgentRuntime,
  BudgetExceeded,
  chargeNeverSent,
  RuntimeEvent,
  SessionMeter,
  SessionResult,
  SessionStatus,
  TempoChannel,
  TempoSettlement,
} from "./runtime";
import { decideWithin, storeUnanswered, type AbortableDecider, type UnansweredPaid } from "./decide";
import type { SandboxSessionResult } from "./zeroclaw/runtime";

/**
 * The record that closes a loop's Tempo channel: one `Action` on the loop's own chain, written
 * after the last step, whose blobs are the channel and the settlement transaction.
 *
 * A loop settles once, not once per step, because the channel is per loop and the Resolution is
 * per step — so there is no Resolution to put the receipt in. It is a full record rather
 * than an epoch entry for the same reason a checkpoint is: an epoch root is built from step
 * leaves and has no field for it, and `listByTool` is how a reader finds the settlement of a
 * loop it is auditing.
 */
export const LOOP_SETTLEMENT_TOOL = "loop.settlement";

/**
 * What decided a run's steps, as a stored run records it.
 *
 * Only `schedule` steps in this build. `request` and `feed` are the oracle triggers, which are on
 * the roadmap: they stay in the type because older rows and templates carry them, and a reader has
 * to name them; the console refuses to start, resume or step a run that asks for one, and
 * `LoopRunner` takes no trigger at all.
 */
export type LoopTrigger =
  /** The default when absent: the interval decides, and a step publishes nothing off its chain. */
  | { kind: "schedule" }
  /** Stepped when a Pending `Request` named the loop's key; answered with a `fulfil` or a `reject`. */
  | { kind: "request"; pollMs: number }
  /** The interval decided, and every step published its value to the loop's one `Feed`. */
  | { kind: "feed" };

/** Why a loop is no longer running. */
export type LoopStopReason =
  /** `maxSteps` steps have been taken. Not a failure: the loop finished. */
  | "max-steps"
  /**
   * A step's answer said the loop's goal was reached. Not a failure:
   * the loop finished — and finished earlier than its ceiling, which is the whole point of
   * giving it a goal. The step that said so carries `LoopStepStatus.GoalReached` on chain, so a
   * reader with an RPC alone sees the same thing this reason says.
   */
  | "goal-reached"
  /**
   * The loop's money ran out. Two shapes: a session crossed its policy `maxCost` (an older loop
   * without `budgetMicroUsdc`, whose `maxCost` is a per-step budget), or — with `budgetMicroUsdc` —
   * what is left of the loop's one overall budget is spent, after the call in flight.
   */
  | "budget"
  /** The billing backend refused a charge — an exhausted or expired allowance. */
  | "charge-failed"
  /** `stop()` was called. */
  | "stopped"
  /**
   * A chain write of this step spent its attempts in the anchor queue
   * (`runtime/src/anchor.ts`, rule 4). The *work* did not fail: the session ran, the model
   * answered and every blob is in the trace store — what failed is the transaction that was to
   * record it, and the records are still in the journal waiting for a `retry`. The loop stops
   * for the reason a budget stops it: three attempts have already failed, so the cluster or the
   * payer is the problem and another step would pile unanchored work on top of unanchored work.
   */
  | "anchor-failed"
  /** The second model answered `escalate`, so the loop takes no further step. */
  | "escalated"
  /**
   * A session of the step failed in its sandbox for a reason that recurs on every later step — the
   * workspace tree refused, sources that no longer check, a wrapper that will not start the binary
   * (`SandboxRefused`). The step still ran, its Resolution is on chain as failed and
   * it is checkpointed; the loop stops after it, with the refusal as `stopDetail`, rather than count
   * it as one failed session and pay for the same refusal every step until `maxSteps`. Nothing
   * wipes the workspace: the owner sees why, and a reset is theirs to make.
   */
  | "sandbox"
  /**
   * The trace audit vetoed a step: the step ran, was checkpointed at 200 and not remembered. The trace
   * audit is on the roadmap, so this build never writes this reason; it stays in the union because an
   * older persisted snapshot may carry it.
   */
  | "trace-flagged"
  /** Consecutive steps failed outright; see `stopDetail`. */
  | "error";

/** What a caller persists between steps. Everything here is a string or a number on purpose. */
export interface LoopSnapshot {
  loopId: string;
  /** Steps taken, including ones that failed. */
  steps: number;
  status: "idle" | "running" | "stopped";
  stopReason?: LoopStopReason;
  /** The message behind `stopReason`, when there is one worth keeping. */
  stopDetail?: string;
  /** Seq the last step's leaf committed to. */
  lastSeq?: string;
  /** Head the last step's leaf committed to. */
  lastHead?: string;
  /** The last leaf itself, hex. */
  lastLeaf?: string;
  /** Unix ms the last step finished. */
  lastStepAt?: number;
  /** `sha256(memory)` the last step committed to — what the next step resumes from. */
  lastMemoryHash?: string;
  /** The step that produced `lastMemoryHash` (a later step may have carried it forward). */
  lastMemoryStep?: number;
  /** Micro-USDC charged across every step so far — sessions A and B, not members (`spentMicroUsdc` adds them). */
  totalCostMicroUsdc: string;
  /**
   * What the owner was charged across the loop so far, micro-USDC: sessions A and B, their
   * delegates, **and every member**, accumulated by the runner as each session finishes rather than
   * summed from a history the console caps. It is what a loop's `budgetMicroUsdc` is drawn down by.
   * Optional because an older persisted snapshot has no such key; the runner reads one of those as
   * `totalCostMicroUsdc`, which is what the owner was charged on every loop that had no members, and
   * writes the key from then on.
   */
  spentMicroUsdc?: string;
  /** Consecutive steps that failed outright, for `maxConsecutiveFailures`. */
  consecutiveFailures: number;
  /**
   * The loop's Tempo channel and what settling it came to, on the `tempo` rail only. Written
   * when the loop leaves `run()` or is stopped; a snapshot persisted mid-loop carries the
   * channel with `closed: false` and no error, which is the state a channel is in while the
   * loop is still spending through it.
   */
  tempo?: TempoSettlement;
}

/** One committed epoch, flattened for a caller that persists JSON. */
export interface LoopEpoch {
  startSeq: string;
  endSeq: string;
  root: string;
  signature: string;
  steps: number;
}

/**
 * What the second model said about a step. `unavailable` is the other half of the same field:
 * the verifier was asked and could not answer, a different fact from a loop that never asks.
 */
export type StepVerify =
  | {
      outcome: VerifyOutcome;
      /** The model's own word and its confidence, before the threshold; `followedPlan` is advisory. */
      choice?: string;
      confidence?: number;
      followedPlan?: number;
      /** The dated build resolved, the blob's hash, and the voucher delta in USDC.e base units. */
      model: string;
      verifyHash: string;
      costBase?: string;
    }
  | ({ unavailable: string } & UnansweredPaid);

/**
 * What Jev said about the goal after a step, on a goal loop whose owner turned the check on.
 * `outcome` is what the runner did: `achieved` ended the loop, `continue` did not, `unavailable`
 * left it to the agent's claim, as a loop without the check does. `claimed` is that claim either
 * way, and `disagreement` is set when the two part ways, so the row can say so.
 *
 * `goalCheckHash` is set only on a loop with no verify seat, where the answer has a blob of its own
 * under the manifest's fourteenth key; with the seat it rides in the blob `verify.verifyHash` names.
 */
export interface StepGoalCheck {
  outcome: GoalCheckOutcome;
  claimed: boolean;
  choice?: "achieved" | "continue";
  confidence?: number;
  /** The bar the answer was held to — the seat's, or the committed default. */
  bar: number;
  disagreement?: "overruled" | "unclaimed";
  /** One sentence from a fixed vocabulary; the outage's own error when `outcome` is `unavailable`. */
  reason: string;
  model?: string;
  goalCheckHash?: string;
  /** What a goal-only decision cost on the loop's channel, base units. Inside `verify` otherwise. */
  costBase?: string;
  /** A goal-only decision the channel paid for and never answered, as the seat stores one. */
  paidHash?: string;
}

/** What one step produced. */
export interface StepResult {
  /** 1-based index of this step. */
  step: number;
  sessionId: string;
  /**
   * The session's outcome; `crashed` when `start()` threw before it could resolve one;
   * `no-memory` when the trace store holds nothing under the memory this step was to resume from,
   * or bytes that do not hash to it, so no session was started at all (a store that could not be
   * read fails no step: `step()` throws, and the step is not taken). `no-payload` is what a
   * request-triggered step returns when its request's payload could not be checked; no step of
   * this build is one, and the member stays because older rows of request-triggered loops carry it.
   */
  status: SessionStatus | "crashed" | "no-memory" | "no-payload";
  reason?: string;
  steps: number;
  batchedSteps: number;
  epochs: LoopEpoch[];
  costMicroUsdc: string;
  unbilledMicroUsdc: string;
  /** Seq the leaf commits to — also the seq of the `loop.step` record itself. */
  seq?: string;
  /** Head the leaf commits to: the head after this step's resolution. */
  head?: string;
  /** `sha256(agent_id ‖ seq_le ‖ head)`, hex. */
  leaf?: string;
  manifest?: LoopStepManifest;
  /** `sha256(memory)` this step's manifest commits to, hex — what the next step is told. */
  memoryHash?: string;
  /** The step whose memory this one was resumed from, when there was one. */
  resumedFromStep?: number;
  /** The hash that memory was fetched under and re-hashed to, hex. */
  resumedMemoryHash?: string;
  /** The verdict a second model gave this step, on a loop that asked for one. */
  verify?: StepVerify;
  /** What Jev said about the goal, on a goal loop with the check on. */
  goalCheck?: StepGoalCheck;
  /**
   * The checkpoint this step still owes, when its writes did not land. The retry writes it once
   * the records are on chain, which is the only moment its leaf can be built truthfully.
   */
  deferredCheckpoint?: DeferredCheckpoint;
  /**
   * Beside a `deferredCheckpoint`: the step would have ended the loop on its goal had its writes
   * landed — Jev's _achieved_ (or the claim, without Jev) through the verdict's gate, and no veto.
   * On the result and never on the plan, whose keys are the manifest's and are written as the
   * committed path would have written them. The console reads it when a Retry lands the plan, and
   * ends the run there instead of putting it back on its schedule, where it would pay for more
   * steps toward a goal already reached.
   */
  deferredGoalReached?: true;
  /** The `loop.step` record, when one was written. */
  record?: { seq: string; head: string; signature: string };
  /**
   * What `work` threw, when a step's extra chain work failed. The step still checkpoints: a
   * session that has already resolved on chain must not be left without the record closing it.
   */
  workError?: string;
  /**
   * Why the step failed, when it was not the work's fault: `no-answer`, a model call of the step's
   * session got no answer on any attempt (`SessionResult.cause`).
   * The step is checkpointed and the loop goes on as after any failed step; this is what lets its
   * row say so in place of a bare _failed_. Absent on every other step.
   */
  cause?: "no-answer";
  /**
   * USDC.e base units Lath paid for this step's chat attempts that got no answer, which the owner
   * was not charged for. Absent when there were none.
   */
  absorbedBase?: string;
  /**
   * False when the record did not land at the seq its leaf commits to — something else appended
   * to this chain between the resolution and the checkpoint. The leaf is then a commitment to a
   * seq the record does not occupy, and a verifier will say so; this flag says it first.
   */
  leafOk: boolean;
  startedAt: number;
  endedAt: number;
}

/**
 * A step's `cause` and `absorbedBase`, from its session: spread onto every `StepResult` a step
 * returns, so a step with neither carries neither key.
 */
function noAnswerOf(session: SessionResult): Pick<StepResult, "cause" | "absorbedBase"> {
  const failed = session.cause === "no-answer" && session.workStatus === "failed";
  const absorbed = session.absorbedBase ?? 0n;
  return {
    ...(failed ? { cause: "no-answer" as const } : {}),
    ...(absorbed > 0n ? { absorbedBase: absorbed.toString() } : {}),
  };
}

/** What `onEvent` reports as a loop runs. */
export interface LoopEvent {
  type:
    | "step:start"
    | "step:end"
    | "memory"
    | "verify"
    | "goal"
    | "checkpoint"
    | "settlement"
    | "storage"
    | "stopped"
    | "error";
  loopId: string;
  /** The loop's own agent. */
  agentId: string;
  timestamp: number;
  step?: number;
  sessionId?: string;
  seq?: string;
  head?: string;
  leaf?: string;
  signature?: string;
  status?: StepResult["status"];
  reason?: LoopStopReason;
  detail?: string;
  costMicroUsdc?: string;
  /** `memory` events: the hash the step resumed from, or committed. */
  memoryHash?: string;
  /** `verify` and `goal` events: what the model said, or why it could not be asked. */
  outcome?: VerifyOutcome | GoalCheckOutcome;
  choice?: string;
  confidence?: number;
  verifyHash?: string;
  unavailable?: string;
  error?: string;
}

/** What `LoopRunnerOptions.work` is handed: the step that is running and the session it ran. */
export interface StepWork {
  /** 1-based index of this step. */
  step: number;
  sessionId: string;
  /** The session this step already resolved on chain. */
  session: SessionResult;
}

export interface LoopRunnerOptions {
  /**
   * The agent this loop runs. Build it with `rollup` on and a `batchSize` comfortably above the
   * tool steps one step can take, so a step produces exactly one epoch; see the class note.
   */
  runtime: AgentRuntime;
  /** Stable across restarts: it is in every step's manifest and in every session id. */
  loopId: string;
  /** The standing instruction. Every step runs this same prompt. */
  prompt: string;
  /**
   * What done looks like — separate from the standing instruction, which says what to do each
   * step. Absent is a loop without a goal, byte for byte: no goal message in the session, no
   * `goalHash` in the manifest or the genesis, and no terminal step.
   *
   * Only `sha256(goal)` reaches the chain. The text itself is the owner's, shown to them by the
   * console and committed by its hash the way `promptHash` commits the instruction.
   */
  goal?: string;
  /** Scheduled gap between steps, ms. `run()` waits this long *after* each step. */
  intervalMs: number;
  /** Hard ceiling on steps. The loop stops itself at it. */
  maxSteps: number;
  /** The user whose balance each step is debited against, and the genesis `caller`. */
  user: PublicKey;
  /**
   * Per-step spend ceiling, micro-USDC. This **is** the runtime's `policy.maxCost` — the runtime
   * enforces it per `start()`, and `policy_version_hash` in every genesis commits to it — so it
   * is checked against the runtime rather than applied to it. Passing a different number would
   * mean the chain named one budget and the loop enforced another. Omit it to take the
   * runtime's.
   *
   * Ignored when `budgetMicroUsdc` is set: a loop with one overall budget commits that budget as
   * `maxCost`, and the per-step number the console still stores beside it is a derived
   * compatibility field, not a ceiling anything enforces.
   */
  budgetMicroUsdcPerStep?: number;
  /**
   * The loop's one overall budget, micro-USDC. Absent is the older per-step loop, byte for byte:
   * `maxCost` is its per-step budget and nothing else bounds it.
   *
   * Set, it must equal the runtime's `policy.maxCost` — the constant each genesis commits through
   * `policy_version_hash` — and the runner enforces what is *left* of it,
   * `budgetMicroUsdc − snapshot.spentMicroUsdc`, as an unhashed spend ceiling on every session of
   * a step. Crossing it resolves that session `aborted` with
   * a `LoopBudgetExhausted`, and the loop stops `budget` after the step's checkpoint.
   */
  budgetMicroUsdc?: bigint;
  /** Unix ms the loop was created. Defaults to now; pass the stored value when resuming. */
  startedAt?: number;
  /** State from a previous process. */
  resume?: LoopSnapshot;
  /**
   * Consecutive steps that may fail outright before the loop stops itself. A step whose session
   * resolved (even `failed`) is not one of these — a tool that threw is information, not a
   * broken loop. Default 3.
   */
  maxConsecutiveFailures?: number;
  /**
   * Extra chain work this step does *after* its session has resolved and its epoch is committed,
   * and *before* the checkpoint leaf is built — so whatever it writes lands inside the boundary
   * the leaf commits to, and one step is still one leaf however much happened in it.
   *
   * A throw is recorded as `workError` and emitted, and the step still writes its record.
   */
  work?: (ctx: StepWork) => Promise<unknown>;
  /**
   * The Tempo channel every step of this loop pays its inference through, on that rail. One
   * channel per runner, opened lazily by the transport on the first call and closed exactly once
   * here — never per step and never scoped to the console's run slot, which lapses on a TTL under
   * a wedged drain. The runtime of a loop is **not** given one: a per-session close would
   * settle the loop's channel after its first step.
   */
  tempo?: TempoChannel;
  /**
   * A second model judges each successful step before its output becomes memory; absent is a loop
   * that no second model judges. The same pair must be in the
   * runtime's policy, which commits it through `policy_version_hash`, so it is checked against
   * the runtime rather than applied to it, as `budgetMicroUsdcPerStep` is.
   */
  verify?: { model: string; minConfidence: number };
  /**
   * Jev's goal check: after each step, the pinned decision model answers
   * whether the goal is achieved, and its answer — not the agent's `GOAL REACHED` — ends the loop.
   * Needs a `goal`; on a loop with `verify` both values must be the seat's, because one call asks
   * both. The same pair must be in the runtime's policy, checked the way `verify` is. Absent is a
   * goal loop stopped by the agent's own claim.
   */
  goalCheck?: { model: string; minConfidence: number };
  /**
   * The loop's Tempo services: the object the console keeps for the loop's whole run, which starts
   * its jobs after each leaf and holds what came back until a runner writes it. Absent — every loop
   * with no treasury, and every older loop — is a loop without them, byte for byte: no job, no
   * `storage.put`, no fifteenth manifest key.
   */
  tempoServices?: LoopTempoServices;
  /**
   * The file a step leaves as its report, read after its leaf has landed and off its clock, or
   * `null` when it wrote none. The console reads it out of the sandbox's workspace record
   * (`@lath/runtime/zeroclaw/report`); it is injected because that module walks trees with Node's
   * filesystem and this one ships in a browser bundle. Without it no report is published.
   */
  stepReport?: (ctx: { step: number; session: SessionResult }) => Promise<StorageReportFile | null>;
  /** Observer. Never awaited; a throwing observer does not stop a loop. */
  onEvent?: (event: LoopEvent) => void;
  /**
   * Told the loop's owner total, micro-USDC, every time it grows: what `snapshot().spentMicroUsdc`
   * holds **plus** what every session still running has metered so far — so a session mid-step
   * that has paid for three calls is in it before it resolves, and a console can show (and
   * persist) spend as it happens rather than at the checkpoint. Monotonic: it is never called with
   * a smaller number than before. A caller persisting it takes `max(stored, value)`, which makes a
   * repeated or late call harmless. A throw from it is swallowed.
   */
  onSpend?: (spentMicroUsdc: bigint) => void;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Sleep override, so a test does not wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

/** The step's session outcome, as the `status` field of the `loop.step` action. */
function stepStatusCode(status: StepResult["status"]): LoopStepStatus {
  if (status === "success") return LoopStepStatus.Success;
  if (status === "aborted") return LoopStepStatus.Aborted;
  return LoopStepStatus.Failed;
}

/**
 * Why a session stopped, in the loop's vocabulary.
 *
 * The runtime turns a breached budget into `aborted` and a refused charge into `failed`, both
 * with the message the exception carried (`BudgetExceeded`, `ChargeFailed` in `runtime.ts`);
 * neither should be caught here — `start()` never throws them, it resolves them onto the chain.
 * So the classification is over the resolved session, which is also what a reader replaying the
 * chain sees. A budget breach is the one read by type: `start()` hands the breach back as
 * `budgetStop`, because the loop's remaining-budget stop (`LoopBudgetExhausted`) has a sentence
 * of its own and a classification that parsed wording would miss it.
 *
 * Exported so a suite can hold a resolved session to its classification without running a step,
 * and so nothing outside the runner grows a second copy of it.
 */
export function stopReasonFor(session: SessionResult): LoopStopReason | null {
  // An anchored session is the one case the chain does *not* show, and it is checked first: the
  // runtime does not re-decide `status` after the Resolution is written — that would leave the
  // record and the return value disagreeing — so a session whose writes are stuck in the queue
  // resolves `success` with `anchor.failed` above zero. That is a write failure, whatever the
  // session itself said.
  if ((session.anchor?.failed ?? 0) > 0) return "anchor-failed";
  // Before the budget and the charge: a refused sandbox is refused again on the next step whatever
  // else this one ran into, so it is the reason the owner has to act on first.
  if (sandboxRefusalOf(session)) return "sandbox";
  const reason = session.reason ?? "";
  // By type first: `start()` hands back the breach it resolved on, a `BudgetExceeded` for
  // `maxCost` or its `LoopBudgetExhausted` subclass for the loop's remaining budget. The wording
  // is the fallback for a result that did not come through this build's `start()` — a runtime
  // that sets no `budgetStop`, or a test's hand-made session — and it matches only the `maxCost`
  // sentence, which is the one such a result can carry.
  if (session.status === "aborted" && (session.budgetStop instanceof BudgetExceeded || /µUSDC budget/.test(reason))) {
    return "budget";
  }
  if (session.status === "failed" && /^billing charge failed/.test(reason)) return "charge-failed";
  return null;
}

/**
 * The recurring sandbox refusal a session resolved with (`SandboxSessionResult.sandboxRefused`,
 * set by `ZeroClawRuntime.start`), or `undefined`. Read off the result rather than decided here:
 * the runtime is the one that knows which failures a later step would meet unchanged, and the
 * session's `reason` is the chain's sentence, which this module does not parse for it. The import is
 * type-only, so the runner stays free of the Node-only sandbox module.
 */
function sandboxRefusalOf(session: SessionResult | undefined): string | undefined {
  const refused = (session as SandboxSessionResult | undefined)?.sandboxRefused;
  return typeof refused === "string" && refused.length > 0 ? refused : undefined;
}

/** What a session's meter says the owner was charged: its own debits and its delegates'. */
function ownerOf(m: Pick<SessionMeter, "spent" | "delegated">): bigint {
  return m.spent + m.delegated;
}

/**
 * The loop's owner total, metered **live**, so parallel sessions cannot each spend the whole
 * remainder. Two parts: `settled`, the snapshot's `spentMicroUsdc`, which every session adds to
 * once as it ends; and `live`, what each session still running has metered so far, reported by the
 * runtime's `onMeter` after every paid call it records — the step's session, and a delegate child
 * through its parent. The remaining-budget ceiling handed to a session is
 * `budget − settled − Σ live of every *other* running session`: the runtime compares it with the
 * session's own meter, so the sum is `budget − everything metered so far` and a member sees its
 * siblings' spend the moment a call of theirs is recorded, not when they resolve.
 *
 * **The overshoot bound.** A call's price is known only once it is answered, so a session asks
 * "is anything left?" before each call and learns what the call cost after it. The loop can
 * therefore end above its budget by exactly the calls that were in flight when the last check
 * passed: at most **one call per session running concurrently at that moment** (the step's session;
 * a `delegate` child stands in for its parent's call, since the parent makes none while it waits).
 * With one session running it is the one call in flight.
 * Nothing else can overshoot: every check after that sees the in-flight calls' cost.
 *
 * Unbilled spend is not the owner's and is not counted here, as the settled total never counted
 * it; the session's own ceiling still counts it over its own meter, as `maxCost` always has.
 */
class OwnerSpend {
  private readonly live = new Map<number, bigint>();
  private nextKey = 0;
  private reported: bigint;
  constructor(
    private readonly state: () => LoopSnapshot,
    private readonly budget: bigint | undefined,
    private readonly onSpend?: (spentMicroUsdc: bigint) => void
  ) {
    this.reported = this.settled();
  }

  settled(): bigint {
    return BigInt(this.state().spentMicroUsdc ?? "0");
  }

  /** Settled plus every running session's metered spend. */
  total(): bigint {
    let t = this.settled();
    for (const v of this.live.values()) t += v;
    return t;
  }

  /**
   * One session's share: the start options that meter it live (and bound it, on a loop with a
   * budget), and `settle`, called exactly once when `start()` returns or throws.
   */
  open(): { options: SessionSpendOptions; settle: (session?: SessionResult) => void } {
    const key = this.nextKey++;
    this.live.set(key, BigInt(0));
    const budget = this.budget;
    const options: SessionSpendOptions = {
      onMeter: (m) => {
        const owner = ownerOf(m);
        if (!this.live.has(key) || owner <= (this.live.get(key) ?? BigInt(0))) return;
        this.live.set(key, owner);
        this.report();
      },
    };
    if (budget !== undefined) {
      options.spendCeilingMicroUsdc = () => {
        let others = BigInt(0);
        for (const [k, v] of this.live) if (k !== key) others += v;
        return budget - this.settled() - others;
      };
    }
    let settled = false;
    const settle = (session?: SessionResult) => {
      if (settled) return;
      settled = true;
      const metered = this.live.get(key) ?? BigInt(0);
      this.live.delete(key);
      // A resolved session's result is what it charged. One whose `start()` threw has none, and
      // what its meter reported is all there is of the calls it paid for before it threw; counting
      // nothing for it would make a crash's spend vanish from the budget.
      // `BigInt(...)` because a result from a runtime this build did not write may carry numbers.
      const owner = session ? BigInt(session.costMicroUsdc ?? 0) + BigInt(session.delegatedMicroUsdc ?? 0) : metered;
      if (owner !== BigInt(0)) {
        const state = this.state();
        state.spentMicroUsdc = (BigInt(state.spentMicroUsdc ?? "0") + owner).toString();
      }
      this.report();
    };
    return { options, settle };
  }

  /**
   * A debit no session metered — a `storage.put`'s — added to the
   * settled total once, when its Action is written, so the loop's remaining budget and the owner
   * total a console shows both count it like a model call.
   */
  add(amount: bigint): void {
    if (amount <= BigInt(0)) return;
    const state = this.state();
    state.spentMicroUsdc = (BigInt(state.spentMicroUsdc ?? "0") + amount).toString();
    this.report();
  }

  private report(): void {
    const total = this.total();
    if (total <= this.reported) return;
    this.reported = total;
    if (!this.onSpend) return;
    try {
      this.onSpend(total);
    } catch {
      // An observer; it cannot stop a loop.
    }
  }
}

/** What `OwnerSpend.open` spreads into a session's start options. */
interface SessionSpendOptions {
  onMeter: (meter: Readonly<SessionMeter>) => void;
  spendCeilingMicroUsdc?: () => bigint;
}

/**
 * A session's share of the owner total, or nothing at all without a tracker: a runner a suite builds
 * in part has none, and a throw inside a session's start would turn a finished session into a crashed one.
 */
function openSpend(spend: OwnerSpend | undefined): {
  options: Partial<SessionSpendOptions>;
  settle: (session?: SessionResult) => void;
} {
  return spend ? spend.open() : { options: {}, settle: () => undefined };
}

/** One attempt, and it gives up here rather than holding a step open on an alpha endpoint. */
const VERIFY_TIMEOUT_MS = 20_000;

/**
 * The loop's verifier is the runtime's own transport, so a decision rides the channel the steps
 * already pay on and no second payer appears in the blob. The cast reaches past `private
 * transport` on `AgentRuntime`; making that field `readonly` is owed elsewhere. A transport with
 * no `decide` is not an error here — it is what the runner reports as `unavailable`.
 */
function deciderOf(runtime: AgentRuntime): AbortableDecider | undefined {
  const t = runtime.transport;
  return typeof t.decide === "function" ? (t as AbortableDecider) : undefined;
}

/** Channel ids are hex either case; which one a writer used must not decide anything. */
function sameChannel(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export class LoopRunner {
  readonly loopId: string;
  readonly prompt: string;
  readonly promptHash: string;
  /** What done looks like, trimmed; `undefined` on a loop without one. */
  readonly goal?: string;
  /** `sha256(goal)` hex, computed once here because it is in every step's manifest. */
  readonly goalHash?: string;
  readonly intervalMs: number;
  readonly maxSteps: number;
  readonly startedAt: number;
  readonly runtime: AgentRuntime;
  readonly agentId: Bytes32;
  private readonly user: PublicKey;
  private readonly maxConsecutiveFailures: number;
  private readonly onEvent?: (event: LoopEvent) => void;
  private readonly work?: (ctx: StepWork) => Promise<unknown>;
  private readonly now: () => number;
  private readonly sleepFor: (ms: number) => Promise<void>;
  /** Full-mode logger for the checkpoint: the step record must be a record a `memcmp` can find. */
  private readonly checkpoints: AgentLogger;
  /**
   * The chain's tip as this runner's own writes left it — the next seq and the head before it — over
   * every record it wrote or journaled itself: a session's records, an epoch it flushed, a member's
   * `delegate.<name>` Action, the feed record. The checkpoint's fallback and
   * floor (`writeLoopCheckpoint`): taken from the closing session alone, it sat behind whatever this
   * runner wrote after that session, so with an indexer that could not answer the leaf named a seq
   * several records back, the record landed later, and `leafOk` was false. Only ever raised.
   */
  private ownTip?: { seq: bigint; head: Uint8Array };
  private readonly tempo?: TempoChannel;
  /** The pinned judge and its bar, when this loop asked for one. */
  private readonly verify?: { model: string; minConfidence: number };
  /** Jev's goal check and its bar, when this goal loop asked for one. */
  private readonly goalCheck?: { model: string; minConfidence: number };
  /** The loop's one overall budget, µUSDC; `undefined` on a loop whose `maxCost` is per step. */
  readonly budgetMicroUsdc?: bigint;
  /**
   * The owner total, metered live, and the remaining-budget ceiling every session of a step is
   * bounded by when the loop has a budget (see `OwnerSpend`). On a loop without one no session is
   * given a ceiling at all; each is still metered, so `onSpend` sees spend as it happens.
   */
  private readonly spend: OwnerSpend;
  private state: LoopSnapshot;
  private inFlight: Promise<StepResult> | null = null;
  /** Set while `run()` is stepping, so `stop()` knows the run's own exit will settle. */
  private running = false;
  /** The one settlement, so `run()` and `stop()` racing cannot close a channel twice. */
  private settling: Promise<TempoSettlement | undefined> | null = null;
  /** Resolves the current `run()` sleep early when `stop()` is called. */
  private nudgeSleeper: (() => void) | null = null;
  private readonly tempoServices?: LoopTempoServices;
  private readonly stepReport?: LoopRunnerOptions["stepReport"];
  /**
   * `storage.put` Actions whose direct `chargeAndLog` threw in doubt (no anchor queue): the charge and
   * the record share one transaction, so the record being on the chain is the charge having landed.
   * Resolved at the next quiet point (`resolveParkedPuts`). In memory: a process that restarts with
   * one parked loses only the chance to count it, never sends it twice.
   */
  private parkedPuts: ParkedPut[] = [];
  /**
   * Why this runner refuses every step, when its policy names protocol-plugin grants or a Solana key
   * (the constructor says why); `undefined` on every loop this build starts.
   */
  private readonly grantsRefused?: string;

  constructor(opts: LoopRunnerOptions) {
    this.runtime = opts.runtime;
    this.agentId = opts.runtime.agentId;
    this.loopId = opts.loopId;
    this.prompt = opts.prompt;
    this.promptHash = promptHash(opts.prompt);
    // Trimmed-empty is no goal, the same normalisation `goalHash` hashes under and the console
    // stores under: a blank textarea must not put a tenth key in a manifest or a goal message in
    // a session. Hashed once, because every step of the loop commits the same value.
    this.goal = opts.goal?.trim() || undefined;
    this.goalHash = this.goal ? goalHash(this.goal) : undefined;
    this.intervalMs = opts.intervalMs;
    this.maxSteps = opts.maxSteps;
    this.user = opts.user;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.onEvent = opts.onEvent;
    this.work = opts.work;
    this.now = opts.now ?? Date.now;
    this.sleepFor = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startedAt = opts.startedAt ?? this.now();
    this.tempo = opts.tempo;
    this.verify = opts.verify;
    this.goalCheck = opts.goalCheck;
    this.tempoServices = opts.tempoServices;
    this.stepReport = opts.stepReport;

    // Mutual, in both directions. The runner asking for a judge the policy does not name is
    // refused; so is the reverse — a policy that names one under a runner with no `verify` — and it
    // is the worse of the two: every genesis would commit a judge through `policy_version_hash` and
    // no step would ever be judged, so the chain would say the loop was verified and nothing
    // verified it. One comparison for both, so the guard cannot go one-directional.
    const pv = this.runtime.policy.verify;
    const agreed = opts.verify
      ? pv?.model === opts.verify.model && pv?.minConfidence === opts.verify.minConfidence
      : pv === undefined;
    if (!agreed) {
      const asked = opts.verify ? `${opts.verify.model} at ${opts.verify.minConfidence}` : "nothing";
      const said = pv ? `${pv.model} at ${pv.minConfidence}` : "nothing";
      throw new Error(
        `this loop verifies with ${asked} and its runtime says ${said}; build the two with the same ` +
          "`verify`, because `policy_version_hash` commits it"
      );
    }

    // The goal check, held to the same mutual rule and for the same reason: every genesis
    // commits it through `policy_version_hash`, so a runner that asked a check the policy does not
    // name, or a policy naming one no runner asks, would put a claim on the chain nothing backs.
    // And two rules of its own: a check needs a goal to ask about, and beside the verify seat it is
    // the seat's model and bar, because one call asks both.
    const pg = this.runtime.policy.goalCheck;
    const goalAgreed = opts.goalCheck
      ? pg?.model === opts.goalCheck.model && pg?.minConfidence === opts.goalCheck.minConfidence
      : pg === undefined;
    if (!goalAgreed) {
      const asked = opts.goalCheck ? `${opts.goalCheck.model} at ${opts.goalCheck.minConfidence}` : "nothing";
      const said = pg ? `${pg.model} at ${pg.minConfidence}` : "nothing";
      throw new Error(
        `this loop checks its goal with ${asked} and its runtime says ${said}; build the two with the same ` +
          "`goalCheck`, because `policy_version_hash` commits it"
      );
    }
    if (opts.goalCheck && !this.goal) {
      throw new Error("Jev's goal check needs a goal to ask about, and this loop has none");
    }
    if (
      opts.goalCheck &&
      opts.verify &&
      (opts.goalCheck.model !== opts.verify.model || opts.goalCheck.minConfidence !== opts.verify.minConfidence)
    ) {
      throw new Error(
        "beside the verify seat the goal check is the seat's own model and bar, because one decision asks both"
      );
    }

    // Protocol-plugin grants (`squads.pay`, `sas.attest`) are on the roadmap, and this runner has no
    // hook to act on them. A policy naming grants or a loop's Solana key belongs to an older run: its
    // runner may still settle the loop's channel, but refuses every step, because a step run without
    // the grants its Genesis committed would drop every `PROPOSE:` line with no record, which the
    // audit could not tell from a step that proposed nothing.
    const pgr = this.runtime.policy.grants;
    const psk = this.runtime.policy.solanaKey;
    if (pgr || psk) {
      this.grantsRefused = `has a policy naming ${
        pgr ? "protocol-plugin grants" : "a Solana key"
      }, which this build does not run (squads.pay and sas.attest are on the roadmap)`;
    }

    // A team (`policy.workers`) is not in this build, and neither is the runner's fan-out to it, so
    // a runtime whose policy names one would commit, in every genesis through `policy_version_hash`,
    // a roster no step of this runner hands anything to. Refused at construction, before anything is
    // spent; the console stops an older run that carries a team before it builds a runner, and
    // settles it under a policy that names none.
    if (this.runtime.policy.workers !== undefined) {
      throw new Error(
        "this runtime's policy names a team, and this build runs none: a loop with a team is on the roadmap; " +
          "its chain still verifies"
      );
    }

    if (opts.budgetMicroUsdc !== undefined) {
      // The whole budget is the policy's `maxCost`, so the genesis of every step names the budget
      // the runner enforces a remainder of. A different number would be the chain naming one budget
      // and the loop spending against another — the same reason the per-step check below exists.
      if (opts.budgetMicroUsdc <= BigInt(0)) throw new Error("a loop's budget must be above zero");
      if (BigInt(this.runtime.policy.maxCost) !== opts.budgetMicroUsdc) {
        throw new Error(
          `the loop's budget is the runtime's own \`maxCost\` (${this.runtime.policy.maxCost} µUSDC), which every ` +
            `genesis event commits to through \`policy_version_hash\`; build the runtime with ` +
            `${opts.budgetMicroUsdc} µUSDC rather than passing it here`
        );
      }
    } else if (
      opts.budgetMicroUsdcPerStep !== undefined &&
      opts.budgetMicroUsdcPerStep !== this.runtime.policy.maxCost
    ) {
      throw new Error(
        `the per-step budget is the runtime's own \`maxCost\` (${this.runtime.policy.maxCost} µUSDC), which every ` +
          `genesis event commits to through \`policy_version_hash\`; build the runtime with ` +
          `${opts.budgetMicroUsdcPerStep} µUSDC rather than passing it here`
      );
    }
    if (!this.runtime.batcher) {
      throw new Error("a loop needs a runtime with `rollup` on: one epoch per step is what makes a step cheap");
    }

    this.checkpoints = new AgentLogger(this.runtime.client, this.agentId, {
      store: this.runtime.store,
      compact: false,
      storePayloads: this.runtime.storePayloads,
      now: this.now,
    });

    this.state = opts.resume
      ? {
          ...opts.resume,
          loopId: this.loopId,
          // An older snapshot has no owner total; `totalCostMicroUsdc` is the nearest thing it
          // kept, and exactly right for a loop that never had members.
          spentMicroUsdc: opts.resume.spentMicroUsdc ?? opts.resume.totalCostMicroUsdc ?? "0",
        }
      : {
          loopId: this.loopId,
          steps: 0,
          status: "idle",
          totalCostMicroUsdc: "0",
          spentMicroUsdc: "0",
          consecutiveFailures: 0,
        };

    this.budgetMicroUsdc = opts.budgetMicroUsdc;
    this.spend = new OwnerSpend(() => this.state, opts.budgetMicroUsdc, opts.onSpend);
  }

  /** What is left of the loop's budget, µUSDC, floored at zero; `undefined` on a loop without one. */
  get remainingMicroUsdc(): bigint | undefined {
    if (this.budgetMicroUsdc === undefined) return undefined;
    // Live, so a step still running is counted: what a session starting now would be allowed.
    const left = this.budgetMicroUsdc - this.spend.total();
    return left > BigInt(0) ? left : BigInt(0);
  }

  /** State to persist between steps. A plain object; safe to `JSON.stringify`. */
  snapshot(): LoopSnapshot {
    return { ...this.state };
  }

  /**
   * Micro-USDC per step: the runtime's `maxCost` on a loop without an overall budget, which is what
   * it enforces per session; on one with a budget, the derived `floor(budget ÷ maxSteps)` the
   * console stores for an older reader that expects a per-step number — a share, not a ceiling
   * anything enforces.
   */
  get budgetMicroUsdcPerStep(): number {
    if (this.budgetMicroUsdc === undefined) return this.runtime.policy.maxCost;
    return Number(this.budgetMicroUsdc / BigInt(Math.max(1, this.maxSteps)));
  }

  /** Would another step be taken? False once the loop is stopped or has taken them all. */
  get runnable(): boolean {
    return this.state.status !== "stopped" && this.state.steps < this.maxSteps;
  }

  /** Unix ms the next step is due, or `null` when there is not going to be one. */
  get nextStepAt(): number | null {
    if (!this.runnable) return null;
    return this.state.lastStepAt ? this.state.lastStepAt + this.intervalMs : this.now();
  }

  /**
   * Stops the loop before its next step. A step already in flight is *not* interrupted: it
   * finishes and writes its checkpoint, so the chain never carries half a step. Idempotent.
   */
  stop(reason: LoopStopReason = "stopped", detail?: string): LoopSnapshot {
    if (this.state.status !== "stopped") {
      this.state.status = "stopped";
      this.state.stopReason = reason;
      this.state.stopDetail = detail;
      this.emit({ type: "stopped", reason, detail });
    }
    this.nudgeSleeper?.();
    // A loop driven by `run()` settles on the way out of it, and a step in flight must finish
    // paying before its channel is closed. What is left is the shape the console's scheduler
    // uses — a runner stepped from outside, with no `run()` to leave — and for that this is the
    // last moment the channel can be closed at all. `settle()` is idempotent, so a stop that
    // races the run's own exit closes nothing twice; `await runner.settle()` is how a caller
    // waits for it.
    if (!this.running && !this.inFlight) void this.settle().catch(() => undefined);
    return this.snapshot();
  }

  /**
   * Closes the loop's Tempo channel, flushes whatever is batched, and writes the one
   * `Action{tool_id: "loop.settlement"}` that records the settlement on the loop's own chain.
   *
   * Idempotent and never throwing: a close that fails is `tempo.closed: false` with the reason
   * on the snapshot, the same shape a failed epoch flush and a failed drain report, and
   * the channel id is kept so a retry has something to re-read. A loop whose steps were paid for
   * is not failed by its receipt.
   *
   * The record is written through the checkpoint logger — full mode, one real seq, folded into
   * the head by the §4.4 formula — rather than batched into an epoch: an epoch root is built
   * from step leaves and has nowhere to put this, and `listByTool` is how a reader finds it.
   *
   * On a chain whose anchor journal still owes writes the channel is closed all the same, and the
   * record is not written: the snapshot says `tempo.recordOwed`, and the loop's Retry writes it
   * once the journal has drained and the step's deferred checkpoint has landed. A direct
   * write there would take the seq a journaled record is holding, which no retry recovers from.
   *
   * Nothing here needs a step to have run in *this* process. The console settles a
   * loop's channel from a runner it builds for the purpose — on stop, on the idle timer, and on
   * the restart path, where the channel was closed from outside and `close()` only hands back the
   * receipt someone else made. Such a runner carries the loop's `resume` snapshot and no step of
   * its own: `steps` comes from the snapshot, the seq comes from the chain, and `flushEpochs()`
   * is a no-op because nothing is batched.
   */
  async settle(): Promise<TempoSettlement | undefined> {
    if (!this.tempo) return undefined;
    if (this.settling) return this.settling;
    this.settling = this.runSettlement();
    return this.settling;
  }

  private async runSettlement(): Promise<TempoSettlement | undefined> {
    const channel = this.tempo!;
    const base = { payer: channel.payer, channelId: channel.channelId };
    // The loop's Tempo services drain first: every PUT and read still in flight finishes, and
    // the `storage.put` Actions the PUTs owe are written ahead of the settlement record, so an audit
    // never finds a payment the record does not. Before either channel closes — a read still queued
    // on the RPC channel is one its close would otherwise cut — and before the branch below, so a
    // loop whose model channel paid nothing still settles its RPC channel.
    const services = this.tempoServices;
    const writePuts = async () => {
      try {
        if (!this.runtime.anchor) await this.runtime.flushEpochs();
        await this.writeStoragePuts();
      } catch (e) {
        this.emit({
          type: "error",
          error: `the storage.put Actions of loop ${this.loopId} were not written at its stop: ${
            (e as any)?.message ?? String(e)
          }`,
        });
      }
    };
    // Bounded: a storage gateway or RPC that stalls must not keep the model channel, and the
    // loop's whole remaining deposit in it, open behind a PUT or a read. Past the bound the channel
    // closes first. Whatever was still in flight is waited out by `services.close()` below, and its
    // Actions are written there, still ahead of the settlement record that names them.
    const drained = services ? await services.drain(services.stopDrainMs) : true;
    if (services) await writePuts();
    // Nothing was opened: no step of this loop made a paid call, so there is nothing held and
    // nothing to record on chain. A runner built only to settle starts from a snapshot that
    // may already name a real settlement of an earlier channel, and `snapshot.tempo` is the
    // loop's *last* settlement — overwriting one that has a txHash with this empty answer would
    // drop the transaction a reader takes from it.
    if (!channel.opened) {
      const earlier = this.state.tempo;
      if (!earlier?.txHash || (channel.channelId && sameChannel(earlier.channelId, channel.channelId))) {
        this.state.tempo = { ...base, closed: true };
      }
      if (services) {
        await services.close();
        // The PUTs the bounded drain did not wait for: their Actions, as an unbounded one wrote them.
        if (!drained) await writePuts();
      }
      return this.state.tempo;
    }

    let settlement: TempoSettlement;
    try {
      const receipt = await channel.close();
      settlement = { ...base, channelId: channel.channelId, closed: true, ...receipt };
    } catch (e) {
      settlement = { ...base, channelId: channel.channelId, closed: false, error: (e as any)?.message ?? String(e) };
    }
    // Then the services' half of the stop record: the block the close settled in, read over the RPC
    // channel while it is still open, then that channel's own close, then whatever no leaf carried —
    // the Actions the drain just wrote and the snapshot after the last leaf. The replay of an owed
    // record hands `services` back through its `close()`, so it is kept rather than rebuilt there.
    if (services) {
      const closeBlock = settlement.txHash ? await services.blockOf(settlement.txHash) : undefined;
      const closed = await services.close();
      // A PUT that came back after the bounded drain gave up has its Action written now, before the
      // carry is read, so the record below names it the way it names every PUT the drain waited for.
      if (!drained) await writePuts();
      const carry = services.carry();
      const last = services.lastSnapshot;
      settlement.services = {
        v: TEMPO_CARRY_VERSION,
        ...(carry?.storage ? { storage: carry.storage } : {}),
        ...(carry?.snapshots ? { snapshots: carry.snapshots } : {}),
        ...(last ? { lastSnapshot: last } : {}),
        ...(closeBlock ? { closeBlock } : {}),
        ...(closed.rpc ? { rpc: closed.rpc } : {}),
      };
      if (carry) services.carried(carry);
    }
    this.state.tempo = settlement;

    // A direct write on a chain whose journal owes a record takes that record's seq, and the
    // retry then diverges for good. Settle the money now; write the record only over a chain the
    // queue has finished with. `drain` loads the on-disk journal for
    // a runner built in a new process, rejects at once on a halted queue, and is a no-op on a
    // healthy one. The epoch flush is inside the same guard because, anchored, it is a journaled
    // write with a barrier drain of its own, and fails the same way for the same reason.
    //
    // The owed record is the Retry's to write (`retryLoopAnchor` in the console), after the
    // step's records and its deferred checkpoint — the order a chain would have had anyway.
    // `recordOwed` lives on the snapshot only: the blob below is built from `settlement`, so the
    // record the Retry writes hashes the bytes this one would have.
    if (this.runtime.anchor) {
      try {
        await this.runtime.flushEpochs();
        await this.runtime.anchor.queue.drain(this.agentId);
      } catch (e) {
        const detail = (e as any)?.message ?? String(e);
        this.state.tempo = { ...settlement, recordOwed: true };
        this.emit({
          type: "error",
          error: `the settlement record of loop ${this.loopId} waits behind a failed chain write; Retry writes it: ${detail}`,
        });
        return this.state.tempo;
      }
    }

    // The epoch first, so the settlement record takes the seq after the last step's rather than
    // landing inside a batch that has not been committed yet.
    try {
      if (!this.runtime.anchor) await this.runtime.flushEpochs();
      const record = await this.checkpoints.action({
        toolId: LOOP_SETTLEMENT_TOOL,
        args: utf8(canonicalJson({ loopId: this.loopId, steps: this.state.steps, ...base })),
        result: utf8(canonicalJson(settlement)),
        statusCode: settlement.closed ? 200 : 500,
      });
      this.emit({
        type: "settlement",
        seq: record.seq.toString(),
        head: hex(record.head),
        signature: record.signature,
        detail: settlement.txHash ?? settlement.error,
      });
    } catch (e) {
      // The channel is closed either way; what failed is the record of it. Said out loud rather
      // than thrown, because the caller is already on its way out of the loop — and owed, the
      // same debt a halted journal leaves above: with only `error` set, nothing would write the
      // record again, and a healthy chain whose one write failed would lose it for good. The
      // Retry replays the stored receipt, so the record it writes hashes the bytes this one would
      // have; `error` stays for the page, and is not in those bytes either.
      const detail = (e as any)?.message ?? String(e);
      this.state.tempo = {
        ...settlement,
        recordOwed: true,
        error: settlement.error ?? `the settlement record did not land: ${detail}`,
      };
      this.emit({ type: "error", error: `the settlement record of loop ${this.loopId} did not land: ${detail}` });
    }
    return this.state.tempo;
  }

  /**
   * One step. Refuses rather than queues if one is already running, because two steps on one
   * chain would race for the seq their leaves commit to.
   */
  async step(): Promise<StepResult> {
    if (this.inFlight) throw new Error(`loop ${this.loopId} already has a step in flight`);
    if (this.state.status === "stopped") {
      throw new Error(`loop ${this.loopId} is stopped (${this.state.stopReason ?? "unknown"})`);
    }
    if (this.state.steps >= this.maxSteps) {
      throw new Error(`loop ${this.loopId} has taken all ${this.maxSteps} of its steps`);
    }
    // A loop whose budget is already spent takes no step: its first call would be refused
    // anyway, and a step that can only write a genesis and an aborted Resolution is chain work the
    // owner would pay the fees of for nothing. Stopped here so the reason is on the snapshot.
    if (this.remainingMicroUsdc === BigInt(0)) {
      this.stop("budget", `the loop's budget of ${this.budgetMicroUsdc} µUSDC is spent`);
      throw new Error(`loop ${this.loopId} is stopped (budget)`);
    }
    // The trace audit is not in this build, and a policy that names one takes no step rather than
    // one without it: every Genesis of the step would commit, under `policy_version_hash`, an audit
    // and its stops that nothing ran — a claim on the chain nothing backs. Here and not in the
    // constructor, because a runner is also built to settle such a loop's channel (`settle`), which
    // runs no step. A console stops such a loop before it asks for one; the steps it already took
    // still verify, since `verify-step` re-reads the blobs they committed.
    if (this.runtime.policy.traceAudit !== undefined) {
      throw new Error(
        `loop ${this.loopId}'s policy names the trace audit, which is not in this build, so it takes no step; ` +
          "the steps it already took still verify"
      );
    }
    // A policy with a `gate` is a gated loop's, and every step of one closes a gate log that only
    // the gate's tick can hand it. Gated loops and their tick are not in this build, so such a step
    // is refused before anything is spent rather than run as a step whose policy commits a gate it
    // never consulted. `policy_version_hash` still hashes `gate`, which is how old chains verify.
    if (this.runtime.policy.gate !== undefined) {
      throw new Error(`loop ${this.loopId} is gated, and gated loops are not in this build; it takes no step`);
    }
    this.state.status = "running";
    this.inFlight = this.runStep().finally(() => {
      this.inFlight = null;
      if (this.state.status === "running") this.state.status = "idle";
    });
    return this.inFlight;
  }

  /**
   * Steps until the loop stops itself — the step ceiling, a budget, a charge, or `stop()`. The
   * interval is waited *after* each step, so a step that overruns it delays the next one.
   */
  async run(): Promise<LoopSnapshot> {
    this.running = true;
    try {
      while (this.runnable) {
        await this.step();
        if (!this.runnable) break;
        await this.sleepUntilNextStep();
      }
    } finally {
      this.running = false;
      // However the loop leaves — the step ceiling, a budget, a `stop()`, or a step that threw
      // — the channel is settled here. It is the only hook there is, and a channel left
      // open strands the operator's USDC.e with nothing on chain naming it.
      await this.settle();
    }
    return this.snapshot();
  }

  /** The `run()` gap, interruptible by `stop()`. */
  private async sleepUntilNextStep(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const early = new Promise<void>((resolve) => {
      this.nudgeSleeper = resolve;
    });
    await Promise.race([this.sleepFor(this.intervalMs), early]);
    this.nudgeSleeper = null;
  }

  // `agentId` is optional rather than omitted so a `member` event can name the member's chain
  // instead of the loop's; the spread below already lets an explicit one win.
  private emit(event: Omit<LoopEvent, "loopId" | "agentId" | "timestamp"> & { agentId?: string }): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({ loopId: this.loopId, agentId: hex(this.agentId), timestamp: this.now(), ...event });
    } catch {
      // An observer is a spectator; it must not be able to fail a step.
    }
  }

  /**
   * A step that never got a session: the transport or the chain threw, or the memory it was to
   * resume from could not be had. No resolution, no checkpoint; counted, so enough in a row
   * stop the loop.
   */
  private failStep(
    step: number,
    sessionId: string,
    startedAt: number,
    status: "crashed" | "no-memory",
    reason: string,
    extra: {
      resumedFromStep?: number;
      resumedMemoryHash?: string;
      epochs?: LoopEpoch[];
    }
  ): StepResult {
    this.state.steps = step;
    this.state.lastStepAt = this.now();
    this.state.consecutiveFailures++;
    this.emit({ type: "error", step, error: reason });
    const result: StepResult = {
      step,
      sessionId,
      status,
      reason,
      steps: 0,
      batchedSteps: 0,
      epochs: extra.epochs ?? [],
      costMicroUsdc: "0",
      unbilledMicroUsdc: "0",
      resumedFromStep: extra.resumedFromStep,
      resumedMemoryHash: extra.resumedMemoryHash,
      leafOk: false,
      startedAt,
      endedAt: this.state.lastStepAt,
    };
    this.emit({ type: "step:end", step, sessionId, status, detail: reason });
    if (this.state.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.stop("error", `${this.state.consecutiveFailures} steps failed in a row: ${reason}`);
    } else if (this.state.steps >= this.maxSteps) {
      this.stop("max-steps");
    }
    return result;
  }

  /**
   * A step whose session ran and which could not be closed on chain: counted, charged, reported,
   * and *not* checkpointed. Two ways in — its records are still in the journal, or they landed
   * and a closing write after its session resolved failed (the memory commit, the epoch flush, a
   * member's close, the checkpoint itself).
   *
   * The distinction from `failStep` is worth keeping: that one is a step that produced nothing,
   * this one is a step that produced everything except the transactions. So the cost is counted
   * (the model was paid), the session's status is kept rather than overwritten with `crashed`,
   * and `consecutiveFailures` is not touched — the failure is not the agent's, and a run of them
   * is one write problem, not three bad steps. What is missing is `seq`, `head`, `leaf` and the
   * record: `leafOk` is false because there is no leaf.
   *
   * It is also never run again. The step index is spent — `state.steps` moves to it — and the
   * loop stops `anchor-failed` with the checkpoint deferred to Retry, because a re-run would be
   * a second paid session under the same index with nothing to cap it.
   */
  private async unanchoredStep(
    step: number,
    sessionId: string,
    startedAt: number,
    session: SessionResult,
    epochs: LoopEpoch[],
    detail: string,
    extra: {
      resumedFromStep?: number;
      resumedMemoryHash?: string;
      /** What the second model said about this step; the caller asked before it got here. */
      verify?: StepVerify;
      /** What Jev said about the goal, asked in the same place and for the same reason. */
      goalCheck?: StepGoalCheck;
      /** False when that verdict was `retry` or `escalate`: the output is not to become memory. */
      remembered: boolean;
      /**
       * The memory this step would have committed, already shaped by the committed path. `null` is
       * a step with no memory of its own; absent is the session's answer, shaped here.
       */
      memoryBytes?: Uint8Array | null;
      workError?: string;
      /** Whether the step would have ended the loop on its goal (`StepResult.deferredGoalReached`). */
      goalReached?: boolean;
    }
  ): Promise<StepResult> {
    const costMicroUsdc = session.costMicroUsdc;
    const unbilledMicroUsdc = session.unbilledMicroUsdc;
    this.state.steps = step;
    this.state.lastStepAt = this.now();
    this.state.totalCostMicroUsdc = (BigInt(this.state.totalCostMicroUsdc) + costMicroUsdc).toString();

    /**
     * What the retry needs to write the checkpoint this step could not.
     *
     * The memory blob goes into the store now even though nothing commits to it yet: a `put` is
     * content-addressed and costs no seq, and the alternative is a hash the retry would have to
     * recompute from an output nobody kept. `lastMemoryHash` is *not* moved — the next step must
     * resume from a hash the chain names, and until the retry lands the records and writes this
     * checkpoint, the chain names the previous one.
     */
    // `workStatus`, not `status`: a session reaches this method *because* its drain failed, and
    // the drain is what overwrote `status` to `failed`. Asking `status` here asks whether the
    // transactions landed — which they did not, by construction — and so would never keep a memory
    // at all, leaving the step after a repaired one with nothing to resume from.
    let memoryHash = this.state.lastMemoryHash;
    let memoryIsOwn = false;
    // `extra.remembered` is the verdict's, and it gates this store the same way it gates the
    // committed path's: a retried or escalated output must not be waiting in the store for the
    // console's retry to write as the next step's memory. A caller that already shaped the memory
    // passes the bytes, so the retry commits what the step would have.
    const memoryBytes =
      extra.memoryBytes !== undefined
        ? extra.memoryBytes
        : extra.remembered && session.workStatus === "success" && session.output.trim().length > 0
        ? loopMemoryBytes(session.output)
        : null;
    if (memoryBytes) {
      try {
        memoryHash = hex(await this.runtime.store.put(memoryBytes));
        memoryIsOwn = true;
      } catch (e) {
        // A store that will not take the bytes costs the retry this step's memory, and nothing
        // else. Throwing here would turn "your writes did not land, retry them" into a crashed
        // step, which is the one outcome this path exists to avoid.
        this.emit({
          type: "error",
          step,
          error: `the memory of step ${step} was not stored: ${(e as any)?.message ?? e}`,
        });
      }
    }
    // The Tempo carry, owed with the checkpoint like the rest of the plan: the Actions it names are
    // journaled ahead of this step's records, and the Retry writes the leaf that names them.
    const tempoCarry = await this.storeCarry(step);
    if (tempoCarry) this.tempoServices!.carried(tempoCarry.carry);
    const deferredCheckpoint: DeferredCheckpoint = {
      loopId: this.loopId,
      step,
      sessionId,
      intervalMs: this.intervalMs,
      maxSteps: this.maxSteps,
      promptHash: this.promptHash,
      startedAt: this.startedAt,
      // Never `GoalReached`, whatever the output said. The terminal step is the one that
      // stops the loop, and a step whose writes are still in the journal has not finished
      // happening: the loop stops here for `anchor-failed` instead, and the retry writes a step
      // that ran — not a step that ended the loop on a boundary no reader can rebuild.
      statusCode: stepStatusCode(session.status),
      memoryHash,
      memoryIsOwn,
      verifyHash: extra.verify && "outcome" in extra.verify ? extra.verify.verifyHash : undefined,
      goalHash: this.goalHash,
      // No eleventh key: a team step's member commits (`members`) are written by a fan-out this
      // build does not run, and an older plan deferred with them is refused a Retry
      // (`REMOVED_PLAN_KEYS`).
      // The thirteenth, as the committed path would have written it: the record names this
      // step's workspace and seqs, which the retry cannot re-read.
      ...(session.replayHash ? { replayHash: session.replayHash } : {}),
      // The fourteenth, as the committed path would have written it: the blob is paid for and
      // stored, and the Retry cannot ask Jev again. The status stays 200 all the same (above).
      ...(extra.goalCheck?.goalCheckHash ? { goalCheckHash: extra.goalCheck.goalCheckHash } : {}),
      // The fifteenth, as the committed path would have written it.
      ...(tempoCarry ? { tempoHash: tempoCarry.hash } : {}),
      genesisPayloadHash: hexOf(session.events.find((e) => e.input.kind === EventKind.Genesis)?.input.payloadHash),
    };

    this.emit({ type: "error", step, error: detail });
    this.emit({
      type: "step:end",
      step,
      sessionId,
      status: session.status,
      detail,
      costMicroUsdc: costMicroUsdc.toString(),
    });
    this.stop("anchor-failed", detail);

    return {
      step,
      sessionId,
      status: session.status,
      reason: detail,
      steps: session.steps,
      batchedSteps: session.batchedSteps,
      epochs,
      costMicroUsdc: costMicroUsdc.toString(),
      unbilledMicroUsdc: unbilledMicroUsdc.toString(),
      resumedFromStep: extra.resumedFromStep,
      resumedMemoryHash: extra.resumedMemoryHash,
      verify: extra.verify,
      ...(extra.goalCheck ? { goalCheck: extra.goalCheck } : {}),
      workError: extra.workError,
      ...noAnswerOf(session),
      leafOk: false,
      deferredCheckpoint,
      ...(extra.goalReached ? { deferredGoalReached: true as const } : {}),
      startedAt,
      endedAt: this.state.lastStepAt,
    };
  }

  private async runStep(): Promise<StepResult> {
    if (this.grantsRefused) {
      throw new Error(`loop ${this.loopId} ${this.grantsRefused}, so this runner settles and never steps`);
    }
    const step = this.state.steps + 1;
    const sessionId = `${this.loopId}:step-${step}`;
    const startedAt = this.now();
    this.emit({ type: "step:start", step, sessionId });
    // The paid RPC session opens beside the loop's first step and never on its clock: fired
    // here, not awaited, and a no-op on every later step and on a loop with no services.
    this.tempoServices?.start();

    // What this step resumes from: the last committed memory, fetched by its hash and re-hashed.
    // No bytes, or the wrong bytes, is a failed step — never a step that starts from nothing
    // while the chain says it had something to start from.
    //
    // "No bytes" is the store's `null`, which is its answer for a hash it does not hold. A `get` that
    // throws is the read failing — a timeout, a 429, a directory this process cannot open — and says
    // nothing about the memory, so it is not `no-memory`: that would spend this step's index, count
    // toward `consecutiveFailures`, and tell the owner the memory is gone. It is thrown instead,
    // before anything is spent, which is how a step that was not taken leaves the runner: the index
    // and the count stay where they were, and the console's next tick asks again (`runOneStep`).
    const resumedFromStep = this.state.lastMemoryHash ? this.state.lastMemoryStep : undefined;
    const resumedMemoryHash = this.state.lastMemoryHash;
    let memory: { text: string; hash: string; from?: string } | undefined;
    if (resumedMemoryHash) {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.runtime.store.get(toBytes32(resumedMemoryHash));
      } catch (e) {
        throw new Error(
          `step ${step} resumes from step ${resumedFromStep}'s memory ${resumedMemoryHash} and the trace store ` +
            `could not be read, so the step was not taken: ${(e as any)?.message ?? String(e)}`
        );
      }
      const problem = !bytes
        ? `the trace store has nothing under ${resumedMemoryHash}`
        : !memoryMatches(bytes, resumedMemoryHash)
        ? `the bytes under ${resumedMemoryHash} hash to ${hex(sha256(bytes))}`
        : null;
      if (problem) {
        const detail = `step ${step} resumes from step ${resumedFromStep}'s memory and cannot: ${problem}`;
        return this.failStep(step, sessionId, startedAt, "no-memory", detail, { resumedFromStep, resumedMemoryHash });
      }
      memory = {
        text: new TextDecoder().decode(bytes!),
        hash: resumedMemoryHash,
        from: resumedFromStep ? `step ${resumedFromStep}` : undefined,
      };
      this.emit({
        type: "memory",
        step,
        sessionId,
        memoryHash: resumedMemoryHash,
        detail: `resumed from step ${resumedFromStep}`,
      });
    }

    // The reports the last steps published, recorded now: the chain is quiet between the last
    // step's seal and this step's genesis, and journaling costs this step a disk write, not a
    // confirmation (`writeStoragePuts`). After every check above that can fail the step without a
    // session, so a step refused for its memory does not write Actions a leaf never carries.
    await this.writeStoragePuts(step);

    let session: SessionResult | null = null;
    let crash: string | undefined;
    let crashedAnchoring = false;
    const spentA = openSpend(this.spend);
    try {
      session = await this.runtime.start({
        user: this.user,
        // The standing instruction is what the manifest's `promptHash` commits to and is never
        // rewritten.
        prompt: this.prompt,
        sessionId,
        // The Resolution's reference is the session id.
        taskId: sessionId,
        memory,
        goal: this.goal,
        ...spentA.options,
      });
      spentA.settle(session);
    } catch (e) {
      // Whatever it paid for before it threw still counts against the budget.
      spentA.settle();
      // `start()` resolves every path it can onto the chain, so a throw is the chain or the
      // transport failing outright — this step has no resolution and gets no checkpoint.
      //
      // `AnchorFailed` is the one throw that says *nothing was attempted*: an earlier session
      // left records in the journal that will not land, and `start()` refuses to open a genesis
      // on top of them rather than write this step's records at seqs the failed ones own
      // (`runtime/src/anchor.ts`, rule 1). Stopping on it is the point — the loop waits for a
      // `retry` instead of stacking a second unanchored step on the first.
      crash = (e as any)?.message ?? String(e);
      crashedAnchoring = e instanceof AnchorFailed;
    }

    const epochs: LoopEpoch[] = (session?.epochs ?? []).map(flatten);

    if (!session) {
      if (crashedAnchoring) this.stop("anchor-failed", crash);
      return this.failStep(step, sessionId, startedAt, "crashed", crash ?? "start() threw", {
        resumedFromStep,
        resumedMemoryHash,
        epochs,
      });
    }

    this.state.consecutiveFailures = 0;

    // ── The verdict, then the goal, then everything that depends on them ───────────────────
    //
    // Both are asked *before* the anchor check below, not after it. A step whose chain writes
    // failed still ran, still spent the user's money and still produced text the console's retry
    // will write as the next step's memory — so it is exactly the step that must not skip the
    // verifier. The two questions are asked in one place for both exits, which is also what keeps
    // their order fixed.
    //
    // The verdict is first because it decides whether there is a memory commit at all. A step the
    // verifier retried is *not* re-run: what the runner does is "do not remember this".
    const judged = await this.runVerify(step, sessionId, session, memory?.text);
    const verify = judged?.verify;
    const verified = verify && "outcome" in verify ? verify : undefined;
    const remembered = !verified || verified.outcome === "accepted";

    // Jev's goal check, on a goal loop that asked for it: out of the answers the seat's call
    // already carries, or its own call on a loop with no seat. An answer ends the loop in place of
    // the agent's claim; no answer leaves the claim to decide, as on a loop without the check.
    const goalCheck = await this.runGoalCheck(step, sessionId, session, memory?.text, judged);
    // Jev's decision is paid by Lath's treasury on the loop's channel and charged to nobody: its
    // voucher stays in its blob and its `costBase`, and nothing about it reaches the checkpoint's
    // transaction.
    const jevDecides = !!goalCheck && goalCheck.outcome !== "unavailable";

    // The goal second, and never on text the judge refused: a plan that was retried or escalated
    // is not a plan whose last line may end the loop. `remembered` is the same gate the memory
    // commit uses, for the same reason — a step that is not worth remembering is not worth
    // believing about the goal either.
    //
    // With the goal check answered, Jev's word replaces the claim — through the same `remembered`
    // gate, so text the verdict refused ends no loop whatever either of them said.
    let goalReached = jevDecides
      ? remembered && goalCheck!.outcome === "achieved"
      : this.reachedGoal(session, remembered);

    // The session answered and its writes did not. `drain: true` means `start()` waited for the
    // queue before it resolved, so `anchor.failed` above zero is a record that has spent its
    // attempts and is sitting in the journal (`runtime/src/anchor.ts`, rule 4).
    //
    // This step gets **no checkpoint**. The leaf is `sha256(agent_id ‖ seq_le ‖ head)` over the
    // chain as it stands, and the chain does not stand there: the head the session computed is
    // one no reader can reach, so a `loop.step` record committing to it would be a leaf that
    // never rebuilds — the failure written down as a lie rather than left as a gap. The work is
    // not lost either way: the session's blobs are in the trace store and its records are in the
    // journal, and `retry` is what puts them on chain. That includes the step's batched LLM and
    // tool Actions: the session flushes its epoch even when its drain failed, so the epoch is
    // journaled behind the failed entry and the Resolution lazily behind it, and the retry
    // lands them in that order.
    //
    // The memory is left uncommitted for the same reason: the next step must resume from a hash
    // the chain names, and nothing this step wrote is on the chain yet.
    const failedEntry = this.runtime.anchor?.queue.failed(this.agentId)[0];
    if ((session.anchor?.failed ?? 0) > 0 || failedEntry) {
      const detail = failedEntry
        ? `step ${step} ran and its chain writes did not land: ${failedEntry.error ?? "unknown"} ` +
          `(${failedEntry.kind} entry ${failedEntry.id}, ${failedEntry.attempts} attempts)`
        : `step ${step} ran and ${session.anchor?.failed} of its chain writes did not land`;
      return this.unanchoredStep(step, sessionId, startedAt, session, epochs, detail, {
        resumedFromStep,
        resumedMemoryHash,
        verify,
        goalCheck,
        remembered,
        goalReached,
      });
    }

    // Hoisted above the `try` below, because its `catch` has to hand `unanchoredStep` whatever
    // the step had done by the time something threw: the memory it had shaped. A team step's fan-out
    // and its synthesis would sit here, between the anchor check and the memory; this build runs
    // neither.
    let memoryBytes: Uint8Array | null = null;
    const errors: string[] = [];
    const priorMemory = { hash: this.state.lastMemoryHash, step: this.state.lastMemoryStep };
    // Every way out of the `try` below that is not a checkpoint goes through here: the step ran,
    // was paid for, and could not be closed on chain. The memory pointer goes back to where the
    // chain still has it — the deferred checkpoint carries this step's memory, and the Retry that
    // writes it is what moves the pointer (`payDeferredCheckpoints`).
    const closeUnanchored = (detail: string): Promise<StepResult> => {
      this.state.lastMemoryHash = priorMemory.hash;
      this.state.lastMemoryStep = priorMemory.step;
      return this.unanchoredStep(step, sessionId, startedAt, session, epochs, detail, {
        resumedFromStep,
        resumedMemoryHash,
        verify,
        goalCheck,
        remembered,
        memoryBytes,
        workError: errors.length ? errors.join("; ") : undefined,
        goalReached,
      });
    };
    // Whether this chain's journal still owes a write, asked right before a write that goes
    // straight to the chain. A direct write on a chain whose journal owes a record takes that
    // record's seq, and the retry then diverges for good. `drain`
    // sends whatever is pending on a healthy queue — which is what has to happen before a direct
    // write anyway — and rejects at once on a halted one.
    const owedWrite = async (): Promise<string | null> => {
      if (!this.runtime.anchor) return null;
      try {
        await this.runtime.anchor.queue.drain(this.agentId);
        return null;
      } catch (e) {
        if (!(e instanceof AnchorFailed)) throw e;
        return (
          `step ${step} ran and a chain write after its session did not land: ${e.entry.error ?? "unknown"} ` +
          `(${e.entry.kind} entry ${e.entry.id}, ${e.entry.attempts} attempts)`
        );
      }
    };
    try {
      // What the next step will be told. A successful step that said something is remembered;
      // anything else carries the previous memory forward under the same hash, so the manifest
      // always names the memory the loop stands on. Shaped here, before the chain is asked
      // anything, so a step that cannot be closed still hands its retry the memory it would have
      // committed.
      if (remembered && session.status === "success" && session.output.trim().length > 0) {
        memoryBytes = loopMemoryBytes(session.output);
      }

      // The session already flushed its epoch before resolving; this is the guard against a timer flush
      // landing between the resolution and the checkpoint and taking the seq the leaf names. Above the memory
      // commit rather than below it, because it is also the anchor guard for everything the step wrote after
      // its session drained. A direct write — the feed record, the checkpoint — on a chain whose journal
      // still owes one of those takes the owed record's seq, and the retry then diverges for good. So the
      // step drains first, and a journal that will not drain closes the step the way a failed session-A
      // drain does: counted, stopped `anchor-failed`, its checkpoint deferred to Retry.
      //
      // An anchored flush that fails is the journal failing — its barrier drain rejects — and is
      // asked about by `owedWrite` just below, which gives it the same answer.
      const pending = await this.runtime.flushEpochs().catch((e) => {
        if (e instanceof AnchorFailed) return null;
        throw e;
      });
      if (pending) {
        epochs.push(flatten(pending));
        // `[startSeq, endSeq)`: the chain stands at `endSeq` with the epoch's head after it.
        this.noteOwnWrite(pending.endSeq, pending.head);
      }
      const owedBeforeMemory = await owedWrite();
      if (owedBeforeMemory) return closeUnanchored(owedBeforeMemory);

      let memoryHash = this.state.lastMemoryHash;
      if (memoryBytes) {
        // Wrapped the way `unanchoredStep`'s own put is: a store that will not take the bytes
        // costs this step its memory — the checkpoint names the previous one, carried forward —
        // and nothing else. Unwrapped, the throw would leave a step that had resolved and been paid
        // for with no checkpoint, uncounted, and the console would run the same index again.
        try {
          memoryHash = hex(await this.runtime.store.put(memoryBytes));
          this.state.lastMemoryHash = memoryHash;
          this.state.lastMemoryStep = step;
          this.emit({ type: "memory", step, sessionId: session.sessionId, memoryHash, detail: "committed" });
        } catch (e) {
          this.emit({
            type: "error",
            step,
            error: `the memory of step ${step} was not stored, so the step carries the previous one forward: ${
              (e as any)?.message ?? e
            }`,
          });
        }
      }

      // Whatever else this step does on chain happens here: after the epoch is committed, so the
      // records it writes are not inside one, and before the leaf is built, so they are inside the
      // boundary the leaf commits to.
      if (this.work) {
        try {
          await this.work({ step, sessionId, session });
        } catch (e) {
          const detail = (e as any)?.message ?? String(e);
          errors.push(detail);
          this.emit({ type: "error", step, error: `the work of step ${step} failed: ${detail}` });
        }
      }

      // Asked again, because `work` is the caller's and may have journaled a record of its own:
      // the checkpoint below goes straight to the chain.
      const owedBeforeCheckpoint = await owedWrite();
      if (owedBeforeCheckpoint) return closeUnanchored(owedBeforeCheckpoint);

      // What the loop's Tempo services owe a leaf: the `storage.put` Actions written since the last
      // one, with their receipts, and the snapshots finished since — the previous step's, or an
      // earlier one that was late. Absent on every loop without them.
      const tempoCarry = await this.storeCarry(step);

      const written = await writeLoopCheckpoint({
        client: this.runtime.client,
        agentId: this.agentId,
        logger: this.checkpoints,
        plan: {
          loopId: this.loopId,
          step,
          sessionId,
          intervalMs: this.intervalMs,
          maxSteps: this.maxSteps,
          promptHash: this.promptHash,
          startedAt: this.startedAt,
          // 201 rather than 200 on the step that reached the goal, inside `payload_hash` and so
          // committed: the stop reason below is the server's state, and the rule here is that the
          // chain says what happened. A reader with `listByTool(agentId, "loop.step")` and nothing
          // else sees that this loop ended because it got there.
          statusCode: goalReached ? LoopStepStatus.GoalReached : stepStatusCode(session.status),
          memoryHash,
          verifyHash: verified?.verifyHash,
          goalHash: this.goalHash,
          // No eleventh key (`members`): only a team step wrote one, and this build runs no team.
          // The thirteenth, from the step's own session and only when it ran in the sandbox: the
          // replay record is written by the runtime that spawned it, and an in-process session
          // leaves it unset, so its manifest carries no thirteenth key.
          ...(session.replayHash ? { replayHash: session.replayHash } : {}),
          // The fourteenth, only on a goal-checked step with no verify seat whose check Jev
          // answered: with the seat the answer is inside `verifyHash`'s blob.
          ...(goalCheck?.goalCheckHash ? { goalCheckHash: goalCheck.goalCheckHash } : {}),
          // The fifteenth, only when the loop's Tempo services have something to carry.
          ...(tempoCarry ? { tempoHash: tempoCarry.hash } : {}),
        },
        // Only reached when the indexer cannot answer at all; the last record this process wrote
        // is then the best statement of where the chain stands — the session's own resolution.
        // The highest of them all (`ownTip`), so the floor never sits behind a record this runner wrote.
        fallback: this.ownTipAfter({ seq: session.events[session.events.length - 1].seq + 1n, head: session.head }),
      });
      const { seq, head, leaf, manifest, record, leafOk } = written;
      if (tempoCarry) this.tempoServices!.carried(tempoCarry.carry);
      if (!leafOk) {
        this.emit({
          type: "error",
          step,
          error:
            `the checkpoint for step ${step} committed to seq ${seq} and landed at ${record.seq}: ` +
            "something else appended to this chain between the resolution and the checkpoint",
        });
      }

      const endedAt = this.now();
      this.state.steps = step;
      this.state.lastStepAt = endedAt;
      this.state.lastSeq = seq.toString();
      this.state.lastHead = hex(head);
      this.state.lastLeaf = hex(leaf);
      // Nothing for Jev's decisions: Lath pays those, so this is what the owner was charged and no
      // more.
      const stepCostMicroUsdc = session.costMicroUsdc;
      this.state.totalCostMicroUsdc = (BigInt(this.state.totalCostMicroUsdc) + stepCostMicroUsdc).toString();

      this.emit({
        type: "checkpoint",
        step,
        sessionId,
        seq: record.seq.toString(),
        head: hex(record.head),
        leaf: hex(leaf),
        signature: record.signature,
      });
      this.emit({
        type: "step:end",
        step,
        sessionId,
        status: session.status,
        detail: session.reason,
        costMicroUsdc: stepCostMicroUsdc.toString(),
      });

      // The leaf has landed: the loop's Tempo services start this step's jobs and the step goes on
      // without them. The report is found inside the job, so even
      // walking the workspace record is off the step's clock; a step that wrote none publishes none.
      if (this.tempoServices) {
        const report = this.stepReport;
        const ran = session;
        this.tempoServices.afterLeaf(step, () => (report ? report({ step, session: ran }) : Promise.resolve(null)));
      }

      // A sandbox refused for a reason the next step would meet unchanged. After the
      // checkpoint, like every stop here: the step ran and was paid for, and it owes the chain its leaf.
      const refused = sandboxRefusalOf(session)
        ? `the sandbox refused step ${step}: ${sandboxRefusalOf(session)}`
        : undefined;
      const stopReason = refused ? "sandbox" : stopReasonFor(session);
      // After the checkpoint, never before it: an escalated step has run, and a step that ran owes
      // the chain a leaf whatever the verdict was.
      if (verified?.outcome === "escalated") {
        this.stop("escalated", `step ${step} was escalated by ${verified.model} at confidence ${verified.confidence}`);
      } else if (stopReason) this.stop(stopReason, refused ?? session.reason);
      // Here, beside `max-steps`, and after the checkpoint for the same reason the escalation is:
      // the step that says the goal is reached is a step, and a step owes the chain its leaf
      // before anything is decided about the loop. Before `max-steps` because they can both be
      // true on the last step, and _reached it_ is the truer of the two — an unreached goal is
      // the case that runs out of steps.
      else if (goalReached) {
        // Who ended it, in the detail: the page reads *Jev judged the goal achieved* off this, and
        // a claim-stopped loop keeps its own sentence.
        this.stop(
          "goal-reached",
          jevDecides
            ? `Jev judged the goal achieved at step ${step} (confidence ${(goalCheck!.confidence ?? 0).toFixed(2)})`
            : `step ${step} reported the goal reached`
        );
      } else if (this.remainingMicroUsdc === BigInt(0)) {
        // The step spent what was left, while its session finished clean: the step is
        // checkpointed, and the next one could not buy a call. After the goal, which is the truer
        // of the two when both happen on one step, and before `max-steps` for the same reason.
        this.stop("budget", `step ${step} spent the last of the loop's ${this.budgetMicroUsdc} µUSDC budget`);
      } else if (this.state.steps >= this.maxSteps) this.stop("max-steps");

      return {
        step,
        sessionId,
        status: session.status,
        reason: session.reason,
        steps: session.steps,
        batchedSteps: session.batchedSteps,
        epochs,
        costMicroUsdc: stepCostMicroUsdc.toString(),
        unbilledMicroUsdc: session.unbilledMicroUsdc.toString(),
        seq: seq.toString(),
        head: hex(head),
        leaf: hex(leaf),
        manifest,
        memoryHash,
        resumedFromStep,
        resumedMemoryHash,
        verify,
        ...(goalCheck ? { goalCheck } : {}),
        record: { seq: record.seq.toString(), head: hex(record.head), signature: record.signature },
        // One field for every kind of extra work a step does, so a console shows "the step resolved
        // and something after it did not" however many there were.
        workError: errors.length ? errors.join("; ") : undefined,
        ...noAnswerOf(session),
        leafOk,
        startedAt,
        endedAt,
      };
    } catch (e) {
      // After the session resolved, the step has been paid for; a throw here must not hand the
      // console an index to run again. It is closed like a step whose writes did not land —
      // counted, stopped, its checkpoint deferred to Retry — because a re-run is a second paid
      // session under the same index with nothing to cap it.
      return closeUnanchored(`step ${step} ran and could not be closed: ${(e as any)?.message ?? String(e)}`);
    }
  }

  /** Raises `ownTip` to the chain as it stands after a record this runner wrote: `seq` is the next seq. */
  private noteOwnWrite(seq: bigint, head: Uint8Array): void {
    if (!this.ownTip || seq > this.ownTip.seq) this.ownTip = { seq, head: Uint8Array.from(head) };
  }

  /** `ownTip` after noting each of `tips`: the furthest point this runner's own writes put the chain. */
  private ownTipAfter(...tips: ({ seq: bigint; head: Uint8Array } | undefined)[]): { seq: bigint; head: Uint8Array } {
    for (const t of tips) if (t) this.noteOwnWrite(t.seq, t.head);
    return this.ownTip!;
  }

  /**
   * The `storage.put` Actions the loop owes, written at a point where
   * nothing else writes to this chain: a step's start, before its session opens, and a settlement,
   * before its record. Never in between — a PUT comes back ~2 s after a leaf, which is while the
   * console seals that step's bundle with a direct cell write, and a record journaled then would
   * hand the seal a seq a journaled record holds. At a step's start the journal only appends,
   * so the step's clock pays a disk write, not a confirmation; the genesis queues behind it.
   *
   * Each Action is debited to the owner in its own transaction, the way a model call's record is:
   * through the anchor queue's composed charge when the runtime journals, `chargeAndLog` otherwise.
   * The amount is the receipt's, with the margin — `toMicroUsdcFromBase`, the formula a model call's
   * voucher delta meets. A write that throws puts the rest back for the next quiet point.
   */
  private async writeStoragePuts(step?: number): Promise<void> {
    const services = this.tempoServices;
    if (!services) return;
    const written: CarriedStorage[] = [];
    // A parked PUT that provably did not land goes back among the puts and is written below.
    if (this.parkedPuts.length) await this.resolveParkedPuts(step, services, written);
    const puts = services.takePuts();
    if (puts.length === 0) {
      services.wrote(written);
      return;
    }
    for (let i = 0; i < puts.length; i++) {
      const put = puts[i];
      // Set while the direct `chargeAndLog` is in flight: a throw from it may follow a debit and a
      // record that both landed (a confirmation lost), and only one that provably never landed may
      // be sent again — the rule `chargeWithRetry` holds a model call's charge to.
      let charging = false;
      let parked: Omit<ParkedPut, "signature"> | undefined;
      try {
        const store = this.runtime.store;
        const argsHash = await store.put(storageArgsBytes(put.service, put.key));
        // The report is the result blob, so `result_hash` is its SHA-256 and the bytes are in the
        // bundle of the step that writes the Action.
        const resultHash = await store.put(put.report);
        const receiptHash = hex(await store.put(storageReceiptBytes(put.receipt)));
        const payload: ActionPayload = {
          kind: EventKind.Action,
          toolId: STORAGE_PUT_TOOL,
          argsHash,
          resultHash,
          statusCode: put.statusCode,
        };
        if (this.runtime.storePayloads) await store.put(payloadPreimage(payload));
        const amount = toMicroUsdcFromBase(put.ownerBase, this.runtime.margin);
        const timestamp = this.now();
        let seq: bigint;
        if (this.runtime.anchor) {
          const logged = await this.runtime.anchor.queue.logEvent(this.agentId, payload, {
            compact: false,
            timestamp,
            charge: amount > BigInt(0) ? { user: this.user, amountMicroUsdc: amount } : undefined,
          });
          seq = logged.seq;
        } else {
          let charged: LogResult | null = null;
          if (amount > BigInt(0)) {
            // Where the chain stood before the send: if the transaction lands, its record is at or
            // after this seq, which is where `resolveParkedPuts` looks for it.
            const before = await this.runtime.client.getAgentState(this.agentId).catch(() => null);
            parked = {
              put,
              amount,
              receiptHash,
              payloadHash: hex(hashPayload(payload)),
              fromSeq: before ? before.state.seq : undefined,
            };
            charging = true;
            charged = await this.runtime.billing.chargeAndLog({
              user: this.user,
              amountMicroUsdc: amount,
              agentId: this.agentId,
              payload,
              compact: false,
              timestamp,
            });
            charging = false;
          }
          seq = (charged ?? (await this.runtime.client.logEvent(this.agentId, payload, { compact: false, timestamp })))
            .seq;
        }
        this.putWritten(put, seq, amount, receiptHash, written);
      } catch (e) {
        const why = (e as any)?.message ?? String(e);
        // In doubt only when the charge was sent and the cluster may have taken it: a send that never
        // left the process, or one the billing program refused (`chargeRefusal`: an allowance revoked
        // or closed, a cap reached, a balance short), moved nothing and wrote no record, so the PUT
        // waits for the next quiet point like any other failure.
        if (charging && !chargeNeverSent(e) && !chargeRefusal(e)) {
          services.returnPuts(puts.slice(i + 1));
          const signature = (e as any)?.signature;
          if (parked && typeof signature === "string" && signature.length > 0) {
            this.parkedPuts.push({ ...parked, signature });
            this.emit({
              type: "error",
              step,
              error:
                `the storage.put of step ${put.ofStep}'s report failed in its charge, which may have landed ` +
                `(${signature}); it is asked about at the next quiet point rather than sent again: ${why}`,
            });
          } else {
            // No signature to ask about, so nothing can prove the charge did not land: the PUT is
            // dropped rather than risk a second debit and a second Action. If it did land, its record
            // is on the chain and uncounted — the spend and the carry miss it — which is the smaller
            // loss, and the error says so.
            this.emit({
              type: "error",
              step,
              error:
                `the storage.put of step ${put.ofStep}'s report failed in its charge with no signature to ask ` +
                `about, and is not written again; if the charge landed, its Action is on the chain but not ` +
                `counted: ${why}`,
            });
          }
          break;
        }
        services.returnPuts(puts.slice(i));
        this.emit({
          type: "error",
          step,
          error: `the storage.put of step ${put.ofStep}'s report was not written, and waits for the next one: ${why}`,
        });
        break;
      }
    }
    services.wrote(written);
  }

  /** A written `storage.put` counted: the owner's spend, the carry, and the console's event. */
  private putWritten(put: StoragePut, seq: bigint, amount: bigint, receiptHash: string, written: CarriedStorage[]) {
    this.spend.add(amount);
    written.push({
      ofStep: put.ofStep,
      seq: seq.toString(),
      key: put.key,
      statusCode: put.statusCode,
      receiptHash,
    });
    this.emit({
      type: "storage",
      step: put.ofStep,
      seq: seq.toString(),
      detail: put.key,
      costMicroUsdc: amount.toString(),
      ...(put.statusCode < 200 || put.statusCode >= 300
        ? { error: put.receipt.error ?? `status ${put.statusCode}` }
        : {}),
    });
  }

  /**
   * Each parked `storage.put`, asked about: its record found on the chain is the charge having
   * landed — the two share a transaction — and it is counted as written; a signature the cluster
   * reports failed, or has no record of once the client's wait outlasted its blockhash, moved nothing,
   * and the PUT goes back to be written again; anything else stays parked. Never throws: a read that
   * fails leaves the PUT where it was.
   */
  private async resolveParkedPuts(
    step: number | undefined,
    services: LoopTempoServices,
    written: CarriedStorage[]
  ): Promise<void> {
    const still: ParkedPut[] = [];
    for (const p of this.parkedPuts) {
      try {
        const seq = await this.findParkedRecord(p);
        if (seq !== undefined) {
          this.putWritten(p.put, seq, p.amount, p.receiptHash, written);
          continue;
        }
        const ask = (this.runtime.billing as { chargeLanded?(sig: string): Promise<boolean | null | "unknown"> })
          .chargeLanded;
        const landed = ask ? await ask.call(this.runtime.billing, p.signature) : "unknown";
        if (landed === false || landed === null) {
          services.returnPuts([p.put]);
          continue;
        }
        // Landed with its record not yet indexed, or not knowable now: asked again next time.
        still.push(p);
      } catch (e) {
        still.push(p);
        this.emit({
          type: "error",
          step,
          error: `the parked storage.put ${p.signature} could not be asked about: ${(e as any)?.message ?? e}`,
        });
      }
    }
    this.parkedPuts = still;
  }

  /** The seq of a parked PUT's record, read from where the chain stood before its send to its tip. */
  private async findParkedRecord(p: ParkedPut): Promise<bigint | undefined> {
    const client = this.runtime.client;
    const found = await client.getAgentState(this.agentId);
    if (!found) return undefined;
    const tip = found.state.seq;
    const from = p.fromSeq ?? (tip > PARKED_SCAN ? tip - PARKED_SCAN : BigInt(0));
    const to = from + PARKED_SCAN < tip ? from + PARKED_SCAN : tip;
    for (let seq = from; seq < to; seq++) {
      const record = await client.getEvent(this.agentId, seq);
      if (record && hex(record.payloadHash) === p.payloadHash) return seq;
    }
    return undefined;
  }

  /**
   * The carry blob a checkpoint names under `tempoHash`, put through the step's store so it lands in
   * the step's bundle; `undefined` when there is nothing to carry. Not consumed here: the caller
   * marks it carried once a leaf (or a deferred plan) names it, so a step that never checkpoints
   * leaves it for the next one.
   */
  private async storeCarry(step: number): Promise<{ hash: string; carry: TempoCarry } | undefined> {
    const carry = this.tempoServices?.carry();
    if (!carry) return undefined;
    try {
      return { hash: hex(await this.runtime.store.put(tempoCarryBytes(carry))), carry };
    } catch (e) {
      this.emit({
        type: "error",
        step,
        error: `step ${step}'s Tempo carry was not stored, so a later leaf carries it: ${(e as any)?.message ?? e}`,
      });
      return undefined;
    }
  }

  /**
   * Whether this step's answer says the loop's goal is reached — the one thing that ends a goal
   * loop early.
   *
   * Three gates, and all three are the same gate seen from different sides: the loop must have a
   * goal at all, the session must have resolved `success` (a budget stop or a crash says nothing
   * about a goal), and the output must be one the judge did not refuse. Text that carries no
   * DONE/NEXT/OPEN block parses to `null` and the loop simply keeps running on it, on purpose —
   * the shape is an instruction to the model, not a contract it can break the loop by mis-typing.
   */
  private reachedGoal(session: SessionResult, remembered: boolean): boolean {
    if (!this.goal || !remembered || session.status !== "success") return false;
    return parseGoalPlan(session.output)?.reached === true;
  }

  /**
   * Asks the second model about a step, between the session resolving and the memory commit —
   * the verdict decides whether there *is* a commit — and stores the blob the manifest commits
   * to. Every failure ends in `unavailable` rather than a failed step: the endpoint is alpha, and
   * an outage must leave the loop where verify-off would have left it, with no `verifyHash`, so
   * the chain says *not verified* rather than nothing. One attempt, because a retry is a second
   * paid request the manifest could not tell from the first.
   */
  private async runVerify(
    step: number,
    sessionId: string,
    session: SessionResult,
    previousMemory: string | undefined
  ): Promise<{ verify: StepVerify; answers?: VerifyAnswers } | undefined> {
    if (!this.verify) return undefined;
    if (session.status !== "success" || session.output.trim().length === 0) return undefined;
    const unavailable = (reason: string, paid: UnansweredPaid = {}) => {
      this.emit({ type: "verify", step, sessionId, unavailable: reason });
      return { verify: { unavailable: reason, ...paid } as StepVerify };
    };

    const decider = deciderOf(this.runtime);
    if (!decider) return unavailable("transport has no decide");
    // The goal goes to the judge too: without it Jev weighs the step against
    // a standing instruction like _do the next item of the plan_ and has no way to tell whether
    // the item was the right one. Absent on a goal-less loop, whose state bytes do not move.
    const state = verifyState(this.prompt, previousMemory, session.output, this.goal);
    // With the goal check on, the goal question rides this same call: one voucher and one blob
    // under `verifyHash`. Without it the request is the frozen two, so a verified step's blob
    // without the check hashes the way every such blob already on chain does.
    const questions = this.goalCheck && this.goal ? VERIFY_GOAL_QUESTIONS : VERIFY_QUESTIONS;
    const req = { model: this.verify.model, state, questions };
    try {
      const result = await decideWithin(decider, req, VERIFY_TIMEOUT_MS);
      const answers = result.answers as VerifyAnswers;
      const payment = result.payment as TempoPaymentRecord | undefined;
      const blob: DecisionBlob = {
        request: { ...req, minConfidence: this.verify.minConfidence },
        answers,
        payment,
        model: result.model,
        id: result.id,
        usage: result.usage as Record<string, unknown> | undefined,
      };
      const verifyHash = hex(await this.runtime.store.put(decisionBlobBytes(blob)));
      const decision = applyVerdict(answers, this.verify.minConfidence);
      const summary: StepVerify = {
        outcome: decision.outcome,
        choice: answers.verdict?.choice,
        confidence: answers.verdict?.confidence,
        followedPlan: answers.followed_plan?.noul,
        model: result.model,
        verifyHash,
        costBase: payment ? (BigInt(payment.cumulativeAfter) - BigInt(payment.cumulativeBefore)).toString() : undefined,
      };
      const { outcome, choice, confidence } = summary;
      this.emit({ type: "verify", step, sessionId, outcome, choice, confidence, verifyHash, detail: decision.reason });
      return { verify: summary, answers };
    } catch (e) {
      const paid = await storeUnanswered(
        (bytes) => this.runtime.store.put(bytes),
        { ...req, minConfidence: this.verify.minConfidence },
        e
      );
      return unavailable((e as any)?.message ?? String(e), paid);
    }
  }

  /**
   * Jev's goal check: whether the goal is achieved, asked after the step's
   * session resolved and before anything depends on the answer — the fan-out and the 201 do.
   *
   * On a loop with the verify seat the question already rode the seat's call, so this reads the
   * answer out of `judged` and spends nothing; a seat that could not be asked leaves the check
   * unavailable too, with the seat's reason. On a loop with no seat it is one call of its own,
   * under the same deadline and on the same channel, and its blob goes to the store for the
   * manifest's fourteenth key. Every failure ends in `unavailable` and no hash — the seat's outage
   * rule, so a Jev that did not answer leaves the loop where check-off would have left it.
   */
  private async runGoalCheck(
    step: number,
    sessionId: string,
    session: SessionResult,
    previousMemory: string | undefined,
    judged: { verify: StepVerify; answers?: VerifyAnswers } | undefined
  ): Promise<StepGoalCheck | undefined> {
    if (!this.goalCheck || !this.goal) return undefined;
    // The same floor as the seat: a step with nothing to show has no goal to judge, and the claim
    // (which needs a successful session too) could not have ended the loop on it either.
    if (session.status !== "success" || session.output.trim().length === 0) return undefined;
    const bar = this.goalCheck.minConfidence;
    const claimed = goalReachedIn(session.output);
    const unavailable = (reason: string, paid: UnansweredPaid = {}): StepGoalCheck => {
      this.emit({ type: "goal", step, sessionId, outcome: "unavailable", unavailable: reason });
      return { outcome: "unavailable", claimed, bar, reason, ...paid };
    };
    const decided = (
      answers: VerifyAnswers | Record<string, unknown> | undefined,
      extra: Pick<StepGoalCheck, "model" | "goalCheckHash" | "costBase">
    ): StepGoalCheck => {
      const d = applyGoalCheck(answers as GoalCheckBlob["answers"] | undefined, bar, claimed);
      const out: StepGoalCheck = {
        outcome: d.outcome,
        claimed,
        ...(d.choice ? { choice: d.choice } : {}),
        ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
        bar,
        ...(d.disagreement ? { disagreement: d.disagreement } : {}),
        reason: d.reason,
        ...extra,
      };
      this.emit({
        type: "goal",
        step,
        sessionId,
        outcome: d.outcome,
        choice: d.choice,
        confidence: d.confidence,
        detail: d.reason,
      });
      return out;
    };

    if (this.verify) {
      const seat = judged?.verify;
      if (!seat) return unavailable("the verify seat was not asked");
      if (!("outcome" in seat)) return unavailable(seat.unavailable);
      return decided(judged?.answers, { model: seat.model });
    }

    const decider = deciderOf(this.runtime);
    if (!decider) return unavailable("transport has no decide");
    const state = verifyState(this.prompt, previousMemory, session.output, this.goal);
    const req = { model: this.goalCheck.model, state, questions: GOAL_CHECK_QUESTIONS };
    try {
      const result = await decideWithin(decider, req, VERIFY_TIMEOUT_MS);
      const payment = result.payment as TempoPaymentRecord | undefined;
      const blob: GoalCheckBlob = {
        request: { ...req, minConfidence: bar },
        answers: result.answers as GoalCheckBlob["answers"],
        payment,
        model: result.model,
        id: result.id,
        usage: result.usage as Record<string, unknown> | undefined,
      };
      const goalCheckHash = hex(await this.runtime.store.put(decisionBlobBytes(blob)));
      return decided(result.answers, {
        model: result.model,
        goalCheckHash,
        ...(payment
          ? { costBase: (BigInt(payment.cumulativeAfter) - BigInt(payment.cumulativeBefore)).toString() }
          : {}),
      });
    } catch (e) {
      const paid = await storeUnanswered((bytes) => this.runtime.store.put(bytes), { ...req, minConfidence: bar }, e);
      return unavailable((e as any)?.message ?? String(e), paid);
    }
  }
}

function flatten(commit: EpochCommit): LoopEpoch {
  return {
    startSeq: commit.startSeq.toString(),
    endSeq: commit.endSeq.toString(),
    root: hex(commit.epochRoot),
    signature: commit.signature,
    steps: commit.inputs.length,
  };
}

// ─── The checkpoint, and the one a failed step still owes ───────────────────

/**
 * Everything a `loop.step` checkpoint needs that is *not* read off the chain when it is written.
 *
 * A step whose writes did not land gets no checkpoint at the time (`unanchoredStep`): the leaf is
 * `sha256(agent_id ‖ seq_le ‖ head)` over the chain as it stands, and the chain did not stand
 * there, so a record committing to it would be a leaf that never rebuilds. Once the retry has put
 * that step's records on chain the objection is gone — the chain now stands exactly where the
 * step's resolution left it — and the leaf can be built correctly over the same boundary. What
 * the retry cannot reconstruct is the step's own metadata, so the step writes this down before it
 * stops and the retry reads it back.
 */
export interface DeferredCheckpoint {
  loopId: string;
  step: number;
  sessionId: string;
  intervalMs: number;
  maxSteps: number;
  promptHash: string;
  startedAt: number;
  /** `stepStatusCode(session.status)`, kept because the session object is long gone by then. */
  statusCode: number;
  /** The memory the loop stands on, already in the trace store; the manifest names it. */
  memoryHash?: string;
  /**
   * True when `memoryHash` is what *this* step produced rather than the previous step's, carried
   * forward. Only the first kind moves `lastMemoryStep`, which is what tells the step after it
   * whose memory it is resuming from.
   */
  memoryIsOwn?: boolean;
  /** `sha256` of the decision blob, when a second model judged this step; absent when none did. */
  verifyHash?: string;
  /**
   * `sha256(goal)` hex, on a loop that has one. Fixed for the life of the loop, so the retry
   * could in principle recompute it — kept here for the same reason `promptHash` is, that a
   * retry reads this object and not the runner that wrote it.
   */
  goalHash?: string;
  /**
   * `sha256` of the step's replay record — the thirteenth manifest key, on a step that ran in the
   * sandbox and on no other. Kept here rather than recomputed: the record names the workspace as the
   * step left it and the seqs its calls took, and the retry that writes a deferred checkpoint cannot
   * go back to either.
   */
  replayHash?: string;
  /**
   * `sha256` of the goal-check blob — the fourteenth manifest key, on a
   * goal-checked step of a loop with no verify seat whose check Jev answered. Kept for the reason
   * `verifyHash` is: the decision was paid for once and the retry cannot ask it again.
   */
  goalCheckHash?: string;
  /**
   * `sha256` of the step's Tempo carry blob — the fifteenth manifest key, on a step of a loop whose
   * host pays Tempo's services and had something to carry. Kept for
   * the reason `replayHash` is: it names Actions written at this step's start, which the Retry that
   * writes the checkpoint cannot go back to.
   */
  tempoHash?: string;
  /** Hex `payload_hash` of the step's genesis — the key its trace bundle is sealed under. */
  genesisPayloadHash?: string;
}

/**
 * The plan keys only a roadmap feature writes, and what each one commits, in a sentence's words: the
 * oracle's `requestAddress`, a team's `members` (the eleventh manifest key), the gate's `gateHash`
 * (twelfth), the trace audit's `traceAuditHash` (sixteenth) and protocol-plugin grants' `pluginHash`
 * (eighteenth). This build plans none of them. An older plan left owed on disk may carry one, and its
 * checkpoint is not written here: without the key it is a manifest other than the one the step
 * planned, and with it a claim this build has no code behind. Its Retry is refused instead, and its
 * records stay journaled.
 */
export const REMOVED_PLAN_KEYS = {
  requestAddress: "an oracle request",
  members: "a team's member commits",
  gateHash: "a gate's log",
  traceAuditHash: "the trace audit",
  pluginHash: "protocol-plugin grants",
} as const;

/**
 * The keys of `REMOVED_PLAN_KEYS` a plan read back from disk carries, in that order: none on a plan this
 * build writes. `members` counts only when it names someone, as `loopManifestBytes` writes it: an
 * empty roster is never a key in the bytes.
 */
export function removedPlanKeys(plan: object): (keyof typeof REMOVED_PLAN_KEYS)[] {
  const p = plan as Record<string, unknown>;
  return (Object.keys(REMOVED_PLAN_KEYS) as (keyof typeof REMOVED_PLAN_KEYS)[]).filter((k) =>
    k === "members" ? Array.isArray(p.members) && p.members.length > 0 : !!p[k]
  );
}

/** What a checkpoint write turned out to be. */
export interface WrittenCheckpoint {
  seq: bigint;
  head: Uint8Array;
  leaf: Uint8Array;
  manifest: LoopStepManifest;
  record: Awaited<ReturnType<AgentLogger["action"]>>;
  /** False when the record did not land at the seq its leaf commits to. */
  leafOk: boolean;
}

/**
 * Writes one `loop.step` checkpoint: reads where the chain stands, builds the leaf over it, and
 * anchors the record whose `result_hash` *is* that leaf.
 *
 * One implementation for both callers. A step writes its own the moment it resolves; a retry
 * writes the one a step whose drain failed could not, and the only difference between them is
 * when the chain is read — which is the whole point, because the leaf is a statement about the
 * chain at the moment it is taken and not about the session that produced it.
 *
 * Both blobs go to the trace store through the logger: the manifest under `args_hash`, and the
 * leaf's own 72-byte preimage under `result_hash`, so an auditor walking `result_hash` gets the
 * seq and the head back instead of an opaque 32 bytes it cannot check.
 */
export async function writeLoopCheckpoint(p: {
  client: LathClient;
  agentId: Bytes32;
  /** Full mode: a checkpoint must be a record `listByTool` can find. */
  logger: AgentLogger;
  plan: DeferredCheckpoint;
  /** Where the chain stands when the indexer cannot say. */
  fallback?: { seq: bigint; head: Uint8Array };
}): Promise<WrittenCheckpoint> {
  // No charge rides the record, whatever an older plan says it owed: Jev's decisions are Lath's to
  // pay, so a checkpoint carries no debit for them.
  // A plan carrying a key only a roadmap feature writes is refused before anything is read or written
  // (`REMOVED_PLAN_KEYS`): dropping the key would land a checkpoint other than the one its step planned.
  const removed = removedPlanKeys(p.plan);
  if (removed.length > 0) {
    throw new Error(
      `step ${p.plan.step}'s checkpoint commits ${removed.map((k) => REMOVED_PLAN_KEYS[k]).join(", ")}, which ` +
        "this build does not write"
    );
  }
  // The leaf commits to the chain as it stands *now*: `seq` is the next seq — which the
  // checkpoint record is about to occupy — and `head` is the head at `seq - 1`, the step's own
  // resolution. Read rather than derived from the session, so a chain someone else also wrote to
  // is committed to as it really is.
  const found = await p.client.getAgentState(p.agentId);
  if (!found && !p.fallback) throw new Error("the chain has no state to take a checkpoint over");
  // The fallback is also a floor, not only a last resort: it names a record this process has
  // already written, and an indexer that has not caught up with it answers with a seq behind one
  // we know landed. Taking the checkpoint over that older state builds a leaf for a boundary the
  // chain has moved past, and the record then lands a seq late — which is exactly the `leafOk`
  // failure below. A member's close or a plugin's Action can land right before this read, so the
  // window is worth closing rather than reporting.
  const stale = !!(found && p.fallback && found.state.seq < p.fallback.seq);
  const seq = found && !stale ? found.state.seq : p.fallback!.seq;
  const head = found && !stale ? found.state.head : p.fallback!.head;
  const leaf = loopStepLeaf(p.agentId, seq, head);

  const manifest: LoopStepManifest = {
    loopId: p.plan.loopId,
    step: p.plan.step,
    intervalMs: p.plan.intervalMs,
    maxSteps: p.plan.maxSteps,
    promptHash: p.plan.promptHash,
    startedAt: p.plan.startedAt,
  };
  // Each key only when set, so a manifest is the JSON of the keys its step had and no more; the order
  // the bytes take is `loopManifestBytes`'s. The keys only roadmap features write never reach here.
  if (p.plan.memoryHash) manifest.memoryHash = p.plan.memoryHash;
  if (p.plan.verifyHash) manifest.verifyHash = p.plan.verifyHash;
  if (p.plan.goalHash) manifest.goalHash = p.plan.goalHash;
  // The thirteenth key, only on a sandboxed step: an in-process step never sets `replayHash`.
  if (p.plan.replayHash) manifest.replayHash = p.plan.replayHash;
  // The fourteenth, only on a goal-checked step with no verify seat.
  if (p.plan.goalCheckHash) manifest.goalCheckHash = p.plan.goalCheckHash;
  // The fifteenth, only when the loop's Tempo services carried something.
  if (p.plan.tempoHash) manifest.tempoHash = p.plan.tempoHash;

  const args = loopManifestBytes(manifest);
  const result = loopLeafPreimage(p.agentId, seq, head);
  const record = await p.logger.action({ toolId: LOOP_STEP_TOOL, args, result, statusCode: p.plan.statusCode });
  return { seq, head, leaf, manifest, record, leafOk: record.seq === seq && hex(record.resultHash) === hex(leaf) };
}

/** `hex`, but an absent value stays absent rather than becoming the hash of nothing. */
function hexOf(b: Uint8Array | undefined): string | undefined {
  return b ? hex(b) : undefined;
}

/** How many seqs past where the chain stood before its send a parked PUT's record is looked for. */
const PARKED_SCAN = BigInt(256);

/** A `storage.put` whose direct charge threw in doubt, waiting to be asked about. */
interface ParkedPut {
  put: StoragePut;
  /** The charge's transaction, as the billing client threw it. */
  signature: string;
  amount: bigint;
  receiptHash: string;
  /** `hashPayload` of the Action, hex: what its record carries if it landed. */
  payloadHash: string;
  /** The chain's seq before the send; the record, if it landed, is at or after it. */
  fromSeq?: bigint;
}
