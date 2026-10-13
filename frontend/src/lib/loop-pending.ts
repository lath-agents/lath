/**
 * The loop page's pending step row and its ticking countdown, as pure functions a Node suite
 * can test without a browser.
 *
 * A running step reaches the chain only when its checkpoint lands, and the Steps table reads the
 * chain through Photon, which is a poll behind that. Until then the console is the only thing that
 * knows a step is running and where it is (`LoopView.stepStartedAt`, `stepStage`), so the table
 * shows a row made of that and nothing else — no figure on it is the chain's.
 *
 * Kept free of React and of `@/` imports so `tests/console-loops.ts` can import it.
 */

/** What the table shows until the step's real row arrives. */
export interface PendingStep {
  /** The 1-based step the console is running. */
  step: number;
  /** The console's word for where it is; `undefined` from an older server that does not send it. */
  stage?: string;
  /** Unix ms the console began the step; the clock counts from here. */
  startedAt: number;
  /** Unix ms the page first saw the step stop running; absent while it runs. */
  endedAt?: number;
}

/**
 * How long the row outlives the step on the page when the chain has not shown the step yet: the
 * Steps query polls Photon every 15 s, so the checkpoint can take that long to appear after the
 * console is done, and a row that vanished at once would leave a gap in exactly that window. A
 * step that wrote no checkpoint (a failure before it) never shows a row, and this is how long its
 * pending row stays before it goes.
 */
export const PENDING_GRACE_MS = 20_000;

/** What the page knows at one render. */
export interface PendingInput {
  stepping: boolean;
  stepStartedAt?: number;
  stepStage?: string;
  /** `LoopView.steps`: the steps the console has recorded. */
  steps: number;
  /**
   * `startedAt` of the newest row the console recorded (`history`), which tells a step still
   * sealing after its registry write — whose `steps` already counts it — from one not yet counted.
   */
  lastRecordedStartedAt?: number;
  /** The highest step index the Steps table shows (0 when it shows none). */
  lastRowIndex: number;
  now: number;
}

/**
 * The next pending row from the last one and what the page sees now. Returns `prev` itself when
 * nothing moved, so a React state setter that is handed this does not re-render for nothing.
 */
export function nextPendingStep(prev: PendingStep | null, s: PendingInput): PendingStep | null {
  if (s.stepping && s.stepStartedAt) {
    // The step's number, fixed the first time this step is seen: `steps` moves to it at the
    // registry write, while the step is still sealing, and re-deriving it then would say N + 1.
    const same = prev && prev.startedAt === s.stepStartedAt;
    const counted = s.lastRecordedStartedAt !== undefined && s.lastRecordedStartedAt >= s.stepStartedAt;
    const step = same ? prev.step : counted ? s.steps : s.steps + 1;
    // The real row has landed while the console is still sealing: the pending row has done its job.
    if (s.lastRowIndex >= step) return null;
    if (same && prev.stage === s.stepStage && prev.endedAt === undefined) return prev;
    return { step, stage: s.stepStage, startedAt: s.stepStartedAt };
  }
  if (!prev) return null;
  if (s.lastRowIndex >= prev.step) return null;
  if (prev.endedAt === undefined) return { ...prev, endedAt: s.now };
  return s.now - prev.endedAt > PENDING_GRACE_MS ? null : prev;
}

/** `0:34`, `12:05`, `1:02:03`: an elapsed time as a clock reads it, never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * `step 3 · model call 2 · 0:34`. A step the page saw end says `landing` in place of its last stage:
 * the console is done and the row waits on the indexer, which is not something the console is doing.
 * With no stage (an older server) the word is `running`, which is what the badge says.
 */
export function pendingStepLabel(p: PendingStep, now: number): string {
  // `Jev` is the console's wire value for the decision model's turn; the screen names the role
  // (`stepStageText` in types/loop.ts — repeated here so this file stays import-free).
  const stage = p.endedAt !== undefined ? "landing" : p.stage === "Jev" ? "decision model" : p.stage ?? "running";
  return `step ${p.step} · ${stage} · ${formatElapsed(now - p.startedAt)}`;
}

/**
 * The page's _Next step_ countdown, to the second under ten minutes (`in 0:42`, `in 9:05`) so a
 * one-second clock visibly moves, and in `untilStep`'s coarser words beyond that, where seconds are
 * noise. `now` is passed in so the clock is the caller's.
 */
export function countdownTo(at: number | null, now: number): string {
  if (!at) return "—";
  const delta = at - now;
  if (delta <= 1000) return "now";
  if (delta < 600_000) return `in ${formatElapsed(delta)}`;
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)} min`;
  return `in ${(delta / 3_600_000).toFixed(1)} h`;
}
