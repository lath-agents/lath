/**
 * The verify step: what a second model is asked about a loop step, what it answers, what the
 * runner does with the answer, and the bytes the chain commits to.
 *
 * A loop that asks for it has every step's output judged by TypeSafe's Jev — a typed decision
 * model, not a chat model — over the Decisions API on the same Tempo MPP channel the loop
 * already holds. The questions are fixed here rather than composed per loop so the runtime and
 * an auditor hash the same bytes: `VERIFY_QUESTIONS` *is* the `questions` field of the request,
 * and `verifyState` *is* the `state` field.
 *
 * Teams are the same three pieces again, one layer down: a member's questions, its two-word
 * enforcer and the routing blob. Teams are on the roadmap, and this build neither writes nor audits
 * a team step.
 *
 * Nothing here is a proof. Jev is probabilistic: it **proposes** a verdict with a confidence and
 * `applyVerdict` — code, no model in it — **enforces** a threshold on it: the model proposes, code
 * enforces.
 *
 * Pure: `sha256`/`utf8` and nothing else, no Anchor and no Node built-in, because `browser.ts`
 * re-exports this file and CI fails the browser bundle on either.
 */
import { hex, sha256, utf8 } from "./hash";
import { goalReachedIn } from "./goal";
import type { TempoPaymentRecord } from "./audit/core";

/**
 * One typed question as the Decisions API takes it, and as a blob commits to it.
 *
 * Written out here because the questions are the bytes: the runtime sends them, the blob hashes
 * them, and an auditor holds them to the frozen sets below. `criteria` keys are the answer's
 * options for a `choice` and `true`/`false` for a `noul`, which is why they are a plain map
 * rather than a union — the shape is the same and only the keys differ.
 */
export interface DecideQuestion {
  type: string;
  instructions: string;
  criteria: Record<string, string>;
}

/** The `questions` field of a decision request, keyed by the answer it asks for. */
export type DecideQuestions = Record<string, DecideQuestion>;

/** The three answer shapes the Decisions API returns, one per question type. */
export interface VerifyAnswer {
  /** A `noul` question's probability that the statement holds. */
  noul?: number;
  /** A `choice` question's chosen option. */
  choice?: string;
  /** A `score` question's position on its legend. Advisory: nothing in this cut reads it. */
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** Every answer the model returned, keyed by question. `verdict` is the one the runner obeys. */
export interface VerifyAnswers {
  verdict: VerifyAnswer;
  followed_plan?: VerifyAnswer;
  [question: string]: VerifyAnswer | undefined;
}

/**
 * The two questions, fixed. Frozen because their JSON is the bytes the
 * runtime sends and the bytes the blob commits to: a caller that mutated one would move the
 * commitment for every loop at once, and an auditor re-reading a step would find the request it
 * holds no longer describes the step it is checking. A third question, a per-loop question and a
 * `score` are roadmap.
 *
 * `followed_plan` is asked against the previous memory on purpose — a step that continues work
 * already done is following the prompt even though it does not restate it.
 */
export const VERIFY_QUESTIONS = deepFreeze({
  followed_plan: {
    type: "noul",
    instructions: "Did the step output carry out what the prompt asked, given the previous memory?",
    criteria: {
      true: "the step output does what the prompt asked of it",
      false: "the step output leaves what the prompt asked undone, or does something else",
    },
  },
  verdict: {
    type: "choice",
    instructions: "What should the loop do with this step output?",
    criteria: {
      accept: "keep it as memory",
      retry: "incomplete or off-prompt, do not remember it",
      escalate: "outside the prompt's bounds or unsafe, stop the loop",
    },
  },
});

/**
 * `Object.freeze` all the way down, so no caller can reach past the top level and edit a criterion.
 * Exported so any other frozen question set can be frozen the same way.
 */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") for (const child of Object.values(v)) deepFreeze(child);
  return Object.freeze(v);
}

