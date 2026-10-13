/**
 * The wire shape of a loop: what `GET /api/loops` returns, declared once for both sides.
 *
 * One declaration rather than one per reader — the storage record in `_lib/loop-record.ts`, the
 * projection `publicLoop` builds, the browser's `LoopView` — because separate copies drift: a
 * browser copy of the step status that lacks `no-payload`, which a real step can return, misreads
 * that step.
 *
 * This file imports nothing but its sibling types, which is why both sides can have it:
 * `_lib/loops.ts` pulls in `fs` and cannot be reached from the browser, the browser cannot be
 * reached from a route handler without dragging React into it, and the root `tsconfig.json` the
 * node-only tests compile under does not resolve `@lath/sdk/browser` at all.
 *
 * The server proves it still matches by annotating `publicLoop`'s return with `LoopView`; the
 * browser gets it by importing. Anything the server keeps to itself — the runner snapshot, the
 * keypair, the scheduler's bookkeeping — stays in `_lib/loops.ts` and is not here.
 */
import type { TemplateLinkView } from "./template";
import type { SandboxSourceInput, ZeroClawStepRecord } from "./zeroclaw";

/**
 * What wakes a run. `schedule` is the interval; `request` polls `lath-oracle` for a Pending
 * request naming the agent's key and steps once per request; `feed` is the interval plus an
 * `update_feed` at the end of every step. Only `schedule` steps in this build: the oracle triggers
 * are on the roadmap, and the other kinds stay so a row that carries one still reads, is refused on
 * _Run again_ and is stopped by the scheduler with its sentence.
 */
export type LoopTrigger =
  /** The default when absent: the interval decides, and a step publishes nothing off its chain. */
  | { kind: "schedule" }
  /** Step when a Pending `Request` names this loop's key; the answer is a `fulfil` or a `reject`. */
  | { kind: "request"; pollMs: number }
  /** The interval, plus an `update_feed` at the end of every step. */
  | { kind: "feed" }
  /**
   * Look every `pollMs`, and step only when a second model says what changed needs one. The run's `intervalMs` is this poll, set by the server at start,
   * because the manifest commits `intervalMs` and it should say how often the loop looked.
   */
  | { kind: "gate"; pollMs: number };

/** Why a gated run's step started. */
export type LoopWakeReason = "gate" | "heartbeat" | "unavailable" | "manual" | "routine";

/**
 * A feature a stored loop row can carry that this build does not have: a team, a gate, an oracle
 * request or feed trigger, the trace audit, or protocol-plugin grants. Each is on the roadmap, with no
 * write side and no page section here; a row that carries one is refused at every door and stopped if
 * it is still running, and its page says so in one line.
 */
export type EarlierBuildFeature = "team" | "gate" | "oracle" | "trace-audit" | "grants";

/** The keys each feature is carried by, as a loop row, a start body and a template config all spell them. */
export interface EarlierBuildTerms {
  workers?: unknown;
  gate?: unknown;
  trigger?: unknown;
  traceAudit?: unknown;
  grants?: unknown;
}

/**
 * The roadmap features `terms` carries, in this fixed order, or `[]`. Read on the rules the refusals
 * read them by, so the page names exactly what a start would refuse: `workers` and `traceAudit` count
 * unless absent, `null` or `false`; a gate is a `gate` that is set or a `gate` trigger; an oracle
 * trigger is a `request` or `feed` one; grants are any `grants` at all. Tolerant of every shape, because
 * older stored rows are read with it.
 */
export function earlierBuildFeatures(terms: EarlierBuildTerms | null | undefined): EarlierBuildFeature[] {
  if (!terms || typeof terms !== "object") return [];
  const on = (v: unknown) => v !== undefined && v !== null && v !== false;
  const kind = (terms.trigger as { kind?: unknown } | null | undefined)?.kind;
  const out: EarlierBuildFeature[] = [];
  if (on(terms.workers)) out.push("team");
  if (kind === "gate" || (terms.gate !== undefined && terms.gate !== null)) out.push("gate");
  if (kind === "request" || kind === "feed") out.push("oracle");
  if (on(terms.traceAudit)) out.push("trace-audit");
  if (terms.grants !== undefined) out.push("grants");
  return out;
}

/** What each roadmap feature is called in a sentence. */
const EARLIER_BUILD_NAME: Record<EarlierBuildFeature, string> = {
  team: "a team",
  gate: "a gate",
  oracle: "an oracle trigger",
  "trace-audit": "the trace audit",
  grants: "protocol-plugin grants",
};

