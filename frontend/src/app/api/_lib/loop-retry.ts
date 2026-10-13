/**
 * Retry and Discard of a run whose last checkpoint did not land (`_lib/loops.ts` re-exports it):
 * landing the owed checkpoint, locators, settlement and lifecycle records under the run slot, or
 * giving the run up, and the sentences each says on the row.
 */
import * as path from "path";
import { type Keypair, PublicKey } from "@solana/web3.js";
import {
  AgentLogger,
  BillingClient,
  type Bytes32,
  FileTraceStore,
  LathClient,
  LocatorRegistry,
  hex,
  toBytes32,
} from "@lath/sdk";
import {
  AnchorFailed,
  DiscardRefused,
  type DiscardResult,
  NoopBilling,
  writeLoopCheckpoint,
  removedPlanKeys,
  REMOVED_PLAN_KEYS,
} from "@lath/runtime";
import type { LoopStepSummary } from "../../../types/loop";
import { anchorQueue, bindAnchorChain, carriedCharges } from "./anchor";
import { sealDeferred } from "./unsealed";
import { roadmapRetryRefusal } from "./roadmap";
import { TRACE_DIR, TREASURY_ADMIN, deployedRoles, loadKeypair, lookupAgent, rpcFor, traceBackend } from "./runner";
import { type LifecycleActorContext, REBUILT_REFUSAL } from "./lifecycle";
import {
  errorText,
  GOAL_REACHED_STOP_REASON,
  grantsRefusal,
  STEP_DEADLINE_MS,
  teamRunRefusal,
  traceAuditRetryRefusal,
} from "./loop-terms";
import type { LoopDiscardRow, LoopRecord } from "./loop-record";
import { admitStepSpend, stepAdmission } from "./loop-budget";
import { scheduler, withRunSlot } from "./loop-state";
import { payOwedLifecycleUnderSlot, readLoop, updateLoop, withTransitionActor } from "./loop-registry";
import type { LoopChannelHooks } from "./loop-channel-state";
import { keyDone, revokeAfterStop } from "./loop-key";
import { epochStoreFor, savePendingAnchors } from "./loop-step-base";
import { payOwedSettlement } from "./loop-channel";
import { loopRunRefusal } from "./loop-request";
import { schedule } from "./loop-scheduler";

/** What `retryLoopAnchor` needs of the writer queue, so a test can hand it one. */
export interface LoopAnchorQueue {
  retry(agentId: Uint8Array): Promise<void>;
  drain(agentId: Uint8Array): Promise<void>;
  /** Optional so a test that only retries need not fake it; the console's queue always has it. */
  discard?(agentId: Uint8Array): Promise<DiscardResult>;
  /** What the queue still carries for a chain (`retryRefusalNow`); optional for the same reason. */
  carried?(agentId: Uint8Array): Promise<unknown[]>;
}

/**
 * *Retry the step*: put this loop's failed records back on the queue, wait for them, and — only
 * if they land — put the loop back on its schedule.
 *
 * This is the loop's half of the `FAILED` badge. It is **not**
 * *Run again*: nothing is re-run. The session that produced these records has already happened,
 * its blobs are in the trace store and its `EventInput`s are in the journal with the heads they
 * were built against; what failed is the transaction, and the queue's head check is what makes
 * resending it safe — a record that actually landed and only lost its confirmation is marked
 * verified rather than written twice (`runtime/src/anchor.ts`, rule 2). Running the session
 * again would be the duplicate that rule exists to prevent.
 *
 * A drain that rejects leaves everything as it is: the loop stays stopped, the journal keeps the
 * records, and the caller is told why. Nothing is lost by trying again later.
 *
 * The step the failure interrupted gets its checkpoint here, and only here. A leaf is a statement
 * about the chain at the moment it is taken, so the step could not build one while its own
 * records were still journaled — but once this drain lands them the chain stands exactly where
 * that step's resolution left it, which is the boundary the leaf was always meant to commit to.
 * The step wrote down everything else it needed (`DeferredCheckpoint`); this reads the chain and
 * writes the record. Only then is the memory the step produced the memory the chain names, so the
 * snapshot takes it up and the next step is the next index, over a run with no gap in it.
 */
export async function retryLoopAnchor(
  id: string,
  opts: RetryLoopAnchorOpts = {}
): Promise<{ loop: LoopRecord | null; error?: string }> {
  return underLoopSlot(id, "retry", () => retryUnderSlot(id, opts));
}

/**
 * A Retry or a Discard under the run slot, or the reason it could not have it. Each writes the loop agent's
 * chain directly — the drain, the owed checkpoints, locator cells and settlement record, or the queue's
 * re-check — and binds the chain's writer and billing to do it, so one beside a step, a session or a settlement
 * on the same agent would race it for a seq and could leave that writer's charges bound to `NoopBilling`. A
 * click that finds the slot taken is answered at once rather than queued: nothing is lost by pressing it again.
 */
async function underLoopSlot(
  id: string,
  verb: "retry" | "discard",
  work: () => Promise<{ loop: LoopRecord | null; error?: string }>
): Promise<{ loop: LoopRecord | null; error?: string }> {
  const loop = readLoop(id);
  if (!loop) return { loop: null };
  let result: { loop: LoopRecord | null; error?: string } | undefined;
  const ran = await withRunSlot(`loop ${id} ${verb}`, STEP_DEADLINE_MS, async () => {
    result = await work();
  });
  if (ran === "busy" || !result) {
    return {
      loop: readLoop(id) ?? loop,
      error: `another run is writing a chain on this console, so nothing was ${
        verb === "retry" ? "retried" : "discarded"
      }; try again in a minute`,
    };
  }
  return result;
}

