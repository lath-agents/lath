/**
 * Opening and settling a loop's one Tempo channel, and the runner a step and a settle share
 * (`_lib/loops.ts` re-exports what was public).
 *
 * These are one module because they call each other in a cycle no boundary can cut without changing
 * the code: a step's runner (`runnerBaseFor`) opens the channel; the settle writes its
 * `loop.settlement` record through that same runner; opening through the loop's key stops the loop
 * when the key is spent; and `stopLoop` settles the channel. What the console knows of a channel
 * without touching it is `loop-channel-state.ts`; the key's rows and revoke are `loop-key.ts`.
 */
import { PublicKey } from "@solana/web3.js";
import {
  BillingClient,
  DEFAULT_AGENT_DYNAMIC_CONFIG,
  EventKind,
  FileTraceStore,
  LathClient,
  RecordingTraceStore,
  LocatorRegistry,
  hex,
  idFromString,
} from "@lath/sdk";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type ChatTransport,
  LoopRunner,
  type LoopRunnerOptions,
  NoopBilling,
  PaidCallFailed,
  type StepWork,
  retiredHireTool,
  type TempoChannel,
  type TempoSettlement,
  PostureRefused,
  type SessionResult,
} from "@lath/runtime";
// Server-only, and so not in the package index the client pages import (see `runtime/src/index.ts`).
import { ZeroClawRuntime } from "@lath/runtime/zeroclaw/runtime";
import { stepReportFile } from "@lath/runtime/zeroclaw/report";
import { templateSystemPrompt } from "./templates";
import { anchorQueue, bindAnchorChain, carriedCharges } from "./anchor";
import { type Rail, base6, openChannelLedger, openTempoChannel, railFor } from "./tempo";
import { defaultSourcesDeps } from "./sources";
import { sourcesRefreshNoteFor } from "./sources-refresh";
import { setStepStage, stagedTransport } from "./loop-stage";
import { LoopKeyReadFailedError } from "./tempo-keys";
import { OPT_IN_TOOL_NAMES, TOOL_NAMES, consoleTools, scriptedTransport, scriptedTurns } from "./tools";
import {
  CLUSTER,
  type DeployedAgent,
  MAX_STEPS as MAX_SESSION_STEPS,
  RPC_URL,
  TRACE_DIR,
  TREASURY_ADMIN,
  runSlotHolder,
  admitSpend,
  deployedRoles,
  ensureAgent,
  ensureFunded,
  epochsSupported,
  loadKeypair,
  lookupAgent,
  rpcFor,
  traceBackend,
} from "./runner";
import type { LifecycleActorContext } from "./lifecycle";
import { errorText, grantsRefusal, LoopKeyStopped, LoopRefused, SLOT_RETRY_MS, STEP_DEADLINE_MS } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import {
  admitStepSpend,
  digits,
  loopBudgetKeys,
  loopDrainRefusal,
  loopFundedHeadroom,
  stepAdmission,
} from "./loop-budget";
import { cancel, scheduler, SETTLE_SLOT_WAIT_MS, stepSlotHolder, withRunSlotWaiting } from "./loop-state";
import { payOwedLifecycleUnderSlot, readLoop, updateLoop, withTransitionActor } from "./loop-registry";
import { jevMeteredTransport, loopNoAnswer, persistOwnerSpend } from "./loop-meter";
import {
  loopSources,
  SANDBOX_TIMEOUT_MS,
  sandboxFor,
  sandboxNarrowed,
  sandboxToolNames,
  sandboxTurns,
  sandboxWorkspace,
} from "./loop-sandbox";
import { publishReceiptAfterStop } from "./loop-receipt";
import {
  channelIdleMs,
  clearIdleTimer,
  heldChannelShort,
  type LoopChannel,
  loopChannelCaps,
  type LoopChannelHooks,
  loopChannelsCommitted,
  loopChannelSizing,
  loopOwnerFunds,
  sameChannelId,
  treasuryHeld,
  waitForStep,
} from "./loop-channel-state";
import {
  isSpendingLimitExceeded,
  KEY_READ_FAILURES_BEFORE_STOP,
  keyLimitDetail,
  largerDeposit,
  loopCloseById,
  LoopKeyDeferred,
  loopKeyRows,
  loopKeySeams,
  noteKeyChannels,
  openDepositOf,
  rememberKeyChannelClosed,
  revokeAfterStop,
  signedCumulativeOf,
  STORAGE_CHARGES_UNDER_KEY,
} from "./loop-key";
import { loopTempoServices, releaseTempoServices, rememberStepRow, rememberStepStorage } from "./loop-services";
import {
  epochStoreFor,
  type IrysBalance,
  type LoopRunnerContext,
  loopStepPolicy,
  toldSourcesNote,
} from "./loop-step-base";

// ─── The loop's one Tempo channel ──────────────────────────────────────
//
// A loop holds **one** TIP-1034 channel for its whole run rather than one per step. A channel per
// step would cost an open and a close on every tick — 36 s of wall clock for a two-call step,
// serialised behind the treasury lock — and write one `loop.settlement` record per step; one per
// loop also gives an auditor a single `ChannelClosed.finalAmount` that bounds every step's delta.
// What it costs in return is a deposit that stays out while the loop is idle, which is what
// `channelIdleMs` bounds.
//
// The transport lives in this process and nowhere else: mppx refuses to close a channel through
// a `SessionManager` it did not itself open ("no URL available … recreated"), so a channel never
// outlives as a *session* the process that opened it. What outlives it is the row on disk, and
// `settleLoopChannel` settles that one through the treasury's key instead.

/**
 * The rail a deployed agent's own row asks for, when it names one.
 *
 * Read through a cast: writing `payment` onto the row is the deploy and launch forms' half of this
 * module, and an older row that predates the rail names nothing — which `railFor` reads as "the
 * default".
 */
function recordedRail(agent: DeployedAgent): Rail | undefined {
  const named = (agent.policy as { payment?: string } | undefined)?.payment;
  return named === "tempo" || named === "vault" ? named : undefined;
}

/**
 * Arms the idle settle for a loop that still holds a channel. Cleared at the next step. `hooks`
 * are the caller's, so a test that armed the timer settles through its own seams rather than the
 * treasury's.
 */
function armIdleTimer(loop: LoopRecord, hooks: LoopChannelHooks = {}): void {
  // Settled, not stopped: a running loop simply opens a fresh channel on its next step.
  armSettleTimer(loop.id, "idle", channelIdleMs(loop), hooks);
}

/**
 * Settles the channel this process holds for loop `id` after `delayMs`, unless the next step
 * clears the timer first (`openLoopChannel` does, since a step that has started is not quiet).
 *
 * Also how a settle that found the run slot taken comes back (`deferSettle`): on the same map as
 * the idle timer, so a step that starts in the meantime cancels it and decides for itself — a
 * billed step goes on paying through the channel, an unbilled one fires its own settle after it.
 */
function armSettleTimer(id: string, reason: string, delayMs: number, hooks: LoopChannelHooks): void {
  const s = scheduler();
  clearIdleTimer(id);
  if (!s.channels.has(id)) return;
  const timer = setTimeout(() => {
    s.idle.delete(id);
    void settleLoopChannel(id, reason, hooks);
  }, delayMs);
  timer.unref?.();
  s.idle.set(id, timer);
}

/**
 * The rail this loop runs on and the channel this step pays through, or `null` when nothing is
 * paying for this step — including a loop that still holds a channel from an earlier billed step
 * and whose owner's allowance no longer admits this one.
 *
 * The rail is decided **once**, at the loop's first billed step, and written on the row: a loop
 * rehydrated after a restart, or one whose agent row was rewritten by a redeploy in the meantime,
 * keeps stepping on the rail its earlier steps committed in `policy_version_hash`. A treasury
 * switched off since still leaves this step scripted — there is nothing to sign a voucher with and
 * no key to fall back to — but that is a note about the step, not a new rail for the loop.
 *
 * The deposit is sized for the steps this run has **left**, not for a session's `maxSteps`: one
 * channel now covers the rest of the loop, and `tempoCanCover` inside `openTempoChannel` reads
 * the treasury once, here, rather than on every tick.
 */
