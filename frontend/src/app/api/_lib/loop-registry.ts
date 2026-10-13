/**
 * The loop registry, `LATH_TRACE_DIR/loops.json` (`_lib/loops.ts` re-exports it): reading it row by
 * row, the atomic write, and `updateLoop`, the one read-modify-write every change of a row goes
 * through.
 *
 * The lifecycle records a row's transitions owe are here too, because `updateLoop` is where a
 * transition is seen and where its payer is kicked, and the payer writes its ref back through
 * `updateLoop`: one cycle of calls, kept inside one module. The row's shape is `loop-record.ts`.
 */
import * as path from "path";
import type { SignedMessage } from "@lath/sdk";
import type { LoopSandboxRecord, LifecycleRef } from "../../../types/loop";
import { readJsonOr, writeJsonAtomic } from "./json-store";
import { type DeployedAgent, TRACE_DIR, lookupAgent, readRegistry, updateAgent } from "./runner";
import {
  type LifecycleActorContext,
  LifecycleRefused,
  type LifecycleState,
  type LifecycleWriter,
  type OwedLifecycle,
  agentDeployEntry,
  agentMarkEntry,
  freshLifecycle,
  lifecycleOn,
  transitionOwed,
  withOwed,
  writeLifecycle,
} from "./lifecycle";
import { errorText, LoopRefused, STEP_DEADLINE_MS, triggerOf } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { withBudgetKeys } from "./loop-budget";
import { scheduler, SETTLE_SLOT_WAIT_MS, withRunSlotWaiting } from "./loop-state";

export const REGISTRY = () => path.join(TRACE_DIR, "loops.json");

/**
 * A stored record is a `LoopRecord` only if it has the keys the current code reads. An older record
 * keyed differently (`maxWakes`, `budgetMicroUsdcPerWake`) is dropped here rather than cast, so a
 * stale file cannot reach `BigInt(undefined)` on the loop page or `undefined / undefined` in the
 * list. Dropped ids are logged once per process.
 */
function isLoopRecord(v: unknown): v is LoopRecord {
  // Only the keys the current code reads without a fallback are required. `template` and
  // `archivedAt` are not among them: older rows carry neither, and dropping those rows would hide
  // loops whose steps are on chain.
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.agentId === "string" &&
    typeof r.owner === "string" &&
    typeof r.prompt === "string" &&
    typeof r.intervalMs === "number" &&
    typeof r.maxSteps === "number" &&
    // Either key: every row carries the per-step one, and a row carrying only the whole budget is
    // still one the shim below can complete rather than a row to drop.
    (typeof r.budgetMicroUsdcPerStep === "string" || typeof r.budgetMicroUsdc === "string") &&
    (r.status === "running" || r.status === "paused" || r.status === "stopped") &&
    !!r.snapshot &&
    typeof r.snapshot === "object" &&
    typeof (r.snapshot as Record<string, unknown>).steps === "number" &&
    Array.isArray(r.history)
  );
}

const droppedLoops = new Set<string>();

/**
 * The rows `readLoops` could not read, verbatim, keyed by the map it returned them beside. Dropping
 * a row from the answer is one thing; dropping it from the disk is another, and the next
 * `recordLoop`/`updateLoop` would do the second by writing back only the rows it had read — which
 * would erase an older row or a hand edit in a shape this code does not read, and with it whatever
 * that row alone recorded — a live key whose funds only its row pointed at. Kept aside here and
 * merged back by `writeLoops`, so a row this build cannot read is left as it was.
 */
const unreadRows = new WeakMap<object, Record<string, unknown>>();

/**
 * An older row keeps its sandbox under `room`. Moved here, on the read, so nothing past it knows
 * the old name; the next write of the row stores it as `sandbox`. The row is not hashed, so moving
 * the key changes no commitment.
 */
function withSandboxKey(rec: LoopRecord): LoopRecord {
  const { room, ...rest } = rec as LoopRecord & { room?: LoopSandboxRecord };
  return room && !rest.sandbox ? { ...rest, sandbox: room } : (rest as LoopRecord);
}

/**
 * The registry, row by row. Only a missing `loops.json` is an empty registry (`readJsonOr`, the
 * rule `_lib/json-store.ts` states for `agents.json`): any other read error, a file that is not
 * JSON or one that is not an object throws. Answering `{}` to every failure would be worse than the
 * error — a start's `recordLoop` would write its one row over every other loop, and the write that
 * records a step already on chain would find no row, return `null` without throwing, and so never
 * reach the catch that halts the loop before the same index is run again.
 */