/** `a team`, `a team and a gate`, `a team, a gate and the trace audit`. */
export function earlierBuildList(features: readonly string[]): string {
  const names = features.map((f) => EARLIER_BUILD_NAME[f as EarlierBuildFeature] ?? f);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The loop page's one line for a row that carries a roadmap feature, or `null` for every other row.
 * What the run did with the feature is on its chain; this build neither steps such a row nor draws
 * the feature's section.
 */
export function earlierBuildSentence(features: readonly string[] | null | undefined): string | null {
  if (!features?.length) return null;
  const one = features.length === 1;
  return (
    `Written with ${earlierBuildList(features)}, ${one ? "which is" : "which are"} not in this ` +
    `build: this page leaves ${one ? "it" : "them"} out, and this console steps the run no further.`
  );
}

/**
 * The start form's one line for a source (`This run`, `This template`, `This preset`) written with a
 * roadmap feature, or `null`: the form sends none of them, so the loop starts without them.
 */
export function earlierBuildStartSentence(from: string, features: readonly string[] | null | undefined): string | null {
  if (!features?.length) return null;
  const one = features.length === 1;
  return (
    `${from} was written with ${earlierBuildList(features)}, ` +
    `${one ? "which is" : "which are"} not in this build, so this loop starts without ${one ? "it" : "them"}.`
  );
}

/**
 * Why a gated run's step started, as a gated row keeps it on the step. No screen draws it, since the
 * gate is on the roadmap; `gateHash` is the twelfth manifest key the step's checkpoint committed the
 * log under, which the browser's leaf check rebuilds the manifest with.
 */
export interface LoopStepWakeView {
  reason: LoopWakeReason;
  gateHash: string;
  pActBps?: number;
  barBps?: number;
  width?: "solo" | "small" | "full";
  /** Asks and quiet ticks the log this step closed carried. */
  asks: number;
  quiet: number;
  /**
   * The asks' voucher deltas, base units: what Lath paid for them on the loop's channel. Lath pays
   * its decisions, so this is charged to nobody; on an older row a step's checkpoint may have added
   * it to the owner's charge.
   */
  costBase: string;
}

/**
 * What one step's oracle work did, on a step woken by a `request` trigger. Nothing in this build
 * writes it. Only `requestAddress` is read, because the step's manifest committed it and the leaf
 * does not rebuild without it (`lib/loops.ts`); the publish fields an older row may carry
 * (`published`, `rejectReason`, `signature`, `error`) belong to a Requests card that is on the
 * roadmap with the oracle's client, so nothing here reads them.
 */
export interface StepOracleView {
  /** Base58 of the `Request` this step was woken by. */
  requestAddress?: string;
}

/**
 * What the second model said about a step before its output became memory, when the loop asked for
 * one. Absent on every step of a loop that did not, and on older rows written without verify.
 *
 * `unavailable` and the rest are mutually exclusive: an outage commits the memory as it always
 * did and writes no `verifyHash`, so the row has to be able to say *the verifier did not answer*
 * rather than implying a verdict nobody gave.
 */
export interface StepVerifyView {
  /**
   * `accepted` kept the memory, `retried` carried the previous one forward, `escalated` stopped
   * the run. Absent exactly when `unavailable` is set: the verifier gave no verdict, the memory
   * was committed as it always is, and naming an outcome there would be reporting a judgement
   * nobody made.
   */
  outcome?: "accepted" | "retried" | "escalated";
  /**
   * The model's own word — `accept`, `retry` or `escalate`. Absent when it answered anything
   * else: that answer is model-written text, and this row is served by an open GET.
   */
  verdict?: string;
  /** The confidence the threshold was applied to. */
  confidence?: number;
  /** The `followed_plan` probability, shown beside the verdict and never thresholded. */
  followedPlan?: number;
  /** The dated build the gateway resolved, e.g. `typesafe/jev-1.13-20260917`. */
  model?: string;
  /** What the decision cost on the loop's channel, base units — 42 as measured. */
  costBase?: string;
  /** `sha256` of the decision blob, the ninth manifest key — what the trace panel opens. */
  verifyHash?: string;
  /** Why there is no verdict: a timeout, a non-200, a transport error. */
  unavailable?: string;
  /**
   * Beside `unavailable`, when Jev was not asked because this loop's Jev budget is spent:
   * `Jev budget spent`, the gate strip's word for the same reason.
   */
  capped?: string;
  /** Set on a scripted, unbilled step, whose verdict is a fixture and paid for nothing. */
  scripted?: true;
}

/**
 * What Jev said about the goal after a step, on a goal loop whose owner left _Jev checks the goal_
 * on. Absent on every step of any other run, and on older rows written without the check.
 *
 * `outcome` is what the runner did: `achieved` ended the run, `continue` did not, `unavailable`
 * left it to the agent's own `GOAL REACHED`, as a goal loop without the check does. `disagreement`
 * is set when Jev and the agent's claim parted ways.
 */
export interface StepGoalCheckView {
  outcome: "achieved" | "continue" | "unavailable";
  /** Whether the step's answer ended with `GOAL REACHED`. */
  claimed: boolean;
  /** Jev's word; absent when it gave neither of the two. */
  choice?: "achieved" | "continue";
  confidence?: number;
  /** The bar `achieved` was held to: the verify seat's, or the committed 0.5. */
  bar?: number;
  /** `overruled` the agent claimed and Jev said continue; `unclaimed` Jev said achieved unasked. */
  disagreement?: "overruled" | "unclaimed";
  /** Why there is no answer: a timeout, a non-200, the verify seat's own outage. */
  unavailable?: string;
  model?: string;
  /**
   * `sha256` of the goal-check blob, the fourteenth manifest key — only on a run with no verify
   * seat. With the seat the answer is inside the blob `verify.verifyHash` names.
   */
  goalCheckHash?: string;
  /** What a goal-only decision cost on the loop's channel, base units. */
  costBase?: string;
  /**
   * Beside `unavailable`, when Jev was not asked because this loop's Jev budget is spent:
   * `Jev budget spent`. The loop went on, ended only by the agent's claim.
   */
  capped?: string;
  /** Set on a scripted, unbilled step, whose answer is a fixture. */
  scripted?: true;
}

/**
 * What the trace audit (on the roadmap) said about a step, on a row whose policy has `traceAudit`.
 * Absent on every step of any other run.
 *
 * `outcome` is what the runner did: `clean` and `flagged` changed nothing, `stopped` kept the step
 * out of memory and stopped the loop (`trace-flagged`), `unavailable` is the outage row, which
 * changed nothing either. Like the goal chip, only a fixed vocabulary reaches the open GET: ids,
 * numbers, the confirm's two words and the model names — never a line of the span, which is the
 * agent's trace and is read from the blob by those who may read the trace.
 */
export interface StepTraceAuditView {
  outcome: "clean" | "flagged" | "stopped" | "unavailable";
  /** Every behaviour at or above its bar, in id order, with what came of it. */
  hits: {
    id: string;
    /** The model's probability, or 1 for a code check's hit. */
    p: number;
    bar: number;
    onPresent: "flag" | "stop";
    /** `stop` vetoed the step; `flag` marked it, including a veto the confirm dismissed. */
    action: "flag" | "stop";
    dismissed?: true;
    /**
     * On a veto that stood: by the confirm's word, by the fail-closed rule, or `code` — a code
     * check's stop, which no confirm is asked about.
     */
    confirmed?: "confirmed" | "fail-closed" | "code";
    /** Set when a code check found it on the host rather than the model. */
    by?: "code";
  }[];
  stopped: boolean;
  /** `traceAuditLine`'s text, the audit's own words for the step: `trace: clean (5 behaviours)`. */
  line: string;
  /** How many behaviours were checked, by the model and by code together. */
  behaviours: number;
  /** The behaviours checked by code on the host and never sent to the model, sorted. Absent when none. */
  codeChecked?: string[];
  /** Why there is no answer: no trace, a timeout, a non-200, a missing number. */
  unavailable?: string;
  /** Beside `unavailable`, when the loop's decision budget was spent: `Jev budget spent`. */
  capped?: string;
  /** The dated build the model answered with; absent when every behaviour was code-checked. */
  model?: string;
  /** `sha256` of the blob, the sixteenth manifest key: set only when the audit answered. */
  traceAuditHash?: string;
  /** The `llm.*` Action the span was rendered from. */
  spanSeq?: string;
  /** What the model's call cost on the loop's channel, base units: Lath's decision spend. */
  costBase?: string;
  /** A model call the channel paid for and that never answered, stored and not committed. */
  paidHash?: string;
  /**
   * The veto's second opinion: the audited session's own model, its word per vetoed
   * behaviour (the quoted evidence stays in the blob), and what the call cost Lath.
   */
  confirm?: {
    model: string;
    verdicts: Record<string, { verdict: "confirm" | "dismiss"; failClosed?: string }>;
    unavailable?: string;
    costBase?: string;
  };
  /** Set on a scripted, unbilled step, whose answer is a fixture. */
  scripted?: true;
}

/**
 * Why a run stopped, in words, for the reasons a bare code does not read as a sentence.
 *
 * Here rather than in `_lib/copy.ts` — which is the clone/launch rules and pulls `crypto` and
 * `runner.ts` in with it — because this file is the one both the server and the browser can
 * import, and the wording belongs to whichever of them renders the row.
 */
export const LOOP_STOP_REASON_TEXT: Record<string, string> = {
  escalated: "a second model judged a step outside what this loop was asked to do, and the run stopped there",
  // Not a failure: the loop finished, the way `max-steps` finishes one. Three words rather than a sentence because this is the one stop reason that also
  // reads as a status on the tile and in the step row, and the three places have to agree.
  "goal-reached": "goal reached",
  // Said in full wherever the run shows it: this is the one stop that is a loss, and the reader
  // needs to know it was a decision about writes, not about the work.
  "anchor-discarded":
    "the chain moved where this run's journal could not follow, and its owner discarded the last step's records; they and their charge never landed",
  // Not a failure either: the loop drew its one budget down to nothing.
  budget: "the loop's budget is spent",
  // The trace audit's veto, on a row that ran with it: the step ran and is on chain, and it was not
  // remembered; the stop detail names the behaviour and the step.
  "trace-flagged":
    "the trace audit — the decision model, or Lath's code checks — found a stop behaviour in a step's trace, and the run stopped there",
  // The four stops a loop's Tempo access key can cause. Here so the tiles, the list and the loop page say one sentence; `lib/tempo-key.ts`
  // reads them from this map rather than keeping its own copy.
  "tempo-key-limit":
    "Tempo refused the loop's next deposit: its access key reached the limit authorized at the start, so nothing past the loop's budget and its decision share could be paid",
  "tempo-key-expired":
    "the loop's Tempo access key expired, and the run stopped at the step boundary rather than pay with a key Tempo refuses",
  "tempo-key-missing":
    "the console could not load the loop's Tempo access key, so it stopped rather than pay from the treasury without the key the loop committed to",
  "tempo-key-refused":
    "the console would not open the loop's channel with its Tempo access key, so it stopped rather than pay from the treasury without the key the loop committed to",
};

/**
 * The same `budget` stop on a run with a per-step budget (`legacyStepBudget`): its sessions
 * commit a per-step `maxCost`, and what stopped it was one step reaching that, not the whole budget
 * running out — its derived budget is usually far from spent.
 */
export const LOOP_STEP_BUDGET_STOP_TEXT = "a step reached this loop's per-step budget";

/**
 * Why a run stopped, in words, read off the run rather than the code alone: a `budget` stop reads
 * as `LOOP_STEP_BUDGET_STOP_TEXT` when it was a step's per-step ceiling (`stoppedOnStepBudget`), and
 * as `LOOP_STOP_REASON_TEXT.budget` otherwise. `undefined` for a reason with no sentence, as the map.
 */
export function loopStopReasonText(
  loop: Pick<LoopView, "stopReason"> & Partial<Pick<LoopView, "legacyStepBudget" | "budgetMicroUsdc">>
): string | undefined {
  const reason = loop.stopReason;
  if (!reason) return undefined;
  if (reason === "budget" && stoppedOnStepBudget(loop)) return LOOP_STEP_BUDGET_STOP_TEXT;
  return LOOP_STOP_REASON_TEXT[reason];
}

/**
 * Whether a `budget` stop was a step's per-step ceiling rather than the loop's budget running out:
 * a run the console marks `legacyStepBudget`, and every run a console reports without
 * `budgetMicroUsdc` — such a console knows only per-step budgets. A run with one overall budget has
 * no per-step ceiling at all, so on it the stop is always the whole budget, even when the refused
 * call leaves a little of it unspent.
 */
export function stoppedOnStepBudget(loop: Partial<Pick<LoopView, "legacyStepBudget" | "budgetMicroUsdc">>): boolean {
  return loop.legacyStepBudget === true || typeof loop.budgetMicroUsdc !== "string";
}

/**
 * The three ways a row's team (on the roadmap) is named, of which exactly one is set. This is what a *template* stores, not what a run resolved to: a blueprint or a scratch
 * policy has to be re-resolved under whichever wallet launches it, and storing the copies one
 * wallet happened to register would make a loop blueprint on the shelf launch another wallet's
 * agents.
 */
export interface LoopWorkersSource {
  /** Agents the wallet already holds, 1–4, none of them the loop's own agent. */
  agentIds?: string[];
  /**
   * A launchable blueprint and how many copies of it the server registers under the loop.
   * `offerId` is a marketplace listing's own `agentId` (the marketplace is on the roadmap);
   * `templateId` is a blueprint this console already holds.
   */
  blueprint?: { offerId?: string; templateId?: string; count: number };
  /** A policy typed into the form, minted as one implicit template and registered `count` times. */
  scratch?: { policy: LoopWorkerPolicy; count: number };
}

/** The policy a *from scratch* team is minted from. One policy, N names (homogeneous). */
export interface LoopWorkerPolicy {
  prompt?: string;
  tools?: string[];
  budgetCapUsdc?: string;
  expirationDays?: number;
}

/**
 * One member's own rules inside a team: the model it runs on
 * and, when it was filled from a blueprint or from scratch, the prompt and the tools it runs
 * under. Two members of one team may therefore be two models under two policies.
 *
 * Positional: `slots[i]` is the member at `agentIds[i]`, roster order — the order tasks are
 * handed out in and the order answers enter the memory in. `model` is filled from the team's own
 * `model` on the server **before anything is hashed**, so a slot that names none is the team
 * default rather than a hole every later reader would have to fill the same way.
 */
export interface LoopWorkerSlot {
  /** What this member is called in a routing choice and on the row; its deployed name otherwise. */
  name?: string;
  model: string;
  /** The member's own frame. Absent leaves its blueprint's prompt and tools where they are. */
  policy?: { systemPrompt?: string; tools?: string[] };
}

/**
 * A team as a template version stores it: the source above, plus the terms that are the same
 * however the roster was filled — one model for the whole team, the per-task ceiling each member
 * session runs under as its `policy.maxCost`, and optionally the per-slot rules and whether a step
 * ends with a synthesis.
 */
export interface LoopWorkersConfig extends LoopWorkersSource {
  model: string;
  /**
   * Micro-USDC, a whole number as a string: each member session's `policy.maxCost`. With one
   * overall loop budget it is the loop's whole budget — there is no per-task budget to ask for, and
   * a start does not read one — and on an older version stored with a per-task ceiling, that
   * ceiling, which a start reads to derive that version's loop budget.
   */
  budgetMicroUsdcPerTask: string;
  /**
   * One slot per member, roster order, or none at all. Absent when every member runs the team's
   * own model under its blueprint's rules, and **absent before hashing** — `templateHash` drops
   * `undefined`, so a team template stored without slots keeps the hash it has and every step of a
   * run from one keeps the `policy_version_hash` it committed.
   */
  slots?: LoopWorkerSlot[];
  /**
   * Whether a step folds what the team returned back into its plan, in a second session of the
   * same agent under the same checkpoint. Absent rather than `false` when it is off, for
   * the hashing reason `slots` is.
   */
  synthesize?: boolean;
}

/**
 * A team as a *run* carries it: the roster resolved to agent ids, with the source kept beside it
 * so *Run again* and a launch re-resolve the way the first start did rather than re-using ids
 * that belong to the wallet that started it.
 */
export interface LoopWorkers {
  agentIds: string[];
  model: string;
  budgetMicroUsdcPerTask: string;
  source?: LoopWorkersSource;
  /** One slot per member in roster order, or absent — see `LoopWorkersConfig.slots`. */
  slots?: LoopWorkerSlot[];
  /** Set only when the run asked for the synthesis; absent, never `false`, when it did not. */
  synthesize?: boolean;
}

/**
 * What one member did in one step, as the step's manifest commits it plus what only the
 * console knows — what the member's session cost and which transaction opened its Delegation.
 *
 * Absent on every step of a loop without a team, and on a step that opened no member at all: a
 * step whose plan the verifier rejected runs no member, and its manifest has no `members` key
 * for the row to mirror.
 */
export interface LoopMemberView {
  agentId: string;
  /** The member's deployed name, for the link to its own page. */
  name: string;
  /** `${sessionId}:${name}`; `sha256(taskId)` is the Delegation's reference. */
  taskId: string;
  outcome: "done" | "failed" | "crashed" | "refused";
  /** The member's chain when the step closed; `"0"` / `""` when the Delegation was refused. */
  seq: string;
  head: string;
  costMicroUsdc: string;
  /**
   * Why it was refused, or what its session threw — the runner's `reason`, carried through
   * verbatim. Absent on a clean `done`, as it is on the runner's own member: a member
   * that never reached a chain has no `(seq, head)`, no session and no signature to open, so
   * this sentence is the only thing that says what happened to it.
   */
  reason?: string;
  /** The transaction that opened the Delegation on the orchestrator's chain, when there was one. */
  delegationSignature?: string;
  /** The seq of the member's own Resolution, so the row can link straight at it. */
  resolutionSeq?: string;
  /**
   * What the loop's second model said about *this member's* answer before it entered the memory.
   * On screen: _accepted_, _rejected_, or _not judged_.
   *
   * `unavailable` and the verdict are mutually exclusive for the reason `StepVerifyView` gives:
   * an outage keeps the answer, as the loop's own rule for a verifier outage does, and writes no
   * `verifyHash` — so the row has to be able to say *nobody judged this* rather than imply a
   * verdict. Absent on every member of a loop that asked for no judge.
   */
  verify?: { outcome: "accepted" | "rejected"; reason: string } | { unavailable: string };
  /** `sha256` of this member's decision blob — the sixth key inside its manifest object. */
  verifyHash?: string;
  /** `sha256` of its routing blob — the seventh, set only on a member a `choice` picked. */
  routeHash?: string;
  /**
   * The routing a `TASKS:` line addressed to nobody resolved to: who the `choice` named,
   * and whether the runner fell back to the first idle member because the call failed or named
   * somebody off the roster. On screen the row reads _routed by a choice_. A failed routing
   * writes no `routeHash`, which is why the two are separate keys.
   */
  route?: { chose: string; fallback: boolean };
  /**
   * `sha256` of this member's own replay record — the eighth key inside its manifest object. Set
   * only on a member whose sandbox wrote one; absent on every member of an older step written
   * without members' records, which is how the tab tells the two apart.
   */
  replayHash?: string;
  /**
   * The member's own sandbox: each member runs in a sandbox of its own, seeded with the loop's
   * sources. Absent on a member that never reached a sandbox and on older steps that kept no
   * member sandbox. Its replay record is replayable from the checkpoint only when `replayHash`
   * above committed it and equals the record's own hash.
   */
  zeroclaw?: ZeroClawStepRecord;
}

/**
 * The Sandbox section of the loop form: one config per loop, copied to every sandbox of it. Every
 * key is optional and a form that leaves the section untouched sends no `sandbox` at all, so its
 * policy, template and manifests hash exactly as a run without a sandbox config does.
 *
 * - `tools`: the host's tools the owner switches. _Files_ is always on and not a key.
 *   A switch narrows what the agent's deployed policy names and never widens past it.
 * - `maxBytes` / `maxFiles`: the workspace cap, lowered only (the sandbox's own cap is the ceiling).
 * - `sources`: at most `SOURCES_MAX_INPUTS`, fetched once when the loop starts.
 */
export interface SandboxConfig {
  tools?: { chain?: boolean; store?: boolean };
  maxBytes?: number;
  maxFiles?: number;
  sources?: SandboxSourceInput[];
}

/**
 * What a loop record keeps of its sandbox: the config as started, the manifest's hash when it had
 * sources, and where those sources are on Irys when they are there.
 */
export interface LoopSandboxRecord {
  config: SandboxConfig;
  sourcesHash?: string;
  /** Absent on a loop whose console published nothing and that restored nothing, as on older rows. */
  irys?: LoopSourcesIrys;
}

/**
 * A loop's sources on Irys: the index a stranger reads the set through, and the one
 * `LocatorRegistry` cell under the loop agent that names it.
 * Public by design, on every view: the files are in clear on Irys already. Nothing here is hashed;
 * the manifest the posture commits is the same bytes whether or not this key exists.
 */
export interface LoopSourcesIrys {
  /** The index's Irys id, base58: what the locator cell points at. */
  index: string;
  /** The manifest's Irys id, when this start uploaded it (a restored set's is in its index). */
  manifest?: string;
  /** Objects this start uploaded and their bytes together, for the storage card; 0 on a restore. */
  uploads: number;
  bytes: number;
  network: "devnet" | "mainnet";
  /** The gateway the console reads Irys through, and the base a page links each file to. */
  gateway: string;
  /**
   * The cell: its key (`sourcesIrysKey(sourcesHash)`, hex) and whether this start wrote it or found it
   * already there, as a restart of the same sources does.
   */
  cell: { key: string; written: boolean };
  /** Set when the start restored its sources from Irys instead of fetching them. */
  restored?: { agent: string | null };
}

/** One step as the console remembers it. The chain is the record of truth; this is a cache. */
export interface LoopStepSummary {
  step: number;
  /**
   * The session's outcome. `crashed` when the step threw before it could resolve one;
   * `no-memory` when the memory it was to resume from is not in the trace store or does not
   * re-hash (a read that failed is a step not taken, never this); `no-payload` the same for a
   * request-triggered step's payload. Kept in step with
   * `StepResult["status"]` in `@lath/runtime`, which is what writes it.
   */
  status: "success" | "failed" | "aborted" | "crashed" | "no-memory" | "no-payload";
  reason?: string;
  steps: number;
  batchedSteps: number;
  costMicroUsdc: string;
  /**
   * What this step's Tempo channel paid the gateway, USDC.e base units: its model calls and Jev's
   * decision on it, which ride the loop's one channel. A different currency on a different chain
   * from `costMicroUsdc`, so it is shown beside that figure and never added to it
   * (`lib/loop-money.ts`). Jev's part of it is Lath's spend and is not charged to the owner. Absent
   * on a step that paid nothing on Tempo, and on older rows written without it.
   */
  tempoSpent?: string;
  /**
   * The step's report as published to Tempo storage, written onto
   * the row when the PUT comes back — seconds after the row itself, because the PUT runs after the
   * leaf and off the step's clock — and again with `seq` once a later runner has written its
   * `storage.put` Action. `statusCode` is the Action's: 2xx published, anything else a failed PUT
   * recorded as failed. `amount` and `reference` are the committed PUT's charge (USDC.e base units,
   * the Tempo transaction). Absent on a step that wrote no `report/` file, on a loop with no
   * treasury, and on older rows written without Tempo storage.
   */
  /**
   * `sha256` of the Tempo carry blob, the fifteenth manifest key, on a step whose loop's Tempo
   * services carried something. On the row because the browser rebuilds the manifest from it, and a
   * step carrying it rebuilt without it reads *leaf mismatch*. Absent on older rows that do not
   * keep it on the row.
   */
  tempoHash?: string;
  tempoStorage?: {
    key: string;
    path: string;
    bytes: number;
    statusCode: number;
    amount?: string;
    reference?: string;
    error?: string;
    seq?: string;
  };
  /**
   * `"none"` once the step's report job has looked and found no file the step wrote under `report/`,
   * so there is nothing to PUT and the row's storage chip has nothing to wait for. Without it every
   * paid step would read _publishing report · waiting on the PUT_ for a minute whether a report was
   * coming or not (`STORAGE_PENDING_MS`). Absent while the job runs, on a step that published, and
   * on older rows written without it, which keep the minute.
   */
  tempoReport?: "none";
  /**
   * The loop's Tempo state read after this step's leaf over the paid RPC (`TempoSnapshot` in
   * `runtime/src/loop-tempo.ts`): the block, the model channel's deposit,
   * settled total and cumulative, the treasury's USDC.e, and the RPC channel's own cumulative. The
   * chain's copy rides in the next leaf's carry blob; this is the console's, for _read from Tempo at
   * block N_. Absent on a loop with no treasury and on older rows written without it.
   */
  tempoSnapshot?: {
    ofStep: number;
    takenAt: number;
    block?: string;
    channel?: { id: string; deposit?: string; settled?: string; cumulative?: string };
    treasury?: { usdcE?: string };
    rpc: { channelId?: string; cumulative?: string };
    error?: string;
  };
  /** Seq the leaf commits to — also the seq of the `loop.step` record. */
  seq?: string;
  head?: string;
  leaf?: string;
  leafOk: boolean;
  signature?: string;
  epochs: { startSeq: string; endSeq: string; root: string; signature: string; steps: number }[];
  /** `sha256(memory)` the step's manifest commits to — what the next step is told. */
  memoryHash?: string;
  /** The step whose memory this one resumed from, and the hash it was fetched and checked under. */
  resumedFromStep?: number;
  resumedMemoryHash?: string;
  /**
   * What the step's extra chain work threw (`LoopRunner`'s `work` hook). The session resolved
   * and the step checkpointed regardless, so `status` alone would show it clean; this is what
   * says it was not.
   */
  workError?: string;
  /**
   * Why a failed step failed, when it was not the work's fault: `no-answer`, a model call got no
   * answer on any attempt — the step reads _no answer_ in amber and says the loop goes on, rather
   * than a bare _failed_. Absent on every other row, and on older rows written without it, which
   * render as a plain failure.
   */
  cause?: "no-answer";
  /**
   * What Lath paid for this step's model-call attempts that got no answer, USDC.e base units: the
   * owner was charged nothing for them. Absent when there were none.
   */
  absorbedBase?: string;
  /**
   * `payload_hash` of the genesis this step's session opened with — the key its bundle is
   * anchored under (`sdk/src/bundle.ts`), and the one thing the browser needs to read the step's
   * memory without a raw gateway. Absent on older steps written without bundles, and on a step
   * whose session never opened.
   */
  genesisPayloadHash?: string;
  /** Absent on every step but a request-woken one. */
  oracle?: StepOracleView;
  /** What the second model said about this step, when the loop asked for one. */
  verify?: StepVerifyView;
  /** What Jev said about the goal, on a goal-checked run. */
  goalCheck?: StepGoalCheckView;
  /**
   * What the trace audit said, on a row that ran trace-audited. No screen draws it, since the trace
   * audit is on the roadmap: the browser's leaf check reads its `traceAuditHash`, and the Tempo
   * figures read what it cost Lath.
   */
  traceAudit?: StepTraceAuditView;
  /**
   * Why this step started, on a row that ran gated: every step of one closes the gate's log,
   * whatever woke it. Absent on every other run's rows; read for its `gateHash` alone.
   */
  wake?: LoopStepWakeView;
  /**
   * One row per member the step opened, in roster order — the eleventh manifest key as the console
   * remembers it, on a row that ran with a team. Absent on a step that opened none. No screen draws
   * it, since teams are on the roadmap; the browser's leaf check rebuilds the manifest from it.
   */
  members?: LoopMemberView[];
  /**
   * What the members together cost, micro-USDC, kept apart from `costMicroUsdc` above so a page
   * can say what the loop's own agent spent and what its team spent. Absent exactly when
   * `members` is.
   */
  memberCostMicroUsdc?: string;
  /**
   * The second orchestrator session of a step that plans and then synthesizes: the same agent
   * resumed with its plan and the team's
   * answers, whose output **is** the step's memory. Both sessions are Resolutions on one chain
   * under one leaf and one `loop.step`, so this is a row on the step rather than a step of its
   * own, and the page shows it as one more row labelled _Synthesis_.
   *
   * Absent on a step that ran one session — a run that did not ask for it, a step whose plan the
   * verifier rejected, and a step no member returned output to, which is skipped.
   *
   * The row carries no text. The synthesis's output *is* the step's memory, a blob the page reads
   * through `memoryHash` and re-hashes like every other memory cell; a run written encrypted under
   * the owner's key reads as `encrypted` there.
   */
  synthesis?: {
    sessionId: string;
    costMicroUsdc: string;
    /**
     * Never on the wire: on an older row it is the plaintext of an encrypted memory, which the open
     * `GET /api/loops?id=` must not serve. Rows in `loops.json` that hold it are read, and
     * `publicLoop` strips it on the way out. Declared only so such a row still type-checks; nothing
     * should read it.
     */
    output?: string;
  };
  /**
   * The sandbox the step ran in: the wrapper, the posture as committed, the binary, the tool
   * Actions by seq, the workspace against its cap and the replay record — hashes and sizes, never a
   * token or prompt text. The posture's texts are kept on the newest row only. Absent on a step that
   * ran no sandbox, as on older rows.
   */
  zeroclaw?: ZeroClawStepRecord;
  /**
   * The _changed since pinned_ note the step's sandbox was told: the text
   * `sourcesRefreshNote` wrote into the step's message, which the replay record's `messageHash`
   * commits. One line per Solana source — unchanged, `old → new` per changed field, or could not be
   * re-read. Absent on a loop with no Solana source, on a step whose sandbox never opened, on older
   * rows written without it, and on a view for a reader who is not the owner (it names the sources).
   */
  sourcesNote?: string;
  /** The locator of this step's bundle, or why the seal did not land. Neither fails the step. */
  bundle?: { scheme: number; id: string; count: number; bytes: number } | { error: string };
  /**
   * What the step cost to keep, measured: the lamports its chain writes took, its bundle's bytes,
   * and what Irys charged when the console anchors there. Absent on older rows written without it,
   * and on one whose reading was not attributable,
   * and the loop page then renders no storage card for it rather than a guess.
   */
  storage?: LoopStepStorage;
  /**
   * The checkpoint this step still owes, present only while its writes have not landed. The leaf
   * is a statement about the chain at the moment it is taken, so a step whose records are still
   * journaled cannot have one; *Retry the step* writes it when they land and clears this.
   * Everything in it is metadata the retry cannot reconstruct — the chain part is read then.
   */
  deferredCheckpoint?: {
    loopId: string;
    step: number;
    sessionId: string;
    intervalMs: number;
    maxSteps: number;
    promptHash: string;
    startedAt: number;
    /**
     * The code the `loop.step` record will carry: 200 a success, **201 a step that reached the
     * loop's goal** (`LoopStepStatus.GoalReached`), 499 aborted, 500
     * failed. 201 is additive — a reader that switches on the three older codes must fall
     * through to *unknown*, never to *failed*.
     */
    statusCode: number;
    memoryHash?: string;
    memoryIsOwn?: boolean;
    requestAddress?: string;
    /**
     * `sha256(goal)`, the manifest's tenth key, on a goal loop only. Listed here because this
     * plan is persisted as JSON and read back to build the manifest a *Retry the step* writes:
     * a key this shape does not name is a key a repaired step's manifest is missing, and the
     * `args_hash` it commits then fails `verifyStep` against the one the runner meant to write.
     */
    goalHash?: string;
    /**
     * What each member's chain committed to when the step closed, in roster order — the
     * eleventh manifest key. Listed here for the reason `goalHash` is: this plan is persisted
     * as JSON and read back to build the manifest a *Retry the step* writes, so a key this
     * shape does not name is a key the repaired step's manifest is missing, and the `args_hash`
     * it then commits fails `verifyStep` against the one the runner meant to write. It cannot
     * be recomputed either way — it is a statement about three other chains at one moment.
     */
    members?: {
      agentId: string;
      taskId: string;
      outcome: LoopMemberView["outcome"];
      seq: string;
      head: string;
      /**
       * The sixth and seventh keys inside the member object, listed for the same reason the five above are: a key the plan loses is a key the
       * repaired manifest is missing, and neither can be recomputed — one names a decision blob
       * and the other a routing blob, both already paid for and already in the store.
       */
      verifyHash?: string;
      routeHash?: string;
    }[];
    /**
     * The gate log's hash, the twelfth manifest key, on a gated loop's step only — listed for the
     * reason `goalHash` is: a key this shape does not name is a key the repaired manifest is missing.
     */
    gateHash?: string;
    /**
     * What an older plan said its late checkpoint would debit for the log's asks and for Jev's
     * decision, micro-USDC. Nothing writes them and the Retry charges neither: Jev is paid by Lath
     * and free for users, so such a plan lands uncharged. Kept because such plans can be on disk,
     * and a discard says what they would have charged.
     */
    gateChargeMicroUsdc?: string;
    decisionChargeMicroUsdc?: string;
    /**
     * `sha256` of the step's replay record, the thirteenth manifest key, on a step that ran in a sandbox — listed for the reason `goalHash` is: the record names the
     * workspace and the seqs as the step left them, which the Retry cannot read back.
     */
    replayHash?: string;
    /**
     * `sha256` of the goal-check blob, the fourteenth manifest key, on a goal-checked step of a run with no verify seat — listed for the reason `goalHash` is.
     */
    goalCheckHash?: string;
    /** The fifteenth key, the Tempo carry blob, as the committed path would have written it. */
    tempoHash?: string;
    /**
     * The sixteenth, the trace-audit blob: the reader, and a veto's
     * confirm, were paid for once and the Retry cannot ask again.
     */
    traceAuditHash?: string;
    genesisPayloadHash?: string;
  };
  /**
   * Unix ms *Retry the step* landed this step's records and wrote its checkpoint. The step ran and
   * its writes were late, not lost — which the `reason` it stopped with no longer says, so the
   * retry rewrites that too. `status` is left alone: the Resolution the retry landed was built
   * after the drain had failed, and it says `failed` on chain.
   */
  landedOnRetryAt?: number;
  /**
   * The step would have ended the loop on its goal had its writes landed (`StepResult.deferredGoalReached`):
   * the Retry that lands its plan ends the run `goal-reached` rather than putting it back on its
   * schedule. Its record stays at 200 — a late checkpoint never carries 201 — so no receipt is due.
   */
  deferredGoalReached?: true;
  /**
   * Unix ms the owner discarded this step's journaled records, because the chain had moved
   * somewhere they could never land. Neither the records nor the charge they carried
   * reached the chain; the entries are in the journal's side file.
   */
  discardedAt?: number;
  startedAt: number;
  endedAt: number;
  // A step of a loop that ran with grants also carries `plugins`, its protocol-plugin record
  // as rows. Nothing in this build reads it and `publicStepRow` keeps it off the wire: the record is the
  // manifest's `pluginHash`, which `lath-audit` opens.
}

/**
 * The stop record's half about the loop's Tempo services (`TempoServicesStop` in
 * `runtime/src/loop-tempo.ts`), as much of it as the page reads: restated here rather than imported
 * because this file is the browser's and `@lath/runtime` is not. Amounts are USDC.e base units and
 * blocks block numbers, decimal strings.
 */
export interface LoopTempoServicesStop {
  v?: number;
  lastSnapshot?: NonNullable<LoopStepSummary["tempoSnapshot"]>;
  /** The block of the model channel's close transaction. */
  closeBlock?: string;
  /** The RPC channel's close: what Lath paid for the loop's Tempo reads, once it settled. */
  rpc?: { channelId?: string; closed: boolean; txHash?: string; spent?: string; error?: string };
}

/**
 * A step's storage, as the console measured it (`LoopStepSummary.storage`). Nothing here is hashed
 * or committed; it is what the step's keeping cost, written beside the row.
 *
 * - `lamports`: what the loop's own chain writes took from the key that pays for them — every record,
 *   epoch commit, locator cell and the bundle's seal, including the per-write fees Light Protocol
 *   moves inside the instruction, which a transaction meta's `fee` does not count.
 * - `source` says how that figure was read, and the page shows it as the figure's tag. `chain` is the
 *   sum over the step's own transactions, each read from its meta. `console` is the fee payer's
 *   balance before the step less its balance after, which the run slot makes attributable: no other
 *   session writes while a step holds it.
 * - `bundleBytes`: the sealed bundle's size, 0 when the seal did not land.
 * - `irysLamports`: the uploader's Irys balance across the step (the epoch blob, its manifest and
 *   the bundle), present only when the console anchors to Irys. It is always a `console` reading.
 */
export interface LoopStepStorage {
  lamports: number;
  source: "chain" | "console";
  bundleBytes: number;
  irysLamports?: number;
}

/**
 * The rent rate the storage card's naive comparison uses: 3 480 lamports per byte-year, held for the
 * two years that make an account rent-exempt, over the data plus the 128 bytes every account carries.
 * These are the cluster's parameters on devnet and mainnet alike; the page states the result as
 * _derived_ because it is arithmetic, not a reading.
 */
export const RENT_LAMPORTS_PER_BYTE = 6_960;
export const RENT_ACCOUNT_OVERHEAD_BYTES = 128;

/** The rent-exempt minimum of one plain account holding `dataBytes`. */
export function rentExemptLamports(dataBytes: number): number {
  return (RENT_ACCOUNT_OVERHEAD_BYTES + Math.max(0, dataBytes)) * RENT_LAMPORTS_PER_BYTE;
}

/**
 * What the storage card shows for one step, or `null` when it shows none.
 *
 * `measured` is the row's own `storage`, tagged as it was read. `derived` is what the same step would
 * have cost as plain accounts: every call the step batched into its epoch, each session's Genesis and
 * Resolution, and the `loop.step` checkpoint, each as its own `recordBytes` account at the rent-exempt
 * minimum, plus the bundle's bytes as one account's data. `compressedPerRecord` is what one record
 * costs as the product writes it, from `sdk/src/storage.ts`, so the card can say both per-record
 * figures side by side. The SDK's two constants are passed in rather than imported, so a Node test can
 * reach this under the root tsconfig, which does not resolve `@lath/sdk/browser`.
 *
 * `null` on a row written without `storage`, and on one whose `storage` is not the shape this
 * build writes: a card with a zero or a guess in it would read as a measurement.
 */
export interface StorageCardView {
  measured: LoopStepStorage & { bundleOn: "irys" | "store" | "none" };
  derived: {
    records: number;
    perRecord: number;
    compressedPerRecord: number;
    recordsLamports: number;
    bundleLamports: number;
    lamports: number;
  };
}

/** `LocatorScheme.Irys` (`sdk/src/locator.ts`), restated for the same reason the SDK's constants are passed in. */
const IRYS_LOCATOR_SCHEME = 4;

export function storageCardOf(
  row: Pick<LoopStepSummary, "storage" | "batchedSteps" | "genesisPayloadHash" | "synthesis" | "seq" | "bundle">,
  sdk: { lamportsPerRecord: number; recordBytes: number }
): StorageCardView | null {
  const s = row.storage;
  if (!s || typeof s !== "object") return null;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!count(s.lamports) || !count(s.bundleBytes)) return null;
  if (s.source !== "chain" && s.source !== "console") return null;
  if (s.irysLamports !== undefined && !count(s.irysLamports)) return null;

  const bundle = row.bundle && "bytes" in row.bundle ? row.bundle : null;
  const bundleOn = !bundle || s.bundleBytes === 0 ? "none" : bundle.scheme === IRYS_LOCATOR_SCHEME ? "irys" : "store";
  // One session, or two on a synthesizing step; none on a step that never opened one.
  const sessions = row.genesisPayloadHash ? (row.synthesis ? 2 : 1) : 0;
  const records = (count(row.batchedSteps) ? row.batchedSteps : 0) + 2 * sessions + (row.seq ? 1 : 0);
  const perRecord = rentExemptLamports(sdk.recordBytes);
  const recordsLamports = records * perRecord;
  const bundleLamports = s.bundleBytes > 0 ? rentExemptLamports(s.bundleBytes) : 0;
  return {
    measured: {
      lamports: s.lamports,
      source: s.source,
      bundleBytes: s.bundleBytes,
      ...(s.irysLamports !== undefined ? { irysLamports: s.irysLamports } : {}),
      bundleOn,
    },
    derived: {
      records,
      perRecord,
      compressedPerRecord: sdk.lamportsPerRecord,
      recordsLamports,
      bundleLamports,
      lamports: recordsLamports + bundleLamports,
    },
  };
}