export async function openLoopChannel(
  loop: LoopRecord,
  agent: DeployedAgent,
  billed: boolean,
  hooks: LoopChannelHooks = {},
  /**
   * Whether the caller holds the run slot this loop's step takes (`stepSlotHolder`), which decides
   * how the restart settle below runs. Read off the slot when not given, because the step reaches
   * here through `runnerBaseFor` and says nothing; a caller that holds no slot says `false`.
   */
  slotHeld: boolean = runSlotHolder() === stepSlotHolder(loop.id)
): Promise<LoopChannel | null> {
  const s = scheduler();
  // A channel is armed to settle itself if the loop goes quiet; a step that has started is not
  // quiet, and `afterLoopStep` puts the timer back on when the step is done.
  clearIdleTimer(loop.id);
  const held = s.channels.get(loop.id);
  if (held) {
    if (billed) return held.channel;
    // An unbilled step is paid for by nobody, so it may not reach the treasury's channel: only a
    // charged step is paid for over MPP (`runnerBaseFor`). Handing the held channel to every step
    // once one was open would let a loop whose allowance lapsed mid-run keep making paid model
    // calls on the operator's deposit and committing `payment: "tempo"` for steps nobody was
    // charged for. The step runs scripted instead, and the channel is settled *after* it
    // (`afterLoopStep`) rather than here: `settleLoopChannel` waits out the step in flight, which
    // is this one, and rebuilds a runner of its own.
    //
    // Before the restart branch below, which must not run while this process holds a channel.
    updateLoop(loop.id, (l) => ({
      ...l,
      tempoNote:
        "the owner's allowance no longer pays for this loop's steps, so this step ran scripted and unbilled; " +
        "the channel it held is settled after the step",
    }));
    return null;
  }
  // A row naming a channel with no session behind it in this process is a restart: mppx cannot
  // close a channel through a `SessionManager` it did not itself open, so the old one is settled
  // through the treasury's key and this step opens a fresh one below.
  //
  // The settle writes `loop.settlement` on this loop's chain, so it runs under the run slot. A step
  // already holds it, and the slot is not re-entrant, so a step's settle runs under the step's; any
  // other caller takes it or, finding it taken, settles nothing now. A row still naming the channel
  // afterwards opens nothing on top of it: that would be a second deposit beside one nobody holds,
  // and such a caller then runs scripted with the reason, as it does when the treasury cannot cover
  // the deposit.
  //
  // The same check after a step's own settle: under the slot the settle is not refused for the slot,
  // but it can still come back without closing the channel (Tempo did not answer, the close did not
  // land), and a step that then opened a fresh channel would leave the old deposit beside it with
  // nothing holding it. The step runs scripted instead, and the next one tries the settle again.
  if (loop.channel) {
    if (slotHeld) await settleChannelUnderSlot(loop.id, "restart", hooks);
    else await settleLoopChannel(loop.id, "restart", hooks);
    if (readLoop(loop.id)?.channel) {
      const note = slotHeld
        ? "the Tempo channel an earlier process left open on this loop could not be settled yet, so this step " +
          "ran scripted and unbilled rather than open a second one beside it; the next step tries the settle again"
        : "the Tempo channel an earlier process left open on this loop could not be settled yet (the run slot " +
          "was taken), so this call ran scripted and unbilled rather than open a second one beside it";
      console.warn(`[loops] ${loop.id}: ${note}`);
      updateLoop(loop.id, (l) => ({ ...l, tempoNote: note }));
      return null;
    }
  }

  // `undefined` rather than `"scripted"`: `rail` on the row is what the loop's records commit in
  // `policy_version_hash`, and a step that paid nobody commits no rail at all.
  const outcome = billed ? railFor(recordedRail(agent), true) : undefined;
  const decided: Rail | undefined = loop.rail ?? (outcome === "tempo" ? "tempo" : undefined);
  if (decided && decided !== loop.rail) updateLoop(loop.id, (l) => ({ ...l, rail: decided }));

  let note: string | undefined;
  let channel: LoopChannel | null = null;
  if (decided === "tempo" && billed) {
    // A treasury switched off since the loop started: there is nothing left to sign a voucher
    // with and no key to fall back to, so this step runs scripted with the reason on the row —
    // and `rail` above is left as it is, because the steps already taken committed it in
    // `policy_version_hash`.
    if (railFor("tempo", true) !== "tempo") {
      note = "this deployment has no Tempo treasury configured, so the step ran scripted and unbilled";
    } else if (await settlementStillOwed(loop.id, slotHeld, hooks)) {
      // A new channel's settlement would overwrite `snapshot.tempo`, the only place an owed
      // record's receipt is kept: the record first, and no channel until it is written.
      note =
        "this loop's last Tempo channel is closed but its loop.settlement record is not written yet, so this call " +
        "ran scripted and unbilled rather than open a channel whose settlement would replace that receipt";
    } else {
      const opened = await (hooks.open ?? defaultOpenChannel)(loop);
      if ("degrade" in opened) note = opened.degrade;
      else {
        channel = opened.channel;
        s.channels.set(loop.id, { channel, openedAt: Date.now(), openedAtStep: loop.snapshot.steps });
      }
    }
  }
  if (note) console.warn(`[loops] ${loop.id} steps unpaid for: ${note}`);
  // Written every time a step decides, so the row says why *this* step ran where it did and a
  // treasury that has been topped up since clears the note rather than leaving it standing.
  if (note || loop.tempoNote) updateLoop(loop.id, (l) => ({ ...l, tempoNote: note }));
  return channel;
}

/**
 * Whether this loop still owes the `loop.settlement` record of a channel that is closed, after
 * trying to write it when the caller holds the run slot: a channel a restart's recovery pass closed
 * by id leaves its receipt on the snapshot as owed, and so does a settle on a chain whose journal
 * was not clear. Written here through Retry's own path (`payOwedSettlement`, which replays the
 * stored receipt), by a step about to open a fresh channel; a caller without the slot writes
 * nothing and opens nothing.
 */
async function settlementStillOwed(id: string, slotHeld: boolean, hooks: LoopChannelHooks): Promise<boolean> {
  if (!readLoop(id)?.snapshot.tempo?.recordOwed) return false;
  if (!slotHeld) return true;
  return payOwedSettlement(id, hooks);
}

/**
 * Writes what this process knows about the loop's channel onto its row: the id a recovery has to
 * name, and the cumulative after the last paid call, which is the meter a screen shows ticking up
 * across the run.
 *
 * Nothing is written before the first paid call — the transport opens the channel lazily, so
 * until then there is no id and nothing is held.
 */
export function rememberLoopChannel(id: string): void {
  const held = scheduler().channels.get(id);
  const channelId = held?.channel.channelId;
  if (!held || !channelId) return;
  updateLoop(id, (l) => ({
    ...l,
    channel: {
      channelId,
      payer: held.channel.payer,
      openedAt: held.openedAt,
      openedAtStep: held.openedAtStep,
      cumulative: held.channel.cumulative ?? "0",
    },
  }));
  // A keyed loop notes the channel and its deposit as of this call; nothing for any other loop.
  noteKeyChannels(id);
}

/**
 * The channel as it opens for real: `openTempoChannel` against the treasury, sized by
 * `loopChannelSizing` over what the owner has funded right now. Read here rather than handed in,
 * because the path that opens a channel — a step (`runnerBaseFor`) — has just admitted the call on
 * the same two reads, and the open is once per channel. Nothing funded, or funds that could not be
 * read, open nothing: the step runs scripted with the reason, as it does on a short treasury.
 */
async function defaultOpenChannel(loop: LoopRecord): Promise<{ channel: LoopChannel } | { degrade: string }> {
  const funds = await loopOwnerFunds(loop);
  const funded = funds ? loopFundedHeadroom({ loop, ...funds }) : 0n;
  if (funded === 0n) {
    return {
      degrade: funds
        ? "the owner's allowance and escrow back none of what is left of this loop's budget, so no channel is opened"
        : "the owner's allowance and escrow could not be read, so no channel is opened on the declared budget alone",
    };
  }
  const sizing = loopChannelSizing(loop, funded);
  // The treasury's balance less what other loops' channels can still top up from it: two loops
  // each checked against the whole balance would both be let open on the same USDC.e.
  const committed = loopChannelsCommitted(loop.id);
  if (committed > 0n) {
    const held = await treasuryHeld();
    if (held === null || held - committed < sizing.maxDepositBase) {
      return {
        degrade:
          held === null
            ? "the operator's Tempo treasury could not be read"
            : `the operator's Tempo treasury holds ${base6(held)} USDC.e, ${base6(committed)} of it committed to ` +
              `other loops' open channels, and this loop's channel needs ${base6(sizing.maxDepositBase)}; ` +
              "it runs scripted and unbilled instead",
      };
    }
  }
  const terms = {
    ...sizing,
    agentId: loop.agentId,
    loopId: loop.id,
    // A restart settles what the ledger still names before this loop's first deposit: another
    // loop's row goes through its own settle so the record lands on its chain. The row goes with
    // the id, as the boot pass passes it (`instrumentation.ts`), so a row this loop's settle cannot
    // settle — the step holds the slot — is closed with its receipt kept.
    recovery: {
      settleLoop: (loopId: string, row: { channelId: string; payer: string }) =>
        settleLoopChannel(loopId, "restart", {}, row),
    },
  };
  // A loop with an access key opens under it and nothing else: reconciled first, signed by the key,
  // and retried once past a limit refusal. This is also the restart path — a console that comes
  // back to a running keyed loop reaches its first open here, so the reconcile runs before it.
  const opened = loop.tempoKey
    ? await openThroughLoopKey(loop, (account) => openTempoChannel({ ...terms, account }))
    : await openTempoChannel(terms);
  if ("channel" in opened) loopChannelCaps().set(loop.id, sizing.maxDepositBase);
  return opened;
}

/**
 * Settles this loop's channel, whatever brought the loop to a halt: a stop, an archive, an error,
 * the consecutive-failure stop, `max-steps`, the idle timer, or a restart that found a channel on
 * the row and no session behind it.
 *
 * Every one of those has to come through here. A channel is the only hold a `tempo`-rail loop has
 * and only the payer's key can close it, so one left open strands the operator's USDC.e with
 * nothing but the step blobs naming it — and with one channel per loop that is the whole run's
 * deposit rather than one step's.
 *
 * **Under the run slot, one at a time per loop.** A settlement is a chain write —
 * `LoopRunner.settle()` drains the queue and appends `loop.settlement`, and the runner it is built
 * on re-binds the chain's writer and billing — so it takes the slot every other writer takes.
 * Without it, a Stop followed by *Run again* on the same agent would let the old run's record take
 * the seq the new run's first step had journaled against, and that run would stop `anchor-failed`
 * with a journal only Discard could clear; an `unbilled` settle and the next step's `restart`
 * settle could close one channel twice. So every call for a loop queues behind the one before it
 * (`loopSettling` says whether one is in flight, which a start on the same agent is refused for),
 * and each takes the slot for its write. How long it waits for the slot is the reason's:
 *
 * - `idle` and `unbilled` try once. The run is still going and still holds the channel, so a slot
 *   taken by someone else puts the settle back on a timer (`deferSettle`) rather than writing
 *   beside them — and rather than dropping it, which would leave the deposit out for good.
 * - `restart` tries once. It is asked by a caller without the slot, which then opens nothing on top
 *   of the row, or by the treasury's recovery pass, which closes a row its loop could not settle by
 *   id: either way nothing is stranded, and a restart settle that waited could wait on the very
 *   caller that awaits it (`openTempoChannel` awaits the recovery pass before its first deposit).
 * - Every other reason is a run that has ended and nothing else will settle it, so it waits for the
 *   slot — out a step in flight, then out whoever holds it — up to `SETTLE_SLOT_WAIT_MS`.
 *
 * A settle that runs inside a step, which already holds the slot, goes through
 * `settleChannelUnderSlot` instead: the slot is not re-entrant, and taking it again there would
 * wait on the step that is waiting for it.
 *
 * Never throwing: a close that fails leaves `closed: false` with the reason on the snapshot rather
 * than failing whatever was stopping the loop.
 *
 * The record is written by `LoopRunner.settle()` rather than here, because the `loop.settlement`
 * Action takes a real seq on the loop's own chain and the runner is what owns that.
 */
