"use client";

import Link from "next/link";
import { Badge } from "@/components/ui";
import { NodeState, Spine, SpineItem } from "@/components/Spine";
import { formatUsdc, truncate } from "@/lib/format";
import { LoopStepSummary, LoopView, untilStep } from "@/lib/loops";
import { stepStageText } from "@/types/loop";
import { NO_ANSWER_BADGE, NO_ANSWER_TEXT, isNoAnswerStep } from "@/lib/loop-no-answer";

/**
 * A loop's steps on the spine, and the node states its runs and steps wear. The workspace's run
 * panel and the loop's own page draw `LoopStepSpine`, and the workspace's rows take `loopNode`.
 *
 * The spine draws `loop.history`, which is the console's cache of each step and not the chain.
 * That is why the short form ends in a link to the loop's own page rather than in a verified mark:
 * there the browser rebuilds each checkpoint leaf from the chain, and here nothing is claimed
 * that was not read from the registry.
 */

/** How many steps the panel draws; the rest are one link away, on the page that verifies them. */
const SHOWN = 8;

function usdc(micro: string | undefined): string {
  try {
    return formatUsdc(BigInt(micro || "0"));
  } catch {
    return "—";
  }
}

/**
 * Stops that end a run without anything going wrong, drawn grey: it took every step it was given,
 * its owner stopped it, or it drew its one budget down to nothing (`budget`, "not a failure either"
 * in `LOOP_STOP_REASON_TEXT`). A run its owner stopped does not wear the rose ring of a failure. The
 * status badge and the tiles read the same set (`LoopStatusBadge`, `statusOf`).
 *
 * The four stops a loop's Tempo access key causes are here too: Tempo refusing a deposit past the
 * key's limit is the cap the owner set doing its job, and an expired, missing or refused key stops
 * the run at a step boundary rather than pay without the key the loop committed to. Nothing is owed
 * and nothing broke, which is what the loop page's amber note says too. `tests/loop-status-neutral.ts` holds
 * this set to every `tempo-key-*` code `LOOP_STOP_REASON_TEXT` words.
 */
export const NEUTRAL_STOPS: ReadonlySet<string> = new Set([
  "max-steps",
  "stopped",
  "budget",
  "tempo-key-limit",
  "tempo-key-expired",
  "tempo-key-missing",
  "tempo-key-refused",
]);

/** A run's one node in the list: what it is doing, not how its last step went. */
export function loopNode(loop: LoopView): NodeState {
  if (loop.stepping) return "now";
  if (loop.status === "running") return "live";
  if (loop.status === "paused") return "quiet";
  if (loop.stopReason === "goal-reached") return "achieved";
  // An archived run is put away by its owner; grey, whatever stopped it.
  if (!loop.stopReason || NEUTRAL_STOPS.has(loop.stopReason) || loop.archivedAt) return "idle";
  return "failed";
}

export function stepNode(h: LoopStepSummary): NodeState {
  // A step the model did not answer is amber, not the rose of a fault: the loop went on.
  if (isNoAnswerStep(h)) return "flagged";
  if (h.status !== "success") return "failed";
  if (h.goalCheck?.outcome === "achieved") return "achieved";
  return "ran";
}

/** The small line under a step: what Jev said, and where it checkpointed. */
function stepDetail(h: LoopStepSummary): string {
  const parts: string[] = [];
  // The cause in words for a step the model did not answer; the runner's sentence is on its row.
  if (isNoAnswerStep(h)) parts.push(NO_ANSWER_TEXT);
  else if (h.status !== "success" && h.reason) parts.push(h.reason);
  const g = h.goalCheck;
  // Jev's word and what the runner did differ when an `achieved` fell under the bar: the step
  // reads as the continue it was, with the word Jev gave beside it.
  if (g)
    parts.push(
      g.outcome === "unavailable"
        ? "the decision model did not answer"
        : g.choice === "achieved" && g.outcome === "continue"
        ? "decision: goal met, under the bar, so it continued"
        : // The model's answer in its own word; _completed_ is the loop's state, not an answer.
          `decision: ${g.outcome === "achieved" ? "achieved" : "continue"}`
    );
  if (h.seq) parts.push(`seq ${h.seq}`);
  if (h.leaf) parts.push(`leaf ${truncate(h.leaf, 4, 4)}`);
  return parts.join(" · ");
}

/**
 * A loop's steps on the spine, ending in the decision model's latest answer on the goal: the
 * workspace run panel's Proof, and the top of the loop's own page too, so the page a judge opens
 * shows the run on the spine rather than only as the proof table.
 *
 * `all` draws every step the console holds (the loop page, which verifies each one in the table
 * below it); without it, the last `SHOWN` and a link to the page for the rest. Either way it draws
 * `loop.history`, the console's cache, and says nothing it did not read from the registry.
 */