interface RetryLoopAnchorOpts {
  queue?: LoopAnchorQueue;
  resume?: (id: string) => void;
  /** Writes the owed `loop.settlement` record; a test passes its own, as `LoopChannelHooks` says. */
  settle?: LoopChannelHooks["settle"];
  /** Retries a close the original settle could not make; a test passes its own. */
  closeById?: LoopChannelHooks["closeById"];
  /**
   * The chain and the logger the owed checkpoints are written through. A test that hands in its
   * own queue has no deployed agent to bind, and hands these in too; nothing is sealed on that
   * path, because a seal needs the server's trace backend. No billing backend: a checkpoint
   * charges nothing, whatever an older plan says it owed.
   */
  checkpoint?: { client: LathClient; logger: AgentLogger };
  /** The owner who asked for the Retry, with the signature the route verified (the lifecycle's `by`). */
  actor?: LifecycleActorContext;
}

/**
 * Whether `loop` is a run a step stopped, as a Retry reads it: `stopped`, or `paused` over a snapshot
 * its own last step stopped (the step's stop lost the row to a pause written just before it). `resumeRefusal`
 * refuses that paused row, so Retry is the only way forward from it.
 */
function stoppedForRetry(loop: LoopRecord): boolean {
  return loop.status === "stopped" || (loop.status === "paused" && loop.snapshot.status === "stopped");
}

/**
 * Why a Retry of `loop` is refused, or `null`. A Retry is for a run that is stopped
 * (`stoppedForRetry`) and owes something: failed writes (`anchor-failed`, on the row or on the
 * snapshot a racing pause hid), its settlement record (`snapshot.tempo.recordOwed`), or
 * records the anchor queue still carries for its agent — `carried`, so a Stop pressed over an
 * `anchor-failed` run, which rewrites the reason, does not strand what the journal holds.
 *
 * The route and `retryUnderSlot` both ask. Without the check, a Retry on a run still `running` would
 * clear its `halted` mark — a step that landed, whose registry write failed and whose stop write
 * failed too (`writeStopLater`), would be re-armed by `syncScheduler` and the same index run again,
 * the duplicate `halted` exists to prevent. It would also blank the running row's `nextStepAt`.
 */
export function retryRefusal(loop: LoopRecord, carried = 0): string | null {
  if (loop.lifecycle?.rebuilt) return REBUILT_REFUSAL;
  if (!stoppedForRetry(loop)) return "only a stopped run can be retried; this one is " + loop.status;
  // A Discard that began and did not finish its row: the journal may no longer hold the records the
  // owed plans stand on, and a Retry's clean drain would then write their checkpoints over nothing.
  if (loop.discardingAt !== undefined) return DISCARD_UNFINISHED_DETAIL;
  // An owed plan with a key only a roadmap feature writes (an older row's): asked before the run's
  // other debts, because the Retry would drain its records and then fail to land its checkpoint.
  const removedPlan = removedPlanRefusal(loop);
  if (removedPlan) return removedPlan;
  const owes =
    loop.stopReason === "anchor-failed" ||
    loop.snapshot.stopReason === "anchor-failed" ||
    !!loop.snapshot.tempo?.recordOwed ||
    carried > 0;
  if (!owes) return "this run owes nothing to retry: its writes are on chain and its settlement record is written";
  return null;
}

/**
 * Why a Retry of `loop` is refused because an owed plan carries a key only a roadmap feature writes
 * (`REMOVED_PLAN_KEYS`: an oracle request, a team's member commits, a gate's log, the trace audit,
 * protocol-plugin grants), or `null`. This build writes no such key, and a checkpoint landed without
 * it would be a manifest other than the one the step planned, so nothing is retried: not the
 * checkpoint, and not the drain before it, which would leave the plan's records on chain under no
 * leaf. The records stay journaled.
 */
export function removedPlanRefusal(loop: Pick<LoopRecord, "history">): string | null {
  const owed = loop.history.flatMap((h) => {
    const keys = h.deferredCheckpoint ? removedPlanKeys(h.deferredCheckpoint) : [];
    return keys.length
      ? [`step ${h.step}'s checkpoint commits ${keys.map((k) => REMOVED_PLAN_KEYS[k]).join(", ")}`]
      : [];
  });
  if (owed.length === 0) return null;
  return (
    `this run owes a checkpoint this build does not write (${owed.join("; ")}), so nothing is retried: ` +
    "its records stay journaled rather than landing under a checkpoint other than the one its step planned"
  );
}

/**
 * `retryRefusal` with the journal read: how many records the anchor queue still carries for the run's
 * agent. The route asks it before it charges the command counter (the journal is this console's own
 * disk, not the chain), and `retryUnderSlot` again under the slot, where the row is current. A journal
 * that cannot be read is no reason to refuse: the drain behind it finds out for itself, and a drain
 * with nothing to send leaves a run that owes nothing as it was.
 */
export async function retryRefusalNow(loop: LoopRecord, queue?: LoopAnchorQueue): Promise<string | null> {
  const first = retryRefusal(loop);
  if (!first || !stoppedForRetry(loop)) return first;
  const carriedOf = queue ? queue.carried?.bind(queue) : (agentId: Uint8Array) => anchorQueue().carried(agentId);
  if (!carriedOf) return first;
  try {
    return retryRefusal(loop, (await carriedOf(toBytes32(loop.agentId))).length);
  } catch (e) {
    console.warn(`[loops] ${loop.id}: the journal could not be read for a Retry (${errorText(e)}); letting it drain`);
    return null;
  }
}