export function readLoops(): Record<string, LoopRecord> {
  const parsed = readJsonOr<unknown>(REGISTRY(), () => ({}));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${REGISTRY()} is not a map of loop records`);
  }
  const out: Record<string, LoopRecord> = {};
  const unread: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    // `JSON.parse` makes `__proto__` an own key, but assigning it below would set `out`'s prototype
    // rather than add a row. No minted id is spelled so (`mintLoopId`), so such a key is dropped.
    if (id === "__proto__") continue;
    // Each row in its own `try`: a shim that throws on one malformed row drops that row alone,
    // rather than the whole registry, which the next write would then save over every other loop.
    let read: LoopRecord | null = null;
    try {
      read = isLoopRecord(rec) ? withBudgetKeys(withSandboxKey(rec)) : null;
    } catch {
      read = null;
    }
    if (read) out[id] = read;
    else {
      unread[id] = rec;
      if (!droppedLoops.has(id)) {
        droppedLoops.add(id);
        console.warn(`[loops] ${id} in loops.json lacks the current keys (an older row?); not read, and kept as it is`);
      }
    }
  }
  if (Object.keys(unread).length > 0) unreadRows.set(out, unread);
  return out;
}

/**
 * One row of the registry by id, or `null`. An own-property lookup, because the id is often a
 * caller's (`GET /api/loops?id=`, `/api/zeroclaw/<loopId>`): a plain index answered `__proto__` with
 * `Object.prototype` and `constructor` with `Object`, which every reader then treated as a loop.
 */
export function registryRow<T>(all: Record<string, T>, id: string): T | null {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
}

export function readLoop(id: string): LoopRecord | null {
  return registryRow(readLoops(), id);
}

/**
 * Atomic: write beside the file and rename (`writeJsonAtomic`), so a crash never leaves half a registry.
 * The rows `readLoops` could not read go back as they were (`unreadRows`); a row the caller holds
 * under the same id wins, since it was written by this build. `__proto__` never reaches either map.
 */
function writeLoops(all: Record<string, LoopRecord>): void {
  const unread = unreadRows.get(all);
  writeJsonAtomic(REGISTRY(), unread ? { ...unread, ...all } : all);
}

/** Throws, and writes nothing, when the registry cannot be read (`readLoops`). */
export function recordLoop(loop: LoopRecord): void {
  const all = readLoops();
  all[loop.id] = loop;
  writeLoops(all);
}

/**
 * Read-modify-write of one loop. Every mutation goes through here rather than holding a record
 * across an await: a step takes minutes, and a pause that arrived meanwhile must not be undone
 * by the step writing back the record it started with.
 */
export function updateLoop(id: string, change: (loop: LoopRecord) => LoopRecord): LoopRecord | null {
  const all = readLoops();
  const current = registryRow(all, id);
  if (!current) return null;
  const next = owingTransition(current, change(current));
  all[id] = next;
  writeLoops(all);
  // A newly owed entry is the last one, and a different one from before (a stop that replaced a stop
  // still owed included); the payer only ever takes entries off the front.
  const owedNow = next.lifecycle?.owed.at(-1);
  if (owedNow && owedNow.id !== current.lifecycle?.owed.at(-1)?.id) afterTransitionOwed(next);
  return next;
}

/**
 * Who is making the transition `updateLoop` is about to write, while a caller that knows says so
 * (`withTransitionActor`): the owner with the signature the route verified, or nobody, which the
 * record names `console`. Module state, set and cleared around a synchronous call, because
 * `updateLoop` and every `change` it runs are synchronous: no other write can interleave.
 */
let transitionActor: LifecycleActorContext | null = null;

/** `work` with `actor` as the author of every transition it writes. */
export function withTransitionActor<T>(actor: LifecycleActorContext | undefined, work: () => T): T {
  if (!actor) return work();
  const before = transitionActor;
  transitionActor = actor;
  try {
    return work();
  } finally {
    transitionActor = before;
  }
}

/**
 * The one place every change of a loop's status is seen: whatever wrote it — the owner's pause, a
 * step's goal, a budget, a refusal, a Retry — goes through `updateLoop`, so the record it owes is
 * decided here, from the row before and after, and nobody has to remember to owe it. Only a row
 * that carries a lifecycle (started with the switch on) owes anything, and never a rebuilt one.
 */
function owingTransition(current: LoopRecord, next: LoopRecord): LoopRecord {
  const state = next.lifecycle;
  if (!state || state.rebuilt || !lifecycleOn()) return next;
  // A change that rewrote the lifecycle itself (the payer recording a ref) is not a transition.
  if (state !== current.lifecycle) return next;
  const entry = transitionOwed(current, next, transitionActor);
  return entry ? { ...next, lifecycle: withOwed(state, entry) } : next;
}

/**
 * What a newly owed transition sets going. A run that is not running is paid now, under the slot
 * when it is free (a pause mid-step waits for the step); a running one is paid by its next step,
 * which pays what its row owes before anything else (`lifecycleBeforeStep`) — kicking that too would
 * only race the tick for the slot and push the step back. Deferred a turn, so the write that owed it
 * is on disk before the payer reads it.
 */
function afterTransitionOwed(next: LoopRecord): void {
  scheduler().lifecycleTried.set(`loop:${next.id}`, Date.now());
  if (next.status === "running") return;
  const timer = setTimeout(() => kickLifecycle(next.id), 0);
  timer.unref?.();
}

// ─── Lifecycle records (`_lib/lifecycle.ts`) ────────────────────────────────
//
// What a row owes its agent's chain — a loop's start, pause, resume and stop, an agent's deploy and
// archive marks — is written here, in order, under the run slot. The documents were built when the
// decision was made (`startLoop`, `owingTransition`, `oweAgentLifecycle`); this only writes them. A
// write that fails leaves its entry owed with the reason on the row, and the next pass — the step's,
// the settle's, a Retry's, or `syncScheduler`'s on a rate — tries again.

/** The writer, swappable by a suite: nothing under `tests/` may write a chain. */
const DEFAULT_LIFECYCLE_WRITER: LifecycleWriter = (target, entry) => writeLifecycle(target, entry);

let lifecycleWriter: LifecycleWriter = DEFAULT_LIFECYCLE_WRITER;

export function setLifecycleWriterForTests(writer: LifecycleWriter | null): void {
  lifecycleWriter = writer ?? DEFAULT_LIFECYCLE_WRITER;
}

/** How often a subject's owed records are tried again by `syncScheduler`, and how often it looks. */
const LIFECYCLE_RETRY_MS = 60_000;

const LIFECYCLE_SCAN_MS = 30_000;

/** The start of the `stopDetail` a running loop carries while its next step waits on an owed record. */
export const LIFECYCLE_WAITING_DETAIL = "waiting for this loop's ";

/** What one pass of a payer did. `refused` is a failure no retry fixes (`LifecycleRefused`). */
export interface LifecyclePaid {
  status: "none" | "paid" | "owed" | "held";
  error?: string;
  refused?: boolean;
}

/**
 * Why a loop's owed records may not be written now, or `null`. A step whose writes did not land owes
 * its `loop.step` checkpoint, whose leaf commits to the head at seq − 1 of the Resolution before it:
 * a record written ahead of that checkpoint would land between the two, so it waits for the Retry
 * that lands them, exactly as an owed settlement waits (`payOwedSettlement`). A Discard still
 * unfinished is the same doubt about what the journal holds.
 */
function lifecycleHeld(loop: LoopRecord): string | null {
  if (loop.history.some((h) => h.deferredCheckpoint))
    return "a step's checkpoint is still owed, and Retry writes it first";
  if (loop.discardingAt !== undefined) return "a Discard of this run's journal has not finished";
  return null;
}

/** `state` once `entryId` is on chain as `ref`: the ref recorded, the entry and the last error gone. */
function lifecycleRecorded(state: LifecycleState, entryId: string, ref: LifecycleRef): LifecycleState {
  const { error: _error, ...rest } = state;
  return { ...rest, records: [...state.records, ref], owed: state.owed.filter((o) => o.id !== entryId) };
}

/**
 * One owed entry written, or why not. A record that landed in an earlier pass whose row would not
 * take its ref (`lifecycleLanded`) is not written again: a second record of one decision would read
 * as a second transition.
 */
async function payLifecycleEntry(
  target: { agentId: string; name: string },
  entry: OwedLifecycle
): Promise<{ ref: LifecycleRef } | { error: string; refused: boolean }> {
  const landed = scheduler().lifecycleLanded.get(entry.id);
  if (landed) return { ref: landed };
  try {
    return { ref: await lifecycleWriter(target, entry) };
  } catch (e) {
    return { error: errorText(e), refused: e instanceof LifecycleRefused };
  }
}

/**
 * Writes what loop `id` owes, in order, for a caller that holds the run slot: a step before it runs
 * (`lifecycleBeforeStep`), a settle before its record, a Retry or a Discard. The agent's own owed
 * records go first, so a deploy that carried its loop reads `agent.deploy` before `loop.start`.
 * Never throws: a failure is on the row (`lifecycle.error`) and in the answer.
 */
export async function payOwedLifecycleUnderSlot(id: string): Promise<LifecyclePaid> {
  if (!lifecycleOn()) return { status: "none" };
  const s = scheduler();
  let loop: LoopRecord | null;
  try {
    loop = readLoop(id);
  } catch (e) {
    return { status: "owed", error: `the registry could not be read: ${errorText(e)}` };
  }
  if (!loop?.lifecycle?.owed.length || loop.lifecycle.rebuilt) return { status: "none" };
  s.lifecycleTried.set(`loop:${id}`, Date.now());
  const held = lifecycleHeld(loop);
  if (held) return { status: "held", error: held };
  const agent = lookupAgent(loop.agentId);
  if (!agent) {
    const error = "the agent this loop runs is no longer deployed here, so nothing signs for its chain";
    noteLifecycleError(id, error);
    return { status: "owed", error, refused: true };
  }
  await payOwedAgentUnderSlot(loop.agentId);
  for (const entry of loop.lifecycle.owed) {
    const paid = await payLifecycleEntry({ agentId: loop.agentId, name: agent.name }, entry);
    if ("error" in paid) {
      console.warn(`[loops] ${id}: ${entry.tool} was not written: ${paid.error}; it stays owed`);
      noteLifecycleError(id, `${entry.tool}: ${paid.error}`);
      return { status: "owed", error: paid.error, refused: paid.refused };
    }
    try {
      updateLoop(id, (l) =>
        l.lifecycle ? { ...l, lifecycle: lifecycleRecorded(l.lifecycle, entry.id, paid.ref) } : l
      );
      s.lifecycleLanded.delete(entry.id);
    } catch (e) {
      s.lifecycleLanded.set(entry.id, paid.ref);
      console.error(
        `[loops] ${id}: ${entry.tool} landed at seq ${paid.ref.seq} (${paid.ref.signature}) but its row could not ` +
          `be written (${errorText(e)}); the next pass records it without writing it again`
      );
      return { status: "owed", error: errorText(e) };
    }
  }
  return { status: "paid" };
}

function noteLifecycleError(id: string, error: string): void {
  try {
    updateLoop(id, (l) => (l.lifecycle ? { ...l, lifecycle: { ...l.lifecycle, error } } : l));
  } catch (e) {
    console.warn(`[loops] ${id}: the lifecycle error was not written: ${errorText(e)}`);
  }
}

/**
 * The step's half: what the row owes, paid before the step writes anything, under the step's slot.
 * `true` means something is still owed and the step must not run — the tick is skipped, with the
 * reason as the row's `stopDetail`, and rescheduled; the loop is not stopped, since a write that
 * failed now is retried next tick. A refusal no retry fixes throws `LoopRefused`, which stops the run
 * as the step's own first read would have.
 */
export async function lifecycleBeforeStep(id: string): Promise<boolean> {
  if (!lifecycleOn()) return false;
  const loop = readLoop(id);
  if (!loop?.lifecycle?.owed.length) {
    if (loop) clearLifecycleWaiting(loop);
    return false;
  }
  const paid = await payOwedLifecycleUnderSlot(id);
  if (paid.status === "paid" || paid.status === "none") {
    const after = readLoop(id);
    if (after) clearLifecycleWaiting(after);
    return false;
  }
  if (paid.refused) throw new LoopRefused(`the loop's lifecycle record cannot be written: ${paid.error}`);
  const tool = readLoop(id)?.lifecycle?.owed[0]?.tool ?? "lifecycle";
  const detail =
    `${LIFECYCLE_WAITING_DETAIL}${tool} record on Solana before its next step (${paid.error ?? "not written"}); ` +
    "it is tried again shortly";
  try {
    updateLoop(id, (l) => ({ ...l, stopDetail: detail }));
  } catch (e) {
    console.warn(`[loops] ${id}: the waiting detail was not written: ${errorText(e)}`);
  }
  return true;
}

