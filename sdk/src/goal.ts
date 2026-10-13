/**
 * Goal loops, read side: what a loop is *for*, and how a reader tells whether it got there.
 *
 * A loop is a cron with memory — one session per step, the step's answer becomes the next step's
 * memory. A **goal loop** adds a text goal the chain commits to as `sha256(goal)` (the manifest's
 * tenth key, `loops.ts`), and a plan the model is told to keep *as* that memory: three labelled
 * sections, and one terminal line when the goal is reached.
 *
 * Nothing new is committed for the plan. It **is** the memory, so `memoryHash` already commits
 * to it and `verifyStep`'s memory verdict is already its verification. What lives here is only
 * the two pure functions that turn that text into an answer: the hash the manifest carries, and
 * the parse the console and the runtime both read the plan through — one implementation, so a
 * loop stops on exactly the line an auditor later looks for.
 *
 * String work only: no Anchor, no Node built-in, nothing that reaches a network. That is what
 * lets `browser.ts` re-export it (`loops.ts` cannot ship in a page — it imports `LathClient`),
 * so the console's Plan panel and the runtime's terminal check run the same code.
 */
import { hex, sha256, utf8 } from "./hash";

/**
 * The line a step writes when the goal is reached, exactly. Matched case-sensitively and with
 * nothing else on the line, because this line stops a loop: everything after it is a step that
 * would have been paid for, and a loop that halted on a sentence merely *containing* the words
 * would be stoppable by any model that mentioned them.
 */
export const GOAL_REACHED_LINE = "GOAL REACHED";

/** The plan a step ended with, as the three sections the model was told to keep. */
export interface GoalPlan {
  /** Everything finished so far, cumulative — one entry per line the step listed. */
  done: string[];
  /** What is still to do, in the order the step put it. */
  next: string[];
  /** Questions the step could not settle itself. Empty when it wrote `none`. */
  open: string[];
  /** Whether the **last non-empty line** of the text is `GOAL REACHED`, exactly. */
  reached: boolean;
}

/**
 * `sha256(goal)` in hex — the value `LoopStepManifest.goalHash` carries.
 *
 * Trimmed first, unlike `promptHash`: a goal is typed into a textarea and a trailing newline the
 * browser added is not a different goal, but it would be a different hash, and the hash is what
 * a reader rebuilds the manifest from. The prompt has no such normalisation because it is sent
 * to the model verbatim, where whitespace is content.
 */
export function goalHash(goal: string): string {
  return hex(sha256(utf8(goal.trim())));
}

/**
 * Whether this text declares the goal reached: its last non-empty line is `GOAL REACHED` and
 * nothing else.
 *
 * The one place the terminal rule lives, so the runtime (which stops a loop on it), the console
 * (which labels the step) and `lath-audit` (which checks the committed memory bytes under
 * `--require-preimages`) cannot drift apart. Lower-cased is not reached, and the line appearing
 * mid-text is not reached: the model was told to make it the *last* line, and a plan that
 * quotes the instruction back is not a plan that finished.
 */
export function goalReachedIn(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return line === GOAL_REACHED_LINE;
  }
  return false;
}

/** `DONE:` / `NEXT:` / `OPEN:`, however a model actually spelled the label. */
type Label = "done" | "next" | "open";

/**
 * One label line. Forgiving on purpose: the label is an instruction to a model, not a wire
 * format, and every variant here was worth reading rather than discarding — a leading bullet, a
 * markdown bold, a stray period, a lower-cased word. Strict about the colon, because that is
 * what separates a label from a sentence starting with the word "Next".
 */
const LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?\s*(done|next|open)\s*\.?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/i;

/**
 * Where the plan stops. A team loop's answer carries a `TASKS:` block after the plan, and the
 * next step's memory carries `RESULTS:` after that. A loop with grants (on the roadmap) may end
 * its answer in a `PROPOSE:` block. None of the three is a plan section, so a label of another
 * block ends the plan rather than pouring its lines into whichever of DONE/NEXT/OPEN came last — a
 * payment line remembered as a NEXT item would be proposed again by the step that reads it. Same
 * leniency as `LABEL` on the spelling.
 */