/** `retryLoopAnchor`'s work, for a caller that holds the run slot. */
async function retryUnderSlot(
  id: string,
  opts: RetryLoopAnchorOpts
): Promise<{ loop: LoopRecord | null; error?: string }> {
  const read = readLoop(id);
  if (!read) return { loop: null };
  const refused = await retryRefusalNow(read, opts.queue);
  if (refused) return { loop: read, error: refused };
  // A paused row over a snapshot its step stopped is written down as the stop that step
  // meant, before anything else: everything below reads the row's `stopReason`, and the update at the
  // end clears the snapshot's — which on a row left `paused` would erase the only sign that the run
  // still owes something, and the next Retry would be refused as a paused run.
  const loop =
    read.status === "paused"
      ? updateLoop(id, (l) =>
          l.status === "paused" && l.snapshot.status === "stopped"
            ? {
                ...l,
                status: "stopped",
                stopReason: l.snapshot.stopReason ?? "stopped",
                stopDetail: l.snapshot.stopDetail,
                nextStepAt: undefined,
              }
            : l
        ) ?? read
      : read;
  const queue: LoopAnchorQueue = opts.queue ?? anchorQueue();
  const owner = new PublicKey(loop.owner);
  const agentId = toBytes32(loop.agentId);
  // A retry may run in a process that never stepped this loop, so the chain is bound afresh:
  // the same key a step signs with, and the owner's allowance for the records that carry a
  // charge. A test hands in its own queue and has no deployed agent to bind.
  // Held past the binding block: the checkpoint below writes through the same client the queue
  // just wrote the records through, which is the only key allowed to append to this chain.
  let client: LathClient | undefined;
  let server: Keypair | null = null;
  if (!opts.queue) {
    const deployed = lookupAgent(loop.agentId);
    if (!deployed) return { loop, error: "the agent this loop runs is no longer deployed here" };
    server = loadKeypair();
    if (!server) return { loop, error: "the server has no runtime keypair, so it cannot sign for this chain" };
    const rpc = rpcFor();
    const key = deployedRoles(server, deployed.name).agent.key;
    client = LathClient.fromIdl(rpc, key);
    // The same rule the step applies: the owner's allowance, when it is live and funded. Only on a
    // console with a billing program to read it from, as `runnerBaseFor` asks: without
    // `NEXT_PUBLIC_TREASURY_ADMIN` there is no admin to build the reader on — `new PublicKey("")`
    // would throw, the route would answer a bare 500, and an anchor-failed run on an unbilled console
    // could never be retried.
    let billing: NoopBilling | BillingClient = new NoopBilling();
    let refused: string | null = null;
    if (TREASURY_ADMIN) {
      const reader = BillingClient.fromIdl(rpc, key, { admin: new PublicKey(TREASURY_ADMIN), lath: client });
      const grant = await reader.getAllowance(owner, key.publicKey).catch(() => null);
      const spendable = await reader.spendable(owner).catch(() => 0n);
      // Same admission as a step. A retry of a step's journaled records is not a free drain: those
      // entries can carry the step's charge, and binding a backend that cannot pay would settle them
      // unpaid, the step's unpaid settlement by the other door. The estimate is
      // floored at one micro-USDC, so a run whose budget the owed step spent still needs a live grant.
      const { estimate, legacyStepCap: legacyCap } = stepAdmission(loop);
      const admitted = admitStepSpend({
        grant,
        spendable,
        estimate: estimate > 0n ? estimate : 1n,
        ...(legacyCap !== undefined ? { legacyStepCap: legacyCap } : {}),
      });
      if ("ok" in admitted) billing = reader;
      else refused = admitted.refuse;
    } else {
      refused = "this console has no billing program configured to charge it through";
    }
    // A journaled charge with no backend that can pay it is refused rather than drained through
    // `NoopBilling`, which would settle it unpaid — on a console with no billing program
    // too, which has nothing to pay a carried charge with.
    const owed = await carriedCharges(agentId);
    if (owed.payers.length > 0 && refused !== null) {
      return {
        loop,
        error:
          `this run owes ${(Number(owed.microUsdc) / 1e6).toFixed(6)} USDC and its allowance can no longer pay it: ` +
          `${refused}. The records stay journaled until it can.`,
      };
    }
    bindAnchorChain(agentId, { client, billing });
  }
  try {
    await queue.retry(agentId);
    await queue.drain(agentId);
  } catch (e) {
    const error =
      e instanceof AnchorFailed
        ? `the records of this run still will not land: ${e.message}`
        : `the retry did not finish: ${(e as any)?.message ?? e}`;
    // Rule 3's failure is the one a second Retry can never fix, so it is the one that offers the
    // way out. Remembered on the run rather than read off the error each time, because the page
    // that shows the button is loaded long after the 409 that said so. The discard re-checks the
    // chain itself; this flag only decides what the page offers.
    if (e instanceof AnchorFailed && /head diverged/.test(e.entry.error ?? "")) {
      return { loop: updateLoop(id, (l) => ({ ...l, anchorDiverged: true })) ?? loop, error };
    }
    return { loop, error };
  }
  /**
   * The checkpoint the interrupted step owes, now that its records are on chain. One step can owe
   * one — the run stopped on it — but the history is walked rather than indexed, because a run
   * stopped twice in a process that died in between would leave two.
   *
   * Never fatal: the records are on chain and the loop is resumable either way. A checkpoint that
   * cannot be written leaves the plan where it is, so the next retry tries again, and the step
   * keeps reading as what it is — a step whose work landed without a leaf over it. One that landed and
   * whose row could not be written is held in this process instead (`unrecordedCheckpoints`), and the
   * run stays stopped until a Retry writes that row rather than the checkpoint.
   */
  // Before the checkpoint, where a run with nothing failed has them: the epoch's `onVerified`
  // hook wrote its locator during the drain above if this process journaled it, and this pays
  // what a restart left owed, now that there is nothing journaled for the cell to land ahead of.
  if (client && server) await payOwedLocators(agentId, client, server);
  const checkpointed =
    client && server
      ? await payDeferredCheckpoints(id, agentId, () => deferredWriter(agentId, client!, server!))
      : opts.checkpoint
      ? await payDeferredCheckpoints(id, agentId, async () => ({
          client: opts.checkpoint!.client,
          logger: opts.checkpoint!.logger,
          sealed: new Map(),
        }))
      : [];
  const unrecorded = unrecordedCheckpointDetail(id, readLoop(id) ?? loop);

  // The lifecycle the run owes — the stop the failed step left — once its checkpoint is on chain and
  // before the settlement, the order the run ended in. Never throws; what fails stays owed.
  await payOwedLifecycleUnderSlot(id);

  // Last of the three, so the chain reads records → the step's checkpoint → the settlement, the
  // order it would have had with nothing failed.
  const settlementOwed = await payOwedSettlement(id, opts);

  /**
   * Whether this retry finished what the run owed, so the loop may go back on its schedule. A
   * settlement record still owed keeps it stopped on `anchor-failed`, the one stop reason that
   * offers *Retry the step*: a run that resumed would open a new channel, and that channel's
   * settlement would overwrite `snapshot.tempo` — the only place the owed receipt is kept.
   */
  // Only a run the failed writes stopped goes back on its schedule. A run that ended
  // any other way — `max-steps`, a stop — can still owe its settlement record and be retried for
  // it, and writing that record is not a reason to start stepping a run its owner had stopped.
  //
  // Nor a keyed loop whose key has been revoked (an archive ended it, then it was unarchived): it could
  // open nothing, and would stop `tempo-key-missing` at its first paid call.
  // Or one whose revoke is in flight right now (an archive's, before the unarchive that let this Retry
  // in): the row cannot say so until the revoke answers, so the process's own record is asked too.
  const keyGone = (l: LoopRecord) => !!l.tempoKey && (keyDone(l) || scheduler().revoking.has(l.id));
  // Nor while a checkpoint this Retry landed is missing from its row: a run that stepped on would leave
  // that plan on the row, and the next anchor-failed stop's Retry — in a process that no longer holds
  // what landed — would write it a second time.
  const owesNothing = (l: LoopRecord) =>
    l.stopReason === "anchor-failed" && l.snapshot.steps < l.maxSteps && !settlementOwed && !unrecorded && !keyGone(l);
  // Nor a run whose last step reached its goal and whose plan this Retry has now landed: the
  // step would have ended the run had its writes landed on time, and put back on its schedule it
  // paid for more steps toward a goal already reached. It ends here, `goal-reached`, once nothing
  // else keeps it on `anchor-failed` — and is not asked the start's refusals below, since it does
  // not start again.
  const goalLanded = (l: LoopRecord) => {
    const last = l.history.at(-1);
    return !!last?.deferredGoalReached && !last.deferredCheckpoint;
  };
  const now = readLoop(id) ?? loop;
  // Nor a run that carries a team (`teamRunRefusal`), the trace audit (`traceAuditRetryRefusal`),
  // protocol-plugin grants (`grantsRefusal`), a gate or an oracle trigger (`_lib/roadmap.ts`), none of
  // which is in this build: going back on its schedule is a resume, and `resumeRefusal` refuses such a row
  // one. Asked first, as `resumeRefusal` asks it ahead of the agent's other runs. The drain above stands —
  // those writes are the chain's own — and the run keeps `anchor-failed` with the reason as its detail, as
  // a blocked run below does.
  const teamBlocked = teamRunRefusal(now);
  const roadmapBlocked =
    owesNothing(now) && !goalLanded(now)
      ? teamBlocked
        ? `this run's writes are on chain, but it stays stopped: ${teamBlocked}`
        : traceAuditRetryRefusal(now) ?? grantsRefusal(now, "retry") ?? roadmapRetryRefusal(now)
      : null;
  // Nor beside another loop running on its agent, another run's settle, or past the wallet's cap:
  // going back on its schedule sets a loop running as a start does. Asked here, after the
  // last await and before the write, so nothing lands in between. Such a run keeps
  // `anchor-failed` with the reason as its detail: its writes are on chain, and a Retry once the
  // other run is done finds nothing to drain and puts it back on its schedule.
  const runBlocked =
    owesNothing(now) && !goalLanded(now) && !roadmapBlocked
      ? loopRunRefusal(now.agentId, now.agentName, now.owner, { except: id })
      : null;
  const blocked = (l: LoopRecord) => !!(roadmapBlocked || runBlocked) && owesNothing(l);
  const resumable = (l: LoopRecord) => owesNothing(l) && !runBlocked && !roadmapBlocked && !goalLanded(l);

  // A Retry that puts the run back on its schedule owes `loop.resume` with reason `retry`, the owner's;
  // one that only rewrites a stopped run's reason owes the stop with its new reason (`transitionOwed`).
  const actor: LifecycleActorContext = { ...(opts.actor ?? { by: "owner" }), resumeReason: "retry" };
  const resumed = withTransitionActor(actor, () =>
    updateLoop(id, (l) => ({
      ...l,
      // The records landed, so whatever an earlier Retry said about divergence is no longer true.
      anchorDiverged: undefined,
      status: resumable(l) ? "running" : l.status,
      // A run whose last step was the one that failed is finished once the retry lands it, and
      // `anchor-failed` is no longer why it stopped — the writes are on chain and the step has its
      // checkpoint. Saying so matters on screen: `anchor-failed` is the one stop reason that
      // offers *Retry the step* instead of *Run again*, so a finished run would keep offering a
      // retry of work already paid for.
      stopReason: resumable(l)
        ? undefined
        : unrecorded || settlementOwed || blocked(l)
        ? l.stopReason
        : l.stopReason === "anchor-failed" && goalLanded(l)
        ? GOAL_REACHED_STOP_REASON
        : l.stopReason === "anchor-failed" && checkpointed.length > 0
        ? "max-steps"
        : l.stopReason,
      stopDetail: resumable(l)
        ? undefined
        : unrecorded
        ? unrecorded
        : settlementOwed
        ? SETTLEMENT_OWED_DETAIL
        : l.stopReason === "anchor-failed" && goalLanded(l)
        ? `step ${l.history.at(-1)!.step} reached the goal, and Retry wrote its checkpoint late: its record ` +
          "is at 200, not 201, so no receipt is published for this run"
        : roadmapBlocked && owesNothing(l)
        ? roadmapBlocked
        : runBlocked && owesNothing(l)
        ? runBlockedDetail(runBlocked.error)
        : l.stopReason === "anchor-failed" && checkpointed.length > 0
        ? undefined
        : l.stopDetail,
      // The runner is rebuilt per step from this snapshot, so `idle` is all a resume is: the next
      // step is scheduled from here, and it is the next index.
      //
      // The snapshot takes up what the late checkpoint put on chain: its seq, its head, its leaf
      // and — only now that the chain names it — the memory the step produced. Until this point
      // `lastMemoryHash` was deliberately the *previous* step's, because a step must resume from a
      // hash a reader can reach.
      snapshot: {
        ...l.snapshot,
        status: "idle",
        stopReason: undefined,
        stopDetail: undefined,
        ...(checkpointed.at(-1)
          ? {
              lastSeq: checkpointed.at(-1)!.seq,
              lastHead: checkpointed.at(-1)!.head,
              lastLeaf: checkpointed.at(-1)!.leaf,
              ...(checkpointed.at(-1)!.memoryHash
                ? {
                    lastMemoryHash: checkpointed.at(-1)!.memoryHash,
                    // Only a memory the step produced makes it the step to resume from; one it
                    // carried forward leaves `lastMemoryStep` pointing where it already pointed.
                    ...(checkpointed.at(-1)!.memoryIsOwn ? { lastMemoryStep: checkpointed.at(-1)!.step } : {}),
                  }
                : {}),
            }
          : {}),
      },
      nextStepAt: resumable(l) ? Date.now() : undefined,
    }))
  );
  // What that write owed, while this Retry still holds the slot: the resume lands before the step it
  // allows, and a rewritten stop before anything else is written on the chain.
  await payOwedLifecycleUnderSlot(id);
  // Only for a run that was not running when the Retry began (`retryRefusal` above): `halted` is what keeps
  // a running row whose step landed from being ticked into the same index again, and a Retry is not
  // the place that may lift it from one that is not stopped.
  if (loop.status !== "running") scheduler().halted.delete(id);
  if (resumed?.status === "running") (opts.resume ?? ((loopId: string) => schedule(loopId, 0)))(id);
  // A Retry that left the run stopped for good — finished, or its settlement written — has ended it,
  // so its key goes; one that resumed it, or left it `anchor-failed`, keeps it (`keyStillNeeded`).
  if (resumed?.tempoKey) await revokeAfterStop(id);
  if (unrecorded) return { loop: resumed ?? loop, error: unrecorded };
  if (roadmapBlocked && resumed?.stopReason === "anchor-failed") return { loop: resumed, error: roadmapBlocked };
  if (runBlocked && resumed?.stopReason === "anchor-failed") {
    return { loop: resumed, error: runBlockedDetail(runBlocked.error) };
  }
  return settlementOwed ? { loop: resumed ?? loop, error: SETTLEMENT_OWED_DETAIL } : { loop: resumed ?? loop };
}

