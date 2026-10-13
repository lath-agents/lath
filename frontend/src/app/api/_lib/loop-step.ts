/**
 * One step of a loop (`runOneStep`), under the run slot the scheduler took, and the stops it and
 * the tick check for: the budget, a key about to expire, and the rows that carry a team or the
 * trace audit (`_lib/loops.ts` re-exports what is public). The construction it runs is
 * `runnerBaseFor` in `loop-channel.ts`; the clock that calls it is `loop-scheduler.ts`.
 */
import { hex } from "@lath/sdk";
import { LoopRunner, type LoopSnapshot, type StepResult } from "@lath/runtime";
// Server-only, and so not in the package index the client pages import (see `runtime/src/index.ts`).
import { ZeroClawRuntime } from "@lath/runtime/zeroclaw/runtime";
import type { LoopPostureIrys, LoopStepSummary, StepGoalCheckView } from "../../../types/loop";
import { base6 } from "./tempo";
import { deferSeal } from "./unsealed";
import { beginStepStage, setStepStage } from "./loop-stage";
import { irysSourcesUploader, type SourcesUploader } from "./sources-irys";
import { knownPosture, posturesToPublish, publishPosture } from "./posture-irys";
import { removedFeatureStop } from "./roadmap";
import { loadKeypair, irysSourcesSettings } from "./runner";
import {
  asksForTraceAudit,
  errorText,
  GOAL_REACHED_STOP_REASON,
  HISTORY_KEPT,
  LoopRefused,
  teamRunRefusal,
  TRACE_AUDIT_STOP_DETAIL,
} from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { type LoopBudgetFields, loopBudgetKeys, loopBudgetSpent, loopSpentOf, withSpentAtLeast } from "./loop-budget";
import { scheduler } from "./loop-state";
import { readLoop, readLoops, updateLoop } from "./loop-registry";
import { persistOwnerSpend } from "./loop-meter";
import { withoutSandboxTexts, zeroclawStepRecord } from "./loop-sandbox";
import { type LoopChannelHooks, loopChannelMark, tempoSpentSince } from "./loop-channel-state";
import { loopKeyExpiryDetail } from "./loop-key";
import { savePendingAnchors, stepStorageOf } from "./loop-step-base";
import { afterLoopStep, runnerBaseFor, stopForTempoKey, stopLoop } from "./loop-channel";
import { stepGoalCheckView, stepVerifyView } from "./loop-views";

/**
 * Stops `loop` when it runs the trace audit, before anything of its next tick is spent — an ask, a
 * poll, a lifecycle record, a step — and says whether it did. An older row left running reaches
 * here on the first tick after a restart; the runner would refuse its step anyway
 * (`LoopRunner.step`), but only after the step's funding and channel. `error` with the sentence as
 * its detail, as a refused step leaves a row (`refusalReason`); the stop settles its channel as any
 * stop does.
 */
export function stopIfTraceAudited(id: string, loop: LoopRecord): boolean {
  if (!asksForTraceAudit(loop)) return false;
  stopLoop(id, "error", {}, TRACE_AUDIT_STOP_DETAIL);
  return true;
}

/**
 * Stops a running row that carries a team, before anything is funded, bound or opened for its step;
 * `true` when it did. Asked at every step boundary — each tick, and each step however it was
 * started — for the reason a spent budget is: an older row left running would otherwise be stepped
 * by this one, which has no team to hand its tasks to. `stopped` rather than a failure: nothing
 * broke and nothing is owed, and the detail says why.
 */
export function stopTeamRun(id: string, loop: LoopRecord): boolean {
  const refusal = teamRunRefusal(loop);
  if (!refusal) return false;
  console.warn(`[loops] ${id} stopped: ${refusal}`);
  stopLoop(id, "stopped", {}, refusal);
  return true;
}

