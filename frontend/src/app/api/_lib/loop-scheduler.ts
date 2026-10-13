/**
 * The scheduler's clock (`_lib/loops.ts` re-exports it): `syncScheduler` puts a timer on every
 * running loop that has none, a tick takes the run slot and runs one step (`loop-step.ts`), and a
 * step that failed is written down. The owner's operations on a loop's status — start, pause,
 * resume, archive, unarchive — are here too. Its state is `loop-state.ts`.
 */
import { endStepStage } from "./loop-stage";
import { removedFeatureStop, roadmapResumeRefusal } from "./roadmap";
import {
  type LifecycleActorContext,
  type LoopStartOrigin,
  REBUILT_REFUSAL,
  freshLifecycle,
  lifecycleOn,
  loopStartEntry,
} from "./lifecycle";
import {
  errorText,
  grantsRefusal,
  LoopRefused,
  refusalReason,
  SLOT_RETRY_MS,
  STEP_DEADLINE_MS,
  teamRunRefusal,
  traceAuditResumeRefusal,
} from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { loopBudgetSpent } from "./loop-budget";
import { cancel, scheduler, stepSlotHolder, withRunSlot } from "./loop-state";
import {
  lifecycleBeforeStep,
  readLoop,
  readLoops,
  recordLoop,
  retryOwedLifecycle,
  updateLoop,
  withTransitionActor,
} from "./loop-registry";
import { discardFetchedSources } from "./loop-sandbox";
import { publishOwedReceipts } from "./loop-receipt";
import type { LoopChannelHooks } from "./loop-channel-state";
import { abandonLoopKey, revokeAfterStop, sweepLoopKeys } from "./loop-key";
import { afterLoopStep, settleLoopChannel, stopLoop } from "./loop-channel";
import { runOneStep, stopForBudget, stopIfKeyExpiring, stopIfTraceAudited, stopTeamRun } from "./loop-step";
import { rebuildFromChainOnce } from "./loop-rebuild";
import { loopRunRefusal } from "./loop-request";

/**
 * Puts a timer on every running loop that has none. Called from every `/api/loops` request, so a
 * server that restarted picks its loops up the first time anyone looks at them — there is no
 * background process here, and a loop whose console is never opened simply waits.
 */
export function syncScheduler(): void {
  try {
    syncSchedulerOnce();
  } catch (e) {
    // A registry that cannot be read schedules nothing and is said in the log: this runs at the
    // top of every `/api/loops` request, and the route's own read answers the caller with the
    // reason. `hydrated` is still false, so the next request makes the first pass again.
    console.error(`[loops] the scheduler could not read the registry: ${(e as any)?.message ?? e}`);
  }
}

function syncSchedulerOnce(): void {
  const s = scheduler();
  // The first pass of this process is the console start: every stopped loop whose key a failed
  // revoke, or a process that died first, left authorized is revoked now, and a failure goes on the
  // backoff. Only keys with a row here, since a key directory can be shared with another trace
  // store. A key file with no row — a start that died between its authorize and its record — is
  // swept by nothing at present: `sweepLoopKeys({ orphans: true })` exists for it but is called
  // only by a suite. A start whose record write throws lets its keys go itself (`startLoop`).
  if (!s.hydrated && Object.values(readLoops()).some((l) => l.tempoKey)) void sweepLoopKeys();
  // And every goal-reached loop whose receipt a failed publish, or a process that died first, left owed.
  if (!s.hydrated && Object.values(readLoops()).some((l) => l.receipt)) void publishOwedReceipts();
  // And the lists this console lost, from the chain (`rebuildFromChain`): only the rows it has no
  // copy of are added, so on a console whose files are intact this reads and adds nothing.
  if (!s.hydrated) rebuildFromChainOnce();
  s.hydrated = true;
  retryOwedLifecycle();
  for (const loop of Object.values(readLoops())) {
    // A rebuilt row is the chain's account of a loop another console ran: nothing here steps it.
    if (loop.status !== "running" || s.halted.has(loop.id) || loop.lifecycle?.rebuilt) {
      cancel(loop.id);
      continue;
    }
    if (s.timers.has(loop.id) || s.inFlight.has(loop.id) || s.ticking.has(loop.id)) continue;
    schedule(loop.id, Math.max(0, (loop.nextStepAt ?? Date.now()) - Date.now()));
  }
}