/**
 * Why a Retry leaves the run stopped while a checkpoint it landed is not on its row, or `undefined`
 * (`unrecordedCheckpoints`). The signature is named so the landing can be checked on an explorer. Only
 * a step whose row still carries its plan counts: one a Discard cleared owes the row nothing.
 */
function unrecordedCheckpointDetail(id: string, loop: Pick<LoopRecord, "history">): string | undefined {
  const held = [...(scheduler().unrecordedCheckpoints.get(id) ?? [])].filter(([step]) =>
    loop.history.some((h) => h.step === step && h.deferredCheckpoint)
  );
  if (held.length === 0) return undefined;
  return (
    held
      .map(
        ([step, c]) =>
          `step ${step}'s checkpoint landed on chain (signature ${c.patch.signature}) but could not be recorded (${c.error})`
      )
      .join("; ") +
    ". The loop stays stopped; Retry records it without writing it again, and only this console process holds " +
    "what landed, so retry before it restarts"
  );
}

/** What a Retry whose writes landed says when the run may not go back on its schedule yet. */
function runBlockedDetail(why: string): string {
  return `this run's writes are on chain, but it stays stopped: ${why}. Retry once that is done to put it back on its schedule`;
}

/**
 * *Discard*: the way out of a run whose journal the chain has moved away from for good.
 *
 * Retry cannot help such a run: every journaled head was computed over the heads before it, and
 * the chain now stands under one the journal never computed, so each Retry answers _head
 * diverged_ again (as when a locator cell written outside the journal takes a seq the journal planned).
 * The queue's `discard` checks that against the chain itself and refuses anything a Retry could
 * still land; what it drops it writes to the journal's side file first.
 *
 * What this adds is the run's side of it. The stop stops being `anchor-failed` — nothing is owed
 * any more, and the page stops offering a Retry that cannot work — and becomes
 * `anchor-discarded`, with a sentence saying the step's records and its charge never landed. The
 * step's deferred checkpoint goes with them: there are no records on chain for a leaf to commit to.
 * The money is said plainly, because it is not the user's loss: the model calls were paid out of the
 * operator's treasury over Tempo, and the charge that would have recovered them was in a record
 * that never landed.
 *
 * Owner-signed, like every loop verb (the signed message binds `action: "discard"` to the run's id): the
 * divergence is not something the owner can cause — the server holds the agent key — so the only
 * thing the verb lets them do is stop waiting for an operator. The owed `loop.settlement` record,
 * when there is one, is written afterwards: the channel did settle, and once the journal is empty
 * the chain can take the record of it.
 */