function clearLifecycleWaiting(loop: LoopRecord): void {
  if (!loop.stopDetail?.startsWith(LIFECYCLE_WAITING_DETAIL)) return;
  try {
    updateLoop(loop.id, (l) =>
      l.stopDetail?.startsWith(LIFECYCLE_WAITING_DETAIL) ? { ...l, stopDetail: undefined } : l
    );
  } catch (e) {
    console.warn(`[loops] ${loop.id}: the waiting detail was not cleared: ${errorText(e)}`);
  }
}

/**
 * `payOwedLifecycleUnderSlot` for a caller that does not hold the slot: it waits for it, out a step in
 * flight and whoever else holds it, as a stop's settle does. Never called by a holder of the slot,
 * which would wait on itself; a step owes through `afterTransitionOwed`, which only kicks this.
 */
export async function payOwedLifecycle(id: string, waitMs: number = SETTLE_SLOT_WAIT_MS): Promise<LifecyclePaid> {
  if (!lifecycleOn()) return { status: "none" };
  let paid: LifecyclePaid = { status: "none" };
  const ran = await withRunSlotWaiting(
    `loop ${id} lifecycle`,
    STEP_DEADLINE_MS,
    async () => {
      paid = await payOwedLifecycleUnderSlot(id);
    },
    waitMs
  );
  return ran === "busy" ? { status: "owed", error: "the run slot stayed taken" } : paid;
}