export function settleLoopChannel(
  id: string,
  reason = "stopped",
  hooks: LoopChannelHooks = {},
  /**
   * The channel ledger's own row, when a caller has one this loop's record does not. A console
   * killed early in a loop's first step can write the ledger row and die before the `channel` field
   * reaches the loop record, so reading only the record would settle nothing and strand the deposit
   * while the resumed loop opened a second channel on top of it.
   */
  ledgerRow?: { channelId: string; payer: string }
): Promise<TempoSettlement | undefined> {
  const s = scheduler();
  // A keyed loop's channel is noted before anything can turn this settle away: a restart settle
  // that finds the slot taken leaves the row to the recovery pass, which closes it by id. Caught,
  // because it reads the registry and this function is called — and not awaited — by stops, timers
  // and the end of a step, none of which has anything to catch a synchronous throw with: an
  // unreadable `loops.json` must cost the note, not the settle behind it.
  try {
    noteKeyChannels(id, ledgerRow);
  } catch (e) {
    console.warn(`[loops] ${id}: the key's channels were not noted before the settle: ${errorText(e)}`);
  }
  // One promise per loop, each call chained behind the last: two settles of one loop are two
  // writes of one record and two closes of one channel, and the second must find the first done.
  const before = s.settles.get(id) ?? Promise.resolve(undefined);
  // And after the settle, in the same queue, the revoke of a stopped loop's access key: only once
  // the channel is closed, so the key can still sign the cooperative close. A loop without a key
  // returns from `revokeAfterStop` on its first read.
  //
  // Never rejects, as the header promises: every caller fires it with `void` or from a timer, so a
  // rejection — `readLoops` throws on any registry it cannot read — would be an unhandled one, and the
  // revoke and the sweep after a failed settle would be skipped with it. Each part is tried on its own.
  const settleThenRevoke = async (): Promise<TempoSettlement | undefined> => {
    let settlement: TempoSettlement | undefined;
    try {
      const settled = await settleTakingSlot(id, reason, hooks, ledgerRow);
      // A recovery pass's row the settle could not settle is closed here, by id, with its receipt
      // kept on the loop, before the revoke, which waits for the row's channel to go.
      settlement =
        settled ?? (reason === "restart" && ledgerRow ? await closeLeftChannel(id, ledgerRow, hooks) : undefined);
    } catch (e) {
      console.error(`[loops] the channel of ${id} was not settled on ${reason}: ${errorText(e)}`);
    }
    // `revokeAfterStop` never throws and reads the row itself; a row that cannot be read here is the same
    // question asked of it, and it puts itself on its own retry.
    let keys: { tempoKey: boolean; receipt: boolean };
    try {
      const row = readLoop(id);
      keys = { tempoKey: !!row?.tempoKey, receipt: !!row?.receipt };
    } catch {
      keys = { tempoKey: true, receipt: true };
    }
    if (keys.tempoKey) await revokeAfterStop(id);
    // Last, the receipt: after the settle, so its Tempo figure is what the close paid. It never
    // throws, and does nothing unless the loop stopped on Jev's achieved.
    if (keys.receipt) await publishReceiptAfterStop(id);
    return settlement;
  };
  const run = before.then(settleThenRevoke, settleThenRevoke);
  s.settles.set(id, run);
  const done = () => {
    if (s.settles.get(id) === run) s.settles.delete(id);
  };
  run.then(done, done);
  return run;
}

/**
 * The channel a recovery pass handed this loop and the loop's settle left open — the run slot was
 * taken, or building the settle's runner threw (an RPC read, an agent no longer in `agents.json`) —
 * closed here by id, and its receipt kept on the loop as a settlement whose record is owed. A pass
 * that closed such a row itself and forgot it would leave the loop's own row naming a channel
 * nobody would ever settle again: a stopped loop would then refuse every start on its agent for
 * good and keep its access key authorized (`revokeAfterStop` waits on `channel`), and a running
 * one's next step would settle the closed channel again and write `closed, nothing settled` on
 * chain for a channel that had paid out. The close is the pass's own — `closeChannelById`, under
 * the loop's key when it has one — and needs no run slot: only the record is a chain write, and the
 * record is what is owed. A stopped loop's Retry replays it from the receipt (`payOwedSettlement`),
 * a running loop's next billed step does before it opens another channel (`openLoopChannel`).
 *
 * Only a row the ledger still names, of a loop this process has a record of and holds no session
 * for, which is the loop's own `channel` or a channel its record never learnt. Anything else is
 * left to the pass, which closes it by id. A close that throws leaves the row for the pass and the
 * next restart; `undefined` in every case where nothing was closed here.
 */
async function closeLeftChannel(
  id: string,
  row: { channelId: string; payer: string },
  hooks: LoopChannelHooks
): Promise<TempoSettlement | undefined> {
  if (!openChannelLedger().some((r) => sameChannelId(r.channelId, row.channelId))) return undefined;
  const loop = readLoop(id);
  // A step of this loop in flight here is the one whose open ran this pass: it opens a channel of
  // its own next, whose settlement would overwrite the receipt kept here, so the pass closes this
  // row itself.
  if (!loop || scheduler().channels.has(id) || scheduler().inFlight.has(id)) return undefined;
  if (loop.channel && !sameChannelId(loop.channel.channelId, row.channelId)) return undefined;
  let receipt: { txHash?: string; spent?: string };
  try {
    receipt = (await (hooks.closeById ?? loopCloseById(loop))(row.channelId, row.payer)) ?? {};
  } catch (e) {
    console.warn(
      `[loops] the channel ${row.channelId} an earlier process left open on ${id} was not closed: ${errorText(e)}`
    );
    return undefined;
  }
  // With a receipt, a settlement whose record is owed, as `LoopRunner.settle` leaves one on a chain
  // whose journal is not clear. Without one the escrow held nothing — never opened, or closed already —
  // which `LoopRunner` records as nothing at all: the row is dropped, and a settlement on the snapshot
  // that has a transaction is not overwritten by an empty one.
  const settlement: TempoSettlement = receipt.txHash
    ? {
        payer: row.payer,
        channelId: row.channelId,
        closed: true,
        txHash: receipt.txHash,
        ...(receipt.spent !== undefined ? { spent: String(receipt.spent) } : {}),
        recordOwed: true,
      }
    : { payer: row.payer, channelId: row.channelId, closed: true };
  updateLoop(id, (l) => {
    const { channel, ...rest } = l;
    const keepsChannel = !!channel && !sameChannelId(channel.channelId, row.channelId);
    const earlier = l.snapshot.tempo;
    // One owed record per snapshot: an earlier receipt still owed for another channel is not traded
    // for this one, and this one is said in the log instead.
    const replaces = settlement.recordOwed
      ? !(earlier?.recordOwed && !sameChannelId(earlier.channelId, row.channelId))
      : !earlier?.txHash || sameChannelId(earlier.channelId, row.channelId);
    if (!replaces) {
      console.warn(
        `[loops] ${id}: the close of ${row.channelId} (${receipt.txHash ?? "nothing settled"}) is not kept on the ` +
          `snapshot, which still owes the record of ${earlier?.channelId}`
      );
    }
    return {
      ...(keepsChannel ? l : rest),
      ...(replaces ? { snapshot: { ...l.snapshot, tempo: settlement } } : {}),
    } as LoopRecord;
  });
  console.log(
    `[loops] ${id}: closed the channel ${row.channelId} an earlier process left open, by id (${
      receipt.txHash ?? "nothing settled"
    })${settlement.recordOwed ? "; its loop.settlement record is owed" : ""}`
  );
  return settlement;
}

/** A settle's own slot, the one it takes when nothing it runs inside holds one. */
async function settleTakingSlot(
  id: string,
  reason: string,
  hooks: LoopChannelHooks,
  ledgerRow?: { channelId: string; payer: string }
): Promise<TempoSettlement | undefined> {
  const s = scheduler();
  clearIdleTimer(id);
  // Only a channel *this* process holds can have a voucher in flight: its last one is signed
  // inside `runner.step()`, and a close that overtook it would settle a channel the gateway is
  // about to charge again. Waited out before the slot, which that step holds until it is done.
  if (s.channels.has(id)) await waitForStep(id);
  const once = reason === "idle" || reason === "unbilled" || reason === "restart";
  let settlement: TempoSettlement | undefined;
  const ran = await withRunSlotWaiting(
    `loop ${id} settlement`,
    STEP_DEADLINE_MS,
    async () => {
      // The stop this settle follows goes on chain first, so the chain reads `loop.stop` then
      // `loop.settlement`, the order the run ended in. Never throws; a failure stays owed.
      await payOwedLifecycleUnderSlot(id);
      settlement = await settleChannelUnderSlot(id, reason, hooks, ledgerRow);
    },
    once ? 0 : SETTLE_SLOT_WAIT_MS
  );
  if (ran === "stepped") return settlement;
  if (reason === "idle" || reason === "unbilled") deferSettle(id, reason, hooks);
  else if (reason === "restart") {
    console.warn(`[loops] the channel an earlier process left open on ${id} was not settled: the run slot is taken`);
  } else {
    console.error(
      `[loops] the channel of ${id} was not settled on ${reason}: the run slot stayed taken for ` +
        `${Math.round(SETTLE_SLOT_WAIT_MS / 60_000)} min; it stays on the row for the next restart to settle`
    );
  }
  return undefined;
}