export async function discardLoopAnchor(
  id: string,
  opts: DiscardLoopAnchorOpts = {}
): Promise<{ loop: LoopRecord | null; error?: string }> {
  return underLoopSlot(id, "discard", () => discardUnderSlot(id, opts));
}

interface DiscardLoopAnchorOpts {
  queue?: LoopAnchorQueue;
  settle?: LoopChannelHooks["settle"];
  closeById?: LoopChannelHooks["closeById"];
  /** The owner who asked for the Discard, with the signature the route verified (the stop's `by`). */
  actor?: LifecycleActorContext;
}

/** `discardLoopAnchor`'s work, for a caller that holds the run slot. */
async function discardUnderSlot(
  id: string,
  opts: DiscardLoopAnchorOpts
): Promise<{ loop: LoopRecord | null; error?: string }> {
  const loop = readLoop(id);
  if (!loop) return { loop: null };
  if (loop.status === "running" || loop.stopReason !== "anchor-failed") {
    return { loop, error: "only a run stopped on anchor-failed has journaled writes to discard" };
  }
  const queue: LoopAnchorQueue = opts.queue ?? anchorQueue();
  if (!queue.discard) return { loop, error: "this server's writer queue cannot discard" };
  const agentId = toBytes32(loop.agentId);
  if (!opts.queue) {
    // The queue reads the chain through the chain's binding, and a process that never stepped this
    // loop has none. `NoopBilling`, because a discard sends nothing and a later step binds its own.
    const deployed = lookupAgent(loop.agentId);
    if (!deployed) return { loop, error: "the agent this loop runs is no longer deployed here" };
    const server = loadKeypair();
    if (!server) return { loop, error: "the server has no runtime keypair, so it cannot read for this chain" };
    const key = deployedRoles(server, deployed.name).agent.key;
    bindAnchorChain(agentId, { client: LathClient.fromIdl(rpcFor(), key), billing: new NoopBilling() });
  }

  // Written before the queue drops anything, so a row write that fails after the drop cannot leave
  // plans a Retry would checkpoint over records that are gone (`discardingAt`). A marker that cannot
  // be written stops the discard here, with nothing dropped.
  const resumedDiscard = loop.discardingAt !== undefined;
  try {
    if (!resumedDiscard) updateLoop(id, (l) => ({ ...l, discardingAt: Date.now() }));
  } catch (e) {
    return { loop, error: `nothing was discarded: the run's row could not be written (${errorText(e)})` };
  }

  let result: DiscardResult;
  try {
    result = await queue.discard(agentId);
  } catch (e) {
    // A refusal is thrown before the queue drops anything, so a marker this call set comes off again.
    // One an earlier Discard set stays: its drop may have happened, which is why this one finds
    // nothing to discard, and only the side file under `pending/` can say what it dropped. Any other
    // error leaves the drop in doubt, so the marker stays too.
    if (e instanceof DiscardRefused && !resumedDiscard) {
      try {
        updateLoop(id, ({ discardingAt: _began, ...rest }) => rest);
      } catch (w) {
        console.warn(`[loops] ${id}: a refused Discard's marker could not be cleared: ${errorText(w)}`);
      }
    }
    const error =
      e instanceof DiscardRefused
        ? resumedDiscard
          ? `${DISCARD_UNFINISHED_DETAIL} This Discard was refused (${e.message})`
          : `nothing was discarded: ${e.message}`
        : `the discard did not finish: ${(e as any)?.message ?? e}`;
    return { loop: readLoop(id) ?? loop, error };
  }

  const at = Date.now();
  // The gate's asks the dropped plans would have committed. An older plan may also carry their
  // charge, which goes with it; otherwise the asks are Lath's to pay, the plan's `uncharged` is "0",
  // and the detail says only that they were not committed.
  const woken = (readLoop(id) ?? loop).history.filter((h) => h.deferredCheckpoint && h.wake);
  const gateCostBase = woken.reduce((sum, h) => sum + BigInt(h.wake!.costBase || "0"), 0n);
  const gateAsks = woken.reduce((sum, h) => sum + h.wake!.asks, 0);
  const discarded: LoopDiscardRow = {
    at,
    entries: result.dropped.length,
    unbilledMicroUsdc: result.unbilledMicroUsdc.toString(),
    chargedMicroUsdc: result.chargedMicroUsdc.toString(),
    // Only when some of it is in doubt, so every other discard carries no such key.
    ...(result.inDoubtMicroUsdc ? { inDoubtMicroUsdc: result.inDoubtMicroUsdc.toString() } : {}),
    ...(result.file ? { file: path.relative(TRACE_DIR, result.file) } : {}),
    reason: result.reason,
    // Spread, and only when a dropped plan closed a gate log, so every other discard carries no gate
    // keys.
    ...(woken.length
      ? {
          gate: {
            asks: gateAsks,
            costBase: gateCostBase.toString(),
            uncharged: woken
              .reduce((sum, h) => sum + BigInt(h.deferredCheckpoint!.gateChargeMicroUsdc ?? "0"), 0n)
              .toString(),
          },
        }
      : {}),
  };
  // The owner's Discard rewrites the stop's reason, which owes the stop again with it (`transitionOwed`).
  const discardedRow = (l: LoopRecord): LoopRecord => ({
    ...l,
    stopReason: "anchor-discarded",
    stopDetail: discardDetail(discarded),
    anchorDiverged: undefined,
    discarded,
    // In the same write that clears the plans below, so the marker and the plans go together.
    discardingAt: undefined,
    history: l.history.map((h) =>
      h.deferredCheckpoint
        ? {
            ...h,
            deferredCheckpoint: undefined,
            discardedAt: at,
            reason: `step ${h.step} ran; its records were discarded after the chain diverged, so they and their charge never landed`,
          }
        : h
    ),
  });
  withTransitionActor(opts.actor, () => updateLoop(id, discardedRow));
  // The stop the discard rewrote (`anchor-discarded`), before the settlement, with the journal clear.
  await payOwedLifecycleUnderSlot(id);
  await payOwedSettlement(id, opts);
  // `anchor-discarded` ends the run: nothing can resume it, so its key goes once the close is paid.
  if (readLoop(id)?.tempoKey) await revokeAfterStop(id);
  return { loop: readLoop(id) ?? loop };
}