/**
 * What a *discard* dropped from a run's journal: when, how many entries, where they were
 * written, and the money — a charge that never moved is the operator's loss, because the model
 * calls it paid for were paid out of the treasury over Tempo.
 */
export interface LoopDiscard {
  at: number;
  entries: number;
  /** Charges in the dropped records that were never debited, micro-USDC. */
  unbilledMicroUsdc: string;
  /** Charges sent on their own before their record failed; they may have moved. Usually "0". */
  chargedMicroUsdc: string;
  /**
   * The part of `chargedMicroUsdc` whose landing nobody confirmed — a charge journaled in doubt
   * (`runtime/src/anchor.ts` `inDoubt`). Absent when zero, and on older discards recorded without it.
   */
  inDoubtMicroUsdc?: string;
  /** The side file the entries were written to, relative to the trace directory. */
  file?: string;
  /** Where the chain stood, and why that was a divergence. */
  reason: string;
  /**
   * On a gated run, the gate asks a dropped checkpoint would have committed: how many, their
   * summed voucher delta in base units, and the micro-USDC an older plan carried for them, never
   * debited — `"0"` on a plan whose asks Lath pays. Absent on every other discard.
   */
  gate?: { asks: number; costBase: string; uncharged: string };
}

/** What `GET /api/loops` returns per loop — the projection `publicLoop` builds. */
/**
 * Where a running step is, in the console's words: reading the chain and its sources, in its
 * sandbox, waiting on its nth model call, waiting on Jev, or writing its checkpoint. Not committed
 * anywhere; nothing in it is the owner's text.
 */