/**
 * A settle of a still-running loop that found the run slot taken, tried again `SLOT_RETRY_MS` later
 * — the wait a step that found it taken has. Not written beside whoever holds it, and not dropped:
 * the channel stays held, so the loop's next billed step pays through it and an unbilled one fires
 * its own settle after it.
 */
function deferSettle(id: string, reason: string, hooks: LoopChannelHooks): void {
  armSettleTimer(id, reason, SLOT_RETRY_MS, hooks);
}

/**
 * The settle itself, for a caller that holds the run slot: `settleTakingSlot` once it has taken
 * it, or a step's restart settle in `openLoopChannel`, which runs under the step's.
 *
 * Idempotent: the transport is taken out of the map and the row cleared here, inside the slot, so
 * the next settle of the same loop finds nothing to settle.
 */
async function settleChannelUnderSlot(
  id: string,
  reason: string,
  hooks: LoopChannelHooks,
  ledgerRow?: { channelId: string; payer: string }
): Promise<TempoSettlement | undefined> {
  const s = scheduler();
  clearIdleTimer(id);
  // The row before the transport leaves the map: a read that throws (an unreadable `loops.json`) must
  // leave the held channel where the next step pays through it and the next settle finds it, not take
  // it out of the only place its session lives with nothing settled.
  const loop = readLoop(id);
  const held = s.channels.get(id);
  s.channels.delete(id);
  const row = loop?.channel ?? ledgerRow;
  if (!loop || (!held && !row)) {
    releaseTempoServices(id);
    return undefined;
  }

  const closeRow = () => (hooks.closeById ?? loopCloseById(loop))(row!.channelId, row!.payer);
  // A channel the loop's row names and the ledger does not was closed by someone else — a recovery
  // pass that closed the loop's row by id and kept no receipt on the loop. Its close by id then
  // finds an empty escrow and answers no receipt, and writing the record anyway would put
  // `closed, nothing settled` on chain for a channel that had paid out. So such a channel is closed first,
  // and only a close that settled something (or failed, which the record says) writes one; an empty
  // answer is the "nothing was opened" settle, which writes no record. A ledger lost from disk is
  // the other way to get here, and its close finds the deposit and returns a receipt as usual.
  let early: { receipt: { txHash?: string; spent?: string } } | { error: unknown } | undefined;
  if (
    !held &&
    !ledgerRow &&
    loop.channel &&
    !openChannelLedger().some((r) => sameChannelId(r.channelId, row!.channelId))
  ) {
    try {
      early = { receipt: (await closeRow()) ?? {} };
    } catch (error) {
      early = { error };
    }
  }
  const channel: TempoChannel = held
    ? held.channel
    : {
        payer: row!.payer,
        channelId: row!.channelId,
        // A row on disk names a channel that was open when it was written, and only a close can
        // say otherwise: `opened: true` is what makes `runSettlement` write the record instead of
        // deciding there was nothing to settle.
        opened: !early || "error" in early || !!early.receipt.txHash,
        close: early
          ? async () => {
              if ("error" in early!) throw early.error;
              return early!.receipt;
            }
          : closeRow,
      };

  // What the key's channel deposited, read before the close takes its ledger row away.
  const keyDeposit = loop.tempoKey && channel.channelId ? openDepositOf(loop, channel.channelId) : undefined;
  // And what the key has signed on it per the ledger and the row, read now for the same reason. The
  // held transport's own cumulative is read after the close instead (below), so a voucher signed
  // while the close waited is counted too.
  const signedOn = loop.tempoKey && channel.channelId ? signedCumulativeOf(loop, channel.channelId) : undefined;
  let settlement: TempoSettlement | undefined;
  try {
    settlement = await (hooks.settle ?? defaultLoopSettle)(loop, channel);
  } catch (e) {
    // `settle()` does not throw; the construction around it can — a chain this process can no
    // longer reach. The channel row stays, so the next step (or the next restart) retries.
    console.warn(`[loops] the channel of ${id} was not settled on ${reason}: ${(e as any)?.message ?? e}`);
    releaseTempoServices(id);
    return undefined;
  }
  // After the settle, never before: its runner is the one handed the services, and drains them into
  // the stop record before either channel closes. A later paid step builds new ones.
  releaseTempoServices(id);
  // A keyed channel that closed joins the key's finished rows, so the next open's reconcile hands
  // back what the close refunded and no more. One whose close failed is still open on Tempo and
  // still in the ledger, where `loopKeyRows` counts its deposit.
  try {
    if (keyDeposit !== undefined && settlement?.closed && settlement.channelId) {
      // Undefined when neither says, so a close with no receipt amount either counts its whole deposit.
      const heldOn = held?.channel.cumulative;
      const keySigned = digits(signedOn) || digits(heldOn) ? largerDeposit(signedOn, heldOn) : undefined;
      rememberKeyChannelClosed(id, settlement.channelId, keyDeposit, settlement.spent, keySigned);
    }
    // The row keeps naming a channel whose close came back `closed: false`: it is still open on Tempo,
    // and the row is what the next step's restart settle (`openLoopChannel`) closes it by. Stripped,
    // the next step would find no channel to settle, open a fresh one beside it, and leave the failed
    // close to the recovery pass alone.
    const stillOpen = settlement?.closed === false;
    updateLoop(id, (l) => {
      const { channel: _settled, ...rest } = l;
      const kept = stillOpen ? l : rest;
      return { ...kept, ...(settlement ? { snapshot: { ...rest.snapshot, tempo: settlement } } : {}) };
    });
  } catch (e) {
    // The close has happened and only this file has its receipt now: said whole in the log, so the
    // operator can put it on the row. Left as it is, the row still names the channel, and the next
    // settle finds its escrow empty and records nothing over it.
    console.error(
      `[loops] ${id}: the channel was settled on ${reason} but the row could not be written (${errorText(e)}); ` +
        `settlement: ${JSON.stringify(settlement ?? null)}`
    );
  }
  return settlement;
}

/**
 * The channel's half of the end of a step: write down where the channel stands, then either arm
 * the idle settle or, if that step ended the run, settle it.
 *
 * A run this step ended — `max-steps`, or the consecutive-failure stop the runner writes into the
 * snapshot — never reaches `stopLoop`, so this is the only place that settles it. The settle is
 * fired rather than awaited: it waits out this very step, and the step is recorded already. It
 * then takes the run slot the step lets go of, so its record lands after the step's and never
 * beside a later writer's.
 *
 * A run that is still going but whose step just ran unbilled while this process held its channel is
 * settled here too. `openLoopChannel` kept that step off the channel; leaving the channel open
 * until the idle timer would never close it, because a loop that keeps stepping is never idle, and
 * the whole remaining deposit — sized for every step the run had left — would stay locked for as
 * long as the allowance stays lapsed. A later billed step opens a fresh one through the ordinary
 * path, on the rail the row already carries.
 */
export function afterLoopStep(id: string, hooks: LoopChannelHooks = {}): void {
  rememberLoopChannel(id);
  // May throw on a registry that cannot be read; both callers catch it (`runOneStep`'s end through
  // `stepNow`, `afterStepFailure` in its own try), and the channel then stays held for the next step.
  const after = readLoop(id);
  if (after?.status !== "running") {
    void settleLoopChannel(id, after?.stopReason ?? "stopped", hooks);
    return;
  }
  // `billing` is what `runOneStep` wrote for the step that just finished, before and after it.
  if (after.billing === "unfunded" && scheduler().channels.has(id)) void settleLoopChannel(id, "unbilled", hooks);
  else armIdleTimer(after, hooks);
}

// ─── Opening through the loop's access key (the rest of the key: `loop-key.ts`) ───

/**
 * Sets the key's limit to the reconcile's target over `loopKeyRows`, or stops the loop
 * `tempo-key-refused`. **Fails closed**: any throw — Tempo unreachable, an update whose outcome is
 * unknown and may land after the next deposit, a recheck that reads the key above its target —
 * stops the loop with the reason and throws, so no open and no retry follows a limit this console
 * cannot vouch for.
 */
async function reconcileLoopKey(id: string): Promise<{ target: string }> {
  noteKeyChannels(id);
  const loop = readLoop(id);
  const s = scheduler();
  let why: string;
  if (loop?.tempoKey) {
    try {
      const reconciled = await loopKeySeams.reconcile(id, loopKeyRows(loop));
      s.keyReadFailures.delete(id);
      return reconciled;
    } catch (e) {
      // A read that failed before anything was sent moved nothing: this step opens nothing and the next
      // one reconciles again, up to `KEY_READ_FAILURES_BEFORE_STOP` in a row (a dead RPC must not spin).
      if (LoopKeyReadFailedError.is(e)) {
        const failures = (s.keyReadFailures.get(id) ?? 0) + 1;
        if (failures < KEY_READ_FAILURES_BEFORE_STOP) {
          s.keyReadFailures.set(id, failures);
          throw new LoopKeyDeferred(
            `the limit of this loop's Tempo access key could not be read (${errorText(e)}), so this step opened ` +
              `no channel and ran unbilled; the next step reconciles again (${failures} of ` +
              `${KEY_READ_FAILURES_BEFORE_STOP} in a row before the loop stops)`
          );
        }
        s.keyReadFailures.delete(id);
        why = `${errorText(e)}, ${failures} reconciles in a row`;
        const detail =
          `the limit of this loop's Tempo access key ${loop.tempoKey.address} could not be read (${why}), so it ` +
          "stopped rather than keep stepping unbilled";
        stopForTempoKey(id, "tempo-key-refused", detail);
        throw new LoopKeyStopped("tempo-key-refused", detail);
      }
      // The reconcile's over-cap error zeroes the limit first and says whether the zero landed
      // (`zeroed`): a key left over its cap can still deposit, and only a revoke from the treasury
      // stops it then.
      const zeroed = (e as { zeroed?: unknown } | null)?.zeroed;
      why =
        errorText(e) +
        (zeroed === true
          ? "; the key's limit was set to zero"
          : zeroed === false
          ? `; setting its limit to zero did not land either, so revoke ${loop.tempoKey.address} from the treasury by hand`
          : "");
    }
  } else {
    why = "the loop's row carries no key to reconcile";
  }
  const detail =
    `the limit of this loop's Tempo access key ${loop?.tempoKey?.address ?? ""} could not be reconciled before ` +
    `paying through it (${why}), so it stopped rather than pay under a limit it cannot vouch for`;
  stopForTempoKey(id, "tempo-key-refused", detail);
  throw new LoopKeyStopped("tempo-key-refused", detail);
}