/** One payer per subject at a time; a kick while one runs asks it to run once more after. */
function kickPayer(key: string, run: () => Promise<unknown>): void {
  const s = scheduler();
  if (s.lifecycleRuns.has(key)) {
    s.lifecycleAgain.add(key);
    return;
  }
  const go = async (): Promise<void> => {
    try {
      await run();
    } catch (e) {
      console.warn(`[loops] the lifecycle payer for ${key} failed: ${errorText(e)}`);
    }
    if (s.lifecycleAgain.delete(key)) return go();
  };
  const done = go().finally(() => s.lifecycleRuns.delete(key));
  s.lifecycleRuns.set(key, done);
}

export function kickLifecycle(id: string): void {
  if (lifecycleOn()) kickPayer(`loop:${id}`, () => payOwedLifecycle(id));
}

export function kickAgentLifecycle(agentId: string): void {
  if (lifecycleOn()) kickPayer(`agent:${agentId}`, () => payOwedAgentLifecycle(agentId));
}

/** Every payer this process has running, settled: what a suite waits on before it reads the rows. */
export async function lifecyclePayersSettled(): Promise<void> {
  const s = scheduler();
  while (s.lifecycleRuns.size > 0) await Promise.allSettled([...s.lifecycleRuns.values()]);
}

/**
 * The retry of owed records nobody else will pay soon, from `syncScheduler`: at most every
 * `LIFECYCLE_SCAN_MS`, and each subject at most every `LIFECYCLE_RETRY_MS` after it was last decided
 * or tried. A running loop on the clock is left to its next step, which pays first.
 */
