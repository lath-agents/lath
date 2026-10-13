/**
 * The public view of a loop (`publicLoop`) and of its step rows, and the running loops of an owner
 * (`_lib/loops.ts` re-exports it). Views only: nothing here writes.
 */
import {
  earlierBuildFeatures,
  type LoopMemberView,
  type LoopStepSummary,
  type LoopView,
  type StepGoalCheckView,
  type StepVerifyView,
} from "../../../types/loop";
import { stepStageView } from "./loop-stage";
import { loopChainView } from "./lifecycle";
import { goalHashOf, triggerOf } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { JEV_BUDGET_SPENT, JEV_BUDGET_SPENT_DETAIL, loopBudgetKeys, loopSpentOf } from "./loop-budget";
import { steppingNow } from "./loop-state";
import { readLoops } from "./loop-registry";
import { withoutSandboxTexts } from "./loop-sandbox";

/**
 * What the step's verdict looks like on the row, from what the runner put on the `StepResult`.
 *
 * Typed loosely on the way in on purpose: the runner half of verify lands in its own package, so a
 * step taken by a runtime that does not verify carries nothing here and gets no key — which is what
 * an unverified step should show, rather than a verdict of `undefined`.
 *
 * `scripted` rides on the transport, not on the answer: a scripted session's `decide` returns a
 * fixed accept that cost nothing and decided nothing about anyone's money, and a row that showed it
 * as an ordinary 0.99 would be claiming a judgement nobody made.
 */
export function stepVerifyView(result: unknown, scripted: boolean): StepVerifyView | undefined {
  const v = (result as { verify?: Record<string, unknown> } | null)?.verify;
  if (!v || typeof v !== "object") return undefined;
  // No outcome beside it: an outage commits the memory as an unverified step does, and a row that
  // named one would be reporting a verdict that was never given. A seat not asked because this
  // loop's Jev budget is spent says so beside the outage, in its `capped` field.
  if (typeof v.unavailable === "string") {
    return {
      unavailable: v.unavailable,
      ...(v.unavailable === JEV_BUDGET_SPENT_DETAIL ? { capped: JEV_BUDGET_SPENT } : {}),
    };
  }
  const outcome = v.outcome;
  if (outcome !== "accepted" && outcome !== "retried" && outcome !== "escalated") return undefined;
  return {
    outcome,
    // The model's word only when it is one of the three it was offered: `outcome` above already
    // says what the runner did with it, and anything else it wrote is its own text.
    ...(typeof v.choice === "string" && STEP_VERDICT_WORDS.includes(v.choice) ? { verdict: v.choice } : {}),
    ...(typeof v.confidence === "number" ? { confidence: v.confidence } : {}),
    ...(typeof v.followedPlan === "number" ? { followedPlan: v.followedPlan } : {}),
    ...(typeof v.model === "string" ? { model: v.model } : {}),
    ...(typeof v.costBase === "string" ? { costBase: v.costBase } : {}),
    ...(typeof v.verifyHash === "string" ? { verifyHash: v.verifyHash } : {}),
    ...(scripted ? { scripted: true as const } : {}),
  };
}

/**
 * What Jev said about the goal on the row, from what the runner put on the `StepResult`. Typed
 * loosely on the way in for the reason `stepVerifyView` is.
 *
 * Only the fixed vocabulary reaches the open GET: the two words, a number, the claim and the
 * disagreement flag — never Jev's text. The runner's `reason` travels only as an outage's error,
 * as the verify seat's `unavailable` does; an unrecognised word is no key at all.
 */
export function stepGoalCheckView(result: unknown, scripted: boolean): StepGoalCheckView | undefined {
  const g = (result as { goalCheck?: Record<string, unknown> } | null)?.goalCheck;
  if (!g || typeof g !== "object") return undefined;
  const outcome = g.outcome;
  if (outcome !== "achieved" && outcome !== "continue" && outcome !== "unavailable") return undefined;
  return {
    outcome,
    claimed: g.claimed === true,
    ...(g.choice === "achieved" || g.choice === "continue" ? { choice: g.choice } : {}),
    ...(typeof g.confidence === "number" ? { confidence: g.confidence } : {}),
    ...(typeof g.bar === "number" ? { bar: g.bar } : {}),
    ...(g.disagreement === "overruled" || g.disagreement === "unclaimed" ? { disagreement: g.disagreement } : {}),
    ...(outcome === "unavailable" && typeof g.reason === "string" ? { unavailable: g.reason } : {}),
    // Not asked because this loop's Jev budget is spent — directly, or through the verify seat
    // whose call the check rides, which is then recorded unavailable with the same sentence.
    ...(outcome === "unavailable" && g.reason === JEV_BUDGET_SPENT_DETAIL ? { capped: JEV_BUDGET_SPENT } : {}),
    ...(typeof g.model === "string" ? { model: g.model } : {}),
    ...(typeof g.goalCheckHash === "string" && /^[0-9a-f]{64}$/.test(g.goalCheckHash)
      ? { goalCheckHash: g.goalCheckHash }
      : {}),
    ...(typeof g.costBase === "string" ? { costBase: g.costBase } : {}),
    ...(scripted ? { scripted: true as const } : {}),
  };
}