/**
 * An open, and on Tempo's `SpendingLimitExceeded` one reconcile and one more try: a limit left low
 * by a crash between a close and its reconcile, or by a recovery pass that closed a channel after
 * this open's reconcile, is put right. An open signs no voucher, so the retry pays for nothing
 * twice; a refused open is refused at submission and mines nothing. The reconcile fails closed, and
 * a second refusal stops the loop `tempo-key-limit`.
 */
async function retryOpenOnLimit<T>(id: string, open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (e) {
    if (!isSpendingLimitExceeded(e)) throw e;
    const reconciled = await reconcileLoopKey(id);
    try {
      return await open();
    } catch (again) {
      if (!isSpendingLimitExceeded(again)) throw again;
      const detail = keyLimitDetail(reconciled, false);
      stopForTempoKey(id, "tempo-key-limit", detail);
      throw new LoopKeyStopped("tempo-key-limit", detail);
    }
  }
}

/**
 * The loop's channel with every paid call watched for Tempo's `SpendingLimitExceeded`: mppx opens
 * the channel inside the first paid request and tops it up inside later ones, so that is where a
 * limit refusal surfaces. A proxy rather than a wrapper class, so `channelId`, `cumulative`,
 * `opened` and `close` stay the transport's own getters and methods, and `"decide" in channel`
 * answers as on the transport.
 *
 * **Only a refusal that signed no voucher is retried** (one reconcile, failing closed, then one more
 * try). A call that did sign one — a `PaidCallFailed`, a cumulative that moved, or a call that ran
 * beside another on the channel so neither can be told apart — is never bought again: the error goes
 * back to the runner as it came, so its bracket is recorded, the owner debited and Jev's spend
 * metered, and the loop stops `tempo-key-limit`. After a stop every later call is refused here,
 * before it can sign anything.
 */
function withLimitRetry(id: string, channel: LoopChannel): LoopChannel {
  let active = 0;
  let started = 0;
  let stopped: LoopKeyStopped | null = null;
  const stop = (reconciled: { target: string } | undefined, vouchered: boolean): LoopKeyStopped => {
    const detail = keyLimitDetail(reconciled, vouchered);
    stopForTempoKey(id, "tempo-key-limit", detail);
    stopped = new LoopKeyStopped("tempo-key-limit", detail);
    return stopped;
  };
  const watched =
    (call: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]): Promise<unknown> => {
      if (stopped) throw stopped;
      const mine = ++started;
      active++;
      try {
        // One attempt, and whether it may have signed a voucher if it failed.
        const attempt = async (): Promise<{ ok: unknown } | { err: unknown; vouchered: boolean }> => {
          const before = channel.cumulative;
          const alone = active === 1;
          try {
            return { ok: await call(...args) };
          } catch (err) {
            const overlapped = !alone || active > 1 || started !== mine;
            const moved = channel.cumulative !== before;
            return { err, vouchered: PaidCallFailed.is(err) || moved || overlapped };
          }
        };
        const first = await attempt();
        if ("ok" in first) return first.ok;
        if (!isSpendingLimitExceeded(first.err)) throw first.err;
        if (first.vouchered) {
          stop(undefined, true);
          throw first.err;
        }
        let reconciled: { target: string };
        try {
          reconciled = await reconcileLoopKey(id);
        } catch (e) {
          // A reconcile that stopped the loop stops the channel too, so no other member of the step
          // can keep signing on it. One that only deferred moved nothing: the refusal goes back as
          // it came, unretried, and the next call or step reconciles again.
          if (e instanceof LoopKeyStopped) {
            stopped = e;
            throw e;
          }
          if (e instanceof LoopKeyDeferred) throw first.err;
          throw e;
        }
        const second = await attempt();
        if ("ok" in second) return second.ok;
        if (!isSpendingLimitExceeded(second.err)) throw second.err;
        const why = stop(reconciled, second.vouchered);
        // A voucher the retry signed reaches the runner with its bracket; one that signed none is the stop.
        throw second.vouchered ? second.err : why;
      } finally {
        active--;
      }
    };
  return new Proxy(channel, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      return prop === "chat" || prop === "decide" ? watched(bound) : bound;
    },
  });
}

/**
 * A loop's channel opened through its key: the key's account first — a key whose file is gone stops
 * the loop `tempo-key-missing`, because the only other signer is the treasury and the policy names
 * the key — then the reconcile, then the open with that account, then every paid call retried once
 * past a limit refusal. Out of `defaultOpenChannel` so a suite can hand it an `open` without a
 * treasury.
 */
export async function openThroughLoopKey(
  loop: LoopRecord,
  open: (account: any) => Promise<{ channel: LoopChannel } | { degrade: string }>
): Promise<{ channel: LoopChannel } | { degrade: string }> {
  let account: any = null;
  try {
    account = await loopKeySeams.account(loop.id, loop.tempoKey?.address);
  } catch (e) {
    // A file that cannot be read, or that holds another key than the one the loop committed: either
    // way nothing here may sign for this loop.
    const detail =
      `this loop's Tempo access key ${loop.tempoKey?.address ?? ""} could not be loaded (${errorText(e)}); it ` +
      "stopped rather than pay under any other key";
    stopForTempoKey(loop.id, "tempo-key-refused", detail);
    throw new LoopKeyStopped("tempo-key-refused", detail);
  }
  const why = "its key file is gone";
  if (!account) {
    const detail =
      `this loop pays Tempo through its own access key ${loop.tempoKey?.address ?? ""} and ${why}, so no channel ` +
      "can be opened under it; it stopped rather than pay from the treasury's key, and a channel it left open " +
      "closes through the treasury";
    stopForTempoKey(loop.id, "tempo-key-missing", detail);
    throw new LoopKeyStopped("tempo-key-missing", detail);
  }
  // Fails closed: a reconcile that throws stops the loop here, before anything is opened — except a
  // read that failed before anything was sent, which opens nothing this step and tries again next one.
  try {
    await reconcileLoopKey(loop.id);
  } catch (e) {
    if (e instanceof LoopKeyDeferred) return { degrade: e.message };
    throw e;
  }
  let opened: { channel: LoopChannel } | { degrade: string };
  try {
    opened = await retryOpenOnLimit(loop.id, () => open(account));
  } catch (e) {
    if (e instanceof LoopKeyStopped) throw e;
    if (e instanceof LoopKeyDeferred) return { degrade: e.message };
    // `openTempoChannel` throws, rather than degrading, when the account it is handed is not rooted
    // on this treasury. Nothing here retries on the treasury's key: the loop stops with the reason,
    // as a missing key does, because its policy names the key and no other signer.
    const detail =
      `the Tempo channel of this loop could not be opened under its access key ${loop.tempoKey?.address ?? ""}: ` +
      `${errorText(e)}; it stopped rather than pay from the treasury's key`;
    stopForTempoKey(loop.id, "tempo-key-refused", detail);
    throw new LoopKeyStopped("tempo-key-refused", detail);
  }
  return "channel" in opened ? { channel: withLimitRetry(loop.id, opened.channel) } : opened;
}

/** Stops a loop for its key, with the sentence its page shows; the stop settles, then revokes. */
export function stopForTempoKey(id: string, reason: LoopKeyStopped["reason"], detail: string): void {
  console.warn(`[loops] ${id} stopped ${reason}: ${detail}`);
  stopLoop(id, reason, {}, detail);
}

// ─── The settlement's record, and the runner it shares with a step ───────────

/**
 * What `defaultLoopSettle` is built on: the store the settlement's blobs go through, and the settle
 * itself. The real one is a runner over the loop's chain (`settleOnChain`); a test hands in a
 * recording store and a settle that answers what it is told, because the rule worth pinning — no
 * locator cell for a record still owed — sits between the two and needs neither a chain nor a
 * keypair to check.
 */
export interface LoopSettleSeams {
  build?: (
    loop: LoopRecord,
    channel: TempoChannel
  ) => Promise<{
    traces: Pick<RecordingTraceStore, "entries" | "publish">;
    settle: () => Promise<TempoSettlement | undefined>;
  }>;
}

async function settleOnChain(loop: LoopRecord, channel: TempoChannel) {
  const { base, stepTraces } = await runnerBaseFor(loop, channel);
  return { traces: stepTraces, settle: () => new LoopRunner(base).settle() };
}

/**
 * The settlement as it runs for real: a runner over the loop's chain, which owns the seq.
 *
 * Then the blobs that record it are anchored one cell each. A step's blobs reach a reader who is
 * not us inside the step's bundle, which is keyed by the genesis of the step's session — and a
 * settlement opens no session, so there is no bundle for it and nothing else on chain points at its
 * bytes. Without these cells `verify-channel --gateway` would answer *no preimage* for a settlement
 * that is on chain and readable from this disk. Three cells once per loop is what the whole
 * channel's receipt is worth.
 */
export async function defaultLoopSettle(
  loop: LoopRecord,
  channel: TempoChannel,
  seams: LoopSettleSeams = {}
): Promise<TempoSettlement | undefined> {
  const { traces: stepTraces, settle } = await (seams.build ?? settleOnChain)(loop, channel);
  // Where the settlement's own blobs start: the construction above already put the system prompt
  // through this store, and that one is inside every step's bundle already.
  const before = stepTraces.entries.length;
  const settlement = await settle();
  // A record the runner deferred has nothing on chain for these cells to point at yet, and a cell
  // is a direct write like the record: on a chain whose journal owes an earlier entry it would take
  // that entry's seq, and the Retry would then diverge for good. The Retry writes the record
  // through this same function, and publishes then.
  if (settlement?.recordOwed) return settlement;
  // After the record, never before: the cells are only worth writing for a settlement that
  // happened, and a publish that fails is said out loud rather than thrown — the channel is
  // closed and the record is on chain either way, and `publish` never throws.
  const anchored = await stepTraces.publish(before);
  if (anchored.error) {
    console.warn(`[loops] the settlement blobs of ${loop.id} were not anchored: ${anchored.error}`);
  }
  return settlement;
}

