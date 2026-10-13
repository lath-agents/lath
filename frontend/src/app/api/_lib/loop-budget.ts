/**
 * The loop's one budget and Lath's Jev share of it, as arithmetic over a row (`_lib/loops.ts`
 * re-exports it): what is spent, what is left, what a step may be admitted against, and the keys an
 * older row with only a per-step budget is completed with when it is read. What a step's spend
 * writes back to the row is `loop-meter.ts`.
 */
import { GATE_ASK_BASE } from "@lath/sdk";
import { MAX_STEPS as MAX_SESSION_STEPS, admitSpend } from "./runner";
import { JEV_BUDGET_PERCENT } from "./loop-terms";
import type { LoopRecord } from "./loop-record";

/**
 * An older row has a per-step budget and no whole one. Completed here, on the read, in the shape of
 * `withSandboxKey`, so nothing past it knows the older shape:
 *
 * - `budgetMicroUsdc` is `stepCeiling × maxSteps` — the step budget, doubled on a synthesizing
 *   team, plus one task's budget per member — which is exactly what the row's per-step ceiling and
 *   step count already bounded it to, and `legacyStepBudget` marks it so its steps keep committing
 *   the per-step `maxCost` they started with;
 * - a row carrying only the whole budget gets the derived per-step figure back;
 * - `jevBudgetBase` at the rate set now (it is frozen from here on), and `jevSpentBase` from zero —
 *   such a row's earlier asks were counted against hourly ceilings, not in money.
 *
 * The next write of the row stores the completed keys. The row is not hashed, so nothing moves.
 */
export function withBudgetKeys(rec: LoopRecord): LoopRecord {
  const r = rec as Partial<LoopRecord> & LoopRecord;
  // Floored: `isLoopRecord` checks only that `maxSteps` is a number, and a hand-edited `2.5` would
  // otherwise reach `BigInt(2.5)` below and throw — which `readLoops` confines to this row, but a
  // row that reads is better than one dropped.
  const maxSteps = Math.max(1, Math.floor(r.maxSteps));
  let out: LoopRecord = r;
  if (typeof r.budgetMicroUsdc !== "string" || !/^\d+$/.test(r.budgetMicroUsdc)) {
    const perStep = /^\d+$/.test(r.budgetMicroUsdcPerStep ?? "") ? r.budgetMicroUsdcPerStep : "0";
    // `budgetFromPerStep` rather than `stepCeiling`, the same arithmetic without its `BigInt` of a
    // team's per-task figure, so a row hand-edited to a malformed team still reads.
    const team = r.workers ? { ...r.workers, agentIds: r.workers.agentIds ?? [] } : undefined;
    const derived = budgetFromPerStep(BigInt(perStep), maxSteps, team);
    out = { ...out, budgetMicroUsdc: derived.toString(), legacyStepBudget: true };
  }
  if (typeof out.budgetMicroUsdcPerStep !== "string") {
    out = { ...out, budgetMicroUsdcPerStep: (BigInt(out.budgetMicroUsdc!) / BigInt(maxSteps)).toString() };
  }
  if (typeof out.jevBudgetBase !== "string" || !/^\d+$/.test(out.jevBudgetBase)) {
    out = { ...out, jevBudgetBase: jevBudgetOf(BigInt(out.budgetMicroUsdc!)).toString() };
  }
  if (typeof out.jevSpentBase !== "string" || !/^\d+$/.test(out.jevSpentBase)) out = { ...out, jevSpentBase: "0" };
  return out;
}

// ─── The loop's budget ──────────────────────────────────────────────────────
//
// One overall budget per loop: no per-step ceiling, and Lath's Jev spend capped at a share of it by
// actual voucher cost. Everything here is a pure function of the record, so the admission, the
// channel's size and the page read one arithmetic.

/**
 * Lath's Jev budget for a loop budget, base units: `floor(budget × percent / 100)`. Computed in
 * hundredths of a percent so a fractional `LATH_JEV_BUDGET_PERCENT` is still exact integer math.
 */
export function jevBudgetOf(budget: bigint, percent: number = JEV_BUDGET_PERCENT): bigint {
  const hundredths = BigInt(Math.round(Math.min(100, Math.max(0, percent)) * 100));
  return (budget * hundredths) / 10_000n;
}

export const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

