/**
 * What a loop step is built from, apart from the construction itself (`runnerBaseFor`, in
 * `loop-channel.ts`; `_lib/loops.ts` re-exports what was public): the context it returns, the
 * policy every session of the step commits, the sources note a sandbox is told, the storage meter,
 * and the epoch anchors' pending queue.
 */
import * as path from "path";
import {
  AnchoredEpochStore,
  type LathClient,
  type RecordingTraceStore,
  type LocatorBackend,
  LocatorRegistry,
  type PendingAnchor,
  toBytes32,
} from "@lath/sdk";
import type { AgentRuntime, LoopRunnerOptions, RuntimePolicy, TempoKeyPolicy } from "@lath/runtime";
import type { LoopStepStorage, LoopStepSummary } from "../../../types/loop";
import { readJsonOr, writeJsonAtomic } from "./json-store";
import { TRACE_DIR } from "./runner";
import { boundedEnvNumber } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { type LoopBudgetFields, loopBudgetKeys } from "./loop-budget";
import { scheduler } from "./loop-state";
import { registryRow } from "./loop-registry";
import { solanaKeyPolicyOf } from "./loop-receipt";
import { tempoKeyPolicyOf } from "./loop-key";

/** What a step needs of its construction (`runnerBaseFor`, `loop-channel.ts`), past the runner options themselves. */
export interface LoopRunnerContext {
  base: LoopRunnerOptions;
  runtime: AgentRuntime;
  stepTraces: RecordingTraceStore;
  epochStore: AnchoredEpochStore;
  idBytes: Uint8Array;
  billed: boolean;
  /** Whether the step's inference went to OpenRouter at all — a key, or the gateway. */
  openrouter: boolean;
  /** Filled by the `work` hook with the genesis of this step's session; the bundle's key. */
  genesis: { hash?: Uint8Array };
  /**
   * Reads what the step's storage is measured against (`stepStorageOf`): the balance of the key that
   * pays for this chain's writes, and the uploader's Irys balance when the console anchors there.
   * Never throws; a read that failed is `null` and the step then records no storage.
   */
  storageMeter: () => Promise<StorageReading>;
  /**
   * The _changed since pinned_ note a sandbox of this step was handed, or `undefined` when none
   * asked — a loop with no Solana source, a settlement, or a step that stopped before its sandbox
   * opened. The row keeps it as `sourcesNote`.
   */
  sourcesNoteTold: () => string | undefined;
}

/**
 * The step's one _changed since pinned_ read, handed to every sandbox the step opens, and a record
 * of the text the first of them was given.
 *
 * The row keeps the note the sandbox was **told**, not the read as started: a step that stopped
 * before any sandbox asked put no note in any message, and a row that showed one would say the
 * model read something it never did. The provider hands the promise back as it is, so what reaches
 * the message — and the replay record's `messageHash` over it — is byte for byte what it would be
 * without this.
 */
export function toldSourcesNote(note: Promise<string | undefined> | undefined): {
  provide?: () => Promise<string | undefined>;
  told: () => string | undefined;
} {
  let told: string | undefined;
  if (!note) return { told: () => undefined };
  // Settled once, at the step's start; each sandbox's `sourcesNote()` awaits the same promise.
  const seen = note.then((t) => {
    told = t;
    return t;
  });
  let asked = false;
  return {
    provide: () => {
      asked = true;
      return seen;
    },
    told: () => (asked ? told : undefined),
  };
}

/**
 * The most one step of an older loop, one with a per-step budget, may spend against the owner's
 * allowance: its own budget, plus one task's budget per member. Nothing admits against it —
 * admission uses `stepEstimate` — and what it is for is reading an old row, body or template as a
 * whole budget: `stepCeiling × maxSteps` (`withBudgetKeys`, `budgetFromPerStep`) is what its
 * per-step terms already bounded it to.
 *
 * Doubled on a synthesizing team: such a step runs **two** orchestrator sessions around the
 * fan-out, and the runtime's `policy.maxCost` is enforced per `start()` rather than per step — so
 * session B may spend the step's whole budget again, on top of session A's and the team's.
 * Admitting on one session's share would let a step reach the model key with less headroom than it
 * may spend: the hole per-session admission closes for a session, opened again for a step.
 */
export function stepCeiling(loop: Pick<LoopRecord, "budgetMicroUsdcPerStep" | "workers">): bigint {
  const step = BigInt(loop.budgetMicroUsdcPerStep);
  if (!loop.workers) return step;
  const sessions = loop.workers.synthesize ? 2n : 1n;
  return sessions * step + BigInt(loop.workers.agentIds.length) * BigInt(loop.workers.budgetMicroUsdcPerTask);
}

/**
 * The `maxCost` a step's sessions commit: the loop's whole budget on a loop with one budget, the
 * per-step budget on an older loop that has one (`legacyStepBudget`), whose earlier steps committed
 * that and whose later ones must commit the same policy.
 */