/**
 * Everything a `LoopRunner` for this loop is made of — the chain, the derived key, the billing,
 * the trace store, the tools, the runtime — and the options the runner takes.
 *
 * Out of `runOneStep` because a **settlement** needs the same construction and none of the rest of
 * a step. With one channel per loop the close does not fall inside a tick: it falls on a stop, an
 * archive or an idle timer, with no step running and possibly in a process that never stepped this
 * loop — and the `loop.settlement` record still has to be written by the machinery that owns the
 * chain's seq.
 *
 * `held` is the channel a settlement already has. Passing one suppresses the rail decision and
 * the open below, because a settlement never puts a loop on a rail, and it never makes a call.
 */
export async function runnerBaseFor(loop: LoopRecord, held?: TempoChannel): Promise<LoopRunnerContext> {
  // An older row started with protocol-plugin grants takes no step in this build (`grantsRefusal`):
  // refused first, before the sandbox, the sources, the funding and the channel, so it stops with
  // nothing spent. A settlement (`held`) makes no payment and still closes the channel its earlier
  // steps opened; its runner refuses every step on the policy's grants.
  const noGrants = held ? null : grantsRefusal(loop, "step");
  if (noGrants) throw new LoopRefused(noGrants);
  const server = loadKeypair();
  if (!server || !RPC_URL) throw new LoopRefused("the server has no runtime keypair or RPC configured");

  const deployed = lookupAgent(loop.agentId);
  if (!deployed) throw new LoopRefused("the agent this loop runs is no longer deployed here");
  if (deployed.owner !== loop.owner) throw new LoopRefused("this agent now belongs to another wallet");

  /**
   * The sandbox every session of this step runs in: no working Lath binary or wrapper refuses the
   * step, which stops the loop with the reason — there is no in-process fallback. Asked first,
   * before anything is funded or registered for a step that cannot run. A settlement (`held`) opens
   * no session, so it neither needs a sandbox nor waits on one: a console that lost its binary must
   * still be able to close the channel its loops opened.
   */
  const sandbox = held ? null : sandboxFor();
  /**
   * The loop's sources, read back before anything is funded, for the reason the sandbox is: a step
   * whose sources are gone is refused, not run without them. One read per step serves every sandbox
   * the step opens — session A, each member, the synthesis — so all of them are seeded from one
   * manifest. A settlement opens no sandbox and reads none.
   */
  const sources = sandbox ? await loopSources(loop, sandbox.home, new FileTraceStore(TRACE_DIR)) : undefined;
  /**
   * What changed on chain since the loop's Solana sources were pinned (`sources-refresh.ts`): read
   * once per step, started here so it runs while the step is funded, and handed as one promise to
   * every sandbox the step opens, so all of them are told the same thing. It never rejects — a read
   * that fails is a line of the note — and a loop with no Solana source reads nothing and is told
   * nothing.
   */
  const sourcesNote = toldSourcesNote(
    sources ? sourcesRefreshNoteFor(sources, defaultSourcesDeps(RPC_URL)) : undefined
  );
  const sandboxTools = loop.sandbox?.config.tools;
  // The owner's lowered workspace cap, one for every sandbox of the loop like the sources.
  const sandboxCap = sandboxWorkspace(loop.sandbox?.config);

  const rpc = rpcFor();
  const roles = deployedRoles(server, deployed.name);
  const key = roles.agent.key;
  const idBytes = idFromString(deployed.name);
  const client = LathClient.fromIdl(rpc, key);

  const onChain = await client.getAgentState(idBytes).catch(() => null);
  if (onChain && !onChain.state.authority.equals(key.publicKey)) {
    throw new LoopRefused("this chain is not operated by this runtime");
  }
  // Only `false` read from the program's bytes refuses: a probe that could not read them rejects,
  // and that rejection is let through as a plain error, so the step fails and is retried rather
  // than the loop being stopped for good on a reason that is not true.
  const epochs = await epochsSupported(rpc, client.programId).catch((e: any) => {
    throw new Error(`could not read whether the deployed program has \`commit_epoch\`: ${e?.message ?? e}`);
  });
  if (!epochs) {
    throw new LoopRefused("the deployed program has no `commit_epoch`, and a step is one epoch");
  }

  await ensureFunded(rpc, server, key.publicKey);
  await ensureAgent(client, idBytes, deployed.name);

  // Billing, exactly as a session decides it: a live allowance from the owner to this agent's
  // authority means the step is charged, and only a charged step is paid for over MPP.
  const owner = new PublicKey(loop.owner);
  let billing: NoopBilling | BillingClient = new NoopBilling();
  let billed = false;
  let admission: ReturnType<typeof admitSpend> | null = null;
  // Why this step is not paid through the channel the loop holds, when it is not; see below.
  let channelSpent: string | null = null;
  if (TREASURY_ADMIN) {
    const reader = BillingClient.fromIdl(rpc, key, { admin: new PublicKey(TREASURY_ADMIN), lath: client });
    const grant = await reader.getAllowance(owner, key.publicKey).catch(() => null);
    const spendable = await reader.spendable(owner).catch(() => 0n);
    // Billed when the allowance covers what this step is expected to cost: there is no per-step
    // price, so the estimate is what the last steps actually cost, never less than an even share of
    // what is left. Under the one predicate the session route uses: without it, a loop whose owner
    // has a micro-USDC of headroom, or whose headroom is entirely held by outstanding `reserve`s,
    // would step on the operator's money and fail its charges afterwards — and step again next
    // tick, because a failed charge never lowers `spendable`. Members are charged against this same
    // allowance, and their cost is in the estimate through each row's `memberCostMicroUsdc`. A
    // spent budget never reaches here: the step is stopped `budget` before it is built
    // (`runOneStep`). An older loop with a per-step budget is admitted under the predicate it
    // started with (`admitStepSpend`), so an old billed loop does not flip to scripted steps here.
    const admitted = admitStepSpend({ grant, spendable, ...stepAdmission(loop) });
    admission = admitted;
    if ("ok" in admitted) {
      billing = reader;
      billed = true;
      // The loop's channel is sized from what the owner had funded when it opened
      // (`loopChannelSizing`), and mppx refuses any voucher past that ceiling. An owner who funds
      // more mid-run is admitted here, but the held channel still stops at the old ceiling, and
      // every paid call of the step would fail on it — and so would every later step, since a loop
      // stepping on its interval never idles long enough to settle it. So the step runs unpaid,
      // the row says `unfunded`, `afterLoopStep` settles the channel, and the next step opens one
      // sized to what is funded then. Not for a settlement (`held`), which makes no call.
      if (!held) channelSpent = heldChannelShort(loop.id, stepAdmission(loop).estimate);
      if (channelSpent) billed = false;
    } else {
      // The row already says `unfunded`; this says *why*, because the two refusals want
      // different transactions from the owner and the row cannot carry a sentence.
      console.warn(`[loops] ${loop.id} steps unbilled: ${admitted.refuse}`);
    }
  }
  // Journaled charges an earlier billed step left on this chain are drained by `AgentRuntime.start`
  // before this step writes anything, and by a settlement before its record, through the backend
  // bound below. A step whose backend cannot pay them is refused, with the reason, rather than run
  // to an `anchor-failed` stop on the queue's own refusal (`ChargeUnpaid`). A settlement is not
  // refused: the channel must close whatever the chain owes, and its record is then owed to the
  // Retry, which asks the same question (`retryLoopAnchor`).
  if (!held) {
    const refusal = loopDrainRefusal(await carriedCharges(idBytes), admission);
    if (refusal) throw new LoopRefused(refusal);
  }
  const named = deployed.policy?.tools;
  const toolNames = named && named.length > 0 ? named.filter((t) => TOOL_NAMES.includes(t)) : undefined;
  /**
   * The step's traces, in the clear. The memory a step leaves for the next one is one of these
   * blobs, and the next step reads it back by the hash its checkpoint commits.
   */
  const stored = new FileTraceStore(TRACE_DIR);
  const traces = stored;

  // Where this step's epoch blob goes before its locator does (`runner.ts`): the trace
  // directory by default, Irys when the operator configured and funded it. An upload that
  // fails is `anchorError` on the epoch, not a failed step.
  const backend = await traceBackend(server);
  /**
   * The step's trace store, wrapped so its blobs can be sealed into one bundle when the step
   * ends — the step's session *and* the memory it leaves for the next one, which is the blob a
   * reader most wants and the one nothing else anchors. Built here so the system prompt below
   * is inside the bundle too.
   */
  const stepTraces = new RecordingTraceStore(traces, {
    backend,
    registry: new LocatorRegistry(client, idBytes),
  });

  // The tools this build does not offer but older policies still name
  // (`runtime/src/retired-tools.ts`). A step's `policy_version_hash` commits to the tool list it
  // ran with, so a retired entry is offered under exactly the condition the live tool was — here, a
  // billed step — and an older coordinator keeps the hash its earlier steps wrote.
  let runtime: AgentRuntime;
  const retired = billed && TREASURY_ADMIN ? [retiredHireTool()] : [];
  const all = [...consoleTools(rpc, client, idBytes, "step", (w) => runtime.writeCell(w)), ...retired];
  // A step runs in a sandbox, so its tools are the sandbox's (`sandboxToolNames`): the chain reads,
  // the store when the policy opts in, and a refusal naming any other tool the policy asks for. The
  // retired entry is not among them — the sandbox has no way to offer it — so a coordinator
  // deployed with `hire` in its list is not offered a tool that only says it is gone. A settlement
  // makes no call, so its list is the unsandboxed one; it is never committed. The owner's switches
  // narrow that list; with none, `sandboxNarrowed` returns it unchanged.
  const sandboxed = sandbox ? sandboxNarrowed(sandboxToolNames(named, deployed.name), sandboxTools) : null;
  const picked = sandboxed
    ? all.filter((t) => sandboxed.includes(t.name))
    : toolNames
    ? all.filter((t) => toolNames.includes(t.name))
    : all.filter((t) => !OPT_IN_TOOL_NAMES.includes(t.name));

  // The step's system prompt: the coordinator's template when it carries one, which puts
  // `promptHash` in every step's `policy_version_hash` and the prompt bytes in the trace
  // store. The standing instruction (`loop.prompt`) is separate and is already committed in
  // the manifest; this is the frame the step runs inside.
  const { system, promptHash: systemPromptHash } = await templateSystemPrompt(
    deployed,
    stepTraces,
    `You are an autonomous agent running on Solana ${CLUSTER}, stepped on a schedule. ` +
      "This is one step of a standing instruction: use the tools to check what you were asked to watch, " +
      "then reply in two sentences saying what changed since the last step, or that nothing did."
  );

  const epochStore = epochStoreFor(hex(idBytes), client, backend);
  // The process's one writer queue signs for whichever chain was last bound to it. Bound here,
  // before the runtime journals anything, with the client this step writes with — the queue's reads
  // then wait for the writes this client made (`LathClient.indexerWaitMs`) — and the backend the
  // step's charges go through. Without it the queue would refuse the step's writes with "no client
  // is bound".
  bindAnchorChain(idBytes, { client, billing });
  /**
   * The channel this step pays its inference through: the loop's one channel, opened on the first
   * billed step and held in this process until something settles it. A settlement hands its own
   * channel in and decides no rail — that is a step's decision and it has already been made.
   */
  const channel = held ?? (await openLoopChannel(loop, deployed, billed));
  // A restart settle inside `openLoopChannel` builds a runner of its own and binds this chain to
  // that runner's backend, which it decided moments apart and may have decided differently. The
  // step's binding goes back before the runtime journals anything, so its charges drain through
  // the backend this step was admitted under and not the settlement's.
  if (!held) bindAnchorChain(idBytes, { client, billing });
  // `openLoopChannel` wrote the lapsed-allowance note for an unbilled step with a channel held; this
  // one was admitted, and it is the channel's ceiling that sent it scripted, so the row says that.
  if (channelSpent) updateLoop(loop.id, (l) => ({ ...l, tempoNote: channelSpent! }));
  /**
   * The loop's Tempo services, created on a paid step's runner only: a step that pays nobody has no
   * treasury spend to publish its report with. A settlement (`held`) takes the ones the loop holds.
   */
  const paidStep = !held && !!channel && "chat" in channel;
  // A keyed loop's storage charges are signed by its key, whose account is read here because the
  // services are built synchronously. A key file gone since the channel opened builds no services
  // for this step rather than charge the treasury for a loop whose policy names the key; the next
  // open stops the loop `tempo-key-missing`. Only when new services would be built: held ones keep
  // theirs.
  let storageKey: unknown = undefined;
  if (paidStep && loop.tempoKey && STORAGE_CHARGES_UNDER_KEY && !scheduler().tempoServices.has(loop.id)) {
    try {
      storageKey = await loopKeySeams.account(loop.id, loop.tempoKey.address);
    } catch (e) {
      // A file holding another key than the one committed, or one that cannot be read: nothing signs.
      const detail =
        `this loop's Tempo access key ${loop.tempoKey.address} could not be loaded for its storage charges ` +
        `(${errorText(e)}); it stopped rather than pay under any other key`;
      stopForTempoKey(loop.id, "tempo-key-refused", detail);
      throw new LoopKeyStopped("tempo-key-refused", detail);
    }
  }
  if (storageKey === null) console.warn(`[loops] ${loop.id}: no storage this step, its access key file is gone`);
  const tempoServices =
    storageKey === undefined
      ? loopTempoServices(loop, paidStep)
      : loopTempoServices(loop, paidStep && storageKey !== null, storageKey ?? undefined);

  const options: AgentRuntimeOptions = {
    client,
    agentId: idBytes,
    transport:
      // A settlement's channel is a stub with a `close` and no `chat`, and nothing built beside
      // it makes a call; only a real transport may stand in here. Without one the step is
      // scripted — a step nobody is paying for reaches no model at all, because this server holds
      // no provider key.
      //
      // Either one wrapped by `stagedTransport`, which names each call on the loop page's pending
      // row and hands every argument through: the runner's decider is this same transport, so Jev's
      // decision is staged as well, and a settlement, which begins no step, stages nothing.
      //
      // The paid channel is metered for Jev as well: every `decide` this step makes is Lath's to
      // pay, counted by its voucher, and refused — through the seat's outage path — once this
      // loop's Jev budget is spent. A scripted step's decisions cost nothing and are not.
      stagedTransport(
        loop.id,
        (channel && "chat" in channel ? jevMeteredTransport(loop.id, channel as ChatTransport) : null) ??
          scriptedTransport(
            sandboxTurns(
              scriptedTurns(
                picked.map((t) => t.name),
                hex(idBytes),
                "Stepped on schedule and read the cluster. This step is one epoch and one checkpoint."
              )
            ),
            "step"
          )
      ),
    store: stepTraces,
    storePayloads: true,
    billing,
    maxSteps: MAX_SESSION_STEPS,
    // A paid step retries a chat call that got no answer. A scripted step has no model to wait on,
    // and keeps a one-attempt call. An attempt that got no answer is Lath's to pay, held to Lath's
    // decision share (`loopNoAnswer`).
    ...(channel && "chat" in channel ? { noAnswer: loopNoAnswer(loop.id) } : {}),
    // One epoch per step: the batch is far larger than the turns `maxSteps` allows, so nothing
    // closes it but the flush the session makes before it resolves.
    rollup: {
      store: epochStore,
      batchSize: DEFAULT_AGENT_DYNAMIC_CONFIG.standardBatchSize,
    },
    // The rules every Genesis of the step commits, built by `loopStepPolicy` so a suite can hash
    // them without a cluster (the loop's policy hash is what an old chain's audit holds it to).
    policy: loopStepPolicy(loop, {
      toolAllowList: picked.map((t) => t.name),
      promptHash: systemPromptHash,
      paid: !!channel,
    }),
    tools: picked,
    system,
    // The step's chain writes go through the process's one writer queue, and the step waits for it:
    // `drain` is what keeps a loop synchronous while the console is not. The session still resolves
    // before the drain is judged, so a write that will not land stops the loop with `anchor-failed`
    // rather than losing the work — `LoopRunner` reads `SessionResult.anchor.failed` for exactly
    // that.
    //
    // One queue for the process means one writer per chain, which is the rule the whole journal
    // rests on: the queue's `billing` is the server's, set where it is built (`_lib/anchor.ts`),
    // so a step's `charge` entry is sent by the same backend the runtime was handed here.
    anchor: { queue: anchorQueue(), drain: true },
  };
  // The step's session runs in the loop's sandbox, and the Genesis of each commits the posture
  // through `policy.sandbox`. Unbilled (scripted) steps too: the scripted transport answers through
  // the same proxy, so an unpaid step is confined exactly as a paid one. Only a settlement is built
  // in-process, and it starts no session.
  try {
    runtime = sandbox
      ? new ZeroClawRuntime({
          ...options,
          zeroclaw: {
            binary: sandbox.binary,
            home: sandbox.home,
            sandbox: loop.id,
            timeoutMs: SANDBOX_TIMEOUT_MS,
            // Session A and the synthesis both run on this runtime, so both sandboxes are seeded from
            // the loop's sources and both Genesis records commit them through the posture.
            ...(sources ? { sources } : {}),
            // And both are told what changed since the Solana sources were pinned: the step's one read.
            ...(sourcesNote.provide ? { sourcesNote: sourcesNote.provide } : {}),
            // And both are held to the owner's lowered cap, committed in the same posture.
            ...(sandboxCap ? { workspace: sandboxCap } : {}),
          },
        })
      : new AgentRuntime(options);
  } catch (e) {
    // `sandboxToolNames` refused every tool the posture would; this is the net under it.
    if (PostureRefused.is(e)) throw new LoopRefused(e.message);
    throw e;
  }

  /**
   * The genesis this step's session opened with, taken from the session itself in the `work`
   * hook — which `LoopRunner` calls after the resolution and before the checkpoint, and which is
   * the only place a caller is handed the `SessionResult`. `StepResult` does not carry it.
   *
   * The seal itself happens after `step()` returns, not here, because the `loop.step` record is
   * written *after* `work`: its manifest and its leaf preimage are two of the blobs the bundle
   * has to hold, and a reader opening a step's bundle should find its checkpoint in it.
   */
  const genesis: { hash?: Uint8Array } = {};
  /**
   * The goal, when the run has one. Spread rather than `goal: loop.goal` for the reason `verify`
   * is: a loop without a goal must build options with no goal key, so that its step manifests carry
   * no tenth key and every older run keeps hashing as it does. The runner is what adds the goal's
   * system message and the 201.
   */
  const goalOption: Pick<LoopRunnerOptions, "goal"> | Record<string, never> = loop.goal ? { goal: loop.goal } : {};

  const base: LoopRunnerOptions = {
    // The owner's running total, in-flight members included, written to the row each time it rises
    // (`persistOwnerSpend`), so a restart mid-step resumes from what was already charged.
    onSpend: (spent: bigint) => persistOwnerSpend(loop.id, spent),
    // The loop's one budget, whose remainder the runner enforces on session A, every member and
    // session B, stopping `budget` when it is spent. Absent on an older row with a per-step budget,
    // whose per-step `maxCost` and `maxSteps` already bound it (`legacyStepBudget`).
    ...((): Pick<LoopRunnerOptions, "budgetMicroUsdc"> => {
      const { budget, legacy } = loopBudgetKeys(loop);
      return legacy ? {} : { budgetMicroUsdc: budget };
    })(),
    // Absent when the loop did not ask for a judge, and the runner then makes no decide call.
    ...(loop.verify ? { verify: loop.verify } : {}),
    ...goalOption,
    // Only beside a goal, and absent otherwise: the runner refuses a check with nothing to ask about.
    ...(loop.goalCheck && loop.goal ? { goalCheck: loop.goalCheck } : {}),
    work: async ({ session }: StepWork) => {
      genesis.hash = session.events.find((e) => e.input.kind === EventKind.Genesis)?.input.payloadHash;
      // The session has resolved and what is left is the memory commit and the checkpoint.
      setStepStage(loop.id, "anchoring");
    },
    runtime,
    loopId: loop.id,
    prompt: loop.prompt,
    intervalMs: loop.intervalMs,
    maxSteps: loop.maxSteps,
    user: owner,
    startedAt: loop.createdAt,
    // The runner owns the channel, not the session: a loop settles once, in its own
    // `loop.settlement` record, and a runtime handed the same channel would close it at the end
    // of this step's Resolution instead.
    tempo: channel ?? undefined,
    // The loop's Tempo services: built on a paid step, and handed to every runner of the loop while
    // they are held — an unpaid step still writes the Actions its paid predecessor's PUTs owe, and
    // a settlement drains them. Spread, so a loop with none carries no key for them.
    ...(tempoServices
      ? {
          tempoServices,
          // Only a paid step publishes its report: the PUT is the owner's to pay, and a step whose
          // owner is not charged has no debit to meter it into. Its snapshot is Lath's and is
          // taken. The PUT's body is the report in the clear, as Irys holds it.
          ...(channel && "chat" in channel
            ? {
                stepReport: async ({ step, session }: { step: number; session: SessionResult }) => {
                  const file = await stepReportFile(traces, session.replayHash);
                  // Said on the row, so its chip stops waiting on a PUT that is not coming.
                  if (!file) rememberStepRow(loop.id, step, "report", (h) => ({ ...h, tempoReport: "none" }));
                  return file;
                },
              }
            : {}),
          // The Action's seq, onto the row of the step whose report it records (the step's storage chip).
          onEvent: (e) => {
            if (e.type === "storage" && e.step !== undefined && e.seq)
              rememberStepStorage(loop.id, e.step, { seq: e.seq });
          },
        }
      : {}),
    resume: { ...loop.snapshot, status: "idle" as const, stopReason: undefined, stopDetail: undefined },
  };

  return {
    base,
    runtime,
    stepTraces,
    epochStore,
    idBytes,
    billed,
    openrouter: !!channel,
    genesis,
    sourcesNoteTold: sourcesNote.told,
    // The agent key signs and pays every write on this chain — records, epochs, locator cells, the
    // seal — so its balance is the step's lamports. Irys is read by shape, not by class: the `fs`
    // backend has no balance, and a console on it records no Irys figure at all.
    storageMeter: async () => {
      const shaped = backend as unknown as Partial<IrysBalance>;
      const irys = typeof shaped.balance === "function" ? (shaped as IrysBalance) : null;
      const [payer, irysBalance] = await Promise.all([
        rpc.getBalance(key.publicKey).catch(() => null),
        irys ? irys.balance().catch(() => null) : Promise.resolve(undefined),
      ]);
      return { payer, ...(irysBalance !== undefined ? { irys: irysBalance } : {}) };
    },
  };
}