export type LoopStepStage = "reading chain" | "in sandbox" | `model call ${number}` | "Jev" | "anchoring";

/**
 * A stage as the page says it. The console sends `Jev` for the decision model's turn — a wire value,
 * kept — and the screen calls it the decision model, which is Jev and only Jev.
 */
export function stepStageText(stage: string | null | undefined): string | undefined {
  if (!stage) return undefined;
  return stage === "Jev" ? "decision model" : stage;
}

export interface LoopView {
  id: string;
  agentId: string;
  agentName: string;
  owner: string;
  /** The run's traces were written in the clear (`LoopRecord.plainTraces`); absent on an older row written without it. */
  plainTraces?: true;
  /** The standing instruction. `promptHash` is what a step's manifest commits. */
  prompt: string;
  promptHash: string;
  intervalMs: number;
  maxSteps: number;
  /**
   * The loop's one overall budget, micro-USDC: what its steps draw down. Always present — an older
   * run with a per-step budget reads as its derived budget, the per-step ceiling times its steps
   * with the team's share.
   */
  budgetMicroUsdc: string;
  /**
   * What the owner has been charged against it so far, micro-USDC — sessions A and B and every
   * member. `budgetMicroUsdc − spentMicroUsdc`, floored at zero, is what is left.
   */
  spentMicroUsdc: string;
  /**
   * What Lath may spend on Jev for this loop — gate asks, verify decisions, goal checks — USDC.e
   * base units, 6 decimals like µUSDC: a share of the loop budget (`LATH_JEV_BUDGET_PERCENT`,
   * default 15%) frozen at the start. Paid by Lath, never charged to the owner.
   */
  jevBudgetBase: string;
  /** What Lath has spent on Jev for this loop so far, base units, by each call's actual voucher. */
  jevSpentBase: string;
  /**
   * Set on an older run whose sessions commit a per-step `maxCost`: its `budgetMicroUsdc` is
   * derived, and a `budget` stop on it means one step reached that per-step ceiling
   * (`loopStopReasonText`). Absent on every run with one overall budget.
   */
  legacyStepBudget?: true;
  /**
   * `floor(budgetMicroUsdc / maxSteps)` on a run with one overall budget — a share kept for pages
   * that read a per-step figure, not a ceiling anything enforces — and the per-step ceiling on a
   * `legacyStepBudget` run.
   */
  budgetMicroUsdcPerStep: string;
  model: string;
  createdAt: number;
  /**
   * Always present, even for an older row written without a trigger: `publicLoop` resolves an
   * absent one to `schedule`, so the browser never has to decide what a missing field meant.
   */
  trigger: LoopTrigger;
  /**
   * The template version this run came from — its lineage key, not a chain fact. `null` on an
   * older row recorded without a template, which is what *Run again* needs a template for: there is
   * nothing to start again from without one.
   */
  template: TemplateLinkView | null;
  /** Unix ms the owner archived this run; `null` while it is listed. */
  archivedAt: number | null;
  /**
   * The second model this run's steps are judged by, and the bar its confidence must clear. `null`
   * on a run that did not ask for one — including an older row written without verify — so the
   * browser reads *off* rather than guessing a default the run never committed.
   */
  verify?: { model: string; minConfidence: number } | null;
  /**
   * The roadmap features this row carries that this build does not have (`earlierBuildFeatures`),
   * which the page names in one line (`earlierBuildSentence`). Absent on every row without one, which
   * is every row this build starts.
   */
  earlierBuild?: EarlierBuildFeature[];
  /**
   * What this run is working toward, in the owner's words. Absent on a run that has none —
   * including an older row written without goals — so the browser reads
   * *no goal* rather than an empty string it would have to decide the meaning of.
   */
  goal?: string;
  /**
   * `sha256(goal)` in hex — the tenth key of every one of this run's step manifests, so a reader
   * who knows the goal can rebuild a manifest and reach `verdict: "ok"`, and a console that
   * misreported the goal produces a `"mismatch"`. Absent exactly when `goal` is.
   */
  goalHash?: string;
  /**
   * Jev's goal check: the pinned model and the bar its `achieved` is held
   * to. Absent when the run has no goal or its owner turned the check off.
   */
  goalCheck?: { model: string; minConfidence: number };
  status: "running" | "paused" | "stopped";
  /**
   * The `LoopStopReason` the runner wrote, or a sentence. `escalated` comes from verify and
   * `goal-reached` from a goal; `LOOP_STOP_REASON_TEXT` is how both read on screen.
   */
  stopReason: string | null;
  stopDetail: string | null;
  steps: number;
  lastSeq: string | null;
  lastHead: string | null;
  lastLeaf: string | null;
  /** The loop's Tempo channel and settlement, on the `tempo` rail only; null otherwise. */
  tempo?: {
    payer: string;
    channelId?: string;
    closed: boolean;
    txHash?: string;
    spent?: string;
    error?: string;
    /**
     * The channel closed but its `loop.settlement` record was not written, because the chain
     * owed writes when the loop stopped; Retry writes it from the stored receipt.
     */
    recordOwed?: boolean;
    /**
     * What the loop's Tempo services came to at the stop (`TempoServicesStop` in
     * `runtime/src/loop-tempo.ts`): part of the `loop.settlement` blob. The page reads the last
     * snapshot, the block the model channel's close settled in and the RPC channel's own close off
     * it. Absent on a loop with no treasury and on older stops recorded without it.
     */
    services?: LoopTempoServicesStop;
  } | null;
  /** Why the last tick degraded to the vault rail, when it did; null otherwise. */
  tempoNote?: string | null;
  /** The rail this loop runs on, decided at its first billed step; null before then. */
  rail?: "vault" | "tempo" | null;
  /**
   * The channel every step of this loop pays through while it is open (one per loop),
   * with the cumulative after the last paid call in base units; null on the vault rail and after
   * the settlement.
   */
  channel?: {
    channelId: string;
    payer: string;
    openedAt: number;
    openedAtStep: number;
    cumulative: string;
  } | null;
  lastStepAt: number | null;
  lastMemoryHash: string | null;
  lastMemoryStep: number | null;
  totalCostMicroUsdc: string;
  nextStepAt: number | null;
  stepping: boolean;
  /**
   * While a step runs in this process: when the console began it (Unix ms) and what it is doing
   * now. Absent at rest, after a restart mid-step, and from a server that does not send them, so a
   * page reads `stepping` for whether and these for where.
   */
  stepStartedAt?: number;
  stepStage?: LoopStepStage;
  billing: "charged" | "unfunded" | null;
  inference: "openrouter" | "scripted" | null;
  /**
   * A Retry of this run answered _head diverged_: the chain moved somewhere its journal can
   * never follow, so the page offers *Discard* beside *Retry the step*. The server checks the
   * chain again before it discards anything; this only decides whether to show the button.
   */
  anchorDiverged?: boolean;
  /** What a discard dropped from this run's journal; absent on a run never discarded. */
  discarded?: LoopDiscard;
  /**
   * The sandbox the run was started with, so _Run again_ and a template can
   * carry it. Absent on a run started without a Sandbox section. On a non-owner view `config.sources`
   * is dropped — what the owner typed is theirs — and `sourcesHash` stays.
   */
  sandbox?: LoopSandboxRecord;
  history: LoopStepSummary[];
  /**
   * This run is one arm of an Improve: the source run it was started for, and which arm. Only on an
   * older row that carries it, since the Improve loop is on the roadmap; absent on every other run. A
   * trial's page offers no _Run again_ — the run to repeat is the source.
   */
  trial?: LoopTrialArm;
  /**
   * The loop's Tempo access key with what Tempo says of it now, on `GET /api/loops?id=` only. `null`
   * on a loop without a key; absent from a list answer and from a server that does not send it.
   */
  tempoKey?: LoopTempoKeyView | null;
  /**
   * The loop's receipt on SAS, on `GET /api/loops?id=` only.
   * `null` on a loop whose policy commits no receipt; absent from a list answer.
   */
  receipt?: LoopReceiptView | null;
  /**
   * The loop's lifecycle records on its agent's chain (`sdk/src/lifecycle.ts`): what a reader with
   * the chain and Irys alone rebuilds this row from. Absent on an older row written without them.
   */
  chain?: LoopChainView;
}