/**
 * The words a step's judge may answer with (`sdk/src/verify.ts`, the step's `verdict` choice), and
 * the only ones that reach the open GET. Anything else a model wrote is its own text, not a
 * verdict, and a row that echoed it would publish model output on a route with no gate.
 */
const STEP_VERDICT_WORDS = ["accept", "retry", "escalate"];

/**
 * A member verdict's `reason`, when it is one of the fixed sentences a team member's verdict
 * carries on a row (teams are on the roadmap) — `the verifier accepted at confidence 0.93`,
 * `… retried at …`, `… below the 0.5 this loop requires` — and a fixed sentence otherwise.
 *
 * The fallback is the case this exists for: such a row may quote an out-of-vocabulary `choice`
 * verbatim (`the verifier answered "…"`), which would put model-written text on the open GET. The
 * verdict it stands for is unchanged — an unrecognised answer is `accepted`, by the
 * loop's outage rule — only the quotation is dropped.
 */
const MEMBER_REASON =
  /^the verifier (accepted|retried) at confidence -?\d+\.\d{2}(, below the [0-9.e+-]+ this loop requires)?$/;

const MEMBER_REASON_UNRECOGNISED = "the verifier answered neither of its two choices";

function memberReasonOf(reason: unknown): string {
  if (typeof reason !== "string" || !reason) return "";
  return MEMBER_REASON.test(reason) ? reason : MEMBER_REASON_UNRECOGNISED;
}

/**
 * One history row as the open GET serves it, whatever its shape.
 *
 * `loops.json` may keep older rows, and those can carry two things the writers above never put on a
 * row: `synthesis.output`, the plaintext of the step's memory, and a judge's out-of-vocabulary
 * answer quoted verbatim. Stripped here on the way out rather than by rewriting the file, so the
 * projection is the one place that decides what a stranger can read and an old row cannot get past
 * it.
 */
function publicStepRow(row: LoopStepSummary): LoopStepSummary {
  // The sandbox's texts are the ZeroClaw routes' to serve; this open list carries hashes and sizes.
  let out = withoutSandboxTexts(row);
  // A granted step's protocol-plugin rows, which an older row may carry and no screen of this build
  // draws (grants are on the roadmap): kept off the wire rather than sent for nothing.
  if ("plugins" in out) {
    const { plugins: _rows, ...rest } = out as LoopStepSummary & { plugins?: unknown };
    out = rest;
  }
  if (row.synthesis && "output" in row.synthesis) {
    const { output: _plaintext, ...synthesis } = row.synthesis;
    out = { ...out, synthesis };
  }
  if (row.verify?.verdict !== undefined && !STEP_VERDICT_WORDS.includes(row.verify.verdict)) {
    const { verdict: _echoed, ...verify } = row.verify;
    out = { ...out, verify };
  }
  const echoes = (m: LoopMemberView) =>
    !!m.verify && "reason" in m.verify && memberReasonOf(m.verify.reason) !== m.verify.reason;
  if (row.members?.some(echoes)) {
    out = {
      ...out,
      members: row.members.map((m) =>
        m.verify && "reason" in m.verify
          ? { ...m, verify: { ...m.verify, reason: memberReasonOf(m.verify.reason) } }
          : m
      ),
    };
  }
  return out;
}

/** Running loops this wallet already holds. */
export function runningLoopsFor(owner: string): LoopRecord[] {
  return Object.values(readLoops()).filter((l) => l.owner === owner && l.status === "running");
}

/** The shape the browser reads: no secrets, and the numbers as strings. */
/**
 * The loop on the wire. Every reader gets the same answer: the owner's texts — the instruction, the
 * goal, the sandbox's sources — are as public as the traces this console writes in the clear.
 */