// ─── A settlement still owed, and the stop ───────────────────────────────────

/**
 * Writes the `loop.settlement` record a settle deferred because the chain's journal still owed
 * earlier writes (`LoopRunner.settle`), and says whether one is still owed afterwards.
 *
 * Called only after a clean drain and after the deferred checkpoints, and it waits while any
 * checkpoint is still owed: the record is a direct write that takes the next seq, and one landed
 * ahead of a step's late checkpoint would sit inside the range that checkpoint's leaf commits to.
 *
 * The channel was closed when the settle ran, and only its record is missing, so the settle is
 * replayed over the stored receipt rather than sent to Tempo again: `close()` hands back the
 * `txHash` and `spent` the first close returned, which makes the blob the record hashes the
 * bytes the original write would have carried (`recordOwed` itself is never in them). A close
 * that failed the first time is the exception: that one is tried again, through the ledger's own
 * id, because a record of a failed close is worth less than a close.
 *
 * Never throwing: whatever stops the write leaves the debt on the snapshot, where the loop page
 * shows it and the next Retry finds it.
 */
/** A close receipt with the owed settlement's `services` beside it, when it had any. */
function withServices(
  receipt: { txHash?: string; spent?: string },
  owed: TempoSettlement
): { txHash?: string; spent?: string } {
  return owed.services ? ({ ...receipt, services: owed.services } as { txHash?: string; spent?: string }) : receipt;
}