/** Stops a loop whose key is about to expire, at a step boundary; `true` when it did. */
export function stopIfKeyExpiring(id: string, loop: LoopRecord): boolean {
  const detail = loopKeyExpiryDetail(loop);
  if (!detail) return false;
  stopForTempoKey(id, "tempo-key-expired", detail);
  return true;
}

// ─── One step ───────────────────────────────────────────────────────────────

/** The sentence a loop whose budget is spent stops with, when the runner gave none of its own. */
export function budgetSpentDetail(loop: LoopBudgetFields & Pick<LoopRecord, "snapshot">): string {
  const budget = loopBudgetKeys(loop).budget;
  return `the loop's budget of ${base6(budget)} USDC is spent (${base6(loopSpentOf(loop))} charged)`;
}

/**
 * Stops a loop whose budget is spent: `budget` is the reason, like `max-steps` a loop that finished
 * rather than one that failed, and the channel is settled like every other way out.
 */
export function stopForBudget(id: string, detail?: string, hooks: LoopChannelHooks = {}): LoopRecord | null {
  const current = readLoop(id);
  if (!current) return null;
  return stopLoop(id, "budget", hooks, detail ?? budgetSpentDetail(current));
}

/**
 * Runs one step of `id` and writes the result back into the registry. Assumes the caller holds
 * the run slot; see `tick`.
 */