export function stepMaxCost(loop: LoopBudgetFields): number {
  const { budget, legacy } = loopBudgetKeys(loop);
  return legacy ? Number(loop.budgetMicroUsdcPerStep) : Number(budget);
}

/**
 * The policy every session of a loop step runs under and every Genesis of the step commits, before
 * the sandbox adds its posture (`ZeroClawRuntime`, `policy.sandbox`). Out of `runnerBaseFor`, verbatim,
 * so a suite can hash it for a fixture without a chain: the hash is what every old chain's audit holds
 * its steps to, and a key added for one feature must not move it for a loop that does not use it.
 */
export function loopStepPolicy(
  loop: LoopRecord,
  p: {
    toolAllowList: string[];
    promptHash?: string;
    /** Whether the step pays through a Tempo channel (`payment: "tempo"`). */
    paid: boolean;
  }
): RuntimePolicy {
  return {
    model: loop.model,
    temperature: 0.2,
    toolAllowList: p.toolAllowList,
    // The loop's whole budget, constant for the loop, so its steps commit one policy — and the
    // runner bounds each session by what is *left* of it, which is unhashed. An older row with a
    // per-step budget keeps the per-step `maxCost` its earlier steps committed.
    maxCost: stepMaxCost(loop),
    promptHash: p.promptHash,
    // On a paid step only, and therefore in `policy_version_hash` only there: an unpaid step
    // names no rail, which is what an older chain without a rail carries and what an explicit
    // `vault` is normalised to, so a loop keeps the hash its earlier steps committed.
    ...(p.paid ? { payment: "tempo" as const } : {}),
    // The judge and the bar, in `policy_version_hash` on every step of a loop that asked for
    // one — a change of either changes what the loop will remember, so it is part of the rules
    // a genesis commits to and not a runtime knob. Absent on every other loop, whose hash it
    // therefore leaves unchanged.
    ...(loop.verify ? { verify: loop.verify } : {}),
    // Jev's goal check, on the same rule: it changes when the run ends, so it is policy, and a run
    // without it hashes unchanged.
    ...(loop.goalCheck ? { goalCheck: loop.goalCheck } : {}),
    // The trace audit, on the same rule: it changes what the loop remembers and when it ends, so
    // it is policy, and a run without it hashes unchanged.
    ...(loop.traceAudit ? { traceAudit: loop.traceAudit } : {}),
    // The gate's terms, on an older row started gated (gated loops are on the roadmap). No such row
    // steps in this build — `tickOnce` and `runOneStep` stop it first — and should one get here,
    // the policy still names its gate, so `LoopRunner.step` refuses it rather than run a step whose
    // policy silently dropped the terms its start signed. Absent on every other loop.
    ...(loop.gate ? { gate: loop.gate } : {}),
    // No `workers`: a team step committed its roster here, and this build runs no team step — a row
    // that carries one is stopped before it steps (`teamRunRefusal`), and its settlement opens no
    // session, so nothing commits the policy it builds.
    // The loop's Tempo access key: the key every owner-paid payment of the loop is signed with and
    // the terms the treasury authorized it for, fixed for the loop like the gate, so every step
    // commits the same bytes. Spread, and absent on every loop started with `LATH_TEMPO_LOOP_KEYS`
    // off, whose hash it therefore leaves unchanged.
    ...((): { tempoKey?: TempoKeyPolicy } => {
      const tempoKey = tempoKeyPolicyOf(loop.tempoKey);
      return tempoKey ? { tempoKey } : {};
    })(),
    // The one other model a step's chat call may be served by, frozen on the row at start. Spread,
    // and absent on every loop started without `LATH_FALLBACK_MODEL`, whose hash it therefore
    // leaves unchanged.
    ...(loop.fallbackModel ? { fallbackModel: loop.fallbackModel } : {}),
    // The protocol plugins the owner signed, `spendingLimit` filled, and the loop's own Solana key:
    // fixed for the loop, so every step commits the same bytes, and what the auditor holds every
    // `squads.pay` Action to. Both or neither, and absent on every loop started without grants,
    // whose hash it therefore leaves unchanged.
    ...(loop.grants && loop.solanaKey ? { grants: loop.grants, solanaKey: solanaKeyPolicyOf(loop.solanaKey) } : {}),
    // The receipt's pointer, on a loop that asked for one; absent otherwise, so every other loop's
    // policy hash is unchanged by it.
    ...(loop.receipt ? { receipt: loop.receipt } : {}),
  };
}

/** One reading of what a step's storage is measured against (`LoopRunnerContext.storageMeter`). */
export interface StorageReading {
  /** Lamports held by the key that pays for the loop's chain writes; `null` when the read failed. */
  payer: number | null;
  /** Lamports the uploader holds at Irys; absent when the console does not anchor there. */
  irys?: bigint | null;
}

/** The one method of `IrysBackend` the meter reads. */
export type IrysBalance = { balance(): Promise<bigint> };