export function schedule(id: string, delayMs: number): void {
  const s = scheduler();
  cancel(id);
  const timer = setTimeout(() => {
    s.timers.delete(id);
    void tick(id);
  }, Math.max(0, delayMs));
  // A pending step must not hold the process open on its own; the server outlives it either way.
  timer.unref?.();
  s.timers.set(id, timer);
}

/**
 * One scheduled step: take the shared run slot so nothing else writes a chain meanwhile, run it,
 * write the outcome down, and schedule the next one. Every failure path ends with either a
 * rescheduled loop or a stopped one — never a loop that is "running" with no timer behind it.
 */
async function tick(id: string): Promise<void> {
  const s = scheduler();
  // A tick already running for this loop owns its next timer; a second one would only double it.
  if (s.ticking.has(id)) return;
  s.ticking.add(id);
  try {
    await tickOnce(id);
  } catch (e) {
    // A registry read or write that threw (`readLoops` throws on anything but a missing file): this
    // moment failing, not the loop. A timer that fired is gone, so without one put back here a
    // running loop would sit with none behind it; the next tick reads the row again, and a halted or
    // stopped loop is not stepped by it. `void tick(...)` also has no one to reject to.
    console.error(`[api/loops] the tick for ${id} failed; trying again in ${SLOT_RETRY_MS} ms:`, e);
    if (!s.timers.has(id) && !s.halted.has(id)) schedule(id, SLOT_RETRY_MS);
  } finally {
    s.ticking.delete(id);
  }
}

async function tickOnce(id: string): Promise<void> {
  const s = scheduler();
  if (s.inFlight.has(id) || s.halted.has(id)) return;
  const loop = readLoop(id);
  if (!loop || loop.status !== "running" || loop.lifecycle?.rebuilt) return;
  // An older run started with the trace audit, before any trigger's branch spends anything.
  if (stopIfTraceAudited(id, loop)) return;
  if (loop.snapshot.steps >= loop.maxSteps) {
    updateLoop(id, (l) => ({ ...l, status: "stopped", stopReason: "max-steps", nextStepAt: undefined }));
    // The run is over without a step being taken, so nothing else will settle its channel.
    void settleLoopChannel(id, "max-steps");
    return;
  }
  // An older row started with a team (`teamRunRefusal`) is stopped here, before any trigger's
  // branch and before anything is funded or spent: this build cannot take its steps.
  if (stopTeamRun(id, loop)) return;
  // An older row started on a gate or an oracle trigger is stopped here, before anything is funded,
  // asked or spent: this build has no write side for either, and stepping it on the clock would run
  // a loop whose signed terms named another trigger (`removedFeatureStop`). The stop settles its
  // channel and writes its `loop.stop` like any other; its chain still verifies.
  const removed = removedFeatureStop(loop);
  if (removed) {
    stopLoop(id, "error", {}, removed);
    return;
  }
  // The same for a spent budget.
  if (loopBudgetSpent(loop)) {
    stopForBudget(id);
    return;
  }
  // And a loop whose access key expires before another step and its channel's close could finish.
  if (stopIfKeyExpiring(id, loop)) return;

  if ((await stepNow(id)) === "busy") {
    // A session (or another loop) is writing. Wait rather than queue: the next step is late,
    // which is honest, and the interval is a schedule rather than a promise.
    schedule(id, SLOT_RETRY_MS);
    return;
  }

  const after = readLoop(id);
  if (after?.status === "running") schedule(id, after.intervalMs);
  else cancel(id);
}

/**
 * One step under the shared run slot, with the outcome written down: the body of a tick. `"busy"`
 * means something else is writing a chain and no step was taken — the caller waits it out.
 *
 * Every failure path ends with the loop either rescheduled or stopped by its caller, never
 * "running" with no timer behind it.
 */
