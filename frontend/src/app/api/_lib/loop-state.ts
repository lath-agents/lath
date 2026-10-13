/**
 * The scheduler's process-wide state and the run slot (`_lib/loops.ts` re-exports what was public).
 *
 * `scheduler()` is one object on `globalThis`, never a module-level map, because Next may evaluate a
 * route module twice in one process: every timer, held channel, settle queue and payer the loop
 * modules keep lives on it. The run slot is the rule that one thing writes an agent's chain at a time.
 */
import type { AnchoredEpochStore } from "@lath/sdk";
import type { TempoSettlement, LoopTempoServices } from "@lath/runtime";
import type { LoopStepSummary, LifecycleRef } from "../../../types/loop";
import { acquireRunSlot, extendRunSlot } from "./runner";
import { STEP_DEADLINE_MS } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import type { HeldChannel } from "./loop-channel-state";

/**
 * How long a settle for a run that has ended waits for the run slot: three step deadlines, the
 * point at which `withRunSlot` reports a holder as wedged. Past it the settle gives up with the
 * reason in the log and the channel still on the row, where a start on the agent is refused for it
 * and the next restart's recovery pass settles it.
 */
export const SETTLE_SLOT_WAIT_MS = 3 * STEP_DEADLINE_MS;

// ─── The scheduler ──────────────────────────────────────────────────────────

interface Scheduler {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  inFlight: Set<string>;
  /**
   * Loops whose timer has fired and whose tick has not returned. A timer is taken off `timers` as
   * it fires, and `inFlight` is set only once a step holds the run slot, so whatever a tick awaits
   * before that would have neither: a `/api/loops` request meanwhile would run `syncScheduler`, find
   * the loop running with no timer, and arm a second tick beside the first.
   */
  ticking: Set<string>;
  hydrated: boolean;
  /** One `AnchoredEpochStore` per agent id, so a manifest queue spans steps. */
  epochStores: Map<string, AnchoredEpochStore>;
  /**
   * Loops whose last step landed on chain but could not be written to the registry. Held here
   * because the registry is exactly what could not be written: until the process restarts,
   * these are not stepped again, so a step index the chain already carries is not run twice.
   */
  halted: Set<string>;
  /**
   * The Tempo channel each `tempo`-rail loop pays every one of its steps through, and the timer
   * that settles one the loop has gone quiet on.
   *
   * Here rather than in a module-level `Map` for the reason the pool state in `_lib/tempo.ts` is on
   * `globalThis`: Next compiles each route into its own module graph, so a module-level map is one
   * map per route — and two maps would be two channels for one loop, the second one's deposit
   * stranded behind a row naming the first.
   */
  channels: Map<string, HeldChannel>;
  idle: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * The last settle queued for each loop (`settleLoopChannel`), until it is done. On `globalThis`
   * for the reason `channels` is: two queues for one loop would be two settles of one channel.
   */
  settles: Map<string, Promise<TempoSettlement | undefined>>;
  /**
   * Each paid loop's Tempo services: the PUTs and reads it starts after every leaf, kept for the
   * loop's run because the runner that started them is dropped when its step returns. On
   * `globalThis` for the reason `channels` is. Settled with the channel.
   */
  tempoServices: Map<string, LoopTempoServices>;
  /** Loops whose access key is being revoked now (`revokeAfterStop`), so two triggers send one revoke. */
  revoking: Set<string>;
  /**
   * Reconciles in a row that could not read the key before sending anything, by loop
   * (`KEY_READ_FAILURES_BEFORE_STOP`). In memory: a restart starts the count again, which is the
   * generous direction for a loop that opened nothing meanwhile.
   */
  keyReadFailures: Map<string, number>;
  /**
   * The next try of each revoke Tempo refused (`retryRevokeLater`), by loop id or `orphan:<loop id>`,
   * with how many have failed: on a backoff timer, so a refused revoke is neither dropped nor sent on
   * every `/api/loops` request.
   */
  revokeRetries: Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>;
  /**
   * The stop a refused step could not write (`afterStepFailure`), tried again on a timer until the
   * registry takes it (`writeStopLater`). A halted loop is never ticked again, so without this its row
   * would read `running` for the life of the process and its key would never be let go.
   */
  stopRetries: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * `loop.step` checkpoints a Retry landed whose row the registry would not take, by loop and step
   * (`payDeferredCheckpoints`). The row still carries the plan, so the next Retry would otherwise
   * write the checkpoint a second time; it writes the row from this instead. Held here for the reason
   * `halted` is — the registry is what refused it — so a restart forgets it, the same window a process
   * that died between the landing and the row write leaves.
   */
  unrecordedCheckpoints: Map<string, Map<number, UnrecordedCheckpoint>>;
  /**
   * The lifecycle payer running for each loop (`loop:<id>`) or agent (`agent:<id>`), and the ones
   * asked for again while it ran (`kickLifecycle`): one payer per subject at a time, since two would
   * write one owed entry twice.
   */
  lifecycleRuns: Map<string, Promise<void>>;
  lifecycleAgain: Set<string>;
  /** When each subject's owed records were last decided or tried, so `syncScheduler` retries them on a rate. */
  lifecycleTried: Map<string, number>;
  /**
   * Records that landed and whose row would not take their ref, by owed entry id: the next pass
   * records the ref instead of writing the record a second time. In memory for the reason
   * `unrecordedCheckpoints` is — the registry is what refused it.
   */
  lifecycleLanded: Map<string, LifecycleRef>;
  /** When `syncScheduler` last looked for owed records to retry. */
  lifecycleScanAt: number;
  /** The rebuild from the chain this process ran, or is running (`rebuildFromChain`). */
  rebuild?: { at: number; run: Promise<void> };
}

