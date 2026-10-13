/**
 * `verifyStepDecision`: did the second model a loop asked for actually judge this step, and does the
 * chain agree with what it said? One report per checkpoint, assembling the tempo and sandbox lines
 * from the sibling verifiers, and the formatters the CLI prints them with.
 *
 * A step a roadmap feature wrote — a team's members, a gate log, a trace audit, a protocol plugin's
 * record — is not verified by this build: the report says so by name (`roadmap`) and is never
 * `VERIFIED`.
 */
import { EventKind } from "../events";
import { hex, idFromString, sha256, toBytes32, utf8 } from "../hash";
import { decodeLoopManifest, LOOP_STEP_TOOL, type LoopStepManifest, LoopStepStatus } from "../loops";
import {
  applyVerdict,
  type DecisionBlob,
  decodeDecisionBlob,
  decodeGoalCheckBlob,
  GOAL_CHECK_QUESTIONS,
  type GoalCheckBlob,
  type GoalCheckDecision,
  goalCheckOfBlob,
  type GoalCheckOutcome,
  sameQuestions,
  VERIFY_GOAL_QUESTIONS,
  VERIFY_QUESTIONS,
} from "../verify";
import { isEncryptedTraceBlob, type TraceStore } from "../trace-store";
import type { EpochStore } from "../rollup";
import { checkBuild, checkRecordPostures, checkReplayBlob, postureOfPolicy, type SandboxCheck } from "../step-sandbox";
import {
  type InferenceChain,
  type InferenceRecord,
  type StepVerifyVerdict,
  type TempoReader,
  type WalkedChain,
  blindBetween,
  blobAt,
  canonicalValue,
  encryptedAt,
  genesisPolicyVersionHash,
  openSessionAt,
  payloadLeaf,
  paymentOf,
  sameHex,
  statusOf,
  walkChain,
} from "./core";
import { committedPolicyAt, committedSeatOf, seatProblem } from "./models";
import { manifestOf } from "./shared";
import {
  type CarriedStorageRecord,
  type ChargeReport,
  type LoopTempoView,
  STORAGE_PUT_TOOL,
  type TempoPairingNote,
  carriedStorageOf,
  chargePins,
  collectLoopTempo,
  pairTempoCarries,
  storageLines,
  verifyStorageCharge,
} from "./charges";

/**
 * The manifest keys only a roadmap feature writes, each with the feature's name as the report says it.
 * This build's runner never plans one, and refuses to land a checkpoint whose plan carries one
 * (`writeLoopCheckpoint` in `runtime/src/loop.ts`). So a manifest carrying one is a step a team, a
 * gate, a trace audit or a protocol plugin ran, and this build has no verifier for it.
 */
export const ROADMAP_STEP_KEYS: readonly (readonly [keyof LoopStepManifest, string])[] = Object.freeze([
  ["members", "a team"],
  ["gateHash", "a gated loop"],
  ["traceAuditHash", "a trace audit"],
  ["pluginHash", "a protocol plugin"],
] as const);

/** The roadmap features a manifest's keys name (`ROADMAP_STEP_KEYS`), in that order; empty for this build's steps. */
export function roadmapKeysOf(manifest: LoopStepManifest): string[] {
  return ROADMAP_STEP_KEYS.filter(([key]) => {
    const v = manifest[key];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  }).map(([, name]) => name);
}

/** What a roadmap step's report says, after whatever the rest of the step came to. */
function roadmapReason(features: readonly string[]): string {
  return `this step was written by ${features.join(", ")}, which this build does not verify`;
}

// ---------------------------------------------------------------------------------------------
// The verify step: did a second model judge this step, and does the chain agree with what it said

/** The storage and snapshot lines of one step (`verify-step`), and what failed to pair. */
export interface StepTempoReport {
  step: number;
  /** Each `storage.put` of this step's report, checked. */
  storage: ChargeReport[];
  /** This step's snapshot, with the record that carries it; absent when none is carried yet. */
  snapshot?: { carrierSeq: string; carrierStep?: number; block?: string; error?: string };
  /** Whether the loop takes snapshots at all: any carry holds one. */
  snapshots: boolean;
  /** The stop record's close settlement block, on the last step of a stopped loop. */
  closeBlock?: string;
  /** Pairing failures touching this step: as the carrier, or as the step an entry names. */
  problems: string[];
  unchecked: string[];
}

/**
 * The Tempo half of `verify-step`: the step's own storage PUTs, found by the carry that names them
 * and checked by `verifyStorageCharge`, its snapshot with the record that carries it, and every
 * pairing failure that touches the step. `undefined` for a loop that pays no Tempo service: the
 * report then carries no key and prints no line.
 *
 * Whether to look is decided cheaply first, because the look reads every checkpoint of the loop: the
 * step's own manifest carries `tempoHash`, or the chain has a `storage.put` (by `reference`, no
 * read), or the next checkpoint of the same loop carries `tempoHash` — the one that would carry this
 * step's snapshot. A loop with no report and a snapshot too late for the next leaf is not looked at
 * from this step; `verify-charge` walks it all.
 */
async function stepTempo(
  records: readonly InferenceRecord[],
  want: bigint,
  manifest: LoopStepManifest,
  opts: VerifyStepOptions
): Promise<StepTempoReport | undefined> {
  const storageTool = hex(idFromString(STORAGE_PUT_TOOL));
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  let look =
    !!manifest.tempoHash || records.some((r) => r.kind === EventKind.Action && hex(r.reference) === storageTool);
  if (!look) {
    for (const rec of records) {
      if (rec.seq <= want) continue;
      await openSessionAt(opts.store, rec);
      if (rec.kind !== EventKind.Action || hex(rec.reference) !== stepTool) continue;
      const next = await manifestOf(opts.store, rec).catch(() => null);
      look = !!next && next.loopId === manifest.loopId && !!next.tempoHash;
      break;
    }
  }
  if (!look) return undefined;

  const views = await collectLoopTempo(records, opts.store);
  const view = views.get(manifest.loopId);
  if (!view) return undefined;
  const paired = pairTempoCarries(view, records);
  const step = manifest.step;
  const mine = (n: TempoPairingNote) => n.carrierSeq === want.toString() || n.ofStep === step;
  const report: StepTempoReport = {
    step,
    storage: [],
    snapshots: view.carriers.some((c) => (c.carry.snapshots?.length ?? 0) > 0 || !!c.services?.lastSnapshot),
    problems: paired.problems.filter(mine).map((n) => n.text),
    unchecked: paired.unchecked.filter(mine).map((n) => n.text),
  };
  report.storage = await stepCharges(records, views, view, step, opts);
  for (const c of view.carriers) {
    const snap = c.carry.snapshots?.find((x) => x.ofStep === step);
    if (snap && !report.snapshot) {
      report.snapshot = {
        carrierSeq: c.seq,
        ...(c.step !== undefined ? { carrierStep: c.step } : {}),
        ...(snap.block ? { block: snap.block } : {}),
        ...(snap.error ? { error: snap.error } : {}),
      };
    }
    // The close's block belongs beside the last step's line: it is what the stop settled at.
    if (c.services?.closeBlock && c.services.lastSnapshot?.ofStep === step) report.closeBlock = c.services.closeBlock;
  }
  if (!report.storage.length && !report.snapshot && !report.problems.length && !report.snapshots) {
    return report.unchecked.length ? report : undefined;
  }
  return report;
}