const FOREIGN_LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?\s*(tasks|results)\s*\.?\s*:/i;

/**
 * The `PROPOSE:` block's header, held tighter than `TASKS:`/`RESULTS:` because "propose" is an
 * ordinary word in a plan: `- Propose: a fix to the parser` is a NEXT item on any goal loop. Only
 * a bare label (nothing after the colon but emphasis) or a label followed by a `<plugin>.<action>`
 * line ends the plan, so a loop without grants keeps such a line as the NEXT item it is.
 */
const PROPOSE_HEADER =
  /^\s*(?:[-*•]\s*)?(?:\*\*|__)?\s*propose\s*\.?\s*:\s*(?:\*\*|__)?\s*(?:$|(?:[-*•]\s*)?`?[a-z0-9_]+\.[a-z0-9_]+\b)/i;

/** A list marker a model put in front of an item. Stripped; the item is the text after it. */
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;

/** Trailing markdown emphasis left over when the label line was bold: `**DONE:** a thing**`. */
const TRAILING_EMPHASIS = /(?:\*\*|__)\s*$/;

function itemOf(line: string): string | null {
  const text = line.trim().replace(BULLET, "").replace(TRAILING_EMPHASIS, "").trim();
  if (!text || text === GOAL_REACHED_LINE) return null;
  return text;
}

/**
 * The plan in a step's answer, or `null` when it does not carry one.
 *
 * Takes the **last** `DONE:`/`NEXT:`/`OPEN:` block in the text: a model that thinks out loud
 * often restates the previous plan before writing the new one, and the new one is the memory the
 * next step stands on. The block begins at the last `DONE:` label — or, in text with no `DONE:`
 * at all, the last `NEXT:` — and each label runs to the next label or to the end.
 *
 * `null` rather than an empty plan when there is no block: the loop keeps running on a step that
 * answered in prose, and the console shows the memory as the plain text it is, which is not the
 * same thing as a plan with nothing in it.
 */
export function parseGoalPlan(text: string): GoalPlan | null {
  const lines = text.split(/\r?\n/);
  const labels = lines.map((line) => LABEL.exec(line));

  let start = -1;
  for (let i = lines.length - 1; i >= 0 && start < 0; i--) {
    if (labels[i]?.[1].toLowerCase() === "done") start = i;
  }
  if (start < 0) {
    for (let i = lines.length - 1; i >= 0 && start < 0; i--) {
      if (labels[i]?.[1].toLowerCase() === "next") start = i;
    }
  }
  if (start < 0) return null;

  const sections: Record<Label, string[]> = { done: [], next: [], open: [] };
  let current: Label | null = null;
  for (let i = start; i < lines.length; i++) {
    const match = labels[i];
    if (!match && (FOREIGN_LABEL.test(lines[i]) || PROPOSE_HEADER.test(lines[i]))) break;
    if (match) {
      current = match[1].toLowerCase() as Label;
      // A repeated label inside one block appends rather than replaces: a model that wrote
      // `DONE:` twice listed more things done, it did not retract the first list.
      const inline = itemOf(match[2]);
      if (inline) sections[current].push(inline);
      continue;
    }
    if (!current) continue;
    const item = itemOf(lines[i]);
    if (item) sections[current].push(item);
  }

  // `OPEN: none` is the instruction's own word for "nothing open", so it is an empty list and
  // not a question reading "none". Kept to the whole section: a `none` beside real questions is
  // a question the model wrote, and stays.
  if (sections.open.length === 1 && /^none\.?$/i.test(sections.open[0])) sections.open = [];

  return { done: sections.done, next: sections.next, open: sections.open, reached: goalReachedIn(text) };
}
