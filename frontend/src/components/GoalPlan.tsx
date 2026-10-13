"use client";

import { parseGoalPlan } from "@lath/sdk/browser";
import { Badge } from "@/components/ui";
import { LoopView, useLoopSteps, useVerifiedSteps } from "@/lib/loops";

/**
 * The plan a goal loop carries from step to step.
 *
 * Nothing new is committed for it: the plan *is* the memory, so this panel renders the bytes the
 * steps table's memory cell already shows truncated — the newest one whose verdict is `ok`, which
 * means a step's verified manifest commits to that hash and the bytes served under it re-hash to
 * it. An unverified memory is deliberately not shown: a panel that read a plan out of bytes no
 * step committed to would be putting words on screen the chain does not stand behind.
 *
 * The reads are `useLoopSteps` and `useVerifiedSteps` under the keys `LoopSteps` uses, so on the
 * loop's own page — where both render — this costs one cache hit and no second fetch.
 */
export function GoalPlan({ loop, testId = "loop-goal-plan" }: { loop: LoopView; testId?: string }) {
  const steps = useLoopSteps(loop.agentId);
  const verified = useVerifiedSteps(loop, steps.data);

  // A loop with no goal has no plan to show, and old runs have no `goalHash` at all. The hooks
  // above run regardless — a conditional return before them would change the hook order between
  // a goal loop and a plain one rendered by the same component tree.
  if (!loop.goalHash) return null;

  const rows = verified.data ?? [];
  // The newest plan the run has committed, read from the last row backwards.
  //
  // Each row carries two memories, and `left` is the newer of the pair: the bytes this step wrote,
  // checked against the `memoryHash` its own verified manifest commits, while `memory` is the
  // older one it resumed from. Taking `left` first is what makes a *terminal* step's plan
  // reachable — the step that says GOAL REACHED has no successor to resume from it, so reading only
  // the newest `ok` row of `memory` would make the one plan worth reading the one plan that could
  // never be shown. `memory` stays as the fallback, so a step whose own manifest did
  // not verify still shows the plan the link before it stands behind rather than nothing at all.
  const shown = (m?: { verdict: string }) => !!m && (m.verdict === "ok" || m.verdict === "encrypted");
  const latest = [...rows].reverse().flatMap((r) => {
    if (shown(r.left)) return [{ verdict: r.left!.verdict, text: r.left!.text, step: r.index }];
    if (shown(r.memory)) return [{ verdict: r.memory!.verdict, text: r.memory!.text, step: r.memory!.fromStep }];
    return [];
  })[0];

  // A plan written encrypted: no block, rather than a _Plan_ with nothing to show.
  if (latest?.verdict === "encrypted") return null;

  return (
    <div className="well px-3 py-2.5" data-testid={testId}>
      <div className="eyebrow">Plan</div>
      {!latest ? (
        <p className="mt-1 text-2xs text-ink-3">
          No step has left a verified plan yet. It appears here once a step&apos;s manifest commits a memory hash and
          the bytes the store serves under it re-hash to exactly that.
        </p>
      ) : (
        <PlanBody text={latest.text ?? ""} step={latest.step} />
      )}
    </div>
  );
}

/**
 * The three lists, or the memory as it is.
 *
 * `parseGoalPlan` returns `null` for text with no `DONE:`/`NEXT:`/`OPEN:` block, which is what a
 * model that ignored the shape leaves behind. That is not an error — the loop keeps running on it —
 * so the panel shows the text as it is.
 */
function PlanBody({ text, step }: { text: string; step: number }) {
  const plan = parseGoalPlan(text);
  if (!plan) {
    return (
      <>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{text}</p>
        <div className="mt-1.5 text-2xs text-ink-3">
          the memory step #{step} left, which does not carry a DONE / NEXT / OPEN block
        </div>
      </>
    );
  }
  return (
    <>
      <div className="mt-2 space-y-2.5">
        <PlanList label="Done" lines={plan.done} tone="text-ink-2" testId="goal-plan-done" />
        <PlanList label="Next" lines={plan.next} tone="text-ink-1" testId="goal-plan-next" />
        <PlanList label="Open" lines={plan.open} tone="text-ink-2" testId="goal-plan-open" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
        {plan.reached ? (
          <span data-testid="goal-plan-reached">
            <Badge tone="good">goal reached</Badge>
          </span>
        ) : (
          <Badge tone="neutral">still working</Badge>
        )}
        <span>from the memory step #{step} left</span>
      </div>
    </>
  );
}

function PlanList({ label, lines, tone, testId }: { label: string; lines: string[]; tone: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="eyebrow">{label}</div>
      {lines.length === 0 ? (
        <p className="mt-0.5 text-2xs text-ink-3">—</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {lines.map((line, i) => (
            <li key={i} className={`text-xs leading-relaxed ${tone}`}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
