/**
 * What a loop's running step is doing right now, for the loop page's pending row.
 *
 * In memory only, and on purpose: a stage lives for seconds, is worth nothing after the step ends,
 * and writing `loops.json` on every model call would put a file write inside the paid path of a
 * step for a label. A restart mid-step loses the stage and the step with it — `steppingSince` on
 * the record is what says a step was in flight, and the page falls back to its bare badge.
 *
 * Nothing here is hashed or committed. The stages are the console's own words about where a step
 * is, and carry no prompt, no answer and no tool argument, so the open GET may serve them to anyone.
 */
import type { ChatTransport } from "@lath/runtime";
import type { LoopStepStage } from "../../../types/loop";

interface StageEntry {
  /** Unix ms the console began the step — before the sources are read, not when the chain saw it. */
  startedAt: number;
  stage: LoopStepStage;
  /** The step's model calls so far, the orchestrator's, the members' and the synthesis's alike. */
  calls: number;
}

const STAGES_KEY = Symbol.for("lath.loopStepStages");

/** On `globalThis` for the reason the scheduler is: a hot-reloaded dev server keeps one map. */
function stages(): Map<string, StageEntry> {
  const g = globalThis as any;
  g[STAGES_KEY] ??= new Map<string, StageEntry>();
  return g[STAGES_KEY] as Map<string, StageEntry>;
}

/** The step has begun: it reads the chain and its sources before anything opens a sandbox. */
export function beginStepStage(id: string, now: number = Date.now()): void {
  stages().set(id, { startedAt: now, stage: "reading chain", calls: 0 });
}

/**
 * Moves a running step to `stage`. A loop with no step begun is left alone: a settlement builds the
 * same runtime and transport a step does, and it is not a step the page should say is running.
 */
export function setStepStage(id: string, stage: LoopStepStage): void {
  const entry = stages().get(id);
  if (entry) entry.stage = stage;
}

/** One more model call has gone out for this step; the stage names it by its count. */
export function countModelCall(id: string): void {
  const entry = stages().get(id);
  if (!entry) return;
  entry.calls += 1;
  entry.stage = `model call ${entry.calls}`;
}

/** The step is over, however it ended. */
export function endStepStage(id: string): void {
  stages().delete(id);
}

/**
 * The two fields `LoopView` carries while a step runs, or nothing. Spread into the view, so a loop
 * at rest carries neither key.
 */
export function stepStageView(id: string): { stepStartedAt: number; stepStage: LoopStepStage } | Record<string, never> {
  const entry = stages().get(id);
  return entry ? { stepStartedAt: entry.startedAt, stepStage: entry.stage } : {};
}

/**
 * `inner`, with each call marking the step's stage as it goes out: `chat` is a model call, `decide`
 * is Jev (the verify seat, the goal check, a routing choice). A reply that came back puts the step
 * back `in sandbox`, where the model's tool calls run, and a decision that came back puts it at
 * `anchoring`, since the memory commit and the checkpoint are what a decision is asked ahead of.
 *
 * A plain object, not a proxy: the runtime reads only `chat` off its transport and the runner only
 * `decide` (`deciderOf`), and every argument is handed through untouched — the stream callback and
 * the abort signal included — so what is paid for, recorded and hashed is what it was. `decide` is
 * present exactly when `inner` has one, because its absence is what the runner reports as
 * `unavailable`, and a wrapper that invented one would turn that into a throw.
 */
export function stagedTransport<T extends ChatTransport>(id: string, inner: T): ChatTransport {
  const staged: ChatTransport = {
    chat: async (...args: Parameters<ChatTransport["chat"]>) => {
      countModelCall(id);
      try {
        return await inner.chat(...args);
      } finally {
        setStepStage(id, "in sandbox");
      }
    },
  };
  if (typeof inner.decide === "function") {
    const decide = inner.decide.bind(inner) as (...a: unknown[]) => ReturnType<NonNullable<ChatTransport["decide"]>>;
    staged.decide = (async (...args: unknown[]) => {
      setStepStage(id, "Jev");
      try {
        return await decide(...args);
      } finally {
        setStepStage(id, "anchoring");
      }
    }) as ChatTransport["decide"];
  }
  return staged;
}
