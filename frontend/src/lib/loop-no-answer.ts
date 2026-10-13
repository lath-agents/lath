import type { LoopStepSummary, LoopView } from "../types/loop";

/**
 * How the loop page says a step lost to a model that did not answer.
 *
 * A step that lost one model call to the gateway answering nothing is not the work failing, and red
 * _failed_ on it would read as a loop that broke and then worked: the call was retried inside its
 * time, every attempt was paid by Lath and charged to nobody, and the loop goes on at the next step.
 * So it says that, in amber, and a real failure — a refused sandbox, a write that did not land, the
 * budget — keeps its red.
 *
 * The words avoid _provider_, which nothing on screen may say (`sandboxStderr` in the runtime). No
 * imports but the types, so a node test can load it.
 */

/** The badge a step lost to no answer wears in place of _failed_. */
export const NO_ANSWER_BADGE = "no answer";

/** The first half of the line under such a step. */
export const NO_ANSWER_TEXT = "No answer: the model did not reply in time";

/** Whether a step's row is one the model did not answer, as the console recorded it (`cause`). */
export function isNoAnswerStep(h: Pick<LoopStepSummary, "status" | "cause">): boolean {
  return h.status === "failed" && h.cause === "no-answer";
}

/**
 * The line under a step lost to no answer: what happened, and what the loop did next — only what is
 * known: it went on to a later step that is on the page, or it is still running and will. A loop that
 * stopped on that step is not told it continues.
 */
export function noAnswerLine(loop: Pick<LoopView, "status" | "steps" | "history">, step: number): string {
  const later = (loop.history ?? []).some((h) => h.step > step) || loop.steps > step;
  const next = later
    ? `the loop went on to step ${step + 1}`
    : loop.status === "running"
    ? "the loop continues at the next step"
    : "";
  return next ? `${NO_ANSWER_TEXT} · ${next}` : NO_ANSWER_TEXT;
}

/** How many of the run's steps on the page were lost to no answer. */
export function lostSteps(loop: { history?: LoopView["history"] }): number {
  return (loop.history ?? []).filter(isNoAnswerStep).length;
}

/**
 * The sentence a finish note ends with when steps were lost (`" 2 steps lost because the model did
 * not answer."`), with its leading space; empty when none were, so every other note reads as it did.
 */
export function lostStepsSentence(loop: { history?: LoopView["history"] }): string {
  const n = lostSteps(loop);
  if (n === 0) return "";
  return ` ${n} ${n === 1 ? "step" : "steps"} lost because the model did not answer.`;
}