/**
 * What the owner has been charged across the loop, micro-USDC: the runner's `spentMicroUsdc`, which
 * counts sessions A and B and every member. An older snapshot has none, and reads as
 * `totalCostMicroUsdc` — the runner's own reading of one (`LoopRunner`'s resume).
 */
export function loopSpentOf(loop: Pick<LoopRecord, "snapshot">): bigint {
  const spent = (loop.snapshot as { spentMicroUsdc?: unknown }).spentMicroUsdc;
  if (digits(spent)) return BigInt(spent);
  return digits(loop.snapshot.totalCostMicroUsdc) ? BigInt(loop.snapshot.totalCostMicroUsdc) : 0n;
}

/** The keys of a loop record its budget is read from; every one but `maxSteps` may be absent on an old row. */
export type LoopBudgetFields = Pick<
  LoopRecord,
  | "maxSteps"
  | "budgetMicroUsdcPerStep"
  | "workers"
  | "budgetMicroUsdc"
  | "legacyStepBudget"
  | "jevBudgetBase"
  | "jevSpentBase"
>;

/**
 * A loop's budget, as numbers: the whole budget, whether its steps still commit a per-step
 * `maxCost` (`legacyStepBudget`), and Lath's Jev budget and spend. Read through `withBudgetKeys`,
 * so a record that never went through `readLoops` — a fixture, a record built in memory from an
 * old row — is completed exactly as a read would complete it, and no reader decides it alone.
 */
export function loopBudgetKeys(loop: LoopBudgetFields): {
  budget: bigint;
  legacy: boolean;
  jevBudget: bigint;
  jevSpent: bigint;
} {
  const full = withBudgetKeys(loop as LoopRecord);
  return {
    budget: BigInt(full.budgetMicroUsdc!),
    legacy: full.legacyStepBudget === true,
    jevBudget: BigInt(full.jevBudgetBase!),
    jevSpent: BigInt(full.jevSpentBase!),
  };
}

/**
 * The most one step of a loop started with a per-step budget (`legacyStepBudget`) may charge the
 * owner: `stepCeiling`'s arithmetic over one step, through `budgetFromPerStep` so a malformed team
 * figure reads as no share rather than throwing. Its sessions commit the per-step `maxCost`, so no
 * step of such a loop can draw more than this, whatever is left of its derived budget.
 */
export function legacyStepCap(loop: Pick<LoopRecord, "budgetMicroUsdcPerStep" | "workers">): bigint {
  const perStep = /^\d+$/.test(loop.budgetMicroUsdcPerStep ?? "") ? BigInt(loop.budgetMicroUsdcPerStep) : 0n;
  return budgetFromPerStep(perStep, 1, loop.workers);
}

/**
 * What is left of the loop's budget, micro-USDC, floored at zero.
 *
 * On a loop started with a per-step budget (`legacyStepBudget`) it is what its per-step ceiling
 * still allows over the steps it has left, not the derived budget minus the spend: such a loop's
 * persisted totals may carry gate-ask and Jev-decision debits that the derived budget never
 * counted, so that subtraction would stop it `budget` before `maxSteps` although no step ever
 * crossed its `maxCost`. Its per-step `maxCost` and `maxSteps` bound it, as the row's comment
 * promises, and this is never zero while it has a step left to take.
 */
export function loopRemainingOf(loop: LoopBudgetFields & Pick<LoopRecord, "snapshot">): bigint {
  const { budget, legacy } = loopBudgetKeys(loop);
  if (legacy) return legacyStepCap(loop) * BigInt(Math.max(1, loop.maxSteps - loop.snapshot.steps));
  const left = budget - loopSpentOf(loop);
  return left > 0n ? left : 0n;
}

/**
 * Whether the loop's budget is spent: no step can be admitted, and the loop stops `budget`. Never
 * true of a loop started with a per-step budget (see `loopRemainingOf`): a step that crosses its
 * per-step `maxCost` is what stops that one `budget`, through the runner.
 */
export function loopBudgetSpent(loop: LoopBudgetFields & Pick<LoopRecord, "snapshot">): boolean {
  return loopRemainingOf(loop) === 0n;
}

/** What is left of Lath's Jev budget for this loop, base units, floored at zero. */
export function jevRemainingOf(loop: LoopBudgetFields): bigint {
  const { jevBudget, jevSpent } = loopBudgetKeys(loop);
  const left = jevBudget - jevSpent;
  return left > 0n ? left : 0n;
}

