"use client";

/**
 * The four terms of a loop, and the controls that pick them.
 *
 * `CreatorWizard.tsx` and `LoopStartForm.tsx` both import them from here, so the standalone form
 * does not depend on the wizard, and both render the same three chip groups and the same cost
 * sentence, so the wizard's inline step and the standalone card cannot drift on what a loop
 * costs or what intervals exist.
 *
 * Only the shared parts are here. The standing instruction is not: the wizard shows a character
 * countdown against a red border while the form prints one line underneath, and that is a
 * deliberate difference between a step you cannot leave and a card you can.
 *
 * The verify terms are here too, for the same reason: the toggle, the
 * sentence that says what a second model's verdict is and is not, and the chip a step's verdict
 * earns are read on four screens, and four wordings of "a second opinion, not a proof" is three
 * too many.
 */
import { useState, type ReactNode } from "react";
import { BadgeTone, CheckIcon, Info } from "@/components/ui";
import { OpenRouterMark, TempoMark } from "@/components/Tempo";
import { formatBaseUnits } from "@/lib/tempo";
import { usdcEFigure } from "@/lib/loop-money";
import { LOOP_STOP_REASON_TEXT, type StepGoalCheckView, type StepVerifyView } from "@/types/loop";

/**
 * What a second model judging each step is, said once, in the words the console uses everywhere
 * it names the term. The last clause is the whole of the claim: Jev is probabilistic, the runtime
 * thresholds its confidence, and the chain commits to what it said — which is a second opinion on the
 * record and nothing stronger. It does not open with "Optional": the form sends it on every start,
 * and the copy only shows beside a run that has it.
 */
export const VERIFY_TERMS_COPY =
  "On every loop started from the form: the decision model (TypeSafe's Jev) reads each finished step and answers two typed questions; the answer and its confidence are committed in the step's record. It is a second opinion the chain remembers, not a proof. Lath pays for its answers; they are not charged to you.";

/** The bar a verdict's confidence has to clear when nothing else is said: the form's, for every start. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** *verified by typesafe/jev-1.13 ≥ 0.5* — a run's verify terms in one line, wherever it is named. */
export function verifyTermsLabel(verify: { model: string; minConfidence: number }): string {
  return `verified by ${verify.model} \u2265 ${verify.minConfidence}`;
}

/**
 * The chip one step's verdict earns, or `null` when the loop asked for none — an unverified step
 * of an unverified run gets no chip at all rather than an empty one, because *nothing was asked*
 * and *the verifier did not answer* are different facts and only the second is worth a badge.
 *
 * `scripted` outranks the outcome: a scripted session's verdict is a fixture that cost nothing
 * and judged nothing, and showing it as an ordinary accept would put
 * a judgement on screen that no model made. `unverified` is the outage row: the verifier did not answer, and it
 * carries its reason rather than a confidence, because there is no verdict to be confident about.
 *
 * A step that was not remembered says the verdict and the reason **separately**: an `accept` under
 * the bar drawn as _retried 0.34_ would be a rejection the model never wrote. The word on the chip is the model's own, then why the step was dropped — _below the bar_
 * with the bar's value when the loop's terms are known, or the verdict alone when the word was
 * `retry` — then _not remembered_, which is the one thing every dropped step has in common. The
 * fan-out is not mentioned because it is not gated on this: the members table beside the chip says
 * whether the step tasked anyone.
 *
 * `text` is the whole of what the chip says — _scripted_ and _unverified_ already name the check —
 * so a caller adds no word of its own in front of it: a fixed _verified_ prefix would turn the outage
 * row into _verified unverified_ on every step card. `judged` marks the three chips that
 * carry the model's own verdict, the only ones a label such as `verifyChipLabel`'s reads right before.
 */
