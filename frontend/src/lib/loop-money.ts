import type { LoopStepSummary, LoopView } from "../types/loop";

/**
 * What a loop's terms card says about money: the badge, the "charged so far" figure and the
 * sentence under the model — decided here, together, from one reading of the row.
 *
 * Read independently, the three disagree. The badge would say _billed_ whenever the owner's
 * allowance was live when the step began (`billing`), the figure would be `totalCostMicroUsdc` —
 * every step's metered cost, including a step whose `charge` entry never landed — and the sentence
 * would be picked from the stored `inference` label, which an older row carries as `scripted` even
 * on the `tempo` rail. One loop could then show _billed_, "0.003450 charged so far" and "steps run
 * scripted, so nothing is charged" at once, on a step that paid the gateway 3 000 over Tempo and
 * whose Solana charge was still in the journal.
 *
 * No imports but the type, so a node test can load it.
 */
export interface LoopMoney {
  badge: { text: string; tone: "good" | "warn" | "neutral" };
  /** Micro-USDC charged on Solana by steps whose writes landed. */
  charged: bigint;
  /** Micro-USDC metered by steps whose writes are still in the journal (`deferredCheckpoint`). */
  held: bigint;
  chargedHint: string;
  note?: string;
}

/** Six decimals, which both the vault's USDC and Tempo's USDC.e carry. */
function six(v: bigint): string {
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const unit = BigInt(1_000_000);
  return `${neg ? "-" : ""}${abs / unit}.${(abs % unit).toString().padStart(6, "0")}`;
}

export function loopMoney(
  loop: Pick<LoopView, "billing" | "inference" | "tempo" | "totalCostMicroUsdc" | "history">
): LoopMoney {
  const total = BigInt(loop.totalCostMicroUsdc || "0");
  // A step that still owes its checkpoint is a step whose records — its `charge` among them — did
  // not land: its cost was metered, not charged, and *Retry the step* is what charges it. The
  // history is capped at 50, but a run stops on the step that did not land, so that step is the
  // newest row and never the one dropped.
  const held = loop.history
    .filter((s) => s.deferredCheckpoint)
    .reduce((sum, s) => sum + BigInt(s.costMicroUsdc || "0"), BigInt(0));
  const charged = total > held ? total - held : BigInt(0);

  const badge: LoopMoney["badge"] =
    loop.billing !== "charged"
      ? { text: "unbilled", tone: "neutral" }
      : held > BigInt(0)
      ? { text: "charge not landed", tone: "warn" }
      : { text: "billed", tone: "good" };

  const chargedHint =
    `${six(charged)} USDC charged so far` +
    (held > BigInt(0) ? ` · ${six(held)} USDC metered by a step whose writes did not land, charged when they do` : "");

  // The rail is a fact of the run, not of the server's model key: a loop that opened a channel paid
  // OpenRouter through its MPP gateway whatever `inference` was stored as. What left the
  // payer is USDC.e on Tempo, a different currency from the USDC figure above, so it is named in
  // its own unit and never added to it. The words are the screen's: _OpenRouter via Tempo_, not
  // "the gateway"; the figure stays the measured one, and the clause
  // after it says where it was read — the last step's payment channel, as the console recorded it.
  let note: string | undefined;
  if (loop.tempo) {
    const treasury = loop.tempo.payer
      ? `Lath's treasury ${loop.tempo.payer.slice(0, 6)}…${loop.tempo.payer.slice(-4)}`
      : "Lath's treasury";
    const paid = loop.tempo.spent ? six(BigInt(loop.tempo.spent)) : null;
    note = paid
      ? `${paid} USDC.e to OpenRouter via Tempo, from ${treasury}, on the last step's payment channel`
      : `paid to OpenRouter via Tempo from ${treasury}; the last step's payment channel recorded no spend`;
  } else if (loop.inference === "openrouter") {
    note = loop.billing === "charged" ? "billed against the owner's allowance" : undefined;
  } else if (loop.inference === "scripted") {
    note =
      loop.billing === "charged"
        ? "no accepted model key on this server: steps run scripted, so nothing is charged"
        : "no live allowance: steps run scripted and unbilled";
  }

  return { badge, charged, held, chargedHint, note };
}

/**
 * USDC.e base units as the figure a step row shows: six decimals, and `null` for a figure
 * that is absent or unreadable, so the caller renders nothing rather than a zero nobody paid.
 */