/**
 * What the next Jev call is assumed to cost before it is made: one gate ask's price. A decision
 * is priced by the voucher it signs, which is known only once it is answered, so the check is
 * whether one more such call still fits — and the call that crosses the line is paid, the way a
 * step's last call is.
 */
export const JEV_CALL_ESTIMATE_BASE = BigInt(GATE_ASK_BASE);

/** Whether Lath's Jev budget for this loop can still pay one more call. */
export function jevBudgetAdmits(loop: LoopBudgetFields): boolean {
  const { jevBudget, jevSpent } = loopBudgetKeys(loop);
  return jevSpent + JEV_CALL_ESTIMATE_BASE <= jevBudget;
}

/**
 * The first words of every sentence that says Jev was not asked because this loop's Jev budget is
 * spent — the gate strip's `capped`, and a verify or goal check's `capped` beside its outage. The
 * page matches on it for the badge _gate: scripted (Jev budget)_.
 */
export const JEV_BUDGET_SPENT = "Jev budget spent";

/**
 * The outage a decision is recorded with when the loop's decision budget is spent: the error the
 * step's decider throws in place of the call. A verify decision and a goal check (and the roadmap's
 * trace audit) record it through their outage rule and the loop goes on; the trace audit's confirm
 * records it as unavailable and its veto stands, which is why the sentence says what was not asked
 * and not what happens next.
 *
 * The budget is named `jevBudgetBase` and the prefix reads `Jev budget spent`, because both are
 * stored on rows and matched by the page; it is Lath's **decision spend**, every Jev call together.
 */
export const JEV_BUDGET_SPENT_DETAIL = `${JEV_BUDGET_SPENT}: Lath's decision spend for this loop is used up, so the decision was not asked`;

/**
 * The first words of the error a step's Jev call is refused with when the loop's record cannot be
 * read, so its Jev budget cannot be checked. Recorded through the seat's outage rule like a spent
 * budget: the memory commits, and the loop goes on without Jev.
 */
export const JEV_BUDGET_UNREADABLE = "Jev budget unreadable";

/**
 * What the next step is expected to cost the owner, micro-USDC:
 * `min(remaining, max(average owner cost of the last three steps, remaining ÷ steps left))`.
 * There is no per-step price to admit against, so admission uses what steps have actually cost,
 * and never less than an even share of what is left — a loop whose first steps were cheap must
 * still be able to pay for one that is not.
 */
export function stepEstimate(loop: LoopBudgetFields & Pick<LoopRecord, "snapshot" | "history">): bigint {
  const remaining = loopRemainingOf(loop);
  const stepsLeft = BigInt(Math.max(1, loop.maxSteps - loop.snapshot.steps));
  const recent = loop.history.slice(-3).map((h) => {
    const own = digits(h.costMicroUsdc) ? BigInt(h.costMicroUsdc) : 0n;
    const members = digits(h.memberCostMicroUsdc) ? BigInt(h.memberCostMicroUsdc) : 0n;
    return own + members;
  });
  const average = recent.length ? recent.reduce((a, b) => a + b, 0n) / BigInt(recent.length) : 0n;
  const share = remaining / stepsLeft;
  let expected = average > share ? average : share;
  // A loop started with a per-step budget commits a per-step `maxCost`, so none of its steps can
  // cost more than `stepCeiling`: the unspent budget of its cheap steps is not something one step
  // can draw, and an estimate above that ceiling would refuse steps the loop was always able to
  // take.
  if (loopBudgetKeys(loop).legacy) {
    const ceiling = legacyStepCap(loop);
    if (ceiling < expected) expected = ceiling;
  }
  return expected < remaining ? expected : remaining;
}

/**
 * What a step of `loop` is admitted against: `estimate`, and on a loop started with a per-step
 * budget also `legacyStepCap`, which makes `admitStepSpend` apply the predicate that loop was
 * started under rather than the estimate. See `admitStepSpend` for why.
 */
export function stepAdmission(loop: LoopBudgetFields & Pick<LoopRecord, "snapshot" | "history">): {
  estimate: bigint;
  legacyStepCap?: bigint;
} {
  const estimate = stepEstimate(loop);
  return loopBudgetKeys(loop).legacy ? { estimate, legacyStepCap: legacyStepCap(loop) } : { estimate };
}