export function retryOwedLifecycle(): void {
  if (!lifecycleOn()) return;
  const s = scheduler();
  const now = Date.now();
  if (now - s.lifecycleScanAt < LIFECYCLE_SCAN_MS) return;
  s.lifecycleScanAt = now;
  const due = (key: string) => now - (s.lifecycleTried.get(key) ?? 0) >= LIFECYCLE_RETRY_MS;
  for (const loop of Object.values(readLoops())) {
    if (!loop.lifecycle?.owed.length || loop.lifecycle.rebuilt || s.inFlight.has(loop.id)) continue;
    if (loop.status === "running" && triggerOf(loop).kind === "schedule") continue;
    if (due(`loop:${loop.id}`)) kickLifecycle(loop.id);
  }
  let agents: ReturnType<typeof readRegistry>;
  try {
    agents = readRegistry();
  } catch (e) {
    console.warn(`[loops] agents.json could not be read for owed lifecycle records: ${errorText(e)}`);
    return;
  }
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.lifecycle?.owed.length && due(`agent:${id}`)) kickAgentLifecycle(id);
  }
}

// ─── An agent's lifecycle ───────────────────────────────────────────────────

/**
 * Owes `entry` on agent `id`'s row and sets its payer going. Only a row that carries a lifecycle owes
 * an archive mark, by the rule a loop follows: an agent deployed before the records has no deploy on
 * chain for the mark to follow. A deploy always does (`oweAgentDeploy`). Never throws: a deploy that
 * landed is not failed by the record of it.
 */