export function verifyChip(
  v: StepVerifyView | undefined,
  bar?: number
): { text: string; tone: BadgeTone; title?: string; judged?: true } | null {
  if (!v) return null;
  if (v.scripted) return { text: "scripted", tone: "neutral", title: "a scripted session; the verdict is a fixture" };
  // Jev not asked because this loop's Jev budget is spent is a different
  // fact from Jev not answering: nothing failed, Lath's share ran out, and the chip says which so an
  // owner does not go looking for an outage. The word stays _unverified_ — it is still true.
  if (v.capped)
    return {
      text: "unverified · decision budget spent",
      tone: "warn",
      title:
        "the decision model was not asked: Lath's decision spend for this loop is used up, so the step went on unjudged",
    };
  if (v.unavailable) return { text: "unverified", tone: "warn", title: v.unavailable };
  const confidence = typeof v.confidence === "number" ? ` ${v.confidence.toFixed(2)}` : "";
  if (v.outcome === "accepted") return { text: `accepted${confidence}`, tone: "good", judged: true };
  if (v.outcome === "retried") {
    // `verdict` is the model's word and is absent on steps recorded before it was kept; those
    // fall back to the outcome's word, which is at least not a claim about what the model said.
    const word = v.verdict === "accept" ? "accepted" : v.verdict === "retry" ? "retry" : "retried";
    const why = v.verdict === "accept" ? [typeof bar === "number" ? `below the bar ${bar}` : "below the bar"] : [];
    return {
      text: [`${word}${confidence}`, ...why, "not remembered"].join(" · "),
      tone: "warn",
      judged: true,
      title:
        v.verdict === "accept"
          ? "the judge accepted the step under the loop's confidence bar, so it was not remembered; the next step resumed from the memory before it"
          : "the step ran and was not remembered; the next step resumed from the memory before it",
    };
  }
  if (v.outcome === "escalated")
    return { text: `escalated${confidence}`, tone: "bad", title: LOOP_STOP_REASON_TEXT.escalated, judged: true };
  return null;
}

/**
 * A verify chip's words on a step card, where nothing else says what they answer: _verify: accepted
 * 0.92_, _verify: escalated 0.30_, the way the goal chip beside it reads _goal: continue_. The chips
 * with no verdict in them — _scripted_, _unverified_, _unverified · decision budget spent_ — stand
 * alone, since a prefix would only say the check's name twice.
 */
export function verifyChipLabel(chip: { text: string; judged?: true }): string {
  return chip.judged ? `verify: ${chip.text}` : chip.text;
}

/**
 * The on/off row every optional section of the loop form opens with — the goal check, the trace
 * audit, the sandbox, the team and verify — and, beside it, the `Info` that holds its explanatory
 * paragraph. The paragraph is the section's claim about itself, kept word for word behind the ⓘ.
 *
 * The ⓘ sits beside the toggle and not inside it: a button inside a button is invalid markup, and a
 * click meant for the explanation must never flip a term the start will sign.
 */
export function SectionToggle({
  on,
  onToggle,
  label,
  badge,
  testId,
  info,
  infoLabel,
  infoTestId,
}: {
  on: boolean;
  onToggle: () => void;
  label: ReactNode;
  /**
   * Drawn at the row's right; nothing when absent. The checkbox already says on or off, so no `on` /
   * `off` badge is drawn beside it; a count belongs in the label (`Files · 2`).
   */
  badge?: ReactNode;
  /** On the toggle button, as each section has always carried it. */
  testId: string;
  /** The section's explanatory paragraph(s). */
  info: ReactNode;
  /** The ⓘ's accessible name, e.g. "What the goal check does". */
  infoLabel: string;
  /** On the popover. */
  infoTestId?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        data-testid={testId}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
          on ? "border-spine-green/40 bg-spine-green/[0.06]" : "border-line/[0.08] hover:bg-line/[0.03]"
        }`}
      >
        <span
          className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
            on ? "border-spine-green bg-spine-green text-neutral-950" : "border-line/[0.2] text-transparent"
          }`}
        >
          <CheckIcon />
        </span>
        <span className="min-w-0 flex-1 text-xs font-medium text-ink-1">{label}</span>
        {badge}
      </button>
      <Info label={infoLabel} testId={infoTestId} wide>
        {info}
      </Info>
    </div>
  );
}