export async function runOneStep(id: string): Promise<void> {
  const loop = readLoop(id);
  if (!loop || loop.status !== "running") return;
  // An older row started on a gate or an oracle trigger takes no step: this build has no write side
  // for either (`removedFeatureStop`). Asked here as well as in `tickOnce`, because a Retry or a
  // resume reaches a step through `stepNow` too, and it is asked before anything is funded or
  // bound.
  const removed = removedFeatureStop(loop);
  if (removed) {
    stopLoop(id, "error", {}, removed);
    return;
  }
  // A spent budget takes no step: nothing is funded, bound or opened for a step whose first call
  // the runner would refuse.
  if (loopBudgetSpent(loop)) {
    stopForBudget(id);
    return;
  }
  // A key about to expire takes no step either.
  if (loopKeyExpiryDetail(loop)) {
    stopIfKeyExpiring(id, loop);
    return;
  }
  // Nor an older row started with a team (`teamRunRefusal`), on the same boundary and for the same
  // reason: nothing is funded, bound or opened for a step this build cannot take.
  if (teamRunRefusal(loop)) {
    stopTeamRun(id, loop);
    return;
  }
  // The pending row's clock and first stage: the sources, the funding and the channel below are
  // chain reads the step waits on before any sandbox opens. `stepNow` clears it however this ends.
  beginStepStage(loop.id);

  const ctx = await runnerBaseFor(loop);
  const { base, runtime, stepTraces, epochStore, idBytes, billed } = ctx;
  const runner = new LoopRunner(base);
  // Everything is funded and bound; what runs next is the step's session, in its sandbox, until its
  // first model call names itself.
  setStepStage(loop.id, "in sandbox");

  updateLoop(loop.id, (l) => ({ ...l, steppingSince: Date.now(), billing: billed ? "charged" : "unfunded" }));
  /**
   * The storage card's `console` reading, taken after the step's key was funded and before
   * anything is written to the chain (the in-flight marker above is a file write). Not the `chain`
   * form: that needs the signature of every transaction the step paid for, and only some of them
   * reach this file — `StepResult` carries the checkpoint's and an epoch's commit, and the anchor
   * queue announces the records it drains, but the epochs' locator cells, the sandbox's own cell
   * writes and the bundle's seal (`SealResult`) hand no signature back here. A sum over the ones that
   * do would be a smaller number wearing the `chain` tag.
   */
  const storageBefore = await ctx.storageMeter();
  // The channel before the step, so the row can carry this step's Tempo spend.
  const channelBefore = loopChannelMark(loop.id);
  let result: StepResult;
  try {
    result = await runner.step();
  } catch (e) {
    // The runner threw before it returned: whatever it wrote, it did not count as a step, and
    // `tick` records the failure. Only the in-flight marker comes off here.
    // Caught: a registry that refuses the marker must not also cost the spend the owner was charged,
    // or the budget stop that follows.
    try {
      updateLoop(loop.id, (l) => ({ ...l, steppingSince: undefined }));
    } catch (err) {
      console.warn(`[loops] ${id}: the in-flight marker was not cleared after a failed step: ${errorText(err)}`);
    }
    // What the step charged before it threw is still charged: persisted whatever the error, so the
    // next step's remainder counts it (`persistOwnerSpend`, which never throws).
    persistOwnerSpend(id, loopSpentOf({ snapshot: runner.snapshot() }));
    // Except the one refusal that is a stop: a runner that found the budget spent before the step
    // stopped itself `budget` and threw. Recorded as that stop, not as a failed step that the next
    // tick would try again, and again.
    const stopped = runner.snapshot();
    if (stopped.status === "stopped" && stopped.stopReason === "budget") {
      stopForBudget(id, stopped.stopDetail);
      return;
    }
    throw e;
  }
  // No `settle()` here: the channel is the loop's, not the tick's, and closing it after every step
  // would cost some 36 s of open-and-close per step and one settlement record per step. Every way
  // out of the loop settles it instead — `settleLoopChannel`, below and in `stopLoop`. The registry
  // write is the first thing after the step returns, and everything between the two is inside the
  // one `try` below that halts the loop when it throws. Once `step()` has resolved, the step is on
  // chain — its genesis, its epoch, its resolution and its `loop.step` record. A step that is on
  // chain but not in the registry would be run *again* under the same index: `snapshot.steps` would
  // still be one short, the cost would not be counted, members would be charged twice, and the
  // orphan row would render as a leaf mismatch on a chain that is correct. Building the row reads
  // things — the members' names in `agents.json`, the sandbox's report, the runner's figures — and
  // any of those throwing before a try that opened at the write would leave the run `running` and
  // unhalted, so the try opens here. The reads that are only for display are made not to throw at
  // all (`memberNameOf`), so they cost a name, not the step's row. So the anchor flush and
  // `anchors.json` come after this, and a failure here stops the loop.
  let snapshot: ReturnType<typeof runner.snapshot>;
  let stepGenesis: typeof ctx.genesis.hash;
  let summary: LoopStepSummary;
  try {
    snapshot = runner.snapshot();
    stepGenesis = ctx.genesis.hash;
    // What the step's sandbox left — session A's, with its synthesis folded in — for the ZeroClaw tab.
    const sandbox = runtime instanceof ZeroClawRuntime ? runtime.stepReport() : undefined;
    // This step's Tempo spend: USDC.e base units, beside `costMicroUsdc` and never added to it.
    const tempoSpent = tempoSpentSince(channelBefore, loopChannelMark(loop.id));
    summary = {
      step: result.step,
      status: result.status,
      reason: result.reason,
      steps: result.steps,
      batchedSteps: result.batchedSteps,
      costMicroUsdc: result.costMicroUsdc,
      // Spread, so a step that paid nothing on Tempo carries no key for it.
      ...(tempoSpent ? { tempoSpent } : {}),
      // The fifteenth manifest key, which the browser's rebuild needs and reads off the row. A late
      // step's is on its plan.
      ...(result.manifest?.tempoHash ? { tempoHash: result.manifest.tempoHash } : {}),
      seq: result.seq,
      head: result.head,
      leaf: result.leaf,
      leafOk: result.leafOk,
      signature: result.record?.signature,
      epochs: result.epochs,
      memoryHash: result.memoryHash,
      resumedFromStep: result.resumedFromStep,
      resumedMemoryHash: result.resumedMemoryHash,
      workError: result.workError,
      // Why a failed step failed when the model simply did not answer, and what Lath paid for the
      // attempts that got none. Spread, so every other row carries neither key.
      ...(result.cause ? { cause: result.cause } : {}),
      ...(result.absorbedBase ? { absorbedBase: result.absorbedBase } : {}),
      // What the second model said, when the loop asked for one. Read off `StepResult` defensively
      // because the runner half of this lands separately: a step taken by a runtime that does not
      // verify has no key here, which is exactly what an unverified step should show.
      verify: stepVerifyView(result, !ctx.openrouter),
      // Jev's goal answer, on a goal-checked run. Absent on every other run's rows, which therefore
      // carry no key for it.
      ...((): { goalCheck?: StepGoalCheckView } => {
        const goalCheck = stepGoalCheckView(result, !ctx.openrouter);
        return goalCheck ? { goalCheck } : {};
      })(),
      // No `members` and no `synthesis`: this build runs no team, so a step it writes has neither.
      // Older rows keep theirs, and the page still renders them.
      //
      // The key of this step's bundle, written down before the bundle exists: the seal runs after
      // the registry write below, and the browser needs the key whether or not it landed.
      //
      // A step whose writes did not land never reaches the `work` hook, so `stepGenesis` is unset
      // on exactly the path that most needs the key — the deferred plan carries it instead, read
      // off the session the runner still had.
      genesisPayloadHash: stepGenesis ? hex(stepGenesis) : result.deferredCheckpoint?.genesisPayloadHash,
      // What *Retry the step* writes once the records land. Absent on every step that checkpointed.
      deferredCheckpoint: result.deferredCheckpoint,
      // And whether that step reached the goal, so the Retry ends the run there.
      ...(result.deferredGoalReached ? { deferredGoalReached: true as const } : {}),
      // The sandbox the step ran in (`ZeroClawStepRecord`): absent on a step whose session never
      // opened a sandbox, which is also every older step recorded without one.
      ...(sandbox ? { zeroclaw: zeroclawStepRecord(sandbox) } : {}),
      // What the step's sandbox was told had changed on chain since its Solana sources were pinned:
      // the text of that note in the message `messageHash` commits, kept so the loop page and the
      // ZeroClaw tab can show the chain's move to a viewer. Absent on a loop with no Solana source
      // and on an older row.
      ...((): { sourcesNote?: string } => {
        const note = ctx.sourcesNoteTold();
        return note ? { sourcesNote: note } : {};
      })(),
      startedAt: result.startedAt,
      endedAt: result.endedAt,
    };
    const written = updateLoop(loop.id, (l) => {
      const { status, stopReason, stopDetail } = statusAfterStep(l, snapshot);
      return {
        ...l,
        // Never below what `onSpend` already wrote: the runner's final total should equal it, and
        // if it does not, the figure the owner was shown mid-step is the one that stands.
        snapshot: withSpentAtLeast(snapshot, l),
        status,
        stopReason,
        stopDetail,
        billing: billed ? "charged" : "unfunded",
        // The `tempo` rail talks to OpenRouter through its MPP gateway, key or no key.
        inference: ctx.openrouter ? "openrouter" : "scripted",
        // The sandbox's texts stay on the newest row only (`withoutSandboxTexts`).
        history: [...l.history.map(withoutSandboxTexts), summary].slice(-HISTORY_KEPT),
        steppingSince: undefined,
        nextStepAt: status === "running" ? Date.now() + l.intervalMs : undefined,
      };
    });
    // A row that is gone is a step recorded nowhere, the same failure as a write the disk refused:
    // without this, `updateLoop`'s `null` would let the next tick run this index again.
    if (!written) throw new Error("the loop's row is no longer in the registry");
  } catch (e) {
    // The one failure this file cannot make good: the chain has the step and its row could not be
    // built or the disk refused it. Halt the loop in this process so the index is not run twice, and
    // let `afterStepFailure` write the stop down (its own write may fail for the same reason, and is
    // then retried; the halt does not depend on it).
    scheduler().halted.add(loop.id);
    throw new LoopRefused(
      `step ${result.step} of loop ${loop.id} is on chain (seq ${result.seq ?? "?"}) but could not be recorded: ` +
        `${(e as any)?.message ?? e}; stopped so that index is not run again`
    );
  }

  /**
   * One bundle for the step: its session's preimages and sub-blobs, the memory it committed, and
   * the checkpoint's own two blobs — under one cell keyed by the session's genesis
   * (`sdk/src/bundle.ts`). That is what lets a reader with no raw gateway open a step's memory,
   * and what `lath-audit --require-preimages` walks with the console stopped.
   *
   * After the registry write, deliberately: the seal is a chain write of its own and a step that
   * is on chain but not in `loops.json` would be run again under the same index. It never
   * throws, the summary already carries the key, and a seal that did not land leaves that
   * session's preimages `unavailable` until one is run by hand.
   */
  /**
   * A step whose writes did not land cannot seal for the same reason it cannot checkpoint — the
   * seal is a chain write and its records are still journaled — and it never reaches the `work`
   * hook, so `stepGenesis` is unset on exactly that path. The deferred plan carries the key, and
   * the note goes on disk for the retry to pay.
   */
  const deferredKey = result.deferredCheckpoint?.genesisPayloadHash;
  if (!stepGenesis && deferredKey) {
    await deferSeal(loop.agentId, {
      genesisPayloadHash: deferredKey,
      hashes: [...stepTraces.hashes],
      at: Date.now(),
    });
  }
  const sealed = stepGenesis
    ? await stepTraces.seal(stepGenesis)
    : {
        error: deferredKey
          ? "not sealed: this step's records are not on chain yet; the retry seals it when they land"
          : "this step logged no genesis, so its bundle has no key",
      };
  if (sealed.error) {
    console.warn(`[loops] step ${result.step} of ${loop.id} was not sealed: ${sealed.error}`);
  }
  const bundle: LoopStepSummary["bundle"] = sealed.error
    ? { error: sealed.error }
    : { scheme: sealed.locator!.scheme, id: hex(sealed.locator!.id), count: sealed.count!, bytes: sealed.bytes! };
  try {
    updateLoop(loop.id, (l) => ({
      ...l,
      history: l.history.map((h) => (h.step === result.step ? { ...h, bundle } : h)),
    }));
  } catch (e) {
    // Cosmetic: the bundle is on chain (or is not) whatever this file remembers about it.
    console.warn(`[loops] the bundle of step ${result.step} was not recorded: ${(e as any)?.message ?? e}`);
  }

  // The step's postures in clear on Irys, the first time each is seen. After the registry write and
  // the seal, like them never failing the step: the posture is committed under the Genesis whether
  // or not a copy is on Irys, and a page without one verifies from this console's copy.
  await publishStepPostures(loop.id, summary);

  // Locators queued for a manifest survive a restart through `anchors.json`; a loop that has just
  // stopped flushes them now, so its last epochs are discoverable from the chain. Neither step may
  // fail the step: it is recorded already, and an epoch left unanchored is found again on the next
  // flush (idempotent by manifest hash), whereas a step re-run is a second step. A run stopped on
  // `anchor-failed` flushes nothing here: `flushAnchors` writes no cell while the chain carries
  // journaled records, and the Retry pays what is owed.
  if (snapshot.status === "stopped") {
    try {
      await runtime.flushAnchors();
    } catch (e) {
      console.warn(`[loops] manifest flush for ${loop.agentId} failed: ${(e as any)?.message ?? e}`);
    }
  }
  try {
    savePendingAnchors(hex(idBytes), epochStore.pendingAnchors);
  } catch (e) {
    console.warn(`[loops] anchors.json for ${loop.agentId} not written: ${(e as any)?.message ?? e}`);
  }

  // The other end of the storage reading: after the seal and, on a last step, the manifest flush,
  // which are this step's writes too. Recorded like the bundle — a row without it renders no card,
  // and nothing about the step depends on it. With `LATH_ANCHOR_EVERY=K` a queued epoch's locator
  // cell lands on a later step and is counted there, which is where it was paid. A step whose writes
  // are still journaled gets none: what it paid so far is not what it costs, and the Retry that lands
  // them runs outside this window.
  const storage = result.deferredCheckpoint
    ? undefined
    : stepStorageOf({ source: "console", before: storageBefore, after: await ctx.storageMeter(), bundle });
  if (storage) {
    try {
      updateLoop(loop.id, (l) => ({
        ...l,
        history: l.history.map((h) => (h.step === result.step ? { ...h, storage } : h)),
      }));
    } catch (e) {
      console.warn(`[loops] the storage of step ${result.step} was not recorded: ${(e as any)?.message ?? e}`);
    }
  } else if (!result.deferredCheckpoint) {
    console.warn(`[loops] step ${result.step} of ${loop.id}: no storage reading was attributable to it`);
  }

  afterLoopStep(id);
}