/**
 * The `state` the model judges: the standing prompt, the goal when the loop has one, the memory
 * the step resumed from, and the text the step ended with, in that order under fixed labels.
 *
 * Labelled and ordered rather than free text because the state is hashed into the blob: two runs
 * that saw the same strings must produce the same bytes, whoever assembled them. A step
 * with no memory to resume from says `none` rather than dropping the section — an absent label
 * and an empty memory would otherwise hash alike.
 *
 * `GOAL:` is the one section that *is* dropped when there is nothing to put in it. The two facts
 * are not alike: a loop with a goal asks to be judged against what done looks like as well as
 * against the standing instruction, and a loop without one has no such thing — a `GOAL: none`
 * line would ask the model to weigh an absence. Dropping it also keeps a goal-less loop's state
 * bytes to the three other sections, so an older blob, written for a loop with no goal, still
 * re-hashes to the `verifyHash` its step committed.
 */
export function verifyState(
  prompt: string,
  previousMemory: string | undefined,
  stepOutput: string,
  goal?: string
): string {
  const sections = [`PROMPT: ${prompt}`];
  // Trimmed-empty counts as no goal, the same normalisation `goalHash` hashes under, so a blank
  // textarea cannot move a loop's state bytes.
  if (goal !== undefined && goal.trim().length > 0) sections.push(`GOAL: ${goal}`);
  sections.push(`PREVIOUS MEMORY: ${previousMemory ?? "none"}`, `STEP OUTPUT: ${stepOutput}`);
  return sections.join("\n\n");
}

/**
 * What the trace store holds for one verified step, and what `verifyHash` in the step's manifest
 * is the `sha256` of: the request as sent, the answers as returned, the voucher that paid for it,
 * and the dated build the gateway resolved the pinned model to.
 *
 * `payment` is absent on a scripted (unbilled) session, which is the only case that spends
 * nothing.
 */
export interface DecisionBlob {
  request: {
    model: string;
    state: string;
    /**
     * The frozen set the request was built from — `VERIFY_QUESTIONS` for a step's verdict, and, on an
     * older blob from a team step, a member's or a routing request's. Typed as
     * the general shape rather than one of them so the three kinds of blob share a decoder; which
     * set a blob *ought* to carry is checked where the blob is read, against the thing it claims
     * to be a decision about.
     */
    questions: DecideQuestions;
    /**
     * The bar the runner held the verdict to, so a reader can re-run `applyVerdict` and check
     * the memory against the *outcome* rather than the model's word: an `accept` under the bar is
     * rightly not remembered. Absent on older blobs; those audit by the word.
     */
    minConfidence?: number;
    /**
     * The bar a gate decision was held to, in bps. A blob
     * carries one bar or the other, never both: `minConfidence` is a verdict's, `barBps` a gate's.
     */
    barBps?: number;
  };
  answers: VerifyAnswers;
  payment?: TempoPaymentRecord;
  /** The build the gateway answered with — `typesafe/jev-1.13-20260917`, not the pinned alias. */
  model: string;
  /** OpenRouter's generation id. */
  id: string;
  usage?: Record<string, unknown>;
}

/**
 * Keys sorted at every depth and `undefined` dropped, so the blob's bytes depend on its values
 * and not on the order whoever built it happened to assign them. The wire body is not this — the
 * request goes out in the API's own order — but the *commitment* has to be reproducible by a
 * reader who only has the values back.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonical(child);
    }
    return out;
  }
  return value;
}

/**
 * Whether two `questions` fields are the same set, compared the way the blob's own bytes are
 * canonicalised: keys sorted at every depth, so two spellings of the same questions compare
 * equal and two different sets do not.
 */
