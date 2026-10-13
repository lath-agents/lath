/**
 * What a loop may be started with, and what this build refuses (`_lib/loops.ts` re-exports it).
 *
 * The bounds a loop runs inside, each overridable by its environment variable; the decision
 * model's terms (`checkVerify`, `checkGoalCheck`); the goal and the trigger; the refusal a step
 * throws (`LoopRefused`); and the sentences that refuse the roadmap features — the trace audit, the
 * gate, a team, protocol-plugin grants — so a row that carries one still reads and is stopped before
 * it spends. Nothing here reads the registry or the chain.
 */
import { goalHash, DEFAULT_GOAL_CHECK_CONFIDENCE, GATE_ASK_BASE } from "@lath/sdk";
import { type LoopTrigger, promptHash } from "@lath/runtime";
import type { LoopRecord } from "./loop-record";

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * 10 s. The form's fastest schedule chip is the same figure (`SCHEDULE_FAST_MS` in
 * `lib/loop-trigger.ts`) and hides itself when this is set higher. Nothing hashed depends on the
 * floor — a loop commits the interval it was started with.
 */
export const MIN_INTERVAL_MS = boundedEnvNumber(
  "LATH_LOOP_MIN_INTERVAL_MS",
  process.env.LATH_LOOP_MIN_INTERVAL_MS,
  10_000,
  { min: 0 }
);

export const MAX_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Every bound here goes through `boundedEnvNumber`, not a bare `Number(env)`: a typo makes `NaN`, and
 * `steps > NaN` is false, so a malformed `LATH_LOOP_MAX_STEPS` would switch the step ceiling off for
 * every loop. The counts are floored, because a step or a loop is not had by halves.
 */
export const MAX_STEPS = Math.floor(
  boundedEnvNumber("LATH_LOOP_MAX_STEPS", process.env.LATH_LOOP_MAX_STEPS, 48, { min: 1 })
);

export const LOOPS_PER_WALLET = Math.floor(
  boundedEnvNumber("LATH_LOOPS_PER_WALLET", process.env.LATH_LOOPS_PER_WALLET, 3, { min: 0 })
);

/**
 * Starting a loop funds and registers nothing new, but it does commit the server's clock for
 * hours, so it stays at eight an hour — and *Run again* is a start.
 * Here rather than in the route because `POST /api/agents` charges the same counter when a deploy
 * carries a loop: one budget for one thing, however it was asked for.
 */
export const LOOPS_PER_HOUR = Math.floor(
  boundedEnvNumber("LATH_LOOPS_PER_HOUR", process.env.LATH_LOOPS_PER_HOUR, 8, { min: 0 })
);

/**
 * The run slot's TTL for a step, extended while the step runs (`withRunSlot`): only a process
 * that died mid-step loses the slot to it. Also what `SANDBOX_TIMEOUT_MS` is a third of.
 */
export const STEP_DEADLINE_MS = boundedEnvNumber(
  "LATH_LOOP_DEADLINE_MS",
  process.env.LATH_LOOP_DEADLINE_MS,
  10 * 60_000,
  {
    min: 0,
    minExclusive: true,
  }
);

/** How long to wait before trying again when a session or another step holds the slot. */
export const SLOT_RETRY_MS = 20_000;

/** Step summaries kept per loop. The chain is the history; this is what the list renders fast. */
export const HISTORY_KEPT = 50;

/**
 * One numeric `LATH_*` value, or its documented default when it is absent or malformed. Applied to
 * every bound here, the two money bounds below among them: `Number(env)`
 * turns a typo into `NaN`, and every comparison against `NaN` is false — so a malformed spend bound
 * would switch the bound **off**, the one outcome it must not have. The default, not `0`, because
 * `0` changes what every loop on the console does over a typo while the default is still a bound.
 */