/**
 * What a completed step leaves the record's status and stop reason as.
 *
 * A stop that landed mid-step stays what it was: the step it interrupted still finished and is
 * recorded, and the loop simply does not schedule another. So does a pause, unless the step itself
 * stopped the run: the page tells the owner a running step finishes before the pause takes, so
 * pausing mid-step is the ordinary case, and keeping the pause would erase that step's own stop — a
 * trace-audit veto, an escalation, Jev's goal reached, `anchor-failed`, a sandbox refusal — from a
 * record that would then read paused with no reason. Resume would step on past it, and past what
 * Retry guards on `anchor-failed`: the owed checkpoint, the gate's log and the settlement receipt.
 * The step's stop wins over a pause, as it would over a running record; an outside stop still wins
 * over both.
 *
 * Only a step that *itself* ended the run may write the reason. `LoopRunner` sets `stopReason` only
 * in `stop()`, so a step that merely completed carries none — and taking it whenever the record
 * already read `stopped` would erase the reason an outside stop had just written. `stopLoop` always
 * writes one, so a stopped run with no reason could only come from here: `LoopList` would render it
 * as *stopped: unknown*, and `unarchive`'s "1 loop it stopped" note filters on the string that
 * would have been wiped.
 *
 * Out here as a pure function because it is the whole of the rule and the rest of `runOneStep`
 * needs a session, a chain and a paid transport to reach.
 *
 * `sandbox` is one of those reasons: a step whose sandbox was refused for a reason every later step
 * would meet stops the run, and the refusal — the tree's sentence, the wrapper's — is the
 * `stopDetail` the loop page prints after _Stopped:_. It is not `resumable`: the workspace is as
 * the step left it, and running again would be refused again until the owner acts on it.
 */