export function sameQuestions(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The blob's canonical bytes. A goal-check blob hashes through the same function and under the same
 * rule: it is the same record of a paid decision, and only the answers it carries differ. So do
 * older routing and trace-audit blobs, which this build does not decode.
 */
export function decisionBlobBytes(blob: DecisionBlob | GoalCheckBlob): Uint8Array {
  return utf8(JSON.stringify(canonical(blob)));
}

/** `sha256(decisionBlobBytes(blob))`, hex — the value a `verifyHash` or a `goalCheckHash` carries. */
export function decisionBlobHash(blob: DecisionBlob | GoalCheckBlob): string {
  return hex(sha256(decisionBlobBytes(blob)));
}

/**
 * The inverse, for bytes fetched from a trace store. `null` for anything that is not a decision
 * blob — including one with no `answers.verdict`, because the verdict is the whole reason the
 * blob is committed and a blob without one cannot be checked against what the step did.
 */
export function decodeDecisionBlob(bytes: Uint8Array): DecisionBlob | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
    if (!parsed || typeof parsed !== "object") return null;
    const { request, answers, model, id } = parsed;
    if (typeof model !== "string" || typeof id !== "string") return null;
    if (!request || typeof request !== "object" || typeof request.state !== "string") return null;
    if (!answers || typeof answers !== "object") return null;
    // One bar, never both, and a gate's bar is an integer in bps. A gate blob answers `action`
    // rather than `verdict`, so it still decodes to null below (this build has no gate decoder).
    if (request.barBps !== undefined) {
      if (!Number.isInteger(request.barBps) || request.barBps < 0 || request.barBps > 10_000) return null;
      if (request.minConfidence !== undefined) return null;
    }
    const verdict = answers.verdict;
    if (!verdict || typeof verdict !== "object" || typeof verdict.choice !== "string") return null;
    return parsed as DecisionBlob;
  } catch {
    return null;
  }
}

/** What the runner does with the step: three outcomes, and nothing else. */
export type VerifyOutcome = "accepted" | "retried" | "escalated";

export interface VerifyDecision {
  outcome: VerifyOutcome;
  /** One sentence, shown on the step row and written into the step summary. */
  reason: string;
}

/**
 * The enforcer half: a `choice` and a confidence in, one of three outcomes out, no model and no
 * I/O. `accepted` commits the memory, `retried` carries the previous memory forward and lets the
 * loop continue, `escalated` stops the loop.
 *
 * Exactly at `minConfidence` is accepted — the threshold is a floor a loop's owner set, and a
 * bar that rejected the number it names would be a different bar than the one on screen. A
 * `choice` the model returned outside the three is treated as `retry`, the outcome that loses
 * nothing: the step is not remembered, the loop keeps going, and the row says the choice was
 * unrecognised rather than pretending it was an escalation.
 */
export function applyVerdict(answers: VerifyAnswers, minConfidence: number): VerifyDecision {
  const choice = answers.verdict?.choice;
  const confidence = typeof answers.verdict?.confidence === "number" ? answers.verdict.confidence : 0;
  const at = `${confidence.toFixed(2)}`;
  if (choice === "escalate") {
    return { outcome: "escalated", reason: `the verifier escalated at confidence ${at}` };
  }
  if (choice === "accept") {
    return confidence >= minConfidence
      ? { outcome: "accepted", reason: `the verifier accepted at confidence ${at}` }
      : {
          outcome: "retried",
          reason: `the verifier accepted at confidence ${at}, below the ${minConfidence} this loop requires`,
        };
  }
  if (choice === "retry") {
    return { outcome: "retried", reason: `the verifier asked for a retry at confidence ${at}` };
  }
  return {
    outcome: "retried",
    reason: `the verifier answered "${choice ?? "nothing"}", which is not one of its three choices`,
  };
}

// ---------------------------------------------------------------------------------------------
// The goal check: Jev says whether a goal loop is done.

/**
 * The key the goal answer rides under, in a request's `questions` and in the answers that come
 * back. One key for both shapes of request below, so a reader asks one place whichever blob it holds.
 */
export const GOAL_ANSWER = "goal";

/**
 * The goal question, frozen for the reason `VERIFY_QUESTIONS` is: it *is* the bytes the request
 * carries and the blob commits to. A `choice` of two words and not a `noul`: the runner obeys a
 * word, the same way it obeys the verdict, and a probability would need a second threshold nobody
 * set. The state it is asked of is `verifyState`'s, whose `GOAL:` section is always present on a
 * goal loop, so the question names that section rather than restating the goal.
 */