/**
 * Whether the owner's allowance covers the next step: `admitLoopSpend` over the estimate on a loop
 * with one budget, and on a loop started with a per-step budget (`legacyStepCap` given) the
 * predicate it was started under, `admitSpend` over its step ceiling spread across
 * `MAX_SESSION_STEPS` records. The estimate for such a row is its whole step ceiling, six times
 * that predicate's floor, so applying it would flip a billed older loop to unbilled scripted steps
 * at a headroom that always admitted it.
 */
export function admitStepSpend(p: {
  grant: Parameters<typeof admitSpend>[0]["grant"];
  spendable: bigint;
  estimate: bigint;
  legacyStepCap?: bigint;
  now?: number;
}): ReturnType<typeof admitSpend> {
  if (p.legacyStepCap !== undefined) {
    return admitSpend({
      grant: p.grant,
      spendable: p.spendable,
      cap: p.legacyStepCap,
      maxSteps: MAX_SESSION_STEPS,
      now: p.now,
    });
  }
  return admitLoopSpend(p);
}

/**
 * Whether the owner's allowance covers a step expected to cost `estimate`: headroom and spendable
 * both at least the estimate. `admitSpend` with one step, so the refusal names which of the two is
 * short in the sentence every other admission uses.
 */
export function admitLoopSpend(p: {
  grant: Parameters<typeof admitSpend>[0]["grant"];
  spendable: bigint;
  estimate: bigint;
  now?: number;
}): ReturnType<typeof admitSpend> {
  return admitSpend({ grant: p.grant, spendable: p.spendable, cap: p.estimate, maxSteps: 1, now: p.now });
}

/**
 * What of this loop's remaining budget the owner's money actually backs, micro-USDC: the least of
 * what is left of the declared budget, the allowance's headroom and the escrow's spendable. `0n`
 * with no grant, or an expired one.
 *
 * The declared budget is a number the owner types; nothing about it is funded. A step is admitted
 * when the allowance covers *one step's* estimate (`admitStepSpend`), which on a new loop is about
 * `budget ÷ maxSteps` — so, sized from the declared budget alone, a loop with a budget near the
 * treasury's whole balance and one step's estimate in escrow would open a channel that could draw
 * the treasury down, with every other session and loop then running scripted, and a Jev budget of
 * 15% of money nobody had put up. What Lath can be owed back is what this function returns, and it
 * is what the Lath-paid side of a loop — its channel, its Jev spend — is sized from.
 *
 * `snapshot` may be absent on a record built in memory from the budget keys alone (a fixture): such
 * a record has spent nothing, and what is left of it is its whole budget.
 */
export function loopFundedHeadroom(p: {
  loop: LoopBudgetFields & { snapshot?: LoopRecord["snapshot"] };
  grant: Parameters<typeof admitSpend>[0]["grant"];
  spendable: bigint;
  now?: number;
}): bigint {
  if (!p.grant || Number(p.grant.expiresAt) * 1000 <= (p.now ?? Date.now())) return 0n;
  let funded = p.loop.snapshot
    ? loopRemainingOf(p.loop as LoopBudgetFields & Pick<LoopRecord, "snapshot">)
    : loopBudgetKeys(p.loop).budget;
  const headroom = p.grant.cap - p.grant.spent - (p.grant.reserved ?? 0n);
  if (headroom < funded) funded = headroom;
  if (p.spendable < funded) funded = p.spendable;
  return funded > 0n ? funded : 0n;
}

/**
 * The part of Lath's Jev budget the owner's money backs, base units: the loop's own frozen Jev rate
 * (`jevBudgetBase ÷ budget`) over what the owner has been charged plus what is funded now
 * (`loopFundedHeadroom`), and never more than `jevBudgetBase` itself.
 *
 * The binding rules stand: Jev is Lath's to pay and never charged to the owner, and Lath's Jev
 * spend is at most its share of the budget by voucher cost — this only refuses to spend that share
 * on a part of the budget nobody funded. An owner who funds the whole budget gets the whole share;
 * one who funds it as the loop goes gets it as they go, because the share is read again at every
 * admission and every channel open, never frozen from the funds at start.
 */
export function jevFundedBudget(
  loop: LoopBudgetFields & { snapshot?: LoopRecord["snapshot"] },
  funded: bigint
): bigint {
  const { budget, jevBudget } = loopBudgetKeys(loop);
  if (budget <= 0n) return 0n;
  const spent = loop.snapshot ? loopSpentOf(loop as Pick<LoopRecord, "snapshot">) : 0n;
  const backed = spent + (funded > 0n ? funded : 0n);
  const share = (jevBudget * (backed < budget ? backed : budget)) / budget;
  return share < jevBudget ? share : jevBudget;
}