export function statusAfterStep(
  current: Pick<LoopRecord, "status" | "stopReason" | "stopDetail"> & Partial<Pick<LoopRecord, "maxSteps">>,
  snapshot: Pick<LoopSnapshot, "status" | "stopReason" | "stopDetail"> & Partial<Pick<LoopSnapshot, "steps">>
): { status: LoopRecord["status"]; stopReason?: string; stopDetail?: string } {
  const stoppedByThisStep =
    (current.status === "running" || current.status === "paused") && snapshot.status === "stopped";
  if (!stoppedByThisStep) {
    return { status: current.status, stopReason: current.stopReason, stopDetail: current.stopDetail };
  }
  return { status: "stopped", stopReason: snapshot.stopReason, stopDetail: goalReachedDetail(current, snapshot) };
}

/**
 * The sentence `/loop/[id]` renders after *Finished:* — `goal reached after k of n steps`.
 *
 * Composed here because the runner has no sentence to hand back: `stop("goal-reached")` names a
 * reason, and the two numbers that make the line readable are the step count in the snapshot and
 * the ceiling on the record. The detail the runner *did* write wins, so a later `LoopRunner` that
 * carries its own wording is not overwritten by this one.
 *
 * Only when both numbers are there: a detail reading *after undefined of undefined steps* is
 * worse on screen than no detail at all, which the page already handles by rendering nothing.
 */