/**
 * A step row once *Retry the step* has landed its records and written its checkpoint: the chain
 * part the checkpoint read, the bundle if the seal landed, and the plan gone.
 *
 * What the row said when it stopped — _its chain writes did not land_ — is now false, and the
 * page would show it beside a leaf that verifies, so the reason is rewritten and the row is stamped. The status
 * stays: the Resolution the retry landed was built after the drain had failed, and `failed` is what it says on
 * chain.
 */
export function landedOnRetry(
  row: LoopStepSummary,
  patch: Pick<LoopStepSummary, "seq" | "head" | "leaf" | "leafOk" | "signature" | "memoryHash">,
  bundle?: LoopStepSummary["bundle"],
  at: number = Date.now()
): LoopStepSummary {
  return {
    ...row,
    ...patch,
    ...(bundle ? { bundle } : {}),
    deferredCheckpoint: undefined,
    landedOnRetryAt: at,
    reason: `step ${row.step} ran, its chain writes failed, and Retry landed them with its checkpoint`,
  };
}

/** The run's `stopDetail` after a discard: what went, and who carries the money. */
/**
 * What a run says while a Discard it began has not finished its row (`LoopRecord.discardingAt`).
 */
export const DISCARD_UNFINISHED_DETAIL =
  "a Discard of this run's journal began and its row was not finished, so the records its owed steps " +
  "stand on may already be gone from the journal; no checkpoint is written over them and Retry is refused. " +
  "What the Discard dropped, if anything, is in the journal's side file under pending/.";