/**
 * A labelled field whose label carries an `Info`. Not `Field` from `ui.tsx`: that wraps everything
 * in one `<label>`, and a label's control is its *first* labelable descendant — the ⓘ button, which
 * would then take the input's name and turn every click on the label text into opening the popover.
 * Here the `<label>` names the input by `htmlFor`, and the ⓘ stands beside it, outside.
 */
export function InfoField({
  label,
  info,
  infoLabel,
  infoTestId,
  right,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  info: ReactNode;
  infoLabel: string;
  infoTestId?: string;
  right?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  /** The id of the input `children` holds, so the label still names it. */
  htmlFor: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
            {label}
          </label>
          <Info label={infoLabel} testId={infoTestId} wide>
            {info}
          </Info>
        </span>
        {right && <span className="text-2xs text-ink-3">{right}</span>}
      </div>
      {children}
      {hint && <div className="mt-1.5 text-2xs leading-relaxed text-ink-3">{hint}</div>}
    </div>
  );
}

/**
 * What _Jev checks the goal_ is, said once. Jev's loop decisions are its main job, so the copy
 * names it first; then the outage rule, because a check that can fail open has to say which way it
 * fails; and last who pays, because Jev is free for users and a toggle that costs nothing should say
 * so.
 */
export const GOAL_CHECK_COPY =
  "After each step the decision model (TypeSafe's Jev) answers one more typed question, continue or achieved, with a confidence, and the loop stops when it says achieved at or above the bar. The step's own GOAL REACHED line becomes a claim it checks. The answer is committed in the step's record. If it cannot be reached, the step's claim decides, as it does without the check. Lath pays for its answers; they are not charged to you.";

/**
 * *Jev checks the goal*, under the Goal field, shown only once there is text in it: a check with
 * nothing to ask about is one the server drops (`checkGoalCheck`). One toggle and no number: the bar
 * is the verify seat's when that is on — one call asks both — and the committed 0.5 otherwise, and
 * the ⓘ says which.
 *
 * The form's instruction and goal are one field (`lib/loop-goal-field.ts`), so the toggle also
 * decides what that text is sent as: on, as the instruction and as the goal Jev judges; off, as the
 * instruction alone, unless _The agent says when it is done_ (below) sends it as an unchecked goal.
 * The ⓘ says what off means, because off is a different kind of loop and not only a goal loop with
 * no second opinion.
 */
export function LoopGoalCheckToggle({
  on,
  setOn,
  bar,
  seat,
  more,
}: {
  on: boolean;
  setOn: (v: boolean) => void;
  /** The bar the answer will be held to, as the start would resolve it. */
  bar: number;
  /** Whether the verify seat is on, which is where the bar comes from when it is. */
  seat: boolean;
  /** The form's own lines about the decision model, appended to the ⓘ: what ends the loop, verify. */
  more?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line/[0.08] p-3" data-testid="loop-goal-check">
      <SectionToggle
        on={on}
        onToggle={() => setOn(!on)}
        // "Decision model" on screen, Jev only inside the ⓘ.
        label="Decision model checks the goal"
        testId="loop-goal-check-toggle"
        // The bar is said in the ⓘ, not under the toggle.
        info={
          <>
            <p>{GOAL_CHECK_COPY}</p>
            <p className="mt-2" data-testid="loop-goal-check-bar">
              Bar: <span className="num">{bar}</span>
              {seat
                ? ", the verify seat's minimum confidence, asked in the same call."
                : ", committed in the loop's policy."}
            </p>
            <p className="mt-2" data-testid="loop-goal-check-off">
              Off, the Goal is the instruction every step runs and nothing more: the loop runs until its steps or its
              budget run out.
            </p>
            {more}
          </>
        }
        infoLabel="What the goal check does"
        infoTestId="loop-goal-check-info"
      />
    </div>
  );
}