/** One lifecycle record a console wrote: `loop.start`, `loop.pause`, `loop.resume`, `loop.stop`, `agent.deploy`, … */
export interface LifecycleRef {
  tool: string;
  /** The record's seq on the agent's chain, as a decimal string. */
  seq: string;
  /** The transaction that wrote it. */
  signature?: string;
  /** Unix ms the console recorded it at. */
  at: number;
}

/**
 * A loop as its chain records it, beside the console's own row. `owed` is what the console has
 * decided and not yet written — a pause queued behind a step that holds the run slot, a stop
 * waiting on a failed write's retry — so the screen can say *recording on Solana* rather than
 * show a status the chain does not have yet.
 */
export interface LoopChainView {
  /** Lifecycle records this loop has on chain, oldest first. */
  records: LifecycleRef[];
  /** Tool ids of the lifecycle records still owed, oldest first. */
  owed: string[];
  /** The last owed write's error, when one failed and waits for its retry. */
  error?: string;
  /**
   * Whether the row was rebuilt from the chain by a console that did not start the loop (a fresh
   * state directory, another machine). Such a row is read-only here: nothing schedules it, and its
   * controls refuse with the reason.
   */
  rebuilt?: boolean;
}

/**
 * A loop's receipt on its page. `waiting`: the loop runs, or stopped and its
 * publish has not run yet; `published`: the attestation is on devnet; `failed`: the publish ran and
 * did not land (`error` says why; a console restart retries); `none`: the loop stopped without Jev's
 * `achieved`, so no receipt is published.
 */