export function discardDetail(d: LoopDiscardRow): string {
  const usdc = (micro: string) => (Number(micro) / 1e6).toFixed(6);
  // `chargedMicroUsdc` includes the in-doubt part: a charge whose landing the client could not
  // confirm may or may not have debited the owner, so it is said as "may have been", and only the
  // signed remainder as "had been". A row without `inDoubtMicroUsdc` says all of it "had been".
  const total = /^\d+$/.test(d.chargedMicroUsdc) ? BigInt(d.chargedMicroUsdc) : 0n;
  const doubt = d.inDoubtMicroUsdc && /^\d+$/.test(d.inDoubtMicroUsdc) ? BigInt(d.inDoubtMicroUsdc) : 0n;
  const sure = total > doubt ? total - doubt : 0n;
  const charged =
    (sure > 0n ? `; ${usdc(sure.toString())} USDC had been charged on its own before its record failed` : "") +
    (doubt > 0n
      ? `; ${usdc(doubt.toString())} USDC may have been charged before its record failed (the charge was sent ` +
        `and its landing never confirmed)`
      : "");
  // The gate's asks that step's checkpoint would have committed, which are not among the journaled
  // writes above: said on its own, because nothing else on the page would say it. Only an older plan
  // also carries a charge for them; otherwise Lath pays the asks outright.
  const asks = d.gate ? `${d.gate.asks} ${d.gate.asks === 1 ? "ask" : "asks"}` : "";
  const gate = !d.gate
    ? ""
    : d.gate.uncharged !== "0"
    ? ` The gate's ${asks} that step's checkpoint would have charged (costBase ${d.gate.costBase}, ` +
      `${usdc(d.gate.uncharged)} USDC) went uncharged with it and stay on the loop as not committed; the ` +
      `operator carries them too.`
    : ` The gate's ${asks} that step's checkpoint would have committed (costBase ${d.gate.costBase}) stay on ` +
      `the loop as not committed; Lath paid for them, as it pays for every ask.`;
  return (
    `${d.entries} journaled ${d.entries === 1 ? "write was" : "writes were"} discarded (${d.reason}). ` +
    `${usdc(d.unbilledMicroUsdc)} USDC of charges in them was never debited: the model calls were paid from the ` +
    `operator's treasury over Tempo, and the operator carries them${charged}.${gate}`
  );
}

/**
 * The locator cells a Retry's clean drain leaves owed: epochs that landed with nobody holding the
 * hook that writes their cell, because the process that journaled them is gone. The tick's
 * `flushAnchors` refuses to write while records are journaled, so for a run
 * stopped on `anchor-failed` this is the one place they are paid.
 *
 * Never fatal, like the checkpoint after it: the records are on chain, and a cell not written
 * stays owed on the entry for the next flush or for `reanchorEpochs`.
 */
async function payOwedLocators(agentId: Bytes32, client: LathClient, server: Keypair): Promise<void> {
  const queue = anchorQueue();
  const owed = await queue.locatorsOwed(agentId);
  if (owed.length === 0) return;
  try {
    const store = epochStoreFor(hex(agentId), client, await traceBackend(server));
    for (const entry of owed) {
      await store.anchor(toBytes32(entry.epochRoot));
      await queue.locatorPublished(entry);
    }
    // With `LATH_ANCHOR_EVERY` above 1 the cells above only joined the manifest queue.
    await store.flush();
    savePendingAnchors(hex(agentId), store.pendingAnchors);
  } catch (e) {
    console.warn(`[loops] owed locators for ${hex(agentId)} not written: ${(e as any)?.message ?? e}`);
  }
}

/** What a loop whose settlement record is still owed after a Retry says, on the row and in the 409. */
const SETTLEMENT_OWED_DETAIL =
  "the run's records are on chain and its channel is settled, but the loop.settlement record is not written yet; " +
  "Retry writes it";

/**
 * What `payDeferredCheckpoints` writes through: the chain, the logger and the seals. No charge: a
 * late checkpoint debits nothing, because the gate's asks and Jev's decision are Lath's to pay, so an
 * older plan that still says what it owed lands uncharged like a new one.
 */
interface DeferredWriter {
  client: LathClient;
  logger: AgentLogger;
  /** The bundles the owed steps could not seal, sealed now, by the genesis hash each plan carries. */
  sealed: Map<string, LoopStepSummary["bundle"]>;
}