async function stepNow(id: string): Promise<"stepped" | "busy"> {
  const s = scheduler();
  let waiting = false;
  const ran = await withRunSlot(stepSlotHolder(id), STEP_DEADLINE_MS, async () => {
    s.inFlight.add(id);
    try {
      // A run that carries the trace audit takes no step here, whichever door reached it, and pays no
      // lifecycle record on the way (`stopIfTraceAudited`).
      const current = readLoop(id);
      if (current && stopIfTraceAudited(id, current)) return;
      // What the row owes the chain first — its `loop.start` before its first step, a resume before
      // the step after it — under this same slot, so nothing lands between them. Still owed means no
      // step this tick: `busy`, which reschedules it. A refusal (no key, no agent, a chain this runtime
      // does not operate) is the loop's own end, as it would have been at the step's first read.
      waiting = await lifecycleBeforeStep(id);
      if (waiting) return;
      await runOneStep(id);
    } catch (e: any) {
      console.error(`[api/loops] step failed for ${id}:`, e);
      afterStepFailure(id, e);
    } finally {
      s.inFlight.delete(id);
      endStepStage(id);
    }
  });
  return waiting ? "busy" : ran;
}

/**
 * What a step that threw leaves behind: the reason on the row, and the channel either settled or
 * armed to settle.
 *
 * A refusal is about the loop itself, so it stops the run and settles the channel — a stop that
 * never went through `stopLoop`, of a run whose agent was undeployed under it and still holds the
 * deposit its earlier steps opened. Anything else is about this moment: the run stays running
 * and the next tick tries again.
 *
 * That second branch does more than write the detail. `openLoopChannel` takes the idle timer off
 * when a step starts and `afterLoopStep` puts it back when the step ends — so a step that threw
 * and never reached `afterLoopStep` would leave a run paused after a failed step holding its
 * channel with no timer behind it, and the deposit out until something stopped the run. It goes
 * through `afterLoopStep`, which is also what settles a channel an unbilled step was kept off.
 *
 * Out of `stepNow` so a test can hand it a failure without a cluster to fail against.
 */
export function afterStepFailure(id: string, e: unknown, hooks: LoopChannelHooks = {}): void {
  const detail = (e as any)?.message ?? String(e);
  if (e instanceof LoopRefused) {
    // `error`, or the key's own reason when the refusal was the loop's access key's (`LoopKeyStopped`).
    const reason = refusalReason(e);
    // Each in its own `try`: a stop write the registry refused must not also cost the channel's
    // settle, which holds the operator's deposit. A stop that could not
    // be written is tried again on a timer (`writeStopLater`), since nothing else will: a loop halted
    // here is never ticked again, and its row would otherwise read `running` for good.
    try {
      writeRefusedStop(id, reason, detail);
    } catch (err) {
      console.error(`[loops] ${id}: the stop on ${reason} was not written (${errorText(err)}); trying again`);
      writeStopLater(id, reason, detail, hooks);
    }
    // Never throws. On a row the stop could not reach the settle still closes the channel; the revoke
    // and sweep behind it then find the run still `running` and wait for the stop's own settle.
    void settleLoopChannel(id, reason, hooks);
    return;
  }
  try {
    updateLoop(id, (l) => ({ ...l, stopDetail: detail }));
  } catch (err) {
    console.warn(`[loops] ${id}: the failed step's detail was not written: ${errorText(err)}`);
  }
  try {
    afterLoopStep(id, hooks);
  } catch (err) {
    // The registry write inside it is what can throw, and the step has already failed: the
    // channel is still held in this process and the next step that ends puts the timer back.
    console.warn(`[loops] the channel of ${id} was not re-armed after a failed step: ${(err as any)?.message ?? err}`);
  }
}

/** The row a refused step leaves: stopped on `reason`, with the refusal as its detail. */
function writeRefusedStop(id: string, reason: string, detail: string): void {
  updateLoop(id, (l) => ({ ...l, status: "stopped", stopReason: reason, stopDetail: detail, nextStepAt: undefined }));
}