/**
 * *The agent says when it is done*, in place of the goal check when that is off: a goal loop with no
 * decision model, stopped by a step whose answer ends with `GOAL REACHED` and by nothing else that
 * reads the text. Kept so that loop is one the form starts from its one Goal field
 * (`lib/loop-goal-field.ts`), and kept out of sight until the check is off,
 * because the form's default — and every preset — is the checked goal. Off by default: off is the
 * instruction-only loop, which is what turning the check off most often asks for.
 */
export function LoopSelfStopToggle({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  return (
    <div className="rounded-lg border border-line/[0.08] p-3" data-testid="loop-goal-self-stop">
      <SectionToggle
        on={on}
        onToggle={() => setOn(!on)}
        label="The agent says when it is done"
        testId="loop-goal-self-stop-toggle"
        info={
          <>
            <p>
              On, the loop also stops when a step ends its answer with GOAL REACHED. That is the agent&apos;s own word,
              and nothing checks it. The Goal is committed as the loop&apos;s goal as well as its instruction.
            </p>
            <p className="mt-2">
              Off, the Goal is the instruction every step runs: the loop runs until its steps or its budget run out.
            </p>
          </>
        }
        infoLabel="What the agent's own stop does"
        infoTestId="loop-goal-self-stop-info"
      />
    </div>
  );
}

/**
 * The chip one step's goal answer earns, or `null` on a step Jev was not
 * asked about. The words are the audit's: _goal: achieved 0.82_, _goal: continue 0.41_, and the
 * disagreement after them when Jev and the step's own claim parted ways.
 */
export function goalCheckChip(
  g: StepGoalCheckView | undefined,
  /**
   * What Jev's answer cost on the loop's channel, USDC.e base units: `jevCostBase(row)`,
   * which is the seat's call when the question rode it. Defaults to the goal check's own.
   */
  costBase: string | undefined = g?.costBase
): { text: string; tone: BadgeTone; title: string } | null {
  if (!g) return null;
  const chip = goalChipWords(g);
  // The price on hover only, on an answer that was paid for. In USDC.e, the currency the channel paid
  // it in. Lath pays for Jev and charges the owner nothing for it, so the step's Cost does not hold
  // it. It is not in the chip's words: `goal: achieved 0.94` is what the row is for, and Paid on Tempo
  // lists the decision model's spend on its own row.
  const paid = g.scripted ? null : usdcEFigure(costBase);
  if (!paid) return chip;
  return {
    ...chip,
    title: `${chip.title}. The decision model's answer cost ${paid} USDC.e on the loop's Tempo channel, paid by Lath and not charged to the owner`,
  };
}

function goalChipWords(g: StepGoalCheckView): { text: string; tone: BadgeTone; title: string } {
  if (g.scripted)
    return {
      text: `goal: ${g.choice ?? "scripted"} (scripted)`,
      tone: "neutral",
      title: "a scripted session; the decision model's answer is a fixture that mirrors the step's own claim",
    };
  // Not asked for budget reasons: the claim decided, as on an outage, and the chip says why.
  if (g.capped)
    return {
      text: "goal: unchecked · decision budget spent",
      tone: "warn",
      title:
        "the decision model was not asked: Lath's decision spend for this loop is used up, so the step's own claim decided",
    };
  if (g.outcome === "unavailable")
    return {
      text: "goal: unchecked",
      tone: "warn",
      title: `the decision model could not be asked (${g.unavailable ?? "no answer"}), so the step's own claim decided`,
    };
  const at = typeof g.confidence === "number" ? ` ${g.confidence.toFixed(2)}` : "";
  const word = `goal: ${g.choice}${at}`;
  if (g.outcome === "achieved") {
    return g.disagreement === "unclaimed"
      ? {
          text: `${word} · no claim`,
          tone: "volt",
          title:
            "the decision model judged the goal achieved though the step did not claim it, and the loop stopped here",
        }
      : { text: word, tone: "volt", title: "the decision model judged the goal achieved, and the loop stopped here" };
  }
  const below = g.choice === "achieved" && typeof g.bar === "number" ? ` · below the bar ${g.bar}` : "";
  if (g.disagreement === "overruled")
    return {
      text: `${word}${below} · claim overruled`,
      tone: "warn",
      title: "the step claimed GOAL REACHED and the decision model did not agree at the bar, so the loop went on",
    };
  return {
    text: `${word}${below}`,
    tone: "neutral",
    title: below
      ? "the decision model said achieved under the loop's bar, so the loop went on"
      : "the decision model judged the goal not reached yet",
  };
}

export const LOOP_INTERVALS = [
  { ms: 60_000, label: "1 min" },
  { ms: 5 * 60_000, label: "5 min" },
  { ms: 15 * 60_000, label: "15 min" },
  { ms: 60 * 60_000, label: "1 hour" },
];

/**
 * The loop form's _Step Interval_ chips: 1 min and 5 min, plus the 10 s
 * chip `pollOptions` puts ahead of them, so the form offers exactly 10 s, 1 min and 5 min. Only the
 * form narrows: `LOOP_INTERVALS` stays the default of every display, so a blueprint or an old run that
 * steps every 15 min or every hour still reads its own cadence; carried into the form, it snaps to the
 * nearest chip on screen, which is what the owner then signs.
 */
export const LOOP_FORM_INTERVALS = LOOP_INTERVALS.filter((i) => i.ms <= 5 * 60_000);

/**
 * The steps chips, and beside them a field for any other count. The field takes 1 up to the server's
 * bound on one loop (`MAX_STEPS` in `_lib/loop-terms.ts`, the default of `LATH_LOOP_MAX_STEPS`, 48), so
 * the longest loop the console allows can still be asked for on screen. `loopStepOptions` drops any chip above
 * what the console reports.
 */
export const LOOP_STEP_COUNTS = [3, 6, 12];

/** The server's default bound on one loop's steps, for a form that has not read `limits` yet. */
export const LOOP_MAX_STEPS_DEFAULT = 48;

/** A typed step count as the form keeps it: a whole number from 1 to `max`, else the nearest. */
export function clampSteps(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.floor(n)), Math.max(1, Math.floor(max)));
}