export function oweAgentLifecycle(id: string, entry: OwedLifecycle, opts: { create?: boolean } = {}): void {
  if (!lifecycleOn()) return;
  try {
    const after = updateAgent(id, (a) =>
      a.lifecycle || opts.create
        ? { ...a, lifecycle: { ...(a.lifecycle ?? freshLifecycle()), owed: [...(a.lifecycle?.owed ?? []), entry] } }
        : a
    );
    if (!after?.lifecycle?.owed.some((o) => o.id === entry.id)) return;
  } catch (e) {
    console.warn(`[agents] ${id}: ${entry.tool} was not owed: ${errorText(e)}`);
    return;
  }
  scheduler().lifecycleTried.set(`agent:${id}`, Date.now());
  const timer = setTimeout(() => kickAgentLifecycle(id), 0);
  timer.unref?.();
}

/** The `agent.deploy` a recorded deploy or clone owes, with the transaction the wallet signed. */
export function oweAgentDeploy(id: string, deployTx?: string): void {
  if (!lifecycleOn()) return;
  const agent = lookupAgent(id);
  if (!agent || agent.lifecycle) return;
  oweAgentLifecycle(id, agentDeployEntry(id.toLowerCase(), agent, deployTx), { create: true });
}

/** An owner-signed archive or unarchive of agent `id`. */
export function oweAgentMark(id: string, tool: "agent.archive" | "agent.unarchive", auth?: SignedMessage): void {
  oweAgentLifecycle(id, agentMarkEntry(tool, id.toLowerCase(), auth));
}

/** `payOwedLifecycleUnderSlot` for an agent's row. Never throws. */
export async function payOwedAgentUnderSlot(agentId: string): Promise<LifecyclePaid> {
  if (!lifecycleOn()) return { status: "none" };
  const s = scheduler();
  const id = agentId.toLowerCase();
  let agent: DeployedAgent | null;
  try {
    agent = lookupAgent(id);
  } catch (e) {
    return { status: "owed", error: `agents.json could not be read: ${errorText(e)}` };
  }
  if (!agent?.lifecycle?.owed.length) return { status: "none" };
  s.lifecycleTried.set(`agent:${id}`, Date.now());
  for (const entry of agent.lifecycle.owed) {
    const paid = await payLifecycleEntry({ agentId: id, name: agent.name }, entry);
    if ("error" in paid) {
      console.warn(`[agents] ${id}: ${entry.tool} was not written: ${paid.error}; it stays owed`);
      try {
        updateAgent(id, (a) =>
          a.lifecycle ? { ...a, lifecycle: { ...a.lifecycle, error: `${entry.tool}: ${paid.error}` } } : a
        );
      } catch {
        // The error is in the log; the entry is still owed either way.
      }
      return { status: "owed", error: paid.error, refused: paid.refused };
    }
    try {
      updateAgent(id, (a) =>
        a.lifecycle ? { ...a, lifecycle: lifecycleRecorded(a.lifecycle, entry.id, paid.ref) } : a
      );
      s.lifecycleLanded.delete(entry.id);
    } catch (e) {
      s.lifecycleLanded.set(entry.id, paid.ref);
      console.error(
        `[agents] ${id}: ${entry.tool} landed at seq ${paid.ref.seq} but its row could not be written (${errorText(e)})`
      );
      return { status: "owed", error: errorText(e) };
    }
  }
  return { status: "paid" };
}

export async function payOwedAgentLifecycle(
  agentId: string,
  waitMs: number = SETTLE_SLOT_WAIT_MS
): Promise<LifecyclePaid> {
  if (!lifecycleOn()) return { status: "none" };
  let paid: LifecyclePaid = { status: "none" };
  const ran = await withRunSlotWaiting(
    `agent ${agentId} lifecycle`,
    STEP_DEADLINE_MS,
    async () => {
      paid = await payOwedAgentUnderSlot(agentId);
    },
    waitMs
  );
  return ran === "busy" ? { status: "owed", error: "the run slot stayed taken" } : paid;
}