function goalReachedDetail(
  current: Partial<Pick<LoopRecord, "maxSteps">>,
  snapshot: Pick<LoopSnapshot, "stopReason" | "stopDetail"> & Partial<Pick<LoopSnapshot, "steps">>
): string | undefined {
  if (snapshot.stopDetail) return snapshot.stopDetail;
  if (String(snapshot.stopReason) !== GOAL_REACHED_STOP_REASON) return undefined;
  if (typeof snapshot.steps !== "number" || typeof current.maxSteps !== "number") return undefined;
  return `goal reached after ${snapshot.steps} of ${current.maxSteps} steps`;
}

/**
 * The uploader postures go up through: `irysSourcesUploader` on this console's settings, built once
 * and on first use. `null` on a console that does not anchor to Irys or has no keypair, which
 * publishes no posture — the same rule the sources follow (`sourcesIrysFor`). A suite sets its own
 * through `setPostureUploaderForTests`.
 */
let postureUploader: { uploader: SourcesUploader | null } | null = null;

function postureUploaderFor(): SourcesUploader | null {
  if (!postureUploader) {
    const settings = irysSourcesSettings();
    const server = settings.publish ? loadKeypair() : null;
    postureUploader = {
      uploader: server
        ? irysSourcesUploader({ wallet: server, network: settings.network, rpc: settings.rpc, node: settings.node })
        : null,
    };
  }
  return postureUploader.uploader;
}