/** A checkpoint that is on chain and not on its row: what the row should say, and why it does not. */
interface UnrecordedCheckpoint {
  patch: { seq: string; head: string; leaf: string; leafOk: boolean; signature: string; memoryHash?: string };
  bundle?: LoopStepSummary["bundle"];
  error: string;
}

const SCHEDULER_KEY = Symbol.for("lath.loopScheduler");

export function scheduler(): Scheduler {
  const g = globalThis as any;
  if (!g[SCHEDULER_KEY]) {
    g[SCHEDULER_KEY] = {
      timers: new Map(),
      inFlight: new Set(),
      ticking: new Set(),
      hydrated: false,
      epochStores: new Map(),
      halted: new Set(),
      channels: new Map(),
      idle: new Map(),
      settles: new Map(),
      tempoServices: new Map(),
      revoking: new Set(),
      revokeRetries: new Map(),
      keyReadFailures: new Map(),
      stopRetries: new Map(),
      unrecordedCheckpoints: new Map(),
      lifecycleRuns: new Map(),
      lifecycleAgain: new Set(),
      lifecycleTried: new Map(),
      lifecycleLanded: new Map(),
      lifecycleScanAt: 0,
    } as Scheduler;
  }
  const s = g[SCHEDULER_KEY] as Scheduler;
  // The singleton may predate these fields in a hot-reloaded dev server.
  s.ticking ??= new Set();
  s.epochStores ??= new Map();
  s.halted ??= new Set();
  s.channels ??= new Map();
  s.idle ??= new Map();
  s.settles ??= new Map();
  s.tempoServices ??= new Map();
  s.revoking ??= new Set();
  s.revokeRetries ??= new Map();
  s.keyReadFailures ??= new Map();
  s.stopRetries ??= new Map();
  s.unrecordedCheckpoints ??= new Map();
  s.lifecycleRuns ??= new Map();
  s.lifecycleAgain ??= new Set();
  s.lifecycleTried ??= new Map();
  s.lifecycleLanded ??= new Map();
  s.lifecycleScanAt ??= 0;
  return s;
}

export function cancel(id: string): void {
  const s = scheduler();
  const timer = s.timers.get(id);
  if (timer) clearTimeout(timer);
  s.timers.delete(id);
}

