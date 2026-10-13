/**
 * Which `loop.step` checkpoints on an agent's chain belong to *this* run of it.
 *
 * An agent can be run as a loop more than once, and `listByTool(agentId, "loop.step")` answers
 * with every checkpoint the chain ever carried. Filtering only the ones written before the loop
 * existed leaves the ones written after: a second run's steps would be indexed into the first run's
 * manifest, read *leaf mismatch* — the word for a broken commitment — and make a page whose every
 * step verified say "3/6 leaves verified". A checkpoint's manifest commits to its own `loopId`, so a
 * step of another run can never match this one's terms; the rule is not to ask it to.
 *
 * No React and no chain read here, so the rule is a pure function this suite can check:
 * `tests/console-loops.ts`.
 */

/** The little of a chain step this needs: `LoopStep` from `@lath/sdk` satisfies it. */
export interface WindowedStep {
  seq: bigint;
  /** Client-attested unix ms, from the record. */
  timestamp: bigint;
}

/** The little of a run this needs: `LoopView` satisfies it. */
export interface WindowedLoop {
  createdAt: number;
  status: "running" | "paused" | "stopped";
  /** Seq the last step's leaf committed to — also that step's record seq. */
  lastSeq: string | null;
  /** The registry's own rows; `seq` is absent on rows written before it was recorded. */
  history: { seq?: string }[];
}

export interface LoopStepWindow<S> {
  /** This loop's own checkpoints, in the order they were given. */
  own: S[];
  /** Checkpoints older than this loop: an earlier run of the same agent. */
  before: number;
  /** Checkpoints past its last step: a later run of the same agent. */
  after: number;
}

/**
 * The loop's own steps, and how many of the chain's lie on either side of them.
 *
 * Three tests, in order of how much they prove:
 *
 * 1. A seq the loop's own history names is its own, whatever the clocks say. The registry writes
 *    that row when the checkpoint lands, so this is the one exact test — and it is first so that
 *    two loops running on one agent at once still each claim their own rows.
 * 2. A record whose timestamp predates `createdAt` was written before this loop existed.
 * 3. A record past `lastSeq` — the seq the last step's leaf committed to, which the runner moves
 *    on every step — is a later run's. This is applied only to a loop that can write no more
 *    steps, because for a live one a checkpoint that landed a moment ago is past the `lastSeq` of
 *    the registry row the browser is still holding, and dropping it would make a step disappear
 *    from its own page for a poll. The cost of that lenience is narrow and named: while a loop is
 *    running or paused, a *second* loop's brand-new checkpoint can sit in this one's list until
 *    the poll that brings its own history row.
 *
 * Anything else is the loop's own. History is capped and old rows carry no `seq`, so a row this
 * cannot name is not evidence of anything: inside the window, the chain is taken at its word.
 */
export function loopStepWindow<S extends WindowedStep>(
  loop: WindowedLoop | undefined,
  steps: S[] | undefined
): LoopStepWindow<S> {
  if (!loop || !steps) return { own: steps ?? [], before: 0, after: 0 };
  const named = new Set(loop.history.map((h) => h.seq).filter((seq): seq is string => !!seq));
  const live = loop.status === "running" || loop.status === "paused";
  let last: bigint | null = null;
  try {
    last = loop.lastSeq ? BigInt(loop.lastSeq) : null;
  } catch {
    // A registry row with a seq that is not a number says nothing about where the run ended; the
    // other two tests still hold.
    last = null;
  }

  const own: S[] = [];
  let before = 0;
  let after = 0;
  for (const step of steps) {
    if (named.has(step.seq.toString())) own.push(step);
    else if (Number(step.timestamp) < loop.createdAt) before += 1;
    else if (last !== null && step.seq > last && !live) after += 1;
    else own.push(step);
  }
  return { own, before, after };
}