export function usdcEFigure(base: string | undefined): string | null {
  if (!base || !/^\d+$/.test(base)) return null;
  return six(BigInt(base));
}

/**
 * What Jev's decision on one step cost on the loop's channel, USDC.e base units: the goal
 * check's own call on a run with no verify seat, or the seat's call, which carries the goal
 * question too when the check is on. Absent when Jev was not paid on the step — a scripted
 * answer, an outage, a run that asks Jev nothing. Lath pays it and charges the owner nothing for
 * it, so it is never inside the row's `costMicroUsdc` and the page labels it as Lath's (a few older
 * checkpoints charged it).
 */
export function jevCostBase(row: Pick<LoopStepSummary, "goalCheck" | "verify"> | undefined): string | undefined {
  if (!row) return undefined;
  if (row.goalCheck?.scripted || row.verify?.scripted) return undefined;
  return row.goalCheck?.costBase ?? row.verify?.costBase;
}

/**
 * What the trace audit on one step cost on the loop's channel, USDC.e base units: the reader's call, plus a veto's confirm when there was one. Lath pays it
 * out of the same decision spend as Jev's, and charges the owner nothing. Absent when nothing was
 * paid: a scripted answer, an outage before the reader answered, a run that audits nothing.
 */
export function traceCostBase(row: Pick<LoopStepSummary, "traceAudit"> | undefined): string | undefined {
  const t = row?.traceAudit;
  if (!t || t.scripted) return undefined;
  const parts = [t.costBase, t.confirm?.costBase].filter((x): x is string => typeof x === "string" && /^\d+$/.test(x));
  if (!parts.length) return undefined;
  return parts.reduce((a, b) => a + BigInt(b), BigInt(0)).toString();
}

/**
 * A loop's one budget as the page reads it: what the owner set, what
 * the steps and their members have drawn from it, what is left, and Lath's own Jev share beside it.
 *
 * Read defensively rather than straight off the wire because the page can be newer than the console
 * that answers it: an older server sends no `budgetMicroUsdc`, `spentMicroUsdc` or
 * Jev figures, and this reads those rows as their `perStep × maxSteps` budget and their
 * `totalCostMicroUsdc` spend, with no Jev share at all (`jev: null`) rather than a zero budget that
 * would read as *spent*. `remaining` is floored at zero: the call that crosses the line is paid for,
 * so `spent` may pass `budget` by one call, and *−0.000120 left* is not a figure anyone owes.
 */
export interface LoopBudgetFigures {
  budget: bigint;
  spent: bigint;
  remaining: bigint;
  /** `spent / budget`, 0–1, for the bar; 1 on a zero budget, which has nothing left to draw. */
  fraction: number;
  /** Lath's Jev spend against its share, USDC.e base units; `null` on a console that keeps none. */
  jev: { budget: bigint; spent: bigint; exhausted: boolean } | null;
}

function digits(v: string | undefined): bigint | null {
  return v && /^\d+$/.test(v) ? BigInt(v) : null;
}

export function loopBudgetFigures(
  loop: Pick<LoopView, "maxSteps" | "totalCostMicroUsdc" | "budgetMicroUsdcPerStep"> &
    Partial<Pick<LoopView, "budgetMicroUsdc" | "spentMicroUsdc" | "jevBudgetBase" | "jevSpentBase">>
): LoopBudgetFigures {
  const zero = BigInt(0);
  const perStep = digits(loop.budgetMicroUsdcPerStep) ?? zero;
  const budget = digits(loop.budgetMicroUsdc) ?? perStep * BigInt(Math.max(0, Math.floor(loop.maxSteps || 0)));
  const spent = digits(loop.spentMicroUsdc) ?? digits(loop.totalCostMicroUsdc) ?? zero;
  const remaining = budget > spent ? budget - spent : zero;
  const fraction = budget > zero ? Math.min(1, Number(spent) / Number(budget)) : 1;
  const jevBudget = digits(loop.jevBudgetBase);
  const jevSpent = digits(loop.jevSpentBase) ?? zero;
  const jev = jevBudget === null ? null : { budget: jevBudget, spent: jevSpent, exhausted: jevSpent >= jevBudget };
  return { budget, spent, remaining, fraction, jev };
}