/**
 * `writeRefusedStop`, again every `SLOT_RETRY_MS` until the registry takes it, then the settle a stop
 * fires (its channel, then the key's revoke and the Solana key's sweep, which waited on the row saying
 * `stopped`). One timer per loop; a stop someone else wrote meanwhile (the owner's Stop) is left as it is.
 */
function writeStopLater(id: string, reason: string, detail: string, hooks: LoopChannelHooks): void {
  const s = scheduler();
  if (s.stopRetries.has(id)) return;
  const timer = setTimeout(() => {
    s.stopRetries.delete(id);
    try {
      if (readLoop(id)?.status !== "stopped") writeRefusedStop(id, reason, detail);
    } catch (e) {
      console.error(`[loops] ${id}: the stop on ${reason} is still not written (${errorText(e)}); trying again`);
      writeStopLater(id, reason, detail, hooks);
      return;
    }
    void settleLoopChannel(id, reason, hooks);
  }, SLOT_RETRY_MS);
  timer.unref?.();
  s.stopRetries.set(id, timer);
}

/**
 * Starts a loop now: the first step is immediate, so a console shows one straight away.
 *
 * A record the registry will not take (`recordLoop` throws on a `loops.json` it cannot read) is a
 * start that never happened, after the prepare already authorized its Tempo key, funded its Solana key
 * and fetched its sources. Nothing else knows about them — the revoke and the sweep work from rows,
 * and there is no row — so they are let go here, as `planPreparedStart` lets them go on a refused
 * plan, and the throw goes on to the route. A template the start minted stays; it is a record the
 * owner can see, not something that costs anyone while it sits.
 */
export function startLoop(loop: LoopRecord, home?: string, origin?: LoopStartOrigin): void {
  try {
    // The `loop.start` this run owes its agent's chain, built now from the row and the signature the
    // route checked (or the deploy transaction that carried it): its first step pays it before
    // anything else (`lifecycleBeforeStep`), so no step of the loop is on chain before its start.
    const owed = lifecycleOn() ? { lifecycle: freshLifecycle([loopStartEntry(loop, origin)]) } : {};
    recordLoop({ ...loop, ...owed, status: "running", nextStepAt: Date.now() });
  } catch (e) {
    if (loop.sandbox) {
      try {
        discardFetchedSources(loop.id, home);
      } catch (err) {
        console.warn(
          `[loops] ${loop.id}: the fetched sources of a start that was not recorded stay: ${errorText(err)}`
        );
      }
    }
    if (loop.tempoKey) abandonLoopKey(loop.tempoKey);
    throw e;
  }
  schedule(loop.id, 0);
}

export function pauseLoop(id: string, actor?: LifecycleActorContext): LoopRecord | null {
  // A rebuilt row is not this console's to pause (`REBUILT_REFUSAL`); the route says so first.
  if (readLoop(id)?.lifecycle?.rebuilt) return readLoop(id);
  cancel(id);
  return withTransitionActor(actor, () =>
    updateLoop(id, (l) => (l.status === "running" ? { ...l, status: "paused", nextStepAt: undefined } : l))
  );
}

/**
 * Why `loop` cannot resume now, or `null`: what its own record says (paused, steps and budget
 * left), then the start's rules on its agent and its wallet (`loopRunRefusal`). The route asks it
 * before it charges the command counter, and `resumeLoop` again before it writes.
 */