/**
 * This step's storage charges, each carry entry naming one checked by `verifyStorageCharge` under the
 * pins `verify-charge` holds it to (`chargePins`): the payer `--payer` names, else the chain's own
 * vouchers'; the recipient `--recipient` names, else the first paid charge's; and one transfer per
 * charge. Without them a receipt citing a stranger's transfer to the storage payee, or a transaction
 * an earlier charge already cited, would print `verified` here while `verify-charge` failed it.
 *
 * The pins are run-wide, so every `storage.put` on the chain before this step's last charge — any
 * loop's, since one treasury pays them all — is walked in seq order for the transaction it consumed
 * and the payer and recipient it sets. Those earlier charges are read from their blobs only, with no
 * Tempo reader: this command prints no verdict on them, and a loop of a hundred steps should not cost
 * a hundred Tempo reads to check one. Charges after this step's cannot make it a phantom: the one
 * that cites a transaction second is the one that fails.
 */
async function stepCharges(
  records: readonly InferenceRecord[],
  views: ReadonlyMap<string, LoopTempoView>,
  view: LoopTempoView,
  step: number,
  opts: VerifyStepOptions
): Promise<ChargeReport[]> {
  // This step's entries, every carry that names one, in carrier order.
  const own = new Map<string, (CarriedStorageRecord & { carriedBy: string })[]>();
  for (const c of view.carriers) {
    const carriedBy = c.step === undefined ? `the stop record (seq ${c.seq})` : `seq ${c.seq}`;
    for (const s of c.carry.storage ?? []) {
      if (s.ofStep !== step) continue;
      own.set(s.seq, [...(own.get(s.seq) ?? []), { ...s, carriedBy }]);
    }
  }
  const ownSeqs = [...own.keys()].filter((s) => /^[0-9]+$/.test(s)).map((s) => BigInt(s));
  if (!ownSeqs.length) return [];
  const last = ownSeqs.reduce((a, b) => (b > a ? b : a));
  const { carried, loopOf } = carriedStorageOf(views);
  const storageTool = hex(idFromString(STORAGE_PUT_TOOL));
  const pins = chargePins(records, {
    store: opts.store,
    reader: opts.reader,
    ...(opts.expectedPayer ? { expectedPayer: opts.expectedPayer } : {}),
    ...(opts.expectedRecipient ? { expectedRecipient: opts.expectedRecipient } : {}),
  });
  const out: ChargeReport[] = [];
  for (const [index, rec] of records.entries()) {
    if (rec.seq > last || rec.kind !== EventKind.Action || hex(rec.reference) !== storageTool) continue;
    const seq = rec.seq.toString();
    const pinned = await pins.optsAt(index);
    const entries = own.get(seq);
    if (entries) {
      for (const e of entries) {
        const r = await verifyStorageCharge(rec, e, pinned, { loopId: view.loopId, tempoKey: view.tempoKey });
        pins.note(r);
        out.push(r);
      }
      continue;
    }
    const of = loopOf.get(seq);
    const earlier = await verifyStorageCharge(
      rec,
      carried.get(seq),
      { ...pinned, reader: undefined },
      of ? { loopId: of.loopId, tempoKey: of.tempoKey } : undefined
    ).catch(() => null);
    if (earlier) pins.note(earlier);
  }
  return out;
}

/**
 * The goal answer a step's decision carried, re-derived from the blob by `applyGoalCheck`, and the
 * status the step's record carries beside it. `terminal` is the record's word (201 or not); the
 * check that fails the step is one-directional — a 201 that Jev's answer does not back is a
 * `mismatch`, while an `achieved` on a record at 200 is only reported, because a checkpoint a
 * Retry wrote late never carries 201 whatever the step's answer was (`runtime/src/loop.ts`).
 */
export interface StepGoalReport {
  outcome: GoalCheckOutcome;
  choice?: "achieved" | "continue";
  confidence?: number;
  /** The bar the answer was held to, out of the blob. */
  bar: number;
  /** Whether the step output Jev was shown ended with `GOAL REACHED`. */
  claimed: boolean;
  disagreement?: "overruled" | "unclaimed";
  /** Whether the record carries 201. Absent when the payload preimage is not here to say. */
  terminal?: boolean;
}

export interface StepVerifyReport {
  agentId: string;
  seq: string;
  verdict: StepVerifyVerdict;
  /** The manifest's ninth key — the decision blob this step committed to. */
  verifyHash?: string;
  /** The manifest's fourteenth key — the goal-check blob of a loop with no verify seat. */
  goalCheckHash?: string;
  /**
   * What Jev said about the goal, on a step whose decision asked it — inside the verify blob, or
   * alone under `goalCheckHash` — and whether the record's status agrees.
   */
  goal?: StepGoalReport;
  /** The dated build the gateway resolved the pinned model to, out of the blob. */
  model?: string;
  /** `answers.verdict.choice` and the confidence it came with. */
  choice?: string;
  confidence?: number;
  /** Whether this step's `memoryHash` differs from the previous step's — what the verdict implies. */
  memoryAdvanced?: boolean;
  /**
   * The step was accepted and committed the *same* `memoryHash` as the one before it. Not a
   * contradiction and not a step that stood still: the store is content-addressed, so a step
   * whose answer repeats the previous one word for word commits the hash it already had. It is
   * reported because "advanced" would be a lie and "carried forward" is what a retry does.
   */
  memoryRepeated?: boolean;
  /** The channel the decision's voucher was signed against. Absent on a scripted, unbilled step. */
  channelId?: string;
  /**
   * The roadmap features whose manifest keys this step carries (`roadmapKeysOf`): a team, a gated
   * loop, a trace audit, a protocol plugin. Absent on every step this build writes. Present, the step
   * is never `ok` here — its verdict is at most `no-preimage`, with `roadmapReason`'s sentence — since
   * this build does not check what those keys commit.
   */
  roadmap?: string[];
  /**
   * One entry per sandboxed session of the step whose manifest commits a replay record: the step's
   * own (`replayHash`, the thirteenth key, possibly the fold of the step's session and its synthesis).
   * See `stepSandboxes`. A fail here fails the step. A team member's own record is a roadmap step's,
   * and not read here.
   */
  sandboxes?: StepSandboxReport[];
  /** Why no sandbox could be looked for: the manifest that would name a replay record is unread. */
  sandboxUnread?: string;
  /**
   * The step's Tempo storage PUTs and its snapshot, on a loop whose host pays Tempo's services.
   * Absent on every other loop, so their reports keep their keys.
   */
  tempo?: StepTempoReport;
  /** Why the verdict is not `ok`. Absent when it is. */
  reason?: string;
}