export const GOAL_CHECK_QUESTION: Readonly<DecideQuestion> = deepFreeze({
  type: "choice",
  instructions: "Judged from the step output, has the loop reached its GOAL?",
  criteria: {
    continue: "not yet: the step output does not show the goal met, so the loop takes another step",
    achieved: "yes: the step output shows the goal met, so the loop can stop",
  },
});

/**
 * The request a goal loop with no verify seat sends after each step: the goal question alone.
 * Committed under the manifest's fourteenth key, `goalCheckHash`, because such a step has no
 * decision blob of its own to ride in.
 */
export const GOAL_CHECK_QUESTIONS: Readonly<Record<typeof GOAL_ANSWER, DecideQuestion>> = deepFreeze({
  [GOAL_ANSWER]: GOAL_CHECK_QUESTION,
});

/**
 * The request a goal loop *with* the verify seat sends: the verify seat's two questions and the
 * goal's, in one paid call and one blob under the ninth key. A set of its own rather than an
 * edit to `VERIFY_QUESTIONS`, which stays byte-for-byte what every verified step on devnet was
 * asked — the goal check is additive, and a blob carrying the two-question set still audits.
 */
export const VERIFY_GOAL_QUESTIONS: Readonly<Record<"followed_plan" | "verdict" | typeof GOAL_ANSWER, DecideQuestion>> =
  deepFreeze({ ...VERIFY_QUESTIONS, [GOAL_ANSWER]: GOAL_CHECK_QUESTION });

/** The bar a goal answer is held to on a loop with no verify seat, committed in the policy. */
export const DEFAULT_GOAL_CHECK_CONFIDENCE = 0.5;

/** What the runner did with the goal answer: stopped, went on, or left it to the agent's claim. */
export type GoalCheckOutcome = "achieved" | "continue" | "unavailable";

export interface GoalCheckDecision {
  outcome: GoalCheckOutcome;
  /** Whether this step ends the loop, before the verdict's gate (`remembered`) is applied. */
  reached: boolean;
  /** Whether the step's own text ended with `GOAL REACHED` — the agent's claim. */
  claimed: boolean;
  /** Jev's word, when it was one of the two it was offered. */
  choice?: "achieved" | "continue";
  confidence?: number;
  /**
   * Set when Jev and the claim part ways: `overruled` the agent claimed the goal and Jev did not
   * agree at the bar, `unclaimed` Jev judged it achieved and the agent made no claim. Absent when
   * they agree, and on an unavailable check, where the claim decided alone.
   */
  disagreement?: "overruled" | "unclaimed";
  /** One sentence, from a fixed vocabulary: it reaches the open GET, which never quotes a model. */
  reason: string;
}

/**
 * The enforcer half of the goal check: Jev's word and confidence and the agent's claim in, whether
 * the loop stops out. No model and no I/O, so the runner and `lath-audit` reach the same answer
 * from the same blob.
 *
 * `achieved` at or above the bar stops the loop, claim or no claim; `continue`, and `achieved`
 * under the bar, do not, whatever the agent claimed — with the check on, the claim is a claim.
 * Anything else — no goal answer, or a word outside the two — is `unavailable`, and the claim
 * decides as it does with the check off: a check that did not work must leave the loop where
 * check-off would have left it (the verify seat's outage rule).
 *
 * Exactly at the bar is achieved, for the reason `applyVerdict` gives: the bar is a floor.
 */