export function resumeRefusal(loop: LoopRecord): string | null {
  if (loop.lifecycle?.rebuilt) return REBUILT_REFUSAL;
  if (loop.status !== "paused" || loop.snapshot.steps >= loop.maxSteps) {
    return "this loop cannot resume: it is stopped or has taken all its steps";
  }
  // A spent budget is the same kind of end: it could take no step, and its first tick would stop
  // it.
  if (loopBudgetSpent(loop)) return "this loop cannot resume: its budget is spent";
  // A run its own last step stopped, on an older row that kept a pause over that stop: resuming
  // would step past the stop, and on `anchor-failed` past what Retry owes.
  if (loop.snapshot.status === "stopped") {
    return `this loop cannot resume: its last step stopped it (${loop.snapshot.stopReason ?? "stopped"})`;
  }
  // A row paused while it ran a team: not in this build (`teamRunRefusal`).
  const team = teamRunRefusal(loop);
  if (team) return `this loop cannot resume: ${team}`;
  // A row paused while it ran the trace audit, a gate or an oracle trigger, or an older row started
  // with protocol-plugin grants (`grantsRefusal`): none of them is in this build, so it does not
  // step one on any console. Asked after the row's own reasons, so a loop that could not resume
  // anyway still says why in its own words.
  const roadmap = traceAuditResumeRefusal(loop) ?? grantsRefusal(loop, "resume") ?? roadmapResumeRefusal(loop);
  if (roadmap) return roadmap;
  const busy = loopRunRefusal(loop.agentId, loop.agentName, loop.owner, { except: loop.id });
  return busy ? `this loop cannot resume: ${busy.error}` : null;
}

export function resumeLoop(id: string, actor?: LifecycleActorContext): LoopRecord | null {
  const before = readLoop(id);
  if (!before) return null;
  // Asked and written with no await between, so no start or resume can land in between: a refused
  // resume leaves the row as it was, paused.
  if (resumeRefusal(before)) return before;
  const loop = withTransitionActor(actor, () =>
    updateLoop(id, (l) =>
      l.status === "paused" ? { ...l, status: "running", stopDetail: undefined, nextStepAt: Date.now() } : l
    )
  );
  if (loop?.status === "running") schedule(id, 0);
  return loop;
}

/**
 * Archives a run: stops it first — running or paused — then stamps `archivedAt`. Archive is not
 * deletion — the record stays, so the loop page, the step history and the audit links keep
 * resolving; what changes is that the list stops carrying it. A step already in flight finishes and
 * writes its checkpoint, as it does for `stopLoop`.
 */
export function archiveLoop(
  id: string,
  at: number = Date.now(),
  hooks: LoopChannelHooks = {},
  actor?: LifecycleActorContext
): LoopRecord | null {
  const current = readLoop(id);
  if (!current) return null;
  // A *paused* run is stopped too. Pause is a state the run can leave on its own — the loop page
  // keeps a Resume button, and `resumeLoop` schedules the next step — so archiving one and leaving
  // it paused would leave a run that could start again while every list hid it.
  if (current.status === "running" || current.status === "paused") {
    stopLoop(id, "archived", hooks, undefined, actor);
  }
  const archived = updateLoop(id, (l) => ({ ...l, archivedAt: l.archivedAt ?? at }));
  // An archive ends a run a Retry could have resumed (`keyStillNeeded`), so a key it kept goes now.
  // A run this archive stopped is revoked by its settle instead, after the close.
  if (archived?.tempoKey && current.status === "stopped") void revokeAfterStop(id);
  return archived;
}

/**
 * Takes the stamp off, so the run is in the lists again.
 *
 * Archive is *not deletion*, so it has an inverse: without one, a single click would stop a running
 * loop, hide it from every list, and then disable the button that did it — a delete by another
 * name. The key is removed rather than set to a sentinel, so the *stamp* round-trips exactly:
 * nothing downstream has to know the difference between absent and unset. The record as a whole
 * does not, for a run that was **running** when it was archived — `archiveLoop` stops that one
 * first, and unarchive does not put steps back on the clock (below), so `status`, `stopReason` and
 * `nextStepAt` stay where the stop left them.
 *
 * The run is **not** restarted. Archiving stopped it, and a run is produced once and never revived
 * — *Run again* is how a stopped run gets a successor, with its own id and its own history.
 * Un-archiving puts the record back in front of the person; it does not put steps back on the
 * clock.
 */
export function unarchiveLoop(id: string): LoopRecord | null {
  return updateLoop(id, ({ archivedAt, ...rest }) => rest);
}