export function boundedEnvNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max?: number; minExclusive?: boolean }
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  const low = bounds.minExclusive ? n <= bounds.min : n < bounds.min;
  if (!Number.isFinite(n) || low || (bounds.max !== undefined && n > bounds.max)) {
    const range =
      bounds.max !== undefined
        ? `from ${bounds.min} to ${bounds.max}`
        : `${bounds.minExclusive ? "above" : "at least"} ${bounds.min}`;
    console.warn(`[loops] ${name}=${JSON.stringify(raw)} is not a number ${range}; using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * The most one loop's whole budget may be, micro-USDC. There is no per-step ceiling — a loop's steps
 * draw one budget down until it is spent, `maxSteps` is reached or the goal is met — and the session
 * cap (`SESSION_CAP_MICRO`) does not bound a loop, so this is the operator's bound on what one start
 * can put on the treasury's channel. A start asking for more is clamped to it, as a per-step budget
 * over the session cap is.
 */
export const LOOP_BUDGET_MAX_MICRO = BigInt(
  Math.round(
    boundedEnvNumber("LATH_LOOP_BUDGET_MAX_USDC", process.env.LATH_LOOP_BUDGET_MAX_USDC, 25, {
      min: 0,
      minExclusive: true,
    }) * 1_000_000
  )
);

/**
 * Lath's Jev spend per loop, as a percentage of the owner's loop budget: gate asks, verify
 * decisions and goal checks, which Lath pays and charges the owner nothing for.
 * Bounded 0–100; `0` sends every ask scripted and every decision to its outage path, which is a
 * choice an operator may make on purpose. Read once, at a loop's start, into `jevBudgetBase` —
 * frozen there, so changing the rate later does not retro-apply to loops already running.
 */
export const JEV_BUDGET_PERCENT = boundedEnvNumber("LATH_JEV_BUDGET_PERCENT", process.env.LATH_JEV_BUDGET_PERCENT, 15, {
  min: 0,
  max: 100,
});

/**
 * The judge a loop asks for, resolved. The pinned model is a
 * dated build, never the `~typesafe/jev-latest` alias, because `policy_version_hash` commits it
 * and the alias moves under a run that has already committed a hash.
 */
export const DEFAULT_VERIFY_MODEL = "typesafe/jev-1.13";

export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * The one sentence a `~` alias is refused with. It is what the start form shows, so it says what to do
 * (pin a dated build) before it says why.
 */
export const VERIFY_ALIAS_REFUSAL =
  "Pin a dated Jev build; `~typesafe/jev-latest` moves and the policy hash commits the model.";

/**
 * What a judge's or a gate's pinned model may be spelled as: an OpenRouter slug, at most a hundred
 * characters. The model is written into the loop row, its template and every step's policy, and
 * shown to anonymous readers on `GET /api/loops`, so with any non-empty string taken a start could
 * add megabytes to `loops.json` and `templates.json` per signature. Refused, never clamped: the
 * model is hashed, and a slug the check accepts is exactly the slug the start named.
 */
const PINNED_MODEL = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

/**
 * Every decision seat — the verify seat, and with it the goal check and the routing choice, and the
 * gate — is Jev, one decision model: a dated or pinned `typesafe/jev-*` build is the only one a
 * policy can commit, beyond the spelling `PINNED_MODEL` checks.
 */
const JEV_BUILD = /^typesafe\/jev-/;

export const JEV_ONLY_REFUSAL = "Jev is the one decision model Lath uses: pin a typesafe/jev-* build";

/**
 * The fallback model a loop starting now on `model` commits (`LATH_FALLBACK_MODEL`, documented in
 * `runner.ts`): the setting trimmed, when it is a model slug and not `model` itself; otherwise none,
 * and the loop's chat calls are retried once on their own model and no further. Never a default:
 * a fallback is a model the loop's records may show, so only an operator who named one gets one.
 */
export function fallbackModelFor(
  model: string,
  setting: string | undefined = process.env.LATH_FALLBACK_MODEL
): string | undefined {
  const f = (setting ?? "").trim();
  return f && f !== model && PINNED_MODEL.test(f) ? f : undefined;
}

/** What a loop's `verify` resolves to on the record, in the policy, and in a template. */
export interface VerifyTerms {
  model: string;
  minConfidence: number;
}

/**
 * The verify terms a start asked for, or a sentence saying why they are not terms.
 *
 * `undefined` is the answer for both *absent* and `false`, and the caller writes **no key** for
 * it rather than `{ ...: false }`: a loop that did not ask for a judge must hash its policy and
 * its template exactly as a loop that never names verify does (the absent-when-off rule `goal`
 * follows). `true` is the resolved defaults, so the common case is one flag.
 *
 * The threshold is checked rather than clamped, unlike a poll interval: a clamp would run the
 * loop against a bar its owner did not choose and commit that bar in every step's policy hash.
 */
export function checkVerify(v: unknown): VerifyTerms | undefined | { error: string } {
  if (v === undefined || v === null || v === false) return undefined;
  if (v === true) return { model: DEFAULT_VERIFY_MODEL, minConfidence: DEFAULT_MIN_CONFIDENCE };
  if (typeof v !== "object") return { error: "verify must be true, false, or an object" };
  const asked = v as Record<string, unknown>;

  let model = DEFAULT_VERIFY_MODEL;
  if (asked.model !== undefined) {
    if (typeof asked.model !== "string" || asked.model.trim().length === 0) {
      return { error: "verify.model must be a model slug" };
    }
    model = asked.model.trim();
    if (model.startsWith("~")) return { error: VERIFY_ALIAS_REFUSAL };
    if (!PINNED_MODEL.test(model)) return { error: "verify.model must be a model slug of at most 100 characters" };
    if (!JEV_BUILD.test(model)) return { error: JEV_ONLY_REFUSAL };
  }

  let minConfidence = DEFAULT_MIN_CONFIDENCE;
  if (asked.minConfidence !== undefined) {
    // Not `Number(...)`: a string that happens to parse is a caller sending the wrong type, and
    // the number ends up inside `policy_version_hash`.
    if (typeof asked.minConfidence !== "number" || !Number.isFinite(asked.minConfidence)) {
      return { error: "verify.minConfidence must be a number between 0 and 1" };
    }
    minConfidence = asked.minConfidence;
    if (minConfidence < 0 || minConfidence > 1) {
      return { error: "verify.minConfidence must be between 0 and 1" };
    }
  }
  return { model, minConfidence };
}

/**
 * Jev's goal check, resolved: the pinned model and the bar the
 * `achieved` answer is held to. Beside the verify seat both are the seat's, because one call asks
 * both questions; without it the model is the seat's default and the bar the committed default.
 */
export function checkGoalCheck(
  v: unknown,
  goal: string | undefined,
  verify: VerifyTerms | undefined
): VerifyTerms | undefined | { error: string } {
  if (v === undefined || v === null || v === false) return undefined;
  // `true` from the form, or the resolved terms a template stored: either way the terms are
  // derived here rather than read, so a stored pair cannot disagree with the seat it runs beside.
  if (v !== true && (typeof v !== "object" || Array.isArray(v))) return { error: "goalCheck must be true or false" };
  // No goal, no check, and no refusal: the form's toggle defaults on and a start with an empty
  // goal field is the goal-less loop that exists today, whose policy must not gain a key.
  if (!goal) return undefined;
  return verify
    ? { model: verify.model, minConfidence: verify.minConfidence }
    : { model: DEFAULT_VERIFY_MODEL, minConfidence: DEFAULT_GOAL_CHECK_CONFIDENCE };
}

/**
 * Whether `terms` — a start body, a template config or a loop row — runs the trace audit, which is on
 * the roadmap and not in this build: there is no runner's audit, no terms and no form for it here. A row
 * or a template version written with one keeps it, read-only — the loop page says in one line that the
 * run used the audit (`earlierBuildFeatures`), and the browser's leaf check still rebuilds the manifest
 * key it committed — but this console starts, resumes, retries back onto its schedule and steps none.
 *
 * Refused rather than dropped, for the reason a grant is refused (`checkGrants`): a start's signature
 * binds its terms, and a run started without a term it signed would run something other than what its
 * owner asked for. "Runs" means anything but absent, `null` or `false`, so `{ traceAudit: false }` from
 * an older client starts a plain loop.
 */
export function asksForTraceAudit(terms: { traceAudit?: unknown } | null | undefined): boolean {
  const v = terms?.traceAudit;
  return v !== undefined && v !== null && v !== false;
}

/** What a start, a deploy carrying a loop, *Run again* or a template write naming the trace audit is told. */
export const TRACE_AUDIT_START_REFUSAL =
  "the trace audit is not in this build: leave out traceAudit; loops that already ran with one still verify";

/** Why a paused row that runs the trace audit cannot resume, or `null`; stopping it still settles its channel. */
export function traceAuditResumeRefusal(row: { traceAudit?: unknown } | null | undefined): string | null {
  return asksForTraceAudit(row)
    ? "this loop cannot resume: it runs with the trace audit, which is not in this build; its chain still " +
        "verifies, and stopping it still settles its channel"
    : null;
}

/**
 * Why a Retry that landed what a run owed leaves it stopped rather than back on its schedule, or `null`:
 * going back on the schedule is a resume by another door (`roadmapRetryRefusal` is the same rule).
 */
export function traceAuditRetryRefusal(row: { traceAudit?: unknown } | null | undefined): string | null {
  return asksForTraceAudit(row)
    ? "this run's writes are on chain, but it stays stopped: it runs with the trace audit, which is not in " +
        "this build; its chain still verifies"
    : null;
}

/** The `stopDetail` a running row that runs the trace audit is stopped with, at its next tick. */
export const TRACE_AUDIT_STOP_DETAIL =
  "this loop runs with the trace audit, which is not in this build, so it was stopped before its next step; " +
  "the steps it took still verify";

// ─── The gate, on the roadmap ───────────────────────────────────────────────
//
// Gated loops are on the roadmap and have no write side here: a start, a resume, a Retry
// or a template that asks for one is refused (`_lib/roadmap.ts`), and a running row that carries one
// is stopped before it steps (`tickOnce`). The record keeps its `gate`, which every step's policy of such
// a row committed and which the stop guards read; nothing writes it.

/**
 * The floor under the channel's top-up unit (`loopChannelSizing`): 240 gate asks, 0.01 USDC.e. It
 * is sized for a gated loop's asks between steps; every loop's channel uses it as a floor, so a
 * loop's deposits are the same with or without a gate.
 */
export const GATE_ASK_DEPOSIT_BASE = BigInt(GATE_ASK_BASE * 240);

// ─── Triggers ───────────────────────────────────────────────────────────────
//
// What decides a step. Only the clock steps a loop in this build. A `request` loop steps when a
// Pending `Request` in `lath-oracle` names its key, a `feed` loop publishes each step's value to its
// `Feed`, and a `gate` loop steps when a second model says so; all three are on the roadmap and have no
// write side here. A start, a resume, a Retry or a template that asks for one is refused
// (`removedFeatureOf` in `_lib/roadmap.ts`), and a running row that carries one is stopped before it
// steps (`tickOnce`). The readers below stay because stored rows may name them.

/**
 * The trigger of a run, read rather than taken off the record: a row may carry none, and absent
 * means `schedule`.
 *
 * Structurally typed, so a stored `LoopRecord` and the browser's `LoopView` both go through the
 * same reading.
 */
export function triggerOf(loop: { trigger?: ConsoleLoopTrigger }): ConsoleLoopTrigger {
  return loop.trigger ?? { kind: "schedule" };
}

/**
 * The console's trigger as a stored row spells it: the runtime's three, plus `gate`. Only `schedule` is
 * started, resumed or stepped in this build.
 */
export type ConsoleLoopTrigger = LoopTrigger | { kind: "gate"; pollMs: number };

/** How a trigger reads in a sentence: what the loop page and the wizard's summary say. */
export function triggerLabel(trigger: ConsoleLoopTrigger): string {
  if (trigger.kind === "gate") return "on a gate";
  return trigger.kind === "request" ? "on request" : trigger.kind === "feed" ? "feed" : "on schedule";
}

// ─── What a step is built from ──────────────────────────────────────────────

export class LoopRefused extends Error {}

/**
 * A refusal that comes from the loop's Tempo access key:
 * the key's file is gone (`tempo-key-missing`), Tempo refused a deposit past its limit after one
 * reconcile and one retry (`tempo-key-limit`), it expires before another step could finish
 * (`tempo-key-expired`), or the open under it threw (`tempo-key-refused`). A `LoopRefused`, so a step that meets it stops rather than being tried again
 * next tick, but carrying its own reason: every path that turns a refusal into `stopReason: "error"`
 * reads it through `refusalReason`, so the page names the key rather than a generic error.
 */
export class LoopKeyStopped extends LoopRefused {
  constructor(
    readonly reason: "tempo-key-missing" | "tempo-key-limit" | "tempo-key-expired" | "tempo-key-refused",
    detail: string
  ) {
    super(detail);
  }
}

/** The stop reason a refusal leaves on the row: the key's own, or `error` for every other. */
export function refusalReason(e: unknown): string {
  return e instanceof LoopKeyStopped ? e.reason : "error";
}

/**
 * `sha256(prompt)` in hex — what a step manifest commits to instead of the prompt itself.
 *
 * The runtime's `promptHash` and nothing else: the value is persisted in `loops.json` and
 * committed inside every step manifest's `args_hash`, so a second implementation of it is either
 * an alias or a break in every run already recorded. It keeps this name because the server calls
 * it beside `policyVersionHash` and `promptHash` alone would read as a field.
 */
export const promptHashOf = promptHash;

/**
 * `sha256(goal)` in hex — the tenth key of every step manifest, and
 * what commits the goal without publishing it.
 *
 * The SDK's `goalHash` and nothing else, for the reason `promptHashOf` is the runtime's
 * `promptHash`: the value is persisted in `loops.json` and committed inside every step's
 * `args_hash`, so a second implementation of it is either an alias or a break in every goal loop
 * already recorded.
 */
export const goalHashOf = goalHash;

/**
 * The cap on a goal, the standing instruction's (`checkLoopRequest`) — one field of one signed
 * message, and the goal is the shorter statement of the two by nature.
 */
export const MAX_GOAL = 2000;

/**
 * What a goal-only loop's standing instruction is, applied **here** rather than in the browser.
 *
 * The console offers this text in the form and the server applies it again when a start carries
 * a goal and no prompt, so `promptHash` — which every step's manifest commits to — names the
 * instruction the server actually ran, whatever the browser showed or failed to send.
 */
/**
 * The `LoopStopReason` a step that reached the goal stops the run with — *not a failure: the loop
 * finished*, the way `max-steps` is not one.
 *
 * Declared as a `string` rather than taken from `LoopStopReason`, and it is the one place on the
 * server that spells it: this file compiles against whichever `@lath/runtime` build is on disk,
 * and the reason is the runner's addition, so reading it off the union would tie a console that
 * only *passes the reason through* to the order the two packages were built in.
 */
export const GOAL_REACHED_STOP_REASON: string = "goal-reached";

export const DEFAULT_GOAL_PROMPT =
  "Read what you remember. Do the next item of the plan. End your answer with the plan.";

/**
 * The goal a start or a template asked for, trimmed, or a sentence saying why it is not one.
 *
 * Whitespace is **absent**, not an empty string: a goal is what stops the loop, and a run
 * carrying `goal: ""` would commit a `goalHash` over no goal at all and put a Plan panel on a
 * page with nothing to plan. Absent is also what every run and every template without a goal
 * carries, so the two cases have to be one.
 */
export function checkGoal(v: unknown): { goal?: string } | { error: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "string") return { error: "goal must be text" };
  const goal = v.trim();
  if (!goal) return {};
  if (goal.length > MAX_GOAL) return { error: `the goal is too long (${MAX_GOAL} characters)` };
  return { goal };
}

// ─── The team ───────────────────────────────────────────────────────────────
//
// An orchestrator loop is a loop whose agent ends each step with a list of tasks, and whose runner
// then runs each task on a member agent of the wallet's, in parallel, on the members' own chains,
// before the step closes. Teams are on the roadmap, and this build writes none: it has no member
// checks, copies or runtimes, and no team card on the page. What stays is what a row that carries a
// team still needs — it lists and opens, its page saying in one line that the run used a team
// (`earlierBuildFeatures`), its budget still derives with the team's share (`budgetFromPerStep`), and
// `lath-audit` still checks the members a step committed — and the refusals below.

/**
 * What a start, a deploy carrying a loop, *Run again* and a template write that ask for a team are
 * told: the team's write side is not in this build. Refused, never dropped, for the reason
 * `_lib/roadmap.ts` gives: a start's signature binds its terms, and a loop started without the team
 * it signed for would run something its owner did not ask.
 */
export const TEAM_REFUSAL =
  "teams (multi-agent loops) are on the roadmap and not in this build: leave out workers to run one agent; " +
  "loops that already ran with a team still verify";

/**
 * Why a body or a template config asking for a team is refused, or `undefined` when it asks for
 * none. `workers` absent, `null` or `false` is no team, so a start without one, and every template
 * stored without one, is not refused.
 */
export function checkWorkersRequest(v: unknown): undefined | { error: string } {
  if (v === undefined || v === null || v === false) return undefined;
  return { error: TEAM_REFUSAL };
}

/**
 * Why a row started with a team cannot step, resume or go back on its schedule here, or `null`. The
 * row still renders, its chain still verifies, and stopping it still settles its channel; what it
 * cannot do is take a step, because the fan-out its policy names is not in this build.
 */
export function teamRunRefusal(loop: Pick<LoopRecord, "workers">): string | null {
  return loop.workers
    ? "this loop runs with a team, which is on the roadmap and not in this build; its chain still verifies, " +
        "and stopping it still settles its channel"
    : null;
}

// ─── Protocol-plugin grants ─────────────────────────────────────────────────
//
// Not in this build. `squads.pay` and `sas.attest` — a loop acting on a Solana protocol after each step,
// within grants its owner signed, with a Solana key of its own made and funded at prepare — are on the
// roadmap, and this build has no write side for them (no start key, runner hook, row ledgers or key
// sweep). What it has is the refusal, in every door a grant could come through — a start, a deploy,
// *Run again*, a template write, a resume, a Retry and a step of a row that carries grants — and what
// such a row still needs: it lists and opens, its page saying in one line that the run used grants
// (`earlierBuildFeatures`), its policy still commits the `grants` and `solanaKey` its Genesis did, and
// its hash chain still replays; what its plugin records say is not verified by this build's `lath-audit`.
//
// Refused rather than dropped, because a start's signature binds its grants, so a loop started without
// them would run something other than what its owner signed.

/** What a start, a deploy, *Run again* or a template write carrying `grants` is told. */
const GRANTS_START_REFUSAL =
  "protocol-plugin grants are not in this build: squads.pay and sas.attest are on the roadmap, so a start " +
  "carrying grants is refused rather than run without the grants its signature binds; leave out grants " +
  "(SAS · receipt, the one plugin this build offers, is sent as receipt). Loops that already ran with grants " +
  "still verify";

/**
 * Why a body or a row carrying protocol-plugin grants is refused, in the words of the door it came
 * through, or `null` when it carries none. `start` is every start's (and a template write's); `resume`
 * and `retry` are a paused or stopped row's that carries grants; `step` stops such a row
 * that is still running, before anything is funded.
 */
export function grantsRefusal(
  terms: { grants?: unknown } | null | undefined,
  door: "start" | "resume" | "retry" | "step"
): string | null {
  if (terms?.grants === undefined) return null;
  const not = "protocol-plugin grants, which are not in this build (squads.pay and sas.attest are on the roadmap)";
  switch (door) {
    case "start":
      return GRANTS_START_REFUSAL;
    case "resume":
      return `this loop cannot resume: it runs with ${not}; its chain still verifies, and stopping it still settles its channel`;
    case "retry":
      return `this run's writes are on chain, but it stays stopped: it runs with ${not}; its chain still verifies`;
    case "step":
      return `this loop runs with ${not}, so it stopped before its step, with nothing funded or spent; its chain still verifies`;
  }
}

/**
 * Whether a start may carry the grants it does: never, on this build (above). `null` for a body that
 * carries none — the only start this console takes — and the refusal, before anything is fetched,
 * funded or registered, for one that carries any.
 */
export function checkGrants(body: { grants?: unknown }): Refusal | null {
  const refused = grantsRefusal(body, "start");
  return refused ? { error: refused, status: 400 } : null;
}

/** A refusal with the status the route answers, or `null` when there is nothing to refuse. */
export type Refusal = { error: string; status: number };

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
