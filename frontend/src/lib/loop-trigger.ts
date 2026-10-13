/**
 * What wakes a loop, as the console reads it and says it. The start form offers no trigger, gate or
 * team, and the API refuses them, since none is in this build (`app/api/_lib/roadmap.ts`); the
 * readers below stay for the rows that already carry one.
 *
 * Its own file, importing only types, for the reason `tiles.ts` and `draft.ts` are: a node-only suite
 * compiles it under the root `tsconfig.json`, so it pulls in neither the SDK's browser bundle nor the
 * wallet hooks. Everything here is pure and `tests/tile-rows.ts` pins it.
 */
import type { LoopTrigger } from "../types/loop";

/**
 * The trigger of a run. Absent means `schedule`: a run that carries no trigger steps on the
 * clock.
 *
 * The parameter is `unknown` rather than a shape with one optional key, so this reads a
 * `LoopView` from `/api/loops` without either side casting, and without TypeScript's weak-type
 * rule refusing a type that has no key in common.
 *
 * `gate` is read here and not left to fall through to `schedule`: a gated run's
 * `intervalMs` is its poll, so a list that called it *on schedule* would tell a reader it steps
 * every minute when it only looks that often.
 */
export function triggerOf(loop: unknown): LoopTrigger {
  const t = (loop as { trigger?: { kind?: unknown; pollMs?: unknown } } | null | undefined)?.trigger;
  if (t?.kind === "request" || t?.kind === "gate") {
    const pollMs = Number(t.pollMs);
    return { kind: t.kind, pollMs: Number.isFinite(pollMs) ? pollMs : 0 };
  }
  if (t?.kind === "feed") return { kind: "feed" };
  return { kind: "schedule" };
}

/**
 * *on request* · *feed* · *on a gate* · *on schedule* — the words the console uses for a trigger,
 * the same as the server's `triggerLabel` in `_lib/loop-terms.ts`. The start form has no trigger
 * picker: it starts loops on a step interval only.
 */
export function triggerLabel(trigger: LoopTrigger): string {
  if (trigger.kind === "gate") return "on a gate";
  return trigger.kind === "request" ? "on request" : trigger.kind === "feed" ? "feed" : "on schedule";
}

/**
 * The fastest chip a schedule loop offers, and the route's default `MIN_INTERVAL_MS`: short enough that a four-step demo run takes about two minutes, long enough that
 * the compression indexer has caught up with one step's writes before the next reads the chain.
 * The form starts loops on a step interval only, so a schedule loop is the only one with chips.
 */
export const SCHEDULE_FAST_MS = 10_000;

/** "15 s" / "1 min" / "6 hours" — a poll or heartbeat chip's label, in the words `LOOP_INTERVALS` uses. */
export function pollChipLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const hours = ms / 3_600_000;
  return hours === 1 ? "1 hour" : `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/**
 * The chips the form's _Step Interval_ row offers: the intervals, with the 10 s chip
 * (`SCHEDULE_FAST_MS`) ahead of them unless the route reports a floor above it, since a
 * chip under the floor would sign into a refusal. Before `/api/loops` answers, `minIntervalMs` is 0
 * and the chip shows: 10 s is the route's default floor, so the common case does not flicker in.
 * The form starts loops on a step interval only, so it offers no poll chips for a gated run.
 */
export function pollOptions<T extends { ms: number; label: string }>(
  intervals: readonly T[],
  minIntervalMs = 0
): { ms: number; label: string }[] {
  const fast = SCHEDULE_FAST_MS >= minIntervalMs && !intervals.some((i) => i.ms === SCHEDULE_FAST_MS);
  return fast ? [{ ms: SCHEDULE_FAST_MS, label: pollChipLabel(SCHEDULE_FAST_MS) }, ...intervals] : [...intervals];
}