/**
 * The steps chips the console's bound allows (`GET /api/loops` `limits.maxSteps`): every chip at or
 * under it, and the bound itself as the one chip when an operator set it below the smallest. With no
 * bound (a list not read yet) every chip is offered, and the route checks what it is sent.
 */
export function loopStepOptions(maxSteps: number | undefined): number[] {
  if (typeof maxSteps !== "number" || !Number.isFinite(maxSteps) || maxSteps <= 0) return LOOP_STEP_COUNTS;
  const under = LOOP_STEP_COUNTS.filter((n) => n <= maxSteps);
  return under.length ? under : [Math.floor(maxSteps)];
}

/**
 * Characters a standing instruction needs before a loop may be deployed — the loop form's one Goal
 * field, which is always sent as the instruction (`lib/loop-goal-field.ts`).
 */
export const LOOP_PROMPT_MIN = 10;

/**
 * The loop budget's chips, USDC: one overall budget the steps draw down, with no per-step ceiling.
 * 1, 5 and 10, with 1 the default. The operator's bound on one loop,
 * `LATH_LOOP_BUDGET_MAX_USDC`, is 25 by default; `loopBudgetOptions` drops any chip above it. A chip
 * the treasury cannot fund (the budget plus the decision model's 15 %) is still offered: the start
 * refuses it and names the largest budget that fits.
 */
export const LOOP_BUDGETS = ["1", "5", "10"];

/**
 * The chips a form offers against the console's bound (`GET /api/loops` `limits.loopBudgetMaxMicroUsdc`):
 * every chip at or under it, and — when the operator set a bound below the smallest chip — that
 * bound as the one chip, so the form never offers only budgets the route would clamp. Without a bound
 * (a console that sends none) every chip is offered and the server clamps.
 */