/**
 * What `verify-step` says about one sandboxed session: the replay record re-hashed against the
 * committed `replayHash`, its `postureHash` held to the posture the Genesis commits, and the build
 * flagged — then the wrapper, the sources and the workspace hashes as information. It shows what
 * the step committed to and that the record agrees with the chain; it does not show the process ran
 * inside the posture (`step-sandbox.ts`).
 */
export interface StepSandboxReport {
  /** `"step"`: the loop agent's own session (a team member's agent id, hex, is a roadmap step's). */
  whose: string;
  replayHash: string;
  /** The committed record is the fold of the step's session and its synthesis. */
  folded?: boolean;
  replay: SandboxCheck;
  posture: SandboxCheck;
  build: SandboxCheck;
  /** `posture.wrapper.kind`, when the posture was read. */
  wrapper?: string;
  /** `posture.sources.hash`, when the posture was read and the loop has sources. */
  sourcesHash?: string;
  /** Each record's `workspaceBefore → workspaceAfter`, when the record was read. */
  workspaces?: { before: string; after: string }[];
}

export interface VerifyStepOptions {
  /** Where the manifest and the decision blob are read from. Without one the answer is `no-preimage`. */
  store?: TraceStore;
  /** Epoch blobs, for a chain whose checkpoints the rollup batched. */
  epochs?: EpochStore;
  /**
   * `--tempo-rpc`: Tempo, for the transfer each of the step's storage charges names. Without one a
   * paid charge is unchecked, never a failure; the rest of the step is read from the chain and blobs.
   */
  reader?: TempoReader;
  /**
   * `--payer`: the address every storage charge of the step was paid by, the operator's treasury.
   * Without it the chain's own vouchers name it, as `verify-charge` reads them.
   */
  expectedPayer?: string;
  /** `--recipient`: the storage gateway's payee every storage charge of the step is held to. */
  expectedRecipient?: string;
}

/**
 * The sandbox half of `verify-step`: one report for the step's own session when its manifest
 * commits a replay record.
 *
 * Forgiving: every read that fails is an _unchecked_ with its reason, never a throw, so a reader
 * without the owner's key still gets a line with the committed hash and whatever the Genesis's policy
 * says in the clear.
 */
async function stepSandboxes(
  records: readonly InferenceRecord[],
  want: bigint,
  manifest: LoopStepManifest,
  opts: VerifyStepOptions
): Promise<StepSandboxReport[]> {
  if (!manifest.replayHash) return [];
  return [await sandboxReport("step", manifest.replayHash, async () => records, want, opts)];
}

type GenesisPosture = { postureHash: string; binarySha256?: string; genesisSeq: string } | { unread: string };

async function sandboxReport(
  whose: string,
  replayHash: string,
  chainRecords: () => Promise<readonly InferenceRecord[]>,
  upTo: bigint,
  opts: VerifyStepOptions
): Promise<StepSandboxReport> {
  const store = opts.store;
  let raw: Uint8Array | null = null;
  let refused: string | undefined;
  if (store) {
    try {
      raw = await store.get(toBytes32(replayHash));
    } catch (e) {
      // `EncryptedTraceStore` raises on a key that is not the owner's, which is not the same
      // answer as nothing stored, so it is said as it was thrown.
      refused = (e as Error)?.message ?? String(e);
    }
  }
  const encrypted = !!raw && isEncryptedTraceBlob(raw);
  const opened = refused
    ? { check: { verdict: "unchecked" as const, detail: `the store refused the replay record: ${refused}` } }
    : checkReplayBlob(replayHash, raw, encrypted);
  const records = "records" in opened ? opened.records : undefined;
  const report: StepSandboxReport = {
    whose,
    replayHash,
    ...("folded" in opened && opened.folded ? { folded: true } : {}),
    replay: opened.check,
    posture: { verdict: "unchecked", detail: "" },
    build: { verdict: "unchecked", detail: "" },
  };
  if (records) report.workspaces = records.map((r) => ({ before: r.workspaceBefore, after: r.workspaceAfter }));

  // The posture each session's Genesis commits: the last Genesis before the session's first call,
  // or — with no record to say where the session began — the last one before the step's seq, which
  // is still the posture the step ran under and so still worth showing a reader without the key.
  let walked: readonly InferenceRecord[] | null = null;
  let walkError = "the chain could not be read";
  try {
    walked = await chainRecords();
  } catch (e) {
    walkError = `the chain could not be read: ${(e as Error)?.message ?? String(e)}`;
  }
  const anchors = records?.length ? records.map((r) => (r.seqs.length ? BigInt(r.seqs[0]) : upTo)) : [upTo];
  const postures: GenesisPosture[] = [];
  let shown: Record<string, unknown> | undefined;
  let noSandbox: string | undefined;
  const unread = async (what: string, hash: Uint8Array) =>
    (await encryptedAt(store, hash).catch(() => false))
      ? `${what} is encrypted by the agent's owner; pass --trace-key <hex|path> to read it`
      : `${what} is not available here`;
  for (const anchor of anchors) {
    if (!walked) {
      postures.push({ unread: walkError });
      continue;
    }
    const genesis = [...walked].reverse().find((r) => r.seq < anchor && r.kind === EventKind.Genesis);
    if (!genesis) {
      postures.push({ unread: `no Genesis precedes seq ${anchor} on this chain` });
      continue;
    }
    await openSessionAt(store, genesis);
    const preimage = await blobAt(store, genesis.payloadHash).catch(() => null);
    if (!preimage) {
      postures.push({ unread: await unread(`the Genesis payload at seq ${genesis.seq}`, genesis.payloadHash) });
      continue;
    }
    const pvh = genesisPolicyVersionHash(preimage[0], preimage.slice(1));
    const doc = pvh ? await blobAt(store, pvh).catch(() => null) : null;
    if (!pvh || !doc) {
      postures.push({
        unread: pvh
          ? await unread(`the policy document ${hex(pvh).slice(0, 16)}… the Genesis at seq ${genesis.seq} commits`, pvh)
          : `the payload at seq ${genesis.seq} is not a Genesis preimage`,
      });
      continue;
    }
    const posture = postureOfPolicy(doc);
    if (posture === "no-sandbox" || posture === "unreadable") {
      // A session whose manifest commits a replay record ran in a sandbox; a policy with no posture
      // under `sandbox` is one that never committed the jail the record says it ran in.
      noSandbox ??=
        posture === "no-sandbox"
          ? `the policy the Genesis at seq ${genesis.seq} commits carries no sandbox posture`
          : `the policy document the Genesis at seq ${genesis.seq} commits is not JSON`;
      postures.push({ unread: noSandbox });
      continue;
    }
    shown ??= posture.posture;
    const binary = posture.posture.binarySha256;
    postures.push({
      postureHash: posture.postureHash,
      ...(typeof binary === "string" ? { binarySha256: binary } : {}),
      genesisSeq: genesis.seq.toString(),
    });
  }

  if (noSandbox) report.posture = { verdict: "fail", detail: noSandbox };
  else if (records) report.posture = checkRecordPostures(records, postures);
  else {
    const first = postures[0];
    report.posture = {
      verdict: "unchecked",
      detail: !first
        ? walkError
        : "unread" in first
        ? first.unread
        : `the Genesis at seq ${first.genesisSeq} commits posture ${first.postureHash.slice(0, 16)}…, ` +
          "but no record is here to hold it against",
    };
  }
  const binary = typeof shown?.binarySha256 === "string" ? shown.binarySha256 : records?.[0]?.binarySha256;
  report.build = checkBuild(binary);
  const wrapper = (shown?.wrapper as { kind?: unknown } | undefined)?.kind;
  if (typeof wrapper === "string") report.wrapper = wrapper;
  const sources = (shown?.sources as { hash?: unknown } | undefined)?.hash;
  if (typeof sources === "string") report.sourcesHash = sources;
  return report;
}