export function applyGoalCheck(
  answers: Record<string, VerifyAnswer | undefined> | undefined,
  bar: number,
  claimed: boolean
): GoalCheckDecision {
  const answer = answers?.[GOAL_ANSWER];
  const choice = answer?.choice;
  if (choice !== "achieved" && choice !== "continue") {
    return {
      outcome: "unavailable",
      reached: claimed,
      claimed,
      reason:
        choice === undefined
          ? "Jev gave no goal answer, so the agent's own claim decided"
          : "Jev answered neither achieved nor continue, so the agent's own claim decided",
    };
  }
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
  const at = confidence.toFixed(2);
  if (choice === "achieved" && confidence >= bar) {
    return {
      outcome: "achieved",
      reached: true,
      claimed,
      choice,
      confidence,
      ...(claimed ? {} : { disagreement: "unclaimed" as const }),
      reason: claimed
        ? `Jev judged the goal achieved at confidence ${at}`
        : `Jev judged the goal achieved at confidence ${at}, though the step did not claim it`,
    };
  }
  return {
    outcome: "continue",
    reached: false,
    claimed,
    choice,
    confidence,
    ...(claimed ? { disagreement: "overruled" as const } : {}),
    reason:
      choice === "achieved"
        ? `Jev judged the goal achieved at confidence ${at}, below the ${bar} this loop requires`
        : claimed
        ? `the step claimed the goal reached and Jev answered continue at confidence ${at}`
        : `Jev answered continue at confidence ${at}`,
  };
}

/**
 * A blob that carries a goal answer: the goal-only request's, which has no `verdict` and so is
 * not a `DecisionBlob`, or a combined one, which is. Its own type so that a reader that wants a
 * verdict cannot be handed a goal-only blob and find it missing late.
 */
export interface GoalCheckBlob extends Omit<DecisionBlob, "answers"> {
  answers: Record<string, VerifyAnswer | undefined>;
}

/**
 * The inverse, for bytes fetched from a trace store: any decision blob with a `request.state`,
 * `answers`, `model` and `id`. `null` otherwise. It does **not** require a goal answer, because a
 * blob whose answer is missing was still paid for and committed, and what the runner did then —
 * let the claim decide — is itself checkable (`applyGoalCheck` answers `unavailable`).
 */
export function decodeGoalCheckBlob(bytes: Uint8Array): GoalCheckBlob | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
    if (!parsed || typeof parsed !== "object") return null;
    const { request, answers, model, id } = parsed;
    if (typeof model !== "string" || typeof id !== "string") return null;
    if (!request || typeof request !== "object" || typeof request.state !== "string") return null;
    if (!answers || typeof answers !== "object") return null;
    return parsed as GoalCheckBlob;
  } catch {
    return null;
  }
}

/**
 * Whether a blob's questions ask the goal question at all — the goal-only set, or verify's two
 * plus the goal's. A verify blob of a loop without the check asks the two alone.
 */
export function asksGoal(questions: unknown): boolean {
  return sameQuestions(questions, GOAL_CHECK_QUESTIONS) || sameQuestions(questions, VERIFY_GOAL_QUESTIONS);
}

/**
 * The goal decision a committed blob comes to, re-derived from the blob alone: the bar it records
 * (the default when it records none), and the claim read off the step output in its state.
 * `STEP OUTPUT:` is the state's last section, so what follows its label is the output, or at
 * worst a tail of it that ends on the same line. The claim only labels a disagreement: whether the
 * loop stopped turns on Jev's word whenever there is one, and when there is none the audit holds
 * the claim to the committed memory instead. `null` when the blob did not ask the goal question.
 *
 * `committedBar` is the one the session's policy commits, when the caller has read it: the blob's own
 * is the writer's word, and an audit that took it would let a writer lower the bar after the fact.
 */
export function goalCheckOfBlob(blob: GoalCheckBlob | DecisionBlob, committedBar?: number): GoalCheckDecision | null {
  if (!asksGoal(blob.request.questions)) return null;
  const bar = committedBar ?? blob.request.minConfidence ?? DEFAULT_GOAL_CHECK_CONFIDENCE;
  const state = blob.request.state;
  const label = "STEP OUTPUT: ";
  const at = state.lastIndexOf(`\n\n${label}`);
  const output = at < 0 ? state : state.slice(at + 2 + label.length);
  return applyGoalCheck(blob.answers, bar, goalReachedIn(output));
}