export function loopBudgetOptions(maxMicro: string | undefined): string[] {
  if (!maxMicro || !/^\d+$/.test(maxMicro) || maxMicro === "0") return LOOP_BUDGETS;
  const max = Number(maxMicro) / 1_000_000;
  const under = LOOP_BUDGETS.filter((b) => Number.parseFloat(b) <= max);
  return under.length ? under : [String(max)];
}

/** A chip's USDC string as micro-USDC, which is what the start body carries; `0` when it is not a number. */
export function budgetMicroOf(usdc: string): number {
  return Math.round((Number.parseFloat(usdc) || 0) * 1_000_000);
}

/** One row of chips: a label, and the options as pressable buttons. */
export function Chips<T extends string | number>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testId?: (key: T) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={String(o.key)}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={value === o.key}
            data-testid={testId?.(o.key)}
            className="chip"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/*
 * No trigger picker: the start form starts loops on a step interval and nothing else, so there is no
 * _What wakes a step_ control here. Gated and oracle-woken loops are not in this build and are refused
 * at every door; older runs recorded on a gate, a request or a feed still read in their own words
 * through `triggerLabel` (`lib/loop-trigger.ts`).
 */

/**
 * _Steps_: the chips, and a field for any other whole number up to the console's bound. The field
 * shows the count whenever it is not a chip, so a carried 24 reads as 24 rather than as no chip
 * pressed; typing keeps its own text so a half-typed value survives a keystroke.
 */
function StepsField({
  steps,
  maxSteps,
  setMaxSteps,
  max,
}: {
  steps: readonly number[];
  maxSteps: number;
  setMaxSteps: (v: number) => void;
  max: number;
}) {
  const custom = !steps.includes(maxSteps);
  const [text, setText] = useState(custom ? String(maxSteps) : "");
  const shown = custom && text === "" ? String(maxSteps) : text;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-ink-2">Steps</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setText("");
              setMaxSteps(n);
            }}
            aria-pressed={maxSteps === n}
            className="chip"
          >
            {n}
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={max}
          step={1}
          value={shown}
          placeholder="other"
          aria-label={`Steps, 1 to ${max}`}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n)) setMaxSteps(clampSteps(n, max));
          }}
          onBlur={() => setText(custom || text ? String(maxSteps) : "")}
          className={`input num h-8 w-20 px-2 py-1 text-xs ${custom ? "border-spine-blue/60" : ""}`}
          data-testid="loop-steps-custom"
        />
      </div>
    </div>
  );
}

/**
 * Interval, steps and the loop's budget. The interval reads *Step Interval* — capitalised as
 * written, though the form's other labels are sentence case — on every loop the form starts, which
 * is a loop on the clock. `intervalLabel` stays for a caller that means something else by the row.
 *
 * The budget is the whole loop's: one figure the steps draw down, not a price per step, so the row
 * says *Loop budget*. The chosen chip rides the wrapper as `data-usdc` because there is no input to
 * read a value off.
 */