export async function payOwedSettlement(
  id: string,
  hooks: Pick<LoopChannelHooks, "settle" | "closeById">
): Promise<boolean> {
  let loop: LoopRecord | null;
  try {
    loop = readLoop(id);
  } catch (e) {
    // Unreadable is not "nothing owed": answered as still owed, so no channel opens over a receipt
    // this read could not see, and the next Retry or step asks again.
    console.warn(`[loops] ${id}: the registry could not be read to pay an owed settlement: ${errorText(e)}`);
    return true;
  }
  const owed = loop?.snapshot.tempo;
  if (!loop || !owed?.recordOwed) return false;
  if (loop.history.some((h) => h.deferredCheckpoint)) return true;

  const replay: TempoChannel = {
    payer: owed.payer,
    channelId: owed.channelId,
    // A settled channel with its record owed: `opened: true` is what makes `runSettlement` write
    // the record rather than decide there was nothing to settle.
    opened: true,
    // The stop's Tempo services ride back through the receipt: they were drained and closed when
    // the settlement ran, and `runSettlement` spreads what `close()` returns into the blob, so the
    // record the Retry writes carries them as the original would have.
    close: owed.closed
      ? async () => withServices({ txHash: owed.txHash, spent: owed.spent }, owed)
      : async () => {
          if (!owed.channelId) throw new Error(owed.error ?? "the settlement names no channel to close");
          return withServices(await (hooks.closeById ?? loopCloseById(loop))(owed.channelId, owed.payer), owed);
        },
  };

  // A close tried again here is a keyed channel's first close: its deposit, before the ledger forgets it.
  const keyDeposit = loop.tempoKey && !owed.closed && owed.channelId ? openDepositOf(loop, owed.channelId) : undefined;
  const keySigned = keyDeposit !== undefined && owed.channelId ? signedCumulativeOf(loop, owed.channelId) : undefined;
  let settlement: TempoSettlement | undefined;
  try {
    settlement = await (hooks.settle ?? defaultLoopSettle)(loop, replay);
  } catch (e) {
    console.warn(`[loops] the owed settlement record of ${id} was not written: ${(e as any)?.message ?? e}`);
    return true;
  }
  if (!settlement) return true;
  try {
    if (keyDeposit !== undefined && settlement.closed && settlement.channelId) {
      rememberKeyChannelClosed(id, settlement.channelId, keyDeposit, settlement.spent, keySigned);
    }
    updateLoop(id, (l) => ({ ...l, snapshot: { ...l.snapshot, tempo: settlement } }));
  } catch (e) {
    // The record (and any close tried again) has happened; only the row does not say so. The whole
    // settlement goes to the log so it can be put on the row by hand — left as it is, the row still
    // reads `recordOwed`, and the next Retry would write the record a second time.
    console.error(
      `[loops] ${id}: the owed settlement was paid but the row could not be written (${errorText(e)}); ` +
        `settlement: ${JSON.stringify(settlement)}`
    );
  }
  return settlement.recordOwed === true;
}

/**
 * Stops a running or paused loop with `reason`, and `detail` as its `stopDetail` when given.
 *
 * A loop already stopped is left as it is and returned as it stands: its reason is not rewritten
 * and its channel is not settled a second time. The reason is what later work keys on — a
 * `goal-reached` stop owes its receipt (`receiptOwed`), an `anchor-failed` one is what Discard
 * reads — and a second stop arriving after the first (a stale tab's Stop, a budget or key check
 * finishing behind a stop that landed mid-step) would otherwise turn either into `stopped` and
 * orphan it. The detail rides the same write for the same reason: written after, it would land on a
 * stop this call did not make.
 */
export function stopLoop(
  id: string,
  reason = "stopped",
  hooks: LoopChannelHooks = {},
  detail?: string,
  actor?: LifecycleActorContext
): LoopRecord | null {
  // A rebuilt row is the chain's account of a run another console holds: nothing here stops it, and
  // a status written here would be one the chain does not have (`REBUILT_REFUSAL`).
  const rebuilt = readLoop(id);
  if (rebuilt?.lifecycle?.rebuilt) return rebuilt;
  cancel(id);
  let stoppedNow = false;
  const stopped = withTransitionActor(actor, () =>
    updateLoop(id, (l) => {
      if (l.status === "stopped") return l;
      stoppedNow = true;
      return {
        ...l,
        status: "stopped",
        stopReason: reason,
        nextStepAt: undefined,
        ...(detail !== undefined ? { stopDetail: detail } : {}),
      };
    })
  );
  // Fired, not awaited: this stays synchronous because every caller is a route handler answering a
  // click, and the settlement takes a chain write and a Tempo transaction. It waits out a step in
  // flight on its own, so a stop that landed mid-step still closes the channel that step paid
  // through — after it has paid — and then waits for the run slot that step lets go of, so the
  // record never lands beside another writer's. Until it has, a new run on this agent is refused
  // (`checkLoopStart`). A loop that was already stopped was settled by the stop that stopped it.
  if (stopped && stoppedNow) void settleLoopChannel(id, reason, hooks);
  return stopped;
}