export interface LoopReceiptView {
  status: "waiting" | "published" | "failed" | "none";
  /** The policy's pointer: the credential, the `loop-receipt` schema, the key that signs. */
  credential: string;
  schema: string;
  signer: string;
  /** The receipt's address, derived from the pointer and the loop id. */
  address: string;
  /** Set once published. */
  signature?: string;
  slot?: number;
  /** Unix ms of the publish, or of the failure. */
  at?: number;
  error?: string;
  /** What was published, as the console built it. */
  values?: {
    agent: string;
    loop: string;
    seq: string;
    head: string;
    steps: number;
    goal: string;
    usdcCharged: string;
    tempoSpent: string;
    tempoPayer: string;
  };
}

/** A loop's access key on its page: the committed terms and the live state Tempo answered. */
export interface LoopTempoKeyView {
  address: string;
  token: string;
  /** Raw USDC.e base units, decimal. */
  limitBase: string;
  /** Unix seconds. */
  expiry: number;
  authorizeTx?: string;
  /**
   * The calls the key may make, as the policy commits them; absent for an unscoped key. A call outside them is refused by Tempo with `CallNotAllowed`.
   */
  scopes?: { address: string; selector?: string; recipients?: string[] }[];
  /** `getRemainingLimit`, base units; `null` when Tempo did not answer. */
  remaining: string | null;
  /** `null` when Tempo did not answer. */
  isRevoked: boolean | null;
}

/** Which arm of whose Improve a run is (the Improve loop is on the roadmap). */
export interface LoopTrialArm {
  /** The source run the Improve was started from. */
  of: string;
  improveId: string;
  arm: "baseline" | "candidate";
}

/**
 * One posture on Irys in clear: its id (base58, as Irys prints it) and where it is read. A loop
 * row keeps one per posture hash its sandboxes committed (`LoopRecord.postures`).
 */
export interface LoopPostureIrys {
  id: string;
  network: "devnet" | "mainnet";
  /** The gateway it was uploaded to be read through, without a trailing slash: `<gateway>/<id>`. */
  gateway: string;
}