export function publicLoop(loop: LoopRecord): LoopView {
  return {
    id: loop.id,
    agentId: loop.agentId,
    agentName: loop.agentName,
    owner: loop.owner,
    ...(loop.plainTraces ? { plainTraces: true as const } : {}),
    prompt: loop.prompt,
    promptHash: loop.promptHash,
    intervalMs: loop.intervalMs,
    maxSteps: loop.maxSteps,
    // The loop's one budget and what the owner has been charged against it, and Lath's Jev share
    // and what it has spent: what the page's spent / remaining bar and its Jev line read.
    ...((): Pick<
      LoopView,
      "budgetMicroUsdc" | "spentMicroUsdc" | "jevBudgetBase" | "jevSpentBase" | "legacyStepBudget"
    > => {
      const { budget, legacy, jevBudget, jevSpent } = loopBudgetKeys(loop);
      return {
        budgetMicroUsdc: budget.toString(),
        spentMicroUsdc: loopSpentOf(loop).toString(),
        jevBudgetBase: jevBudget.toString(),
        jevSpentBase: jevSpent.toString(),
        // Spread only when set, so a new loop's view carries no key it never had.
        ...(legacy ? { legacyStepBudget: true as const } : {}),
      };
    })(),
    // Kept for an older page that still reads it; on a new loop a derived share, not a ceiling.
    budgetMicroUsdcPerStep: loop.budgetMicroUsdcPerStep,
    model: loop.model,
    createdAt: loop.createdAt,
    // Always a trigger, even for an older run that carries none: absent means `schedule`, so the
    // browser never has to decide what `null` meant.
    trigger: triggerOf(loop),
    template: loop.template ?? null,
    archivedAt: loop.archivedAt ?? null,
    // `null`, not absent: on the wire the browser needs *this run asked for no judge* to be a
    // value it can read, while the record itself keeps the key absent so the hash does not move.
    verify: loop.verify ?? null,
    // The features this row was run with that this build does not have — a team, a gate, an oracle
    // trigger, the trace audit, grants — named and nothing more: the page says so in one line rather
    // than draw a card for each. Absent on every row without one, which is every row this build
    // starts.
    ...((): Pick<LoopView, "earlierBuild"> => {
      const earlier = earlierBuildFeatures(loop);
      return earlier.length ? { earlierBuild: earlier } : {};
    })(),
    // Absent, not `null`, on a run with no goal: absence is what the record carries and what an
    // older run carries, and one meaning is easier to render than two.
    ...(loop.goal ? { goal: loop.goal, goalHash: loop.goalHash ?? goalHashOf(loop.goal) } : {}),
    // Jev's goal check, absent when off.
    ...(loop.goalCheck ? { goalCheck: loop.goalCheck } : {}),
    status: loop.status,
    stopReason: loop.stopReason ?? null,
    stopDetail: loop.stopDetail ?? null,
    steps: loop.snapshot.steps,
    lastSeq: loop.snapshot.lastSeq ?? null,
    lastHead: loop.snapshot.lastHead ?? null,
    lastLeaf: loop.snapshot.lastLeaf ?? null,
    // The loop's **last** settlement and what it came to. One per loop in the normal case — the
    // idle rule and a restart can make a run settle more than once, each settlement its own
    // `loop.settlement` record. Null on an unbilled loop and before the first settlement.
    tempo: loop.snapshot.tempo ?? null,
    // Why the last step ran scripted and unbilled although the config asked for `tempo` (the
    // treasury below the channel's deposit, or no treasury at all); absent once a channel opens
    // again.
    tempoNote: loop.tempoNote ?? null,
    // The rail the loop was put on at its first billed step, and the channel every step since has
    // paid through while it is open. Both null on a loop no step of which was ever paid for, and on
    // an older run that predates the rail.
    rail: loop.rail ?? null,
    channel: loop.channel ?? null,
    lastStepAt: loop.snapshot.lastStepAt ?? null,
    lastMemoryHash: loop.snapshot.lastMemoryHash ?? null,
    lastMemoryStep: loop.snapshot.lastMemoryStep ?? null,
    totalCostMicroUsdc: loop.snapshot.totalCostMicroUsdc,
    nextStepAt: loop.status === "running" ? loop.nextStepAt ?? null : null,
    stepping: steppingNow(loop),
    // When the running step began and where it is, from this process's memory; absent at rest.
    ...stepStageView(loop.id),
    billing: loop.billing ?? null,
    inference: loop.inference ?? null,
    // Absent unless set, so the answer for every run that never diverged is unchanged.
    ...(loop.anchorDiverged ? { anchorDiverged: true } : {}),
    ...(loop.discarded ? { discarded: loop.discarded } : {}),
    // The sandbox the run was started with, so _Run again_ and a template can carry it: the config
    // (switches, cap, the sources as typed) and the manifest's hash, which the ZeroClaw tab shows
    // anyway. Absent on a run started without one, whose answer is therefore unchanged.
    ...(loop.sandbox ? { sandbox: loop.sandbox } : {}),
    // Projected, not passed through: older rows may still carry a synthesis's plaintext and a
    // judge's quoted answer, and this GET is open (`publicStepRow`).
    history: loop.history.map(publicStepRow),
    // An Improve's arm, on an older row (Improve is on the roadmap), so its page offers no
    // _Run again_ of the trial's terms. Absent on every other run. The source's `improve`
    // state such a row may carry is not passed: no screen of this build reads it.
    ...(loop.trial ? { trial: loop.trial } : {}),
    // The loop's lifecycle records on its agent's chain: refs, the tool ids still owed, the last
    // write's error, and whether the row was rebuilt. Never an owed document — those carry the
    // owner's signature and prompt. Absent on an older row, as the type says.
    ...(loop.lifecycle ? { chain: loopChainView(loop.lifecycle) } : {}),
  };
}
