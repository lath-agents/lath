/**
 * What a running loop's spend writes back to its row (`_lib/loops.ts` re-exports it): the owner's
 * spend after a step, and Lath's Jev spend, metered per decision call. The arithmetic it is checked
 * against is `loop-budget.ts`.
 */
import type { NoAnswerOptions, ChatTransport } from "@lath/runtime";
import type { LoopRecord } from "./loop-record";
import {
  decisionCostBase,
  JEV_BUDGET_SPENT,
  JEV_BUDGET_SPENT_DETAIL,
  JEV_BUDGET_UNREADABLE,
  jevBudgetAdmits,
  loopSpentOf,
} from "./loop-budget";
import { readLoop, updateLoop } from "./loop-registry";

/**
 * Adds one Jev call's actual voucher delta to what Lath has spent on this loop, and persists
 * it at once: the call is paid when its voucher is signed, whatever becomes of its answer, so the
 * count is written then rather than with a step that may never be recorded. Never throws — a
 * registry write that fails loses one call's count, which a stuck spend meter must not turn into a
 * failed ask or a failed step.
 */
export function addJevSpent(id: string, deltaBase: bigint): void {
  if (deltaBase <= 0n) return;
  try {
    updateLoop(id, (l) => ({ ...l, jevSpentBase: (BigInt(l.jevSpentBase ?? "0") + deltaBase).toString() }));
  } catch (e) {
    console.warn(`[loops] ${id}: a Jev call's ${deltaBase} base units were not counted: ${(e as any)?.message ?? e}`);
  }
}

/**
 * Persists the owner's running total as it accrues: `snapshot.spentMicroUsdc` becomes the
 * larger of what is stored and `spent`, so the write is idempotent and never lowers the figure.
 * The runner reports its total — in-flight members included — through `onSpend` each time it
 * rises, and a step that throws reports it once more from its snapshot, so neither a restart
 * mid-step nor a thrown step forgets what the owner was already charged: the next step resumes
 * from this snapshot and holds its remainder to it. Never throws, for `addJevSpent`'s reason.
 */
export function persistOwnerSpend(id: string, spent: bigint): void {
  if (spent <= 0n) return;
  try {
    const current = readLoop(id);
    if (!current || loopSpentOf(current) >= spent) return;
    updateLoop(id, (l) =>
      loopSpentOf(l) >= spent ? l : { ...l, snapshot: { ...l.snapshot, spentMicroUsdc: spent.toString() } }
    );
  } catch (e) {
    console.warn(`[loops] ${id}: the owner's spend of ${spent} µUSDC was not persisted: ${(e as any)?.message ?? e}`);
  }
}

/**
 * A step's paid transport with its Jev calls metered against the loop's Jev budget. `decide` is
 * every Jev call a step makes — the verify seat and the goal check, and the roadmap's team
 * verdicts, routing choices and trace audit, which ask Jev over the same `decide` on the same
 * channel; each is Lath's to pay, and together they are Lath's decision spend. Before one, the
 * budget is read off the record: spent, and the call is not made; the error thrown in its place is
 * what the runner records through the seat's outage path, so the memory commits and the loop goes
 * on. After one, its voucher delta is added to `jevSpentBase` whether it answered or not. `chat`,
 * the owner's model calls, is untouched.
 */
export function jevMeteredTransport(id: string, inner: ChatTransport): ChatTransport {
  // A plain object over bound methods, as `stagedTransport` builds one, and never a prototype
  // copy: the transports keep state on `this` (the channel, the queue), and a copy would split it.
  const metered: ChatTransport = { chat: inner.chat.bind(inner) };
  if (typeof inner.decide !== "function") return metered;
  const decide = inner.decide.bind(inner) as (...a: unknown[]) => Promise<unknown>;
  metered.decide = (async (...args: unknown[]) => {
    // An unreadable registry refuses the call rather than admitting it: with no row there is no
    // budget to check, and the call would also go uncounted — `addJevSpent` could not write it.
    const current = loopForBudget(id);
    if (!current) throw new Error(`${JEV_BUDGET_UNREADABLE}: loop ${id} could not be read from the registry`);
    if (!jevBudgetAdmits(current)) throw new Error(JEV_BUDGET_SPENT_DETAIL);
    return meterJevCall(id, () => decide(...args));
  }) as ChatTransport["decide"];
  return metered;
}

/**
 * The row a Jev budget check reads, or `null` when there is none or the registry cannot be read
 * (`readLoops` throws on anything but a missing file). Both are the same answer to a budget check —
 * `JEV_BUDGET_UNREADABLE`, recorded through the seat's outage rule — rather than a throw out of
 * `admitRetry` or the trace confirm, whose callers expect a refusal and not an exception.
 */
function loopForBudget(id: string): LoopRecord | null {
  try {
    return readLoop(id);
  } catch (e) {
    console.warn(`[loops] ${id}: the registry could not be read for a budget check: ${(e as any)?.message ?? e}`);
    return null;
  }
}

/**
 * How a paid step's chat calls are retried when the model got no answer, with Lath as the payer of
 * every attempt that got none. The owner is debited nothing for such an attempt (the runtime
 * records it `paidBy: "lath"`), so its voucher is Lath's spend for this loop and is added to
 * `jevSpentBase` — the decision share, 15 % of the owner's budget by default — and a retry is
 * admitted only while that share can still pay one more call. Two things follow: Lath's spend on a
 * loop, decisions and lost calls together, stays within its share plus the one call that crosses
 * it, as a Jev call's does; and the loop key's limit, the owner's budget plus that share, still
 * covers everything the loop's channels can be asked to pay.
 */
export function loopNoAnswer(id: string): NoAnswerOptions {
  return {
    admitRetry: () => {
      // An unreadable registry refuses, as `jevMeteredTransport` does: the spend could not be
      // counted either, and a retry Lath cannot account for is one it should not buy.
      const current = loopForBudget(id);
      if (!current) return `${JEV_BUDGET_UNREADABLE}: loop ${id} could not be read from the registry`;
      return jevBudgetAdmits(current)
        ? true
        : `${JEV_BUDGET_SPENT}: Lath's decision spend for this loop is used up, so the call was not tried again`;
    },
    onAbsorbed: (costBase) => addJevSpent(id, costBase),
  };
}

/**
 * Runs one paid Jev call and adds its voucher delta to the loop's `jevSpentBase`, from the answer or
 * from the `PaidCallFailed` it failed with, before handing either back unchanged. The one place a
 * step's decisions (`jevMeteredTransport`) are counted, so no two paths that ask Jev can count
 * differently.
 */
export async function meterJevCall<T>(id: string, call: () => Promise<T>): Promise<T> {
  let answer: T;
  try {
    answer = await call();
  } catch (e) {
    addJevSpent(id, decisionCostBase(e));
    throw e;
  }
  addJevSpent(id, decisionCostBase(answer));
  return answer;
}
