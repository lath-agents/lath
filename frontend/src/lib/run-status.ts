import { agoLabel } from "@/lib/tiles";
import { LOOP_STOP_REASON_TEXT, type LoopView } from "@/types/loop";

/**
 * One sentence on where a loop run stands, for the places that name an agent by its run: the Yours
 * list's agent row and the agent page's _Loops_ row, in place of the grant's _spent x of y USDC_. The badge
 * beside it keeps the one-word status; this says how far the run got and when.
 */
export function runStatusLine(
  loop: Pick<LoopView, "status" | "stepping" | "steps" | "maxSteps" | "stopReason" | "lastStepAt" | "createdAt">,
  now: number
): string {
  const of = `${loop.steps} of ${loop.maxSteps} ${loop.maxSteps === 1 ? "step" : "steps"}`;
  // `steps` counts the steps that closed, so the one in flight is the next (as `LoopSpine` numbers it).
  if (loop.stepping) return `Running step ${Math.min(loop.steps + 1, loop.maxSteps)} of ${loop.maxSteps} now`;
  if (loop.status === "running") return `Loop running, ${of} done, waiting for the next`;
  if (loop.status === "paused") return `Loop paused by its owner after ${of}`;
  const ago = agoLabel(loop.lastStepAt ?? loop.createdAt, now);
  switch (loop.stopReason) {
    case "goal-reached":
      return `Last run reached its goal in ${loop.steps} ${loop.steps === 1 ? "step" : "steps"} · ${ago}`;
    case "max-steps":
      return `Last run took all ${loop.maxSteps} of its steps · ${ago}`;
    case "budget":
      return `Last run stopped when its budget was spent, after ${of} · ${ago}`;
    case "anchor-failed":
      return `Last run's step ran but its records did not land; Retry it from the run · ${ago}`;
    case "stopped":
      return `Last run stopped by its owner after ${of} · ${ago}`;
    case null:
      return `Last run stopped after ${of} · ${ago}`;
    default:
      return `Last run stopped: ${LOOP_STOP_REASON_TEXT[loop.stopReason] ?? loop.stopReason} · ${ago}`;
  }
}