export function LoopStepSpine({
  loop,
  all = false,
  verdict = true,
  steps = true,
}: {
  loop: LoopView;
  all?: boolean;
  /** Draw the decision model's latest answer under the spine; off where the page already says it. */
  verdict?: boolean;
  /**
   * Draw the step rows. Off on the loop page once a run has stopped: every step is then a row of the
   * Steps table below, verified, and the spine would say each one twice.
   */
  steps?: boolean;
}) {
  const history = loop.history ?? [];
  const shown = all ? history : history.slice(-SHOWN);
  const earlier = history.length - shown.length;
  const checked = [...history].reverse().find((h) => h.goalCheck);
  const next = loop.steps + 1;

  return (
    <>
      {history.length === 0 && !loop.stepping && loop.status === "stopped" ? (
        <p className="text-sm text-ink-3">This run stopped before its first step.</p>
      ) : !steps ? null : (
        <Spine label={`Steps of ${loop.agentName}`}>
          {earlier > 0 && (
            <SpineItem state="quiet">
              <Link href={`/loop/${loop.id}`} className="text-xs text-ink-3 transition-colors hover:text-ink-1">
                {earlier} earlier {earlier === 1 ? "step" : "steps"} on the loop&apos;s page
              </Link>
            </SpineItem>
          )}
          {shown.map((h) => (
            <SpineItem key={h.step} state={stepNode(h)}>
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                {all ? (
                  // On the loop's own page each step is a link to its row in the Steps table, where the
                  // browser rebuilds its checkpoint leaf from the chain.
                  <a
                    href={`#step-${h.step}`}
                    className="text-sm text-ink-1 transition-colors hover:text-accent-strong"
                    title="Verify this step against the chain, in the Steps table below"
                  >
                    Step {h.step}
                  </a>
                ) : (
                  <span className="text-sm text-ink-1">Step {h.step}</span>
                )}
                {isNoAnswerStep(h) ? (
                  <Badge tone="warn">{NO_ANSWER_BADGE}</Badge>
                ) : (
                  h.status !== "success" && <Badge tone="bad">{h.status}</Badge>
                )}
                {h.goalCheck?.outcome === "achieved" && <Badge tone="volt">completed</Badge>}
                <span className="num ml-auto text-xs text-ink-2">{usdc(h.costMicroUsdc)} USDC</span>
              </div>
              <div className="num mt-0.5 break-all text-2xs text-ink-3">{stepDetail(h)}</div>
            </SpineItem>
          ))}
          {loop.stepping ? (
            <SpineItem state="now">
              <div className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="text-sm text-ink-1">Step {next}</span>
                <span className="num ml-auto text-xs text-accent">{stepStageText(loop.stepStage) ?? "running"}</span>
              </div>
            </SpineItem>
          ) : loop.status === "running" ? (
            <SpineItem state="next">
              <div className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="text-sm text-ink-2">Step {next}</span>
                <span suppressHydrationWarning className="num ml-auto text-xs text-ink-3">
                  {untilStep(loop.nextStepAt)}
                </span>
              </div>
            </SpineItem>
          ) : null}
        </Spine>
      )}

      {verdict && checked?.goalCheck && (
        // Flush with what is above it when the spine draws no rows: its margin parted it from the spine.
        <JevAnswer step={checked.step} check={checked.goalCheck} flush={!steps} />
      )}
    </>
  );
}

/** Jev's latest answer on the goal, as the box the spine ends on. */
function JevAnswer({
  step,
  check,
  flush = false,
}: {
  step: number;
  check: NonNullable<LoopStepSummary["goalCheck"]>;
  flush?: boolean;
}) {
  const gap = flush ? "" : "mt-5 ";
  if (check.outcome === "unavailable") {
    return (
      <p className={`${gap}rounded-lg border border-line/[0.08] bg-line/[0.03] px-3 py-2.5 text-sm text-ink-2`}>
        The decision model did not answer after step {step}
        {check.unavailable ? ` (${check.unavailable})` : ""}, so the agent&apos;s own <code>GOAL REACHED</code> decides.
      </p>
    );
  }
  const achieved = check.outcome === "achieved";
  const confidence = check.confidence !== undefined ? ` · ${Math.round(check.confidence * 100)}% sure` : "";
  return (
    <p
      className={`${gap}rounded-lg border px-3 py-2.5 text-sm text-ink-2 ${
        achieved
          ? // Electric green, without a halo.
            "border-spine-volt/40 bg-spine-volt/[0.08]"
          : // Blue, the spine's waiting: _continue_ is the run going on to a next step, not a step that ran,
            // and on a run that has since finished it is the last answer, not a success.
            "border-spine-blue/30 bg-spine-blue/[0.08]"
      }`}
      data-testid="loop-spine-jev"
    >
      <b className={`font-semibold ${achieved ? "text-spine-volt" : "text-spine-sky"}`}>
        Decision: {achieved ? "achieved" : "continue"}.
      </b>{" "}
      After step {step}
      {confidence}
      {check.disagreement === "overruled" && " · the agent claimed GOAL REACHED and the decision model overruled it"}
      {check.disagreement === "unclaimed" && " · the decision model called it without the agent claiming it"}
      {achieved ? ". The goal is met and the loop is complete." : "."}
    </p>
  );
}