/**
 * A step's `storage`, from whichever reading the step has, or `undefined` when neither is
 * attributable to it.
 *
 * - `chain`: the fee payer's `preBalance − postBalance` from each of the step's own transactions'
 *   metas, summed. The balance and not `meta.fee`, because Light Protocol's per-write fees (5 000 for
 *   the state tree, 5 000 per new address) move inside the instruction and `fee` counts only the
 *   signatures.
 * - `console`: the payer's balance before the step less its balance after. The run slot is what makes
 *   that the step's: nothing else in this process writes while a step holds it, and the key is this
 *   agent's alone. A balance that went **up** means something funded the key inside the window, and
 *   then no figure is the step's — the row gets no `storage` rather than a wrong one.
 *
 * `runOneStep` feeds the `console` form (see there for why). Irys is only ever read the second way:
 * an upload is not a transaction, and a negative delta (a `fund` mid-step) drops the Irys figure
 * alone.
 */
export function stepStorageOf(
  m: (
    | { source: "chain"; payerDeltas: number[]; irys?: { before: StorageReading; after: StorageReading } }
    | { source: "console"; before: StorageReading; after: StorageReading }
  ) & { bundle: LoopStepSummary["bundle"] }
): LoopStepStorage | undefined {
  const bundleBytes = m.bundle && "bytes" in m.bundle ? m.bundle.bytes : 0;
  let lamports: number;
  let irysPair: { before: StorageReading; after: StorageReading } | undefined;
  if (m.source === "chain") {
    if (m.payerDeltas.length === 0 || m.payerDeltas.some((d) => !Number.isSafeInteger(d) || d < 0)) return undefined;
    lamports = m.payerDeltas.reduce((a, b) => a + b, 0);
    irysPair = m.irys;
  } else {
    const { before, after } = m;
    if (before.payer === null || after.payer === null) return undefined;
    lamports = before.payer - after.payer;
    if (!Number.isSafeInteger(lamports) || lamports < 0) return undefined;
    irysPair = m;
  }
  const irysBefore = irysPair?.before.irys;
  const irysAfter = irysPair?.after.irys;
  const irysSpent =
    typeof irysBefore === "bigint" && typeof irysAfter === "bigint" && irysBefore >= irysAfter
      ? irysBefore - irysAfter
      : undefined;
  return {
    lamports,
    source: m.source,
    bundleBytes,
    ...(irysSpent !== undefined && irysSpent <= BigInt(Number.MAX_SAFE_INTEGER)
      ? { irysLamports: Number(irysSpent) }
      : {}),
  };
}

// ─── Epoch anchors ──────────────────────────────────────────────────────────
//
// One locator cell per epoch costs more than the epoch. `LATH_ANCHOR_EVERY=K` makes the
// store queue K epochs and write one manifest cell for them (`AnchoredEpochStore`). The queue
// lives in the process (one store per agent, on the scheduler singleton) and in `anchors.json`,
// so a restart between steps does not orphan the epochs it held.

// A whole number of epochs: `AnchoredEpochStore` throws on anything else, and it is built in every
// step, so a `2.5` would fail every step of every loop for good. A malformed value falls back to 1 with a
// warning (`boundedEnvNumber`), and a fractional one is floored to the whole epochs it covers.
const ANCHOR_EVERY = Math.floor(boundedEnvNumber("LATH_ANCHOR_EVERY", process.env.LATH_ANCHOR_EVERY, 1, { min: 1 }));

const ANCHORS = () => path.join(TRACE_DIR, "anchors.json");

/**
 * The queued anchors of every agent. Only a missing file is empty (`readJsonOr`): answering `{}` to
 * any read error would let the `savePendingAnchors` after the next step write that one agent's
 * queue over every other agent's, whose queued epochs a restart could then no longer anchor.
 */
function readPendingAnchors(): Record<string, PendingAnchor[]> {
  const parsed = readJsonOr<unknown>(ANCHORS(), () => ({}));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${ANCHORS()} is not a map of pending anchors`);
  }
  return parsed as Record<string, PendingAnchor[]>;
}

export function savePendingAnchors(agentId: string, pending: PendingAnchor[]): void {
  const all = readPendingAnchors();
  if (pending.length === 0) delete all[agentId];
  else all[agentId] = pending;
  writeJsonAtomic(ANCHORS(), all);
}

/** The one epoch store per agent this process writes with, rehydrated from `anchors.json`. */
export function epochStoreFor(agentId: string, client: LathClient, backend: LocatorBackend): AnchoredEpochStore {
  const s = scheduler();
  const have = s.epochStores.get(agentId);
  if (have) return have;
  const store = new AnchoredEpochStore(backend, new LocatorRegistry(client, toBytes32(agentId)), {
    every: ANCHOR_EVERY,
    pending: registryRow(readPendingAnchors(), agentId) ?? [],
  });
  s.epochStores.set(agentId, store);
  return store;
}