/**
 * The standing instruction out of a decision's `state`, which `verifyState` writes first under a
 * fixed label — so it can be re-hashed and held to the manifest's `promptHash`.
 *
 * The section ends at the first blank line that begins another of the state's labels. A prompt
 * that itself contains such a line would be cut short here and the step would read as judged
 * against another prompt; that is the safe direction to be wrong in, because the alternative is
 * accepting a state assembled to look like one.
 */
function promptSectionOf(state: string): string | null {
  const label = "PROMPT: ";
  if (!state.startsWith(label)) return null;
  const rest = state.slice(label.length);
  const next = rest.search(/\n\n(?:GOAL|PREVIOUS MEMORY|STEP OUTPUT): /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * The goal out of a decision's `state`, which `verifyState` writes second, under `GOAL:`, right
 * after the prompt section `promptSectionOf` reads — so it can be re-hashed and held to the
 * manifest's `goalHash`. `null` when the state has no goal section where one belongs.
 */
function goalSectionOf(state: string): string | null {
  const prompt = promptSectionOf(state);
  if (prompt === null) return null;
  const rest = state.slice("PROMPT: ".length + prompt.length);
  const label = "\n\nGOAL: ";
  if (!rest.startsWith(label)) return null;
  const body = rest.slice(label.length);
  const end = body.indexOf("\n\nPREVIOUS MEMORY: ");
  return end < 0 ? null : body.slice(0, end);
}

/**
 * The goal half of a step's decision: the goal the blob was asked about must be the goal the
 * manifest commits, and a record at 201 must be backed by Jev's `achieved` at the bar — and, on a
 * verified step, by a verdict that kept the step, since the runner never ends a loop on text it did
 * not remember. Returns the report and, when the two disagree, why.
 *
 * `committedBar` is the session policy's, when it was read: the answer is held to it rather than to
 * the bar the blob records, which is the writer's word.
 */
function checkGoalAnswer(
  blob: GoalCheckBlob | DecisionBlob,
  manifest: LoopStepManifest,
  hash: string,
  remembered: boolean,
  status: number | undefined,
  committedBar?: number
): { goal?: StepGoalReport; problem?: string } {
  const decision: GoalCheckDecision | null = goalCheckOfBlob(blob, committedBar);
  if (!decision) return {};
  const bar = committedBar ?? blob.request.minConfidence ?? 0.5;
  if (!manifest.goalHash) {
    return {
      problem: `the decision under ${hash} asks whether a goal is reached, and this step's loop commits no goal`,
    };
  }
  const goal = goalSectionOf(blob.request.state);
  const goalHashed = goal === null ? null : hex(sha256(utf8(goal.trim())));
  if (goalHashed !== manifest.goalHash) {
    return {
      problem:
        `the decision under ${hash} judged ${
          goalHashed === null ? "no goal section" : `a goal hashing to ${goalHashed}`
        }, ` + `while this step's manifest commits to ${manifest.goalHash}`,
    };
  }
  const report: StepGoalReport = {
    outcome: decision.outcome,
    ...(decision.choice ? { choice: decision.choice } : {}),
    ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
    bar,
    claimed: decision.claimed,
    ...(decision.disagreement ? { disagreement: decision.disagreement } : {}),
    ...(status !== undefined ? { terminal: status === LoopStepStatus.GoalReached } : {}),
  };
  // An unavailable answer left the claim to decide, and the claim is the memory's to answer for:
  // `audit --require-preimages` holds a 201 to the terminal line. Nothing more to check here.
  if (decision.outcome === "unavailable" || report.terminal !== true) return { goal: report };
  if (decision.outcome !== "achieved" || !remembered) {
    return {
      goal: report,
      problem:
        `the step's record carries 201 (goal reached), and the decision under ${hash} ` +
        (decision.outcome === "achieved"
          ? "did not keep the step, so the runner could not have ended the loop on it"
          : `says Jev answered ${decision.choice} at ${(decision.confidence ?? 0).toFixed(2)} against a bar of ${bar}`),
    };
  }
  return { goal: report };
}

/**
 * The voucher inside a decision blob against the loop's own channel, the check `verifyInference`
 * makes of an LLM call: the channel the chain's own vouchers name up to this seq. A scripted step
 * buys nothing and carries no voucher, so there is nothing for it to disagree with.
 *
 * Only what the records here say can disagree. With no readable voucher up to this seq the
 * decision is held to nothing, and that is `no-preimage`, not a pass; and when `blind` — an epoch up
 * to this seq was not opened, or the epochs could not be listed — the latest voucher read may be a
 * channel the loop has since settled, so a different channel is `no-preimage` rather than `payer`.
 */
async function decisionPayer(
  records: readonly InferenceRecord[],
  want: bigint,
  store: TraceStore | undefined,
  channelId: string | undefined,
  blind: string | undefined
): Promise<{ verdict: "payer" | "no-preimage"; reason: string } | null> {
  if (!channelId) return null;
  let loopChannel: string | undefined;
  for (const rec of records) {
    if (rec.seq > want) break;
    const paid = await paymentOf(store, rec).catch(() => null);
    if (paid) loopChannel = paid.payment.channelId;
  }
  if (loopChannel && sameHex(loopChannel, channelId)) return null;
  if (blind) {
    return {
      verdict: "no-preimage",
      reason:
        `the decision was paid on channel ${channelId}, and ${blind}, so the channel this loop's calls rode ` +
        "by then cannot be read",
    };
  }
  if (!loopChannel) {
    return {
      verdict: "no-preimage",
      reason:
        `the decision was paid on channel ${channelId}, and no voucher of this loop's own calls up to seq ${want} ` +
        "is readable here, so the channel it should have ridden is unknown",
    };
  }
  return {
    verdict: "payer",
    reason:
      `the decision was paid on channel ${channelId}, not on ${loopChannel}, which is the ` +
      `channel this loop's own calls rode`,
  };
}

/**
 * Why the records up to `want` may not be all of them: the chain's epochs could not be
 * listed, or one starting at or before `want` was not opened. `undefined` when every one was.
 */
function blindAt(walked: WalkedChain, want: bigint): string | undefined {
  if (walked.epochsUnlisted) return "the chain's epochs could not be listed";
  const e = walked.unopened.find((x) => x.startSeq <= want);
  return e ? `the epoch ${e.startSeq}–${e.endSeq} is not opened here (pass --epochs or --gateway)` : undefined;
}

/**
 * The policy document of the session the checkpoint at `want` closes: the one the nearest Genesis
 * before it commits through `policy_version_hash`. `unread` when that Genesis or its document is not
 * readable here — or when an epoch not opened lies between it and the checkpoint, because a later
 * Genesis there would be the step's real session, and holding the step to an older session's policy
 * could pass what the real one forbids or fail what it allows.
 */
async function sessionPolicyAt(
  walked: WalkedChain,
  want: bigint,
  store: TraceStore | undefined
): Promise<{ doc: unknown } | { unread: string }> {
  const genesis = [...walked.records].reverse().find((r) => r.seq < want && r.kind === EventKind.Genesis);
  const hidden = blindBetween(walked, genesis ? genesis.seq : -1n, want);
  if (hidden) return { unread: `the session's Genesis may be in an epoch not read here (${hidden})` };
  if (!genesis) return { unread: `no Genesis before seq ${want} is readable here` };
  const doc = await committedPolicyAt(store, genesis, new Map()).catch(() => undefined);
  if (doc === undefined) return { unread: `the policy the Genesis at seq ${genesis.seq} commits is not readable here` };
  return { doc };
}

/**
 * Did a second model judge the step at `seq`, and does the chain agree with what it said?
 *
 * A decision is **not an `Action`** and writes no record of its own: it is committed through the
 * `loop.step` manifest the step already writes, as the ninth key. That is what keeps _one step,
 * one leaf_ — a verified loop folds exactly the records an unverified one folds — and it is why the
 * step's `args_hash` commits to the verdict, its confidence, the model build that gave it and the
 * voucher that paid for it all at once.
 *
 * So the check joins off-chain bytes to on-chain hashes in three parts: the blob under
 * `verifyHash` must re-hash to it, so an edited blob fails; `answers.verdict.choice` must match
 * what the step did with its memory, because `accept` means remembered and `retry`/`escalate` mean
 * carried forward; and the voucher inside the blob must name the loop's own channel, the same check
 * `verifyInference` makes of an LLM call.
 */
export async function verifyStepDecision(
  chain: InferenceChain,
  agentId: Uint8Array,
  seq: bigint | number | string,
  opts: VerifyStepOptions = {}
): Promise<StepVerifyReport> {
  const report = await stepDecision(chain, agentId, seq, opts);
  // A sandbox that fails is the chain contradicting itself — a record that does not re-hash, or a
  // posture that is not the one the Genesis committed — so it fails the step whatever the decision
  // said. One that could not be checked changes nothing: that is a reader without the bytes.
  const failed = report.sandboxes?.find((s) => [s.replay, s.posture, s.build].some((c) => c.verdict === "fail"));
  // So is a storage charge Tempo contradicts, or a carry that does not pair with its step: the
  // record commits a payment or a snapshot that did not happen as it says. One unchecked changes nothing.
  const tempoFailure =
    report.tempo?.problems[0] ??
    (() => {
      const c = report.tempo?.storage.find((x) => x.verdict === "failed");
      return c ? `the storage.put at seq ${c.seq}: ${c.reason}` : undefined;
    })();
  if (!failed && tempoFailure && report.verdict !== "mismatch") {
    return { ...report, verdict: "mismatch", reason: `Tempo: ${tempoFailure}` };
  }
  if (failed && report.verdict !== "mismatch") {
    const check = [failed.replay, failed.posture, failed.build].find((c) => c.verdict === "fail")!;
    return { ...report, verdict: "mismatch", reason: `the step's sandbox: ${check.detail}` };
  }
  // A roadmap step, last: a contradiction found above still fails it, but nothing this build checked
  // can call it verified, because this build does not check what its roadmap keys commit. Said in
  // place of a verdict that was otherwise `ok` or a mere absence, never over a failure.
  if (report.roadmap?.length && (report.verdict === "ok" || report.verdict === "no-preimage")) {
    return { ...report, verdict: "no-preimage", reason: roadmapReason(report.roadmap) };
  }
  return report;
}

async function stepDecision(
  chain: InferenceChain,
  agentId: Uint8Array,
  seq: bigint | number | string,
  opts: VerifyStepOptions
): Promise<StepVerifyReport> {
  const want = BigInt(seq);
  const report: StepVerifyReport = { agentId: hex(agentId), seq: want.toString(), verdict: "mismatch" };
  const bad = (reason: string): StepVerifyReport => ({ ...report, verdict: "mismatch", reason });
  const absent = (reason: string): StepVerifyReport => ({ ...report, verdict: "no-preimage", reason });

  let walked: WalkedChain;
  try {
    walked = await walkChain(chain, agentId, opts.epochs);
  } catch (e) {
    return absent(`the chain could not be read: ${(e as any)?.message ?? String(e)}`);
  }
  const records = walked.records;
  const blind = blindAt(walked, want);
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  const target = records.find((r) => r.seq === want);
  if (!target) return bad(`agent ${report.agentId} has no record at seq ${want}`);
  if (target.kind !== EventKind.Action || hex(target.reference) !== stepTool) {
    return bad(`seq ${want} is not a \`${LOOP_STEP_TOOL}\` checkpoint, and only a checkpoint carries a verdict`);
  }
  for (const rec of records) if (rec.seq <= want) await openSessionAt(opts.store, rec);

  // Bytes that are here and encrypted are a third answer, the one `verifyInference` gives too:
  // the owner withheld them, and `--trace-key` is what reads them.
  const locked = (what: string): StepVerifyReport => ({
    ...report,
    verdict: "encrypted",
    reason: `${what} is encrypted by the agent's owner; pass --trace-key <hex|path> to read it`,
  });
  const manifest = await manifestOf(opts.store, target);
  if (!manifest) {
    report.sandboxUnread =
      "the step's manifest is not readable here, so whether it committed a replay record cannot be said";
    if (await encryptedAt(opts.store, target.payloadHash))
      return locked(`the \`${LOOP_STEP_TOOL}\` payload at seq ${want}`);
    return absent(`the \`${LOOP_STEP_TOOL}\` manifest at seq ${want} is not available here`);
  }
  // A roadmap feature's keys are a fact about how the step was written, said whatever else is
  // checked: `verifyStepDecision` holds the verdict short of `ok` for them, after everything below
  // has had its chance to find a contradiction.
  const roadmap = roadmapKeysOf(manifest);
  if (roadmap.length) report.roadmap = roadmap;
  // The sandbox is a fact about how the step ran, not about its verifier, so it is read here, before
  // any verdict returns: an unverified sandboxed step still prints what its record says.
  const sandboxes = await stepSandboxes(records, want, manifest, opts);
  if (sandboxes.length) report.sandboxes = sandboxes;
  // What the step's report cost on Tempo storage and the snapshot taken after it are facts about the
  // step too, carried by later records, so they are read here and print whatever the verdict.
  const tempo = await stepTempo(records, want, manifest, opts).catch(() => undefined);
  if (tempo) report.tempo = tempo;
  if (!manifest.verifyHash && manifest.goalCheckHash) {
    // A goal loop with Jev's goal check and no verify seat: the goal answer is the only decision
    // the step committed, under the fourteenth key, and it is checked the way a verdict is — the
    // bytes re-hash, the questions are the frozen goal set, the state names this loop's prompt and
    // goal, the record's status agrees, the voucher rode the channel.
    const hash = manifest.goalCheckHash;
    report.goalCheckHash = hash;
    const raw = opts.store ? await opts.store.get(toBytes32(hash)).catch(() => null) : null;
    if (!raw) return absent(`the goal-check blob ${hash} is not available here`);
    if (isEncryptedTraceBlob(raw)) return locked(`the goal-check blob ${hash}`);
    if (hex(sha256(raw)) !== hash) {
      return bad(`the bytes under ${hash} hash to ${hex(sha256(raw))} — the goal-check blob was edited`);
    }
    const blob = decodeGoalCheckBlob(raw);
    if (!blob) return bad(`the bytes under ${hash} are not a decision blob`);
    if (!sameQuestions(blob.request.questions, GOAL_CHECK_QUESTIONS)) {
      return bad(`the decision under ${hash} answered questions that are not the frozen goal question`);
    }
    const asked = promptSectionOf(blob.request.state);
    if (asked === null || hex(sha256(utf8(asked))) !== manifest.promptHash) {
      return bad(`the decision under ${hash} was not taken against the prompt this step's manifest commits to`);
    }
    report.model = blob.model;
    // The model asked and the bar held, against the goal check the step's policy commits.
    // Unread, the check still runs on the blob's own bar, and the step is not called verified for it.
    const policy = await sessionPolicyAt(walked, want, opts.store);
    let seatUnread: string | undefined;
    let committedBar: number | undefined;
    if ("doc" in policy) {
      const seat = committedSeatOf(policy.doc, "goalCheck");
      if (!seat) seatUnread = "the step's policy commits no goal check";
      else {
        const problem = seatProblem(blob.request, seat, hash);
        if (problem) return bad(problem);
        committedBar = seat.minConfidence;
      }
    } else seatUnread = policy.unread;
    const checked = checkGoalAnswer(blob, manifest, hash, true, await statusOf(opts.store, target), committedBar);
    if (checked.goal) report.goal = checked.goal;
    if (checked.problem) return bad(checked.problem);
    if (blob.payment?.channelId) report.channelId = blob.payment.channelId;
    const payer = await decisionPayer(records, want, opts.store, blob.payment?.channelId, blind);
    if (payer) return { ...report, ...payer };
    if (seatUnread) {
      return absent(
        `the model and bar the goal answer was held to cannot be checked against the policy: ${seatUnread}`
      );
    }
    return { ...report, verdict: "ok" };
  }
  if (!manifest.verifyHash) {
    // A loop with verify off and a step whose verifier was unreachable look alike from here:
    // both write the manifest they always did, which is exactly what writing no key means.
    return absent(`seq ${want} carries no \`verifyHash\`: this step was not verified`);
  }
  report.verifyHash = manifest.verifyHash;

  const raw = opts.store ? await opts.store.get(toBytes32(manifest.verifyHash)).catch(() => null) : null;
  if (!raw) return absent(`the decision blob ${manifest.verifyHash} is not available here`);
  if (isEncryptedTraceBlob(raw)) return locked(`the decision blob ${manifest.verifyHash}`);
  if (hex(sha256(raw)) !== manifest.verifyHash) {
    return bad(`the bytes under ${manifest.verifyHash} hash to ${hex(sha256(raw))} — the decision blob was edited`);
  }
  const blob: DecisionBlob | null = decodeDecisionBlob(raw);
  if (!blob) return bad(`the bytes under ${manifest.verifyHash} are not a decision blob, or carry no verdict`);

  // What the model was actually asked, held to what `sdk/src/verify.ts` promises it is asked.
  // Without this, a blob whose decision was about another prompt, or answered questions nobody
  // froze, would re-hash to its `verifyHash` and print VERIFIED — the hash only ever says *these
  // bytes are the ones the step committed*, never *these bytes are a verdict on this step*. Both
  // facts are in hand here, so both are checked.
  //
  // The frozen two, or — on a goal loop with Jev's goal check — the frozen two and the goal
  // question in one request. The three-question set on a loop with no goal is refused like any
  // other set: it would be a goal answer about nothing the chain commits.
  const frozen =
    JSON.stringify(canonicalValue(blob.request.questions)) === JSON.stringify(canonicalValue(VERIFY_QUESTIONS));
  const withGoal = !!manifest.goalHash && sameQuestions(blob.request.questions, VERIFY_GOAL_QUESTIONS);
  if (!frozen && !withGoal) {
    return bad(
      `the decision under ${manifest.verifyHash} answered questions that are not the frozen two, so it is not ` +
        "a verdict on this step in the sense the loop committed"
    );
  }
  const asked = promptSectionOf(blob.request.state);
  if (asked === null) {
    return bad(`the decision under ${manifest.verifyHash} carries no \`PROMPT:\` section, so what it judged is unsaid`);
  }
  if (hex(sha256(utf8(asked))) !== manifest.promptHash) {
    return bad(
      `the decision under ${manifest.verifyHash} was taken against a prompt hashing to ${hex(sha256(utf8(asked)))}, ` +
        `while this step's manifest commits to ${manifest.promptHash}`
    );
  }

  report.model = blob.model;
  report.choice = blob.answers.verdict.choice;
  report.confidence = blob.answers.verdict.confidence;

  // The model asked and the bar held, against the verifier the step's policy commits: the blob
  // records both, but they are the writer's word, and a blob that lowered its own bar would otherwise
  // pass an `accept` the owner's bar rejects. On a goal loop the goal answer rides this blob and is
  // held to the goal check's bar, which beside the seat is the seat's own.
  // Unread, the checks below still run on the blob's own bar, and the step is not called verified.
  const policy = await sessionPolicyAt(walked, want, opts.store);
  let seatUnread: string | undefined;
  let committedBar: number | undefined;
  let committedGoalBar: number | undefined;
  if ("doc" in policy) {
    const seat = committedSeatOf(policy.doc, "verify");
    if (!seat) seatUnread = "the step's policy commits no verifier";
    else {
      const problem = seatProblem(blob.request, seat, manifest.verifyHash);
      if (problem) return bad(problem);
      committedBar = seat.minConfidence;
    }
    if (withGoal) {
      const goalSeat = committedSeatOf(policy.doc, "goalCheck");
      if (goalSeat) committedGoalBar = goalSeat.minConfidence;
      else seatUnread ??= "the step's policy commits no goal check";
    }
  } else seatUnread = policy.unread;

  // Whether the memory moved is a two-manifest question, and the first step of a loop has
  // nothing to compare against, so its verdict is taken as given rather than guessed at.
  //
  // A predecessor that exists on the chain and cannot be read here is a different thing, and it
  // is not a skip: the question this check exists to answer is unanswerable, so the report says
  // so and exits 2 rather than calling the step verified. The first-step case is still
  // the only silent one — there is no earlier step to be missing.
  let previous: LoopStepManifest | null = null;
  let previousSeq = -1n;
  for (let i = records.length - 1; i >= 0 && !previous; i--) {
    const rec = records[i];
    if (rec.seq >= want || rec.kind !== EventKind.Action || hex(rec.reference) !== stepTool) continue;
    const priorArgs = await payloadLeaf(opts.store, rec, 0);
    if (!priorArgs) {
      if (await encryptedAt(opts.store, rec.payloadHash)) return locked(`the step payload at seq ${rec.seq}`);
      return absent(`the step payload at seq ${rec.seq}, the step before this one, is not available here`);
    }
    if (await encryptedAt(opts.store, priorArgs)) return locked(`the manifest of step seq ${rec.seq}`);
    const bytes = await blobAt(opts.store, priorArgs);
    const m = bytes ? decodeLoopManifest(bytes) : null;
    if (!m) {
      return absent(
        `the \`${LOOP_STEP_TOOL}\` manifest at seq ${rec.seq}, the step before this one, is not available here, ` +
          "so whether this step's memory moved cannot be answered"
      );
    }
    if (m.loopId === manifest.loopId) {
      previous = m;
      previousSeq = rec.seq;
    }
  }
  // What was found is the most recent earlier checkpoint *this reader can see*. An unopened epoch
  // between it and this step may hold the real one — or, with none found, the loop's first — so the
  // comparison below would be made against the wrong memory: a withheld epoch could then pass a
  // `retry` that advanced the memory, or fail an honest step. Not compared, and the step is not
  // called verified for it; the checks after this still run, so a mismatch they find still fails it.
  const previousBlind = blindBetween(walked, previousSeq, want);
  if (previousBlind) previous = null;
  // What the runner did with the word is the thresholded outcome: an `accept` under the bar is a
  // `retried` step whose memory rightly stands still. The bar is the policy's when it was read (the
  // blob's, checked above, is then the same number) and the blob's otherwise. A blob with no bar
  // (an older blob that records none) is held to the word alone — unless the policy's bar
  // disagrees with the word about this answer: the word is then the writer's choice of reading, the
  // memory is not compared on it, and the step is not called verified.
  const bar = blob.request.minConfidence ?? committedBar;
  const byWord = report.choice === "accept";
  const remembered = bar === undefined ? byWord : applyVerdict(blob.answers, bar).outcome === "accepted";
  const barUnknown =
    blob.request.minConfidence === undefined && committedBar !== undefined && remembered !== byWord
      ? `the decision under ${manifest.verifyHash} records no bar, and its \`${report.choice}\` at ` +
        `${(report.confidence ?? 0).toFixed(2)} is kept by the word but not by the policy's bar of ${committedBar}, ` +
        "so what the runner did with it cannot be said"
      : undefined;
  if (previous && !barUnknown) {
    // The trace store is content-addressed, so "the same memory" and "the same bytes" are the
    // same fact: an accepted step whose answer repeats the previous one word for word commits
    // the hash it already had. That is a loop with nothing new to say, not a chain contradicting
    // itself, so it does not fail. What is still a contradiction is an accepted step that
    // committed *no* memory while the step before it stood on one.
    const unchanged = manifest.memoryHash === previous.memoryHash;
    const advanced = !unchanged && manifest.memoryHash !== undefined;
    report.memoryAdvanced = advanced;
    if (unchanged && remembered) report.memoryRepeated = true;
    if (remembered && !advanced && !unchanged) {
      return bad(
        `the verifier accepted seq ${want} but its manifest commits no memory, while step ${previous.step} ` +
          `stood on ${previous.memoryHash}`
      );
    }
    if (!remembered && advanced) {
      return bad(
        `the verifier answered \`${report.choice}\` on seq ${want}, which is not remembered, but the memory ` +
          `advanced from ${previous.memoryHash ?? "none"} to ${manifest.memoryHash} anyway`
      );
    }
  }

  // The goal answer, when this decision asked it: after the memory, because the runner asks the
  // goal of a step only through the verdict's gate — text it did not remember ends no loop.
  if (withGoal) {
    const status = await statusOf(opts.store, target);
    // With the reading in doubt the verdict's gate is not held against the goal either: either
    // reading may be the runner's, and the step is not called verified for it below.
    const kept = barUnknown ? true : remembered;
    const checked = checkGoalAnswer(
      blob,
      manifest,
      manifest.verifyHash,
      kept,
      status,
      committedGoalBar ?? committedBar
    );
    if (checked.goal) report.goal = checked.goal;
    if (checked.problem) return bad(checked.problem);
  }

  // The loop's channel, as the chain's own vouchers name it. A scripted step buys nothing and
  // carries no voucher, so there is nothing for it to disagree with.
  if (blob.payment?.channelId) {
    report.channelId = blob.payment.channelId;
    const payer = await decisionPayer(records, want, opts.store, blob.payment.channelId, blind);
    if (payer) return { ...report, ...payer };
  }
  if (previousBlind) {
    return absent(
      `the checkpoint before seq ${want} may be in an epoch not read here (${previousBlind}), so whether ` +
        "this step's memory moved as its verdict says cannot be answered"
    );
  }
  if (barUnknown) return absent(barUnknown);
  if (seatUnread) {
    return absent(`the model and bar the verdict was held to cannot be checked against the policy: ${seatUnread}`);
  }
  return { ...report, verdict: "ok" };
}

/** The human-readable rendering, as lines. `cli.ts` prints them; tests read them. */
export function formatStepVerify(r: StepVerifyReport): string[] {
  const out = [`agent      ${r.agentId}`, `seq        ${r.seq}`];
  if (r.verifyHash) out.push(`decision   ${r.verifyHash}`);
  if (r.goalCheckHash) out.push(`decision   ${r.goalCheckHash} (goal check)`);
  if (r.model) out.push(`model      ${r.model}`);
  if (r.choice) out.push(`verdict    ${r.choice}${r.confidence !== undefined ? ` (confidence ${r.confidence})` : ""}`);
  if (r.goal) out.push(goalLine(r.goal));
  if (r.memoryAdvanced !== undefined) {
    const state = r.memoryAdvanced ? "advanced" : r.memoryRepeated ? "remembered, unchanged" : "carried forward";
    out.push(`memory     ${state}`);
  }
  if (r.channelId) out.push(`channel    ${r.channelId}`);
  for (const s of r.sandboxes ?? []) out.push(...formatSandbox(s));
  if (r.sandboxes?.length) {
    out.push(
      "  (the step committed to this posture and this build, and its record agrees with the chain; " +
        "that the process ran inside the posture is the host's word)"
    );
  }
  if (r.sandboxUnread) out.push(`sandbox    not checkable: ${r.sandboxUnread}`);
  if (r.tempo) out.push(...formatStepTempo(r.tempo));
  if (r.roadmap?.length) out.push(`roadmap    written by ${r.roadmap.join(", ")}: not verified by this build`);
  if (r.reason) out.push(`  ${r.reason}`);
  const last = {
    ok: "VERIFIED",
    mismatch: "FAILED",
    payer: "FAILED (wrong channel)",
    // A roadmap step's absence is not a missing preimage: the bytes may all be here, and what this
    // build lacks is the verifier.
    "no-preimage": r.roadmap?.length ? "NOT VERIFIED (roadmap feature)" : "NOT VERIFIED (no preimage)",
    encrypted: "NOT VERIFIED (encrypted)",
  };
  out.push("", last[r.verdict]);
  return out;
}

/**
 * The Tempo lines of `verify-step`: one per storage PUT of the step's report, then the snapshot taken
 * after the step with the record that carried it, then any pairing failure or unread carry.
 */
export function formatStepTempo(t: StepTempoReport): string[] {
  const out = t.storage.flatMap(storageLines);
  if (t.snapshot) {
    const by =
      t.snapshot.carrierStep !== undefined
        ? `carried by step ${t.snapshot.carrierStep} (seq ${t.snapshot.carrierSeq})`
        : `carried by the stop record (seq ${t.snapshot.carrierSeq})`;
    const at = t.snapshot.block ? `block ${t.snapshot.block}` : "no block";
    const err = t.snapshot.error ? ` (the read failed: ${t.snapshot.error.slice(0, 120)})` : "";
    const paired = t.problems.length ? "not paired" : "paired";
    out.push(`snapshot   after step ${t.step}, ${at}${err}, ${by}, ${paired}`);
  } else if (t.snapshots) {
    out.push(`snapshot   after step ${t.step}, not carried by any record yet`);
  }
  if (t.closeBlock) out.push(`stop       the model channel's close settled at block ${t.closeBlock}`);
  for (const p of t.problems) out.push(`tempo      FAIL: ${p}`);
  for (const u of t.unchecked) out.push(`tempo      not checkable: ${u}`);
  return out;
}

/** One sandbox block of `verify-step`: a heading, the three checks, and what is shown as information. */
export function formatSandbox(s: StepSandboxReport): string[] {
  const whose = s.whose === "step" ? "step session" : `member ${s.whose.slice(0, 16)}…`;
  const fold = s.folded ? " (session and synthesis, folded)" : "";
  const word = (c: SandboxCheck) =>
    c.verdict === "pass"
      ? `PASS: ${c.detail}`
      : c.verdict === "fail"
      ? `FAIL: ${c.detail}`
      : `not checkable: ${c.detail}`;
  const out = [
    `sandbox    ${whose}, replay ${s.replayHash.slice(0, 16)}…${fold}`,
    `  replay   ${word(s.replay)}`,
    `  posture  ${word(s.posture)}`,
    `  build    ${word(s.build)}`,
  ];
  const info: string[] = [];
  if (s.wrapper) info.push(`wrapper ${s.wrapper}`);
  if (s.sourcesHash) info.push(`sources ${s.sourcesHash.slice(0, 16)}…`);
  for (const w of s.workspaces ?? []) info.push(`workspace ${w.before.slice(0, 12)}… → ${w.after.slice(0, 12)}…`);
  if (info.length) out.push(`  shown    ${info.join(", ")}`);
  return out;
}

/**
 * The goal line of `verify-step`: `goal: achieved 0.82` or `goal: continue 0.41` — the words the
 * loop page's chip uses — then what the claim and the record said beside it, when that adds
 * anything. An unavailable answer says so rather than printing a word Jev did not give.
 */
export function goalLine(g: StepGoalReport): string {
  const at = g.confidence !== undefined ? ` ${g.confidence.toFixed(2)}` : "";
  const word = g.outcome === "unavailable" ? "unavailable, the agent's claim decided" : `${g.choice}${at}`;
  const notes: string[] = [];
  if (g.choice === "achieved" && g.outcome === "continue") notes.push(`below the bar ${g.bar}`);
  if (g.disagreement === "overruled") notes.push("the agent claimed GOAL REACHED; Jev did not agree");
  if (g.disagreement === "unclaimed") notes.push("Jev judged it achieved; the agent made no claim");
  if (g.terminal === true) notes.push("the record carries 201");
  if (g.terminal === false && g.outcome === "achieved") {
    notes.push("the record carries 200: a checkpoint a Retry wrote late never carries 201");
  }
  return `goal: ${word}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * `0` the verdict stands, `1` the chain and the decision disagree, `2` there was nothing to
 * check. The audit's own codes rather than `verifyInference`'s: this check reaches no network,
 * so nothing here is ever *unchecked but fine*, and a disagreement is the chain contradicting
 * itself, which is what `exitCode` already calls 1.
 */
export function stepVerifyExitCode(r: StepVerifyReport): number {
  if (r.verdict === "ok") return 0;
  if (r.verdict === "no-preimage" || r.verdict === "encrypted") return 2;
  return 1;
}