/** A suite's uploader in place of the console's; `undefined` goes back to the console's own. */
export function setPostureUploaderForTests(uploader: SourcesUploader | null | undefined): void {
  postureUploader = uploader === undefined ? null : { uploader };
}

/**
 * Puts each posture `row` names that this loop has no Irys id for on Irys, and records the ids on
 * the loop's row under `postures`. Once per posture hash: a loop whose posture never changes
 * uploads once, at its first step, and again only when a later step's posture hash differs (an
 * owner who changed the loop's tools, a new binary). A posture another loop on this console already
 * published is named, not uploaded twice. Never throws: a failed upload is a warning and is tried
 * again on the next step, since the row still has no id for that hash.
 */
export async function publishStepPostures(loopId: string, row: LoopStepSummary): Promise<void> {
  try {
    await publishStepPosturesOnce(loopId, row);
  } catch (e) {
    // The registry reads below throw on a `loops.json` that cannot be read; the step is recorded
    // already, and the next step asks for the same postures again.
    console.warn(`[loops] the postures of ${loopId} were not published: ${errorText(e)}`);
  }
}

async function publishStepPosturesOnce(loopId: string, row: LoopStepSummary): Promise<void> {
  const loop = readLoop(loopId);
  if (!loop) return;
  const wanted = posturesToPublish(loop, row);
  if (!wanted.length) return;
  const uploader = postureUploaderFor();
  if (!uploader) return;
  const settings = irysSourcesSettings();
  const gateway = settings.gateway.replace(/\/+$/, "");
  const found: Record<string, LoopPostureIrys> = {};
  for (const p of wanted) {
    const known = knownPosture(Object.values(readLoops()), p.hash, settings.network);
    if (known) {
      found[p.hash] = known;
      continue;
    }
    try {
      found[p.hash] = { id: await publishPosture(p, uploader), network: settings.network, gateway };
    } catch (e) {
      console.warn(`[loops] the posture ${p.hash} of ${loopId} was not put on Irys: ${errorText(e)}`);
    }
  }
  if (!Object.keys(found).length) return;
  try {
    updateLoop(loopId, (l) => ({ ...l, postures: { ...(l.postures ?? {}), ...found } }));
  } catch (e) {
    // The bytes are on Irys either way; only this console's pointer to them is lost, and the page
    // falls back to its own copy, which the next step's upload attempt will replace.
    console.warn(`[loops] the posture ids of ${loopId} were not recorded: ${errorText(e)}`);
  }
}