/** What is left of `jevFundedBudget` after what Lath has already spent on Jev, floored at zero. */
export function jevFundedRemaining(
  loop: LoopBudgetFields & { snapshot?: LoopRecord["snapshot"] },
  funded: bigint
): bigint {
  const left = jevFundedBudget(loop, funded) - loopBudgetKeys(loop).jevSpent;
  return left > 0n ? left : 0n;
}

/**
 * Why a chain's journaled charges cannot be drained through the backend this caller is about to
 * bind, or `null` when they can — the step's and the settlement's half of the guard
 * `retryLoopAnchor` carries inline, and the loop's counterpart of `drainAdmission`.
 *
 * `AgentRuntime.start` retries and drains whatever the chain's journal still owes before it writes
 * anything, and a settlement drains it before its record. When the owner's allowance no longer
 * admits a step, the chain is bound to `NoopBilling`, and a `charge` entry an earlier billed step
 * left behind would settle through it as `verified` with no USDC moved — after the operator had
 * already paid the model calls over Tempo. The queue refuses that itself (`ChargeUnpaid`); this
 * says so before a step is funded, bound or opened, in words the row can carry.
 */
export function loopDrainRefusal(
  owed: { payers: string[]; microUsdc: bigint },
  admitted: ReturnType<typeof admitSpend> | null
): string | null {
  if (owed.payers.length === 0) return null;
  if (admitted && !("refuse" in admitted)) return null;
  // No admission at all is a console with no treasury: nothing here can charge anyone.
  const why = admitted && "refuse" in admitted ? `: ${admitted.refuse}` : ": this console has no billing treasury";
  return (
    `this loop's chain owes ${(Number(owed.microUsdc) / 1e6).toFixed(6)} USDC of journaled charges and the ` +
    `owner's allowance can no longer pay them${why}. The records stay ` +
    "journaled; top the allowance up and Retry"
  );
}

/** How many members a team names or asks for, however its roster is written. */
function teamSizeOf(workers: unknown): number {
  if (!workers || typeof workers !== "object") return 0;
  const w = workers as Record<string, any>;
  if (Array.isArray(w.agentIds)) return w.agentIds.length;
  const count = Number(w.blueprint?.count ?? w.scratch?.count);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

/**
 * The whole budget a per-step body, template or row implies: `stepCeiling × maxSteps`, with the
 * team's share when it has one — each member's per-task budget, and the step budget twice on a
 * synthesizing team. What an older start, template version or row is read as, so each keeps the
 * spend bound it was written with.
 */
export function budgetFromPerStep(perStep: bigint, maxSteps: number, workers?: unknown): bigint {
  let step = perStep;
  const w = workers as { budgetMicroUsdcPerTask?: unknown; synthesize?: unknown } | undefined;
  if (w && typeof w === "object") {
    const raw = String(w.budgetMicroUsdcPerTask ?? "").trim();
    const perTask = /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    step = (w.synthesize === true ? 2n : 1n) * perStep + BigInt(teamSizeOf(workers)) * perTask;
  }
  return step * BigInt(Math.max(1, Math.floor(maxSteps)));
}

/** `snapshot` with its `spentMicroUsdc` never below what the registry already holds (`persistOwnerSpend`). */
export function withSpentAtLeast<T extends LoopRecord["snapshot"]>(snapshot: T, stored: LoopRecord): T {
  const kept = loopSpentOf(stored);
  return loopSpentOf({ snapshot }) >= kept ? snapshot : { ...snapshot, spentMicroUsdc: kept.toString() };
}

/**
 * The voucher delta a decision paid, base units, from its answer or from the error it failed
 * with: a `PaidCallFailed` carries the payment of a call the channel paid for and that never
 * answered, which is Lath's money as much as an answered one. `0n` when nothing was paid.
 */
export function decisionCostBase(outcome: unknown): bigint {
  const payment = (outcome as { payment?: { cumulativeBefore?: unknown; cumulativeAfter?: unknown } } | null)?.payment;
  if (!payment || !digits(String(payment.cumulativeAfter)) || !digits(String(payment.cumulativeBefore))) return 0n;
  const delta = BigInt(String(payment.cumulativeAfter)) - BigInt(String(payment.cumulativeBefore));
  return delta > 0n ? delta : 0n;
}
