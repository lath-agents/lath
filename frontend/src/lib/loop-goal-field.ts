/**
 * The loop form's one _Goal_ field: what the loop is for and when it is done, in one text, standing
 * for the two terms a loop carries — the standing instruction (`prompt`) and the goal (`goal`).
 *
 * Form and display only. The start body, the policy and every hash keep their two fields — `prompt`
 * committed as `promptHash`, `goal` as `goalHash` — so `/api/loops`, the runner and every loop already
 * on devnet read them as they are; how the form fills those two fields from one text is this file:
 *
 * - the text is **always** sent as `prompt`: it is what every step is told;
 * - it is **also** sent as `goal` when _Jev checks the goal_ is on — and then `goalCheck: true` — so
 *   the decision model judges each step against exactly the text the agent works from;
 * - with the check off it is sent as `goal` too only when _The agent says when it is done_ is on (no
 *   `goalCheck`): the goal loop that stops on the agent's own `GOAL REACHED`, unchecked;
 * - with both off there is no `goal`, which is the instruction-only loop, byte for byte.
 *
 * So every loop the two fields could start is one the form starts, but one: a goal and an
 * instruction that differ, which is what one field gives up. An API client still sends both, and
 * a carried run that had both opens with them folded into the one text (below).
 *
 * Its own file, importing only a type, for the reason `loop-trigger.ts` is: everything here is pure,
 * and `tests/console-sources.ts` pins it with no browser.
 */
import type { DraftLoop } from "./draft";

/** The text the one field opens with, and whether two carried texts were folded into it. */
export interface GoalField {
  text: string;
  /**
   * A carried run, template or `?from=` prefill had a `prompt` and a `goal` that differ, and both are
   * in `text`, the instruction first: the form says so in one line, because what it shows is what is
   * signed, and dropping either text in silence would start a different loop than it shows.
   */
  folded: boolean;
}

/**
 * What the field opens with, from the terms a run, template, prefill or preset carried: the goal if
 * there is one, else the prompt; both, the prompt then the goal, when both are there and differ.
 *
 * Folded rather than one picked, because each says something the other may not — an older goal loop's
 * prompt is often the server's default plan line, and its goal what done means — and the owner may
 * cut either before signing. Compared trimmed, as both fields are trimmed before they are hashed, so
 * a loop this form started (its goal and prompt one text) reopens as that one text. The folded
 * text may pass `MAX_GOAL_TEXT` (two 2000-character fields); the form then holds Start with the cap's
 * reason, as it does for any text too long, rather than cutting what the owner has not read.
 */
export function goalFieldFrom(initial: Pick<DraftLoop, "prompt" | "goal"> | undefined): GoalField {
  const prompt = initial?.prompt?.trim() ?? "";
  const goal = initial?.goal?.trim() ?? "";
  if (prompt && goal && prompt !== goal) return { text: `${prompt}\n\n${goal}`, folded: true };
  return { text: goal || prompt, folded: false };
}

/**
 * Whether the start goes out as a goal loop: a text, and either switch that sends it as `goal`. What
 * the rest of the form keys on — the trigger picker hidden, the interval's pause, the receipt's rule.
 */
export function sendsGoal(text: string, goalCheck: boolean, selfStop: boolean): boolean {
  return text.trim().length > 0 && (goalCheck || selfStop);
}

/** The start body's three goal-related keys, from the field and its two switches (the mapping above). */
export function loopGoalTerms(
  text: string,
  goalCheck: boolean,
  selfStop: boolean
): { prompt: string; goal?: string; goalCheck?: true } {
  const prompt = text.trim();
  if (!sendsGoal(prompt, goalCheck, selfStop)) return { prompt };
  return goalCheck ? { prompt, goal: prompt, goalCheck: true } : { prompt, goal: prompt };
}

/**
 * The cap the field takes: `checkLoopRequest`'s 2000 on the standing instruction, which `checkGoal`'s
 * `MAX_GOAL` equals, so one figure holds for the text whichever fields it is sent as.
 */
export const MAX_GOAL_TEXT = 2000;