export function LoopTermChips({
  intervalMs,
  setIntervalMs,
  maxSteps,
  setMaxSteps,
  budgetUsdc,
  setBudgetUsdc,
  intervalLabel = "Step Interval",
  intervals = LOOP_INTERVALS,
  budgets = LOOP_BUDGETS,
  steps = LOOP_STEP_COUNTS,
  maxStepsBound = LOOP_MAX_STEPS_DEFAULT,
}: {
  /** The most steps the console allows (`limits.maxSteps`); the typed field stops there. */
  maxStepsBound?: number;
  intervalMs: number;
  setIntervalMs: (v: number) => void;
  maxSteps: number;
  setMaxSteps: (v: number) => void;
  budgetUsdc: string;
  setBudgetUsdc: (v: string) => void;
  intervalLabel?: string;
  /** The steps chips, `loopStepOptions` of the console's bound; every chip when it sends none. */
  steps?: readonly number[];
  /**
   * The interval chips, `LOOP_INTERVALS` unless the caller says otherwise: the form offers a 10 s chip
   * ahead of them (`pollOptions` in `lib/loop-trigger.ts`).
   */
  intervals?: readonly { ms: number; label: string }[];
  /** The budget chips, `loopBudgetOptions` of the console's bound; every chip when it sends none. */
  budgets?: readonly string[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Chips
        label={intervalLabel}
        options={intervals.map((i) => ({ key: i.ms, label: i.label }))}
        value={intervalMs}
        onChange={setIntervalMs}
      />
      <StepsField steps={steps} maxSteps={maxSteps} setMaxSteps={setMaxSteps} max={maxStepsBound} />
      <div data-testid="loop-budget-field" data-usdc={budgetUsdc}>
        <Chips
          label="Loop budget"
          options={budgets.map((b) => ({ key: b, label: `${b} USDC` }))}
          value={budgetUsdc}
          onChange={setBudgetUsdc}
          testId={(b) => `loop-budget-${b}`}
        />
      </div>
    </div>
  );
}

/**
 * What the chosen terms add up to, in the worst case, and whose money each part is.
 *
 * The worst case is the budget itself — not budget × steps: the steps draw one figure down, and the
 * loop stops the moment it is spent, so the line says that figure and that stop. It names the one
 * rail too rather than leaving
 * "USDC" to be read as whichever ledger the reader has in mind: the model is paid on Tempo from the
 * operator's treasury, and the figure here is what leaves the owner's escrow on Solana.
 *
 * Jev's line sits beside it because it is the other half of the same budget: Lath may spend up
 * to a share of it on Jev — gate asks, verify and goal checks — out of its own treasury, so the
 * owner reads, before signing, that the share is Lath's and is never added to their figure.
 *
 * The line leads with who is paid: the debit on Solana, then *OpenRouter via Tempo* with both
 * marks, then Lath's decision share. The steps, the interval and the stop are in the ⓘ beside it,
 * figures and all. One more sentence belongs here when per-loop Tempo keys are on (_Tempo itself will refuse
 * any payment past X USDC.e_), and it is not drawn: `GET /api/loops` serves no field saying whether
 * `LATH_TEMPO_LOOP_KEYS` is on for a new start (`limits` has none, and `tempoKey` is on a started
 * loop's one-loop read only), and a limit the form cannot know is enforced is an unbacked claim.
 */
export function LoopCostLine({
  intervalMs,
  maxSteps,
  budgetUsdc,
  intervals = LOOP_INTERVALS,
  jevPercent,
}: {
  intervalMs: number;
  maxSteps: number;
  budgetUsdc: string;
  /** The chips the row above offered, so a 10 s chip is named here too rather than blank. */
  intervals?: readonly { ms: number; label: string }[];
  /** Lath's Jev share, percent (`limits.jevBudgetPercent`); the line is left out when the console sends none. */
  jevPercent?: number;
}) {
  const budget = (Number.parseFloat(budgetUsdc) || 0).toFixed(2);
  return (
    <p className="text-2xs leading-relaxed text-ink-3" data-testid="loop-cost-line">
      {/* The debit and where it is drawn from, then who is paid, and how. Not "to Lath's treasury":
          the vault's debits reach the treasury only when the operator sweeps them by hand, so the
          chain makes no such claim. */}
      You&apos;re debited up to <span className="num text-ink-2">{budget} USDC</span> from your escrow on Solana. Each
      model call is paid to <span className="font-semibold text-ink-1">OpenRouter via Tempo</span>{" "}
      <span className="inline-flex items-center gap-1 align-[-0.1em]">
        <OpenRouterMark title="OpenRouter" />
        <TempoMark title="Tempo" className="text-ink-1" />
      </span>
      .{" "}
      <Info label="What the loop budget covers" testId="loop-cost-info" wide>
        <p>
          At most {maxSteps} steps at {intervals.find((i) => i.ms === intervalMs)?.label}, drawing on one budget of{" "}
          <span className="num text-ink-1">{budget} USDC</span> for the whole loop — never more than that in total,
          however the steps split it. The loop stops itself when the budget is spent or a step cannot be paid for, and
          you can pause or stop it at any time. Tempo pays the model; the figure above is what is debited from your USDC
          escrow on Solana, against the allowance you signed.
        </p>
        <p>
          Each call is paid to OpenRouter&apos;s Tempo gateway with Tempo&apos;s Machine Payments Protocol: a signed
          voucher on a payment channel, where the voucher&apos;s delta is the call&apos;s price.
        </p>
        {/* At the bottom of the ⓘ, out of the line itself. */}
        {typeof jevPercent === "number" && (
          <p data-testid="loop-jev-share">
            Lath pays the decision model, up to <span className="num text-ink-1">{jevPercent} %</span> of the budget.
          </p>
        )}
      </Info>
    </p>
  );
}

/**
 * Why a start on these terms would be refused for want of Tempo deposit, before the signature,
 * or `null` when the treasury holds enough or cannot be read here.
 *
 * The arithmetic is the server's (`treasuryShortfall` in `_lib/loop-channel-state.ts`, `jevBudgetOf` in `_lib/loop-budget.ts`): the deposit
 * a fresh run opens with is the loop budget plus Lath's decision share of it, the share computed in
 * hundredths of a percent and floored, and the largest budget that fits is `held ÷ (1 + percent/100)`.
 *
 * A hint and never a block: the server also counts what other loops' open channels may still draw
 * from the treasury (`loopChannelsCommitted`), which no route serves, so its answer can be a refusal
 * where this one is silent. And the reverse cannot happen only while nothing else spends from the
 * treasury between this read and the start; the route asks again either way and is the one that
 * decides, so this never disables Start.
 */
export function treasuryShortfallHint(
  budgetMicro: number | string,
  percent: number | undefined,
  balanceBase: string | null | undefined
): { heldBase: bigint; neededBase: bigint; fitsBase: bigint } | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  if (!balanceBase || !/^\d+$/.test(balanceBase)) return null;
  let budget: bigint;
  try {
    budget = BigInt(budgetMicro);
  } catch {
    return null;
  }
  if (budget <= BigInt(0)) return null;
  const tenThousand = BigInt(10_000);
  const hundredths = BigInt(Math.round(Math.min(100, Math.max(0, percent)) * 100));
  const needed = budget + (budget * hundredths) / tenThousand;
  const held = BigInt(balanceBase);
  if (held >= needed) return null;
  return { heldBase: held, neededBase: needed, fitsBase: (held * tenThousand) / (tenThousand + hundredths) };
}

/** The shortfall as the line beside Start says it; nothing when there is none. */
export function LoopTreasuryShortfall({
  budgetMicro,
  percent,
  balanceBase,
}: {
  budgetMicro: number;
  percent: number | undefined;
  balanceBase: string | null | undefined;
}) {
  const short = treasuryShortfallHint(budgetMicro, percent, balanceBase);
  if (!short) return null;
  return (
    <p className="text-2xs leading-relaxed text-amber-300" data-testid="loop-treasury-shortfall">
      <TempoMark className="mr-1" />
      Lath&apos;s Tempo treasury holds <span className="num">{formatBaseUnits(short.heldBase)}</span> USDC.e; this loop
      needs up to <span className="num">{formatBaseUnits(short.neededBase)}</span> on deposit, so the start would be
      refused.{" "}
      {short.fitsBase > BigInt(0) ? (
        <>
          Lower the budget to <span className="num">{formatBaseUnits(short.fitsBase)}</span> USDC or less.
        </>
      ) : (
        "The treasury has to be topped up first."
      )}
    </p>
  );
}