/**
 * The name a step of loop `id` holds the run slot under. `openLoopChannel` reads it back to tell a
 * step, which already holds the slot, from a caller that does not; every other writer of a loop's
 * chain holds it under a name of its own (`loop … settlement`, `loop … retry`), so none of them is
 * mistaken for the step.
 */
export function stepSlotHolder(id: string): string {
  return `loop ${id}`;
}

/**
 * `withRunSlot`, asked again every `SLOT_POLL_MS` while something else holds the slot, for up to
 * `waitMs`; `"busy"` if it is still taken then. `waitMs = 0` asks once.
 *
 * For a write that has to happen but has no tick of its own to come back on — a stopped run's
 * settlement, a start's sources cell. Never called by anything that holds the slot: the slot is
 * not re-entrant, and a caller that held it would wait out `waitMs` on itself.
 */
export async function withRunSlotWaiting(
  holder: string,
  ttlMs: number,
  work: () => Promise<void>,
  waitMs: number
): Promise<"stepped" | "busy"> {
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await withRunSlot(holder, ttlMs, work)) === "stepped") return "stepped";
    if (Date.now() >= until) return "busy";
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SLOT_POLL_MS);
      timer.unref?.();
    });
  }
}

/** How often a writer waiting for the run slot asks for it again. */
const SLOT_POLL_MS = 250;

/**
 * `work` under the shared run slot, held for as long as `work` runs: `"busy"` when something else
 * holds the slot, and nothing is run.
 *
 * The TTL is a crash guard, not a deadline. `runSlotHolder` reads a lapsed TTL as *free*, and a
 * loop step can outlive `STEP_DEADLINE_MS` without anything being wrong: a step that opens several
 * sandboxes in a row, each allowed `SANDBOX_TIMEOUT_MS` (a third of the deadline), still has its
 * verify, routing and chain writes to do after them. Without a heartbeat another writer could take
 * the slot mid-step and race this step's checkpoint for the seq its leaf commits to. So the slot is
 * extended every `beatMs` while `work` has not settled, as `/api/run` extends its own
 * (`extendRunSlot`), and a holder past three deadlines is logged as wedged rather than released. A
 * process that dies takes the heartbeat with it, and the TTL then frees the slot, which is what the
 * TTL is for.
 */
export async function withRunSlot(
  holder: string,
  ttlMs: number,
  work: () => Promise<void>,
  beatMs: number = Math.max(15_000, Math.round(ttlMs / 4))
): Promise<"stepped" | "busy"> {
  const slot = acquireRunSlot(holder, ttlMs);
  if (!slot) return "busy";
  const heldFrom = Date.now();
  let running = true;
  let reportedWedged = false;
  const beat = setInterval(() => {
    const decision = extendRunSlot({ workRunning: running, heldMs: Date.now() - heldFrom, limitMs: 3 * ttlMs });
    if (decision.extend) slot.extend(ttlMs);
    if (decision.wedged && !reportedWedged) {
      reportedWedged = true;
      console.error(
        `[api/loops] ${holder} has held the run slot for over ${Math.round((3 * ttlMs) / 60_000)} min and has not ` +
          "finished; the slot stays held so nothing else writes a chain beside it"
      );
    }
  }, beatMs);
  // The heartbeat must not keep a process alive that has nothing else to do.
  beat.unref?.();
  try {
    await work();
  } finally {
    running = false;
    clearInterval(beat);
    slot.release();
  }
  return "stepped";
}

/** True while this loop's step is running in this process. */
export function isStepping(id: string): boolean {
  return scheduler().inFlight.has(id);
}

/**
 * Whether the page should say a step is running. This process's in-flight set first; then the
 * record's `steppingSince`, which is what survives a restart mid-step (`loop-stage.ts`) — but only
 * on a running run. A stopped run never steps again and a paused one does not step until resumed,
 * so a marker a crashed process left on either would say *running* until something cleared it; a
 * pause or stop while a step is in flight in this process is still stepping, and `isStepping` says
 * so.
 */
export function steppingNow(loop: Pick<LoopRecord, "id" | "status" | "steppingSince">): boolean {
  return isStepping(loop.id) || (!!loop.steppingSince && loop.status === "running");
}