/**
 * The real writer: the agent's key, its trace store, and the seals those steps could not make.
 *
 * The bundles come first — a locator cell takes a seq like anything else, and the checkpoints
 * commit to a leaf over the chain as they find it, so the cheapest way to keep the leaf honest is
 * to write the cells before the leaf is taken rather than between two of them. Keyed by the
 * genesis hash the plan carries, which is the key the bundle is anchored under, so each row gets
 * its own result back.
 */
async function deferredWriter(agentId: Uint8Array, client: LathClient, server: Keypair): Promise<DeferredWriter> {
  // No lookup of the agent's name here: it only ever chose the trace key the checkpoints were
  // encrypted under, and this build writes them in the clear. The signing key is `client`'s, which
  // the caller built only for an agent the registry still names.
  const store = new FileTraceStore(TRACE_DIR);
  const logger = new AgentLogger(client, agentId, { store, compact: false, storePayloads: true });
  const sealed = new Map<string, LoopStepSummary["bundle"]>();
  for (const { session, result } of await sealDeferred(hex(agentId), {
    backend: await traceBackend(server),
    registry: new LocatorRegistry(client, agentId),
    store,
  }).catch(() => [])) {
    sealed.set(
      session.genesisPayloadHash,
      result.error
        ? { error: result.error }
        : { scheme: result.locator!.scheme, id: hex(result.locator!.id), count: result.count!, bytes: result.bytes! }
    );
  }
  return { client, logger, sealed };
}

/**
 * Writes the `loop.step` checkpoints this run still owes, and records the bundles those steps
 * could not seal — the two things a step whose drain failed leaves undone.
 *
 * Called only after a clean drain, because both are chain writes and both were skipped for the
 * same reason: a cell or a record written while a step's own records are journaled takes the seq
 * one of them is holding, and a leaf taken over a chain that has not caught up commits to a head
 * no reader can reach.
 *
 * The step's own history row is repaired in the same pass, so the loop page stops showing work
 * that landed as work that was lost.
 */
async function payDeferredCheckpoints(
  id: string,
  agentId: Uint8Array,
  writer: () => Promise<DeferredWriter>
): Promise<{ step: number; seq: string; head: string; leaf: string; memoryHash?: string; memoryIsOwn?: boolean }[]> {
  const row = readLoop(id);
  const owed = (row?.history ?? []).filter((h) => h.deferredCheckpoint);
  if (owed.length === 0) return [];
  // A Discard that began and did not finish its row: these plans' records may be gone from the
  // journal and never on chain, and a `loop.step` written now would commit a leaf over a step whose
  // records were discarded. Nothing is written; `retryRefusal` refuses before a Retry gets here.
  if (row?.discardingAt !== undefined) return [];
  // Built only when something is owed: the seals it makes are the owed steps' own.
  const w = await writer();
  const written: {
    step: number;
    seq: string;
    head: string;
    leaf: string;
    memoryHash?: string;
    memoryIsOwn?: boolean;
  }[] = [];

  const unrecorded = scheduler().unrecordedCheckpoints;
  for (const row of owed) {
    const plan = row.deferredCheckpoint!;
    // A checkpoint an earlier Retry landed and could not write down is not written again: its plan is
    // still on the row only because the row is what failed, and a second `loop.step` for one step is a
    // second leaf over a chain that has moved on from the first.
    const held = unrecorded.get(id)?.get(plan.step);
    const bundle = held?.bundle ?? (plan.genesisPayloadHash ? w.sealed.get(plan.genesisPayloadHash) : undefined);
    let patch = held?.patch;
    if (!patch) {
      try {
        // Uncharged, whatever the plan says it owed: see `DeferredWriter`.
        const done = await writeLoopCheckpoint({ client: w.client, agentId, logger: w.logger, plan });
        patch = {
          seq: done.seq.toString(),
          head: hex(done.head),
          leaf: hex(done.leaf),
          leafOk: done.leafOk,
          signature: done.record.signature,
          memoryHash: plan.memoryHash,
        };
      } catch (e) {
        // The plan stays where it is: the next retry tries again, and nothing here can fail a run
        // whose records are already on chain. The bundle, if it landed, is still worth recording —
        // it is on chain whatever this file remembers about it.
        if (bundle) {
          updateLoop(id, (l) => ({
            ...l,
            history: l.history.map((h) => (h.step === plan.step ? { ...h, bundle } : h)),
          }));
        }
        console.warn(`[loops] the late checkpoint for step ${plan.step} of ${id} did not land: ${e}`);
        continue;
      }
    }
    // Out of the write's `try`: the checkpoint is on chain from here on, and a row the registry refuses
    // must not read as a checkpoint that did not land, or the next Retry writes a second one. The step
    // is not counted as written either — the snapshot takes up a checkpoint once its row names it — and
    // `unrecordedCheckpointDetail` keeps the run stopped until a Retry has written the row.
    const landed = patch;
    try {
      updateLoop(id, (l) => ({
        ...l,
        history: l.history.map((h) => (h.step === plan.step ? landedOnRetry(h, landed, bundle) : h)),
      }));
    } catch (e) {
      const error = errorText(e);
      if (!unrecorded.has(id)) unrecorded.set(id, new Map());
      unrecorded.get(id)!.set(plan.step, { patch: landed, ...(bundle ? { bundle } : {}), error });
      // The whole patch, so the row can be put right by hand if this process does not live to do it.
      console.error(
        `[loops] ${id}: the late checkpoint for step ${plan.step} landed but its row could not be written ` +
          `(${error}); row: ${JSON.stringify(landed)}`
      );
      continue;
    }
    unrecorded.get(id)?.delete(plan.step);
    if (unrecorded.get(id)?.size === 0) unrecorded.delete(id);
    written.push({ step: plan.step, ...landed, memoryIsOwn: plan.memoryIsOwn });
  }

  return written;
}
