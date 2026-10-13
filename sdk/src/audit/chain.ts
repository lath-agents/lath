/**
 * The chain replay behind `lath-audit`: `audit` walks an agent's chain from chain data
 * and, when a trace store is given, checks that the material behind the hashes is still
 * retrievable; `formatReport` and `exitCode` are what the CLI prints and returns. The file-level
 * account of what an auditor can check with only chain data is on `../audit.ts`.
 */
import { NameRecord } from "../abstractions";
import { isSessionScoped } from "../bundle";
import { LathClient } from "../client";
import { EventKind } from "../events";
import { GOAL_REACHED_LINE, goalReachedIn } from "../goal";
import { hex, idFromString, sha256, toBytes32 } from "../hash";
import { decodeLoopManifest, LOOP_STEP_TOOL, type LoopStepManifest, LoopStepStatus } from "../loops";
import { applyVerdict, decodeDecisionBlob, decodeGoalCheckBlob, goalCheckOfBlob } from "../verify";
import { encryptedTraceFor, encryptedTraceHash, isEncryptedTraceBlob, type TraceStore } from "../trace-store";
import { type EpochStore, verifyEpochBlob } from "../rollup";
import { recordFieldsOf, subHashes } from "./core";
import { formatLifecycle, lifecycleSummary, type LifecycleAuditSummary, verifyLifecycle } from "./lifecycle";
import type { SolanaTxReader } from "./solana";
import {
  type CommittedModels,
  chatModelsAt,
  committedModelsAt,
  committedPolicyAt,
  committedSeatOf,
  modelProblem,
  seatProblem,
} from "./models";

export interface AuditReport {
  agentId: string;
  programId: string;
  authority: string;
  seq: string;
  head: string;
  chain: {
    ok: boolean;
    /**
     * Whether the replay actually reached `AgentState.head`. False when a gap runs to the tail
     * — an agent logged entirely with `log_event_compact`, or one whose last write was compact,
     * audited without `--recover`, or a tail whose transaction history the RPC has pruned.
     * Nothing was compared with the head in that case, so the chain is *unchecked*, not
     * verified; `exitCode` gives it its own code.
     */
    headReached: boolean;
    records: number;
    firstBadSeq?: string;
    missingSeqs: string[];
    /**
     * The seqs of `missingSeqs` that transaction history does not explain either — no account and
     * no `EventLogged` / `CellWritten` / `StructCreated` / `AppendPolicySet` for them (`ChainVerification`). The
     * replay re-synced past them, so nothing disagreed, but whatever was written there was not
     * seen: NOT VERIFIED, exit 4. Optional: older reports have none.
     */
    unexplainedGaps?: string[];
    recoveredSeqs: string[];
    /**
     * Seqs whose head came from their event rather than a live account: a `CellWritten` for a closed
     * or replaced-away cell, or a dropped header or rewrite under `--recover`. Optional: older reports
     * have none.
     */
    resyncedSeqs?: string[];
    /** set_append_policy rewrites recomputed from AppendPolicySet. Optional: older reports have none. */
    policyRewrites?: number;
  };
  traces?: {
    checked: number;
    missing: string[];
    /** payload_hashes whose preimage the store does not hold — not a failure by default. */
    preimagesUnavailable: string[];
    /**
     * Records whose payload preimage the store served as plaintext bytes that re-hash to something
     * else. Optional: older reports have none. Always a failure, like `stepBlobsEdited`: the bytes
     * are there and are not what the chain committed, which is the store disagreeing with the
     * chain, not a gap. Bytes that carry an encrypted-trace header without binding to this hash
     * stay `preimagesUnavailable`: without the key they are a shape, not a claim.
     */
    preimagesEdited?: { seq: string; payloadHash: string }[];
    /**
     * payload_hashes whose preimage is *there* and encrypted, with no key given. Optional: older
     * reports have none. A different fact from unavailable, and reported as one — the owner
     * withheld these bytes rather than lost them. Under `--require-preimages` they are not a
     * failure but not a pass either: nothing inside them was read, so the audit is NOT VERIFIED
     * (`notChecked`, exit 4) until `--trace-key` opens them. With the key they decrypt, re-hash,
     * and count as checked like any other.
     *
     * "Encrypted" means the blob carries the encrypted-trace header for this hash at the size the
     * record's kind implies (`encryptedTraceFor`). Without the key an audit cannot tell
     * ciphertext from bytes shaped like it, so this is the owner's claim, and `--trace-key` is
     * what checks it.
     */
    preimagesEncrypted?: string[];
    /**
     * How many of `preimagesEncrypted` are in the older LTE1 format, which carries no hash: for
     * those the size is the only check there is without the key. Optional: absent when there are
     * none.
     */
    encryptedLegacy?: number;
    /**
     * Blobs one level below a preimage the walk *did* read — a step's goal memory or manifest, a
     * verify or goal-check decision blob, a resumed genesis input — that the store served
     * encrypted, with no key given. Optional: absent when there were none.
     *
     * Kept apart from `preimagesEncrypted` because it is a different shape of the same fact: a
     * legitimately encrypted agent never gets here, since its payload preimage is ciphertext too
     * and the walk stops at the record. What gets here is a plaintext record beside a leaf whose
     * only evidence of being the owner's ciphertext is an LTE2 header naming its hash — cleartext
     * anyone can write. Read as `encrypted` alone — the owner's right and never a failure — such
     * a leaf would let `--require-preimages` pass VERIFIED over a goal memory or a decision blob
     * nobody had read. Under that flag these count with `preimagesEncrypted` toward `notChecked`,
     * and `--trace-key` is what settles them: a genuine one opens and re-hashes, a forged one
     * refuses the key and fails.
     */
    blobsEncrypted?: string[];
    /**
     * payload_hashes whose preimage re-hashes correctly but whose leading `kind` byte is not
     * the `kind` of the record that names it. Always a failure: the sub-hash offsets are chosen
     * by kind, so the two disagreeing means the chain and the blob describe different events
     * and no offset in that preimage can be trusted.
     */
    kindMismatches: { payloadHash: string; recordKind: number; preimageKind: number }[];
    /**
     * Records whose `status` or `reference` is not the one the preimage they commit to encodes.
     * Optional: older reports have none. The program stores both beside `payload_hash` without
     * binding them to it, so only a walk that holds the preimage can tell, and a disagreement
     * always fails, like a kind mismatch. `record` and `preimage` are the two values as
     * printed: a decimal status, or a hex reference.
     */
    fieldMismatches?: {
      seq: string;
      payloadHash: string;
      field: "status" | "reference";
      record: string;
      preimage: string;
    }[];
    /**
     * How many epoch steps the walk visited — records that exist only inside an epoch blob that
     * rebuilt its root. Optional: absent when there were none.
     */
    epochSteps?: number;
    /** How many compact logs refilled from history (`--recover`) the walk visited. Optional. */
    recovered?: number;
    /**
     * Blobs the store served and the key in hand could not open — a wrong key, a blob filed
     * under another hash, or bytes whose GCM tag no longer authenticates. Optional: older
     * reports have none. Always a failure, and reported *per record* rather than thrown: the
     * store refuses by raising, and a raise let out of the walk would leave the whole audit as
     * one library sentence with no agent, no seq and no hash. `hash` is the blob that refused,
     * which is often a leaf under the record rather than its payload.
     */
    unopenable?: { hash: string; reason: string; seq?: string; kind?: number; payloadHash?: string }[];
    /**
     * The other blobs a readable `loop.step` manifest commits — its trace audit, gate log, Tempo carry
     * and replay record (`STEP_BLOB_KEYS`), and its members' verdict, routing and replay — that this
     * store does not hold. Optional: absent when there were none. A step's own fail the audit only
     * under `--require-preimages`, the rule the decision blobs are held to: without this walk a step
     * whose every such blob was gone would print VERIFIED under the flag, and the trace audit is what
     * records that a loop stopped. A member's are `reportOnly`, never a failure: they live in the
     * member's own session, which this walk does not open.
     */
    stepBlobsMissing?: { seq: string; key: string; hash: string; reportOnly?: true }[];
    /** Those blobs when the bytes under the hash are something else: always a failure, like a kind mismatch. */
    stepBlobsEdited?: { seq: string; key: string; hash: string }[];
    /**
     * `llm.*` Actions that asked for a model their session's policy does not commit — neither its
     * `model` nor its `fallbackModel`. Always a failure: the record shows a
     * call the Genesis never allowed. Optional: absent when there were none, and never filled for a
     * session whose policy or a call's args this reader could not read.
     */
    modelsUncommitted?: { seq: string; model: string; reason: string }[];
  };
  /**
   * Epochs the chain folded (`commit_epoch`). `steps` is how many seqs they cover. With an
   * `EpochStore`, every blob is fetched and its root rebuilt; a root whose bytes are missing or
   * do not re-derive it is listed in `missing`, and that fails the audit — an epoch nobody can
   * open is a chain segment nobody can check. Without one, nothing is fetched and the audit is
   * not verified either: see `notChecked`.
   */
  epochs?: {
    count: number;
    steps: number;
    checked: number;
    missing: string[];
  };
  /**
   * The name the agent published about itself, present only when it verifies —
   * `sha256(name) === agent_id`. A name that does not is not reported at all, for the same
   * reason `NameRecord.name()` withholds it: an unverifiable name is not a name.
   */
  name?: string;
  /**
   * The steps that said the loop reached its goal: a `loop.step` Action at status 201. Read off
   * the record itself: `status` and `reference` are record fields folded into the head (§4.4),
   * which the SDK derives from the payload. The program does not bind them to `payload_hash`, so
   * the walk cross-checks them against the preimage whenever it holds it — a claim whose record
   * disagrees reads `disputed` — and a chain-only read is the record's word. Filled only when the
   * audit walked the records, which
   * it does when it was given a store — a chain-only audit fetches no records, and paying for a
   * second scan to say something a reader can get from `listByTool` is not worth an RPC call.
   */
  goalReached?: GoalReachedStep[];
  /**
   * The steps that said a second model judged them — every `loop.step` whose manifest carries
   * `verifyHash`. Filled, like `goalReached`, only when the audit was
   * given a store, because the claim lives inside the manifest behind `args_hash` and not on the
   * record.
   */
  verifiedSteps?: VerifiedStep[];
  /**
   * Whether each loop step stood on the memory its loop's previous checkpoint committed. Filled,
   * like `verifiedSteps`, only when the audit was given a store: both halves — the manifest
   * behind `args_hash` and the step's genesis `input` — are blobs.
   */
  memoryLinks?: MemoryLink[];
  /**
   * What this audit was not able to check, when that is the only thing standing between the
   * chain and VERIFIED. Two reasons: epochs the chain folded that no reader was given for (no
   * `--epochs`, `--store` or `--gateway`) — their steps' fields live only in the blob, so a reader
   * who never opened it has seen none of them; and, under `--require-preimages`, payload
   * preimages that are there but encrypted with no `--trace-key` to open them — the sub-hashes,
   * tool ids and goal claims inside were never read — or goal memory and decision blobs a
   * readable manifest names that are there but encrypted (`traces.blobsEncrypted`). Either way the
   * chain is unchecked there, not wrong, and `exitCode` answers 4 as it does for an unreached head.
   * Optional: set only when nothing else failed, because a real failure is the more useful answer.
   */
  notChecked?: string[];
  /**
   * The agent's lifecycle records — its deploy, its loops' starts and transitions — held to the
   * owner's word they carry (`./lifecycle.ts`). Present only when the audit was asked for them
   * (`AuditOptions.lifecycle`) *and* the chain has any: a chain with none reports exactly what it
   * would without the option. A failed check fails the audit.
   */
  lifecycle?: LifecycleAuditSummary;
  ok: boolean;
}

/**
 * One step at 201, and what the memory it committed says about the claim.
 *
 * `terminal` is filled only under `requirePreimages` — the flag that says the reader wants the
 * bytes and not just the hashes. The memory a step commits *is* the answer it ended with, so a
 * step that told the chain the goal was reached and committed memory that does not end with
 * `GOAL REACHED` is the chain and the blob store disagreeing, and it fails the audit.
 */
export interface GoalReachedStep {
  seq: string;
  /** The manifest's tenth key — what the loop was working toward, when the manifest is readable. */
  goalHash?: string;
  /** The memory bytes the step committed, by hash. */
  memoryHash?: string;
  /**
   * `ok` the memory ends with the terminal line; `mismatch` it does not; `missing` the store
   * holds nothing under `memoryHash`, or the step committed no memory at all to stand on;
   * `encrypted` the manifest or memory is there as ciphertext with no key to read it — not a
   * failure, but under `requirePreimages` not a pass either (`traces.blobsEncrypted`);
   * `no-manifest` the manifest is not readable here, so there is nothing to check against;
   * `disputed` the record's status or tool id is not what the payload it commits to encodes, so
   * the claim is the record's word only and its memory is not checked (it fails the audit through
   * `traces.fieldMismatches`). Set whenever the preimage is here, with or without `requirePreimages`.
   * `judged` the memory does not end with the line, and the decision the step committed says Jev
   * judged the goal achieved at or above its bar — which on a loop with the goal check stops the
   * loop without the agent's claim, so it is not a failure.
   */
  terminal?: "ok" | "mismatch" | "missing" | "encrypted" | "no-manifest" | "disputed" | "judged";
  /** On a `judged` step: Jev's confidence and the blob that carries it. */
  judged?: { confidence?: number; hash: string };
}

/**
 * One step that claimed a verifier, and whether the bytes behind the claim are here.
 *
 * Without it, a loop whose every decision blob had been pruned would audit `VERIFIED` and the
 * report would never mention that the loop had claimed to be judged at all — the sub-hash walk
 * reads the fixed offsets of a payload, and `verifyHash` sits a level deeper, inside the
 * manifest. The word an audit prints is about what the chain commits and what the store holds
 * against it, so a commitment whose bytes are gone belongs in it.
 *
 * `decision` is `ok` when the blob is there and re-hashes to the hash the step committed;
 * `mismatch` when the bytes under that hash are something else, which always fails; `missing`
 * when the store has nothing, which fails only under `requirePreimages` — the same rule the goal
 * claim is held to, that an audit not asked for preimages does not fail for want of them; and
 * `encrypted` when the bytes are there as ciphertext with no key to read them, which never fails
 * but under `requirePreimages` leaves the audit NOT VERIFIED (`traces.blobsEncrypted`).
 * The verdict the blob carries is `verifyStepDecision`'s question, not this one's.
 */
export interface VerifiedStep {
  seq: string;
  /** The manifest's ninth key — the decision blob this step committed to. */
  verifyHash: string;
  decision?: "ok" | "missing" | "encrypted" | "mismatch";
}

/**
 * One loop step's resume, held against the checkpoint before it.
 *
 * A step writes what it resumed from twice: its session's genesis `input` carries `memoryHash`,
 * and its loop's previous `loop.step` manifest committed the memory the loop stood on. Without
 * this check the two are compared only by the console, which is the server vouching for itself;
 * `verifyStep` re-hashes each step's memory but
 * never asks whether the next step used it. The step's genesis is found by its session id,
 * `${loopId}:step-${step}`, which the manifest names — not by position, because a synthesis
 * step writes a second session whose memory is session A's output and not the loop's.
 *
 * The comparison is with the loop's most recent checkpoint, not with step − 1: a step that
 * failed before it resolved writes no checkpoint and leaves the memory where it was, so the
 * checkpoint before it still names the memory the next step should stand on.
 *
 * `link` is `ok` when the genesis resumed from exactly what was committed; `mismatch` when it
 * resumed from something else, or from anything when nothing was committed, which always fails —
 * the chain says the loop stood on one memory and the step says it stood on another; `not-resumed`
 * when the loop had a memory and the step's genesis names none, reported and not failed, because
 * it is a step that ignored its memory rather than one that claims a different one; `no-session`
 * when no genesis for the step's session was read here (a step that crashed before its genesis,
 * or a preimage this reader could not open); `unchecked` when a checkpoint between the two could
 * not be read, so which memory came last is not known here; `encrypted` / `missing` for the
 * genesis input's bytes.
 */
export interface MemoryLink {
  seq: string;
  loopId: string;
  step: number;
  /** The memory the loop's previous checkpoint committed, when it committed one. */
  committed?: string;
  /** The memory this step's genesis says it resumed from, when it names one. */
  resumed?: string;
  link: "ok" | "mismatch" | "not-resumed" | "no-session" | "unchecked" | "encrypted" | "missing";
}

export interface AuditOptions {
  store?: TraceStore;
  /**
   * Also read the name the agent published about itself (`NameRecord`) and check it by
   * re-hashing. Off by default: it is an extra account fetch, and an audit is about the chain,
   * not about what the chain is called.
   */
  resolveName?: boolean;
  recover?: boolean;
  traceHashes?: Uint8Array[];
  requirePreimages?: boolean;
  /**
   * Where epoch blobs are read from, keyed by root. Without it, epochs are counted, not opened,
   * and a chain that has any is NOT VERIFIED (`notChecked`, exit 4). With it, every step inside
   * an epoch that rebuilds its root is walked like a record when a store is given too.
   */
  epochs?: EpochStore;
  /**
   * Also read and check the agent's lifecycle records (`verifyLifecycle`), through `store`. Off
   * unless asked: it is one `listByTool` per lifecycle tool and one for `loop.step`, and the CLI
   * asks. `tx` reads the deploy transaction; `keyed` says `store` holds the trace key, so the
   * private halves are opened through it rather than reported unchecked.
   */
  lifecycle?: { tx?: SolanaTxReader; keyed?: boolean };
}

/**
 * A store refusing to open bytes it holds, carried out of the read with the hash that was asked
 * for. `EncryptedTraceStore.get` raises rather than returning null on a wrong key or a tampered
 * tag — deliberately, because "these bytes are not what you think" is not the same answer as
 * "nothing is stored" — so the walk has to catch it *and* know which blob it was about.
 */
class BlobRefused extends Error {
  constructor(readonly hash: Uint8Array, readonly reason: string) {
    super(reason);
  }
}

/** The text a refusal carries; a store may throw anything, and the report prints what it said. */
function refusalText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `store.get`, with a refusal rewrapped so the record walk can name the blob that refused. */
async function readBlob(store: TraceStore, hash: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await store.get(hash);
  } catch (e) {
    throw new BlobRefused(hash, refusalText(e));
  }
}

/** `verifyTrace` through `readBlob`, so a leaf that refuses the key is named and not thrown past. */
async function traceIsHere(store: TraceStore, hash: Uint8Array): Promise<boolean> {
  const bytes = await readBlob(store, hash);
  return bytes !== null && hex(sha256(bytes)) === hex(hash);
}

/**
 * One record the trace walk visits: a record read as an account, a compact log refilled from
 * transaction history (`--recover`), or a step inside an epoch blob that rebuilt its root. The
 * five fields are the `EventInput` every one of them has; `head` is deliberately absent, because
 * an epoch step has none and the walk must never read one.
 */
interface WalkedRecord {
  seq: bigint;
  kind: number;
  status: number;
  reference: Uint8Array;
  payloadHash: Uint8Array;
}

/**
 * The length of a payload preimage, `kind ‖ encodePayload(p)`, by kind: 1 + 128, 1 + 98, 1 + 128
 * and 1 + 69. `encodePayload` is fixed-width and frozen, so a genuine preimage of a kind has
 * exactly one size — and since AES-GCM adds no padding, so does its ciphertext. That is what
 * `encryptedTraceFor` binds an encrypted preimage to.
 */
const PREIMAGE_LEN: Record<number, number> = {
  [EventKind.Genesis]: 129,
  [EventKind.Action]: 99,
  [EventKind.Delegation]: 129,
  [EventKind.Resolution]: 70,
};

export async function audit(client: LathClient, agentId: Uint8Array, opts: AuditOptions = {}): Promise<AuditReport> {
  const found = await client.getAgentState(agentId);
  if (!found) throw new Error(`agent ${hex(agentId)} is not registered on this cluster`);

  const chain = await client.verifyChain(agentId, { recover: opts.recover });
  const report: AuditReport = {
    agentId: hex(agentId),
    programId: client.programId.toBase58(),
    authority: found.state.authority.toBase58(),
    seq: chain.seq.toString(),
    head: hex(chain.head),
    chain: {
      ok: chain.ok,
      headReached: chain.headReached,
      records: chain.records,
      firstBadSeq: chain.firstBadSeq?.toString(),
      missingSeqs: chain.missingSeqs.map(String),
      // `?? []` for a `LathClient` that does not report the field (an older client, or a stub of
      // one): absent means nothing was reported, which is what such a client's `ok` already assumed.
      unexplainedGaps: (chain.unexplainedGaps ?? []).map(String),
      recoveredSeqs: chain.recoveredSeqs.map(String),
      resyncedSeqs: chain.resyncedSeqs.map(String),
      // `?? 0` for the same reason as `unexplainedGaps`: a client that does not fold policy rewrites
      // reports none.
      policyRewrites: chain.policyRewrites ?? 0,
    },
    ok: chain.ok,
  };

  if (opts.resolveName) {
    const published = await new NameRecord(client, agentId).name();
    if (published) report.name = published;
  }

  // The steps each epoch batched, kept for the trace walk below: an epoch step writes no record
  // account, so its four fields exist nowhere but in the blob, and only a blob that rebuilds its
  // root is believed about them.
  const epochSteps: WalkedRecord[] = [];
  if (chain.epochs.length > 0) {
    const missingEpochs: string[] = [];
    let checked = 0;
    if (opts.epochs) {
      for (const e of chain.epochs) {
        const blob = await opts.epochs.get(e.epochRoot);
        const decoded = blob ? verifyEpochBlob(blob, e.epochRoot, e.startSeq, e.endSeq) : null;
        if (!decoded) {
          missingEpochs.push(hex(e.epochRoot));
          continue;
        }
        checked++;
        decoded.inputs.forEach((input, i) =>
          epochSteps.push({
            seq: e.startSeq + BigInt(i),
            kind: input.kind,
            status: input.status,
            reference: input.reference,
            payloadHash: input.payloadHash,
          })
        );
      }
    }
    report.epochs = {
      count: chain.epochs.length,
      steps: chain.epochs.reduce((n, e) => n + Number(e.endSeq - e.startSeq), 0),
      checked,
      missing: missingEpochs,
    };
  }

  const tracesFailed =
    opts.store || opts.traceHashes?.length ? await walkTraces(client, agentId, opts, chain, epochSteps, report) : false;

  // One verdict for every path through here, so a chain-only audit cannot skip a check by
  // returning before the final conjunction.
  //
  // An epoch nobody was given a reader for is *unchecked*, which is not the same as wrong: its
  // steps' kind, status, reference and payload_hash are in the blob and nowhere else, so a reader
  // who never opened it has seen none of them, and the chain replay only folds the root. That is
  // the answer an unreached head gets, and it gets the same treatment — NOT VERIFIED, exit 4 —
  // rather than VERIFIED. A real failure outranks it, which is why `notChecked` is set only when
  // nothing else failed.
  // Lifecycle records after the trace walk, through the same store: their documents are blobs like
  // any leaf, anchored one per cell in the agent's registry (Irys) or kept in the trace directory.
  if (opts.lifecycle) {
    const lifecycle = lifecycleSummary(
      await verifyLifecycle({
        client,
        store: opts.store ?? null,
        agentId,
        tx: opts.lifecycle.tx,
        keyedStore: opts.lifecycle.keyed ? opts.store : undefined,
        authority: report.authority,
        programId: report.programId,
      })
    );
    if (lifecycle) report.lifecycle = lifecycle;
  }
  // A failed lifecycle check is the owner's word not checking out — a disagreement, like a kind
  // mismatch, so it fails the audit (exit 2) and outranks anything merely not checked.
  const lifecycleFailed = report.lifecycle?.verdict === "failed";

  const failed = !chain.ok || (report.epochs?.missing.length ?? 0) > 0 || tracesFailed || lifecycleFailed;
  const unopened = opts.epochs ? 0 : chain.epochs.length;
  // A preimage that is there and encrypted is the owner withholding it, not losing it — but a
  // reader who asked for every preimage and opened none of these has checked nothing inside them.
  // Letting it satisfy `--require-preimages` would audit an encrypted agent VERIFIED with its
  // sub-hashes, tool ids and goal claims unread. A keyed store decrypts what it can and raises on
  // what it cannot (`unopenable`), so anything still here had no key.
  const sealed = opts.requirePreimages ? report.traces?.preimagesEncrypted?.length ?? 0 : 0;
  // The same rule one level down. Goal memory and decision blobs sit behind a manifest rather
  // than at a payload's fixed offsets, and an `encrypted` answer there left uncounted would let an
  // LTE2 header naming the memory hash — forty junk bytes anyone can write — stand in for a
  // memory that does not say GOAL REACHED, and the audit would print VERIFIED. Counting them here
  // and not failing them is deliberate: without the key a forged header and the owner's real
  // ciphertext are the same bytes to this reader, and `--trace-key` is what tells them apart.
  const sealedLeaves = opts.requirePreimages ? report.traces?.blobsEncrypted?.length ?? 0 : 0;
  // Asked for every preimage with nothing to read one from: the walk above never ran, so no
  // preimage counts as missing or encrypted, and the flag alone would pass by default —
  // VERIFIED, exit 0, over an audit that fetched nothing. It is the reader's gap, like an
  // unopened epoch, so it is `notChecked` (exit 4) rather than a usage error: the same command
  // without the flag is a sound structure-only audit, and the flag only adds what it cannot do.
  const noReader = opts.requirePreimages === true && !opts.store;
  report.ok = !failed && unopened === 0 && sealed === 0 && sealedLeaves === 0 && !noReader;
  const notChecked: string[] = [];
  if (unopened > 0) {
    notChecked.push(
      `${unopened} epoch${unopened === 1 ? "" : "s"} not opened (${report.epochs!.steps} steps): ` +
        "pass --epochs, --store or --gateway"
    );
  }
  if (sealed > 0) {
    notChecked.push(`${sealed} encrypted preimage${sealed === 1 ? "" : "s"} not opened: pass --trace-key <hex|path>`);
  }
  if (sealedLeaves > 0) {
    notChecked.push(
      `${sealedLeaves} encrypted blob${sealedLeaves === 1 ? "" : "s"} behind a readable preimage not opened ` +
        "(goal memory, decisions): pass --trace-key <hex|path>"
    );
  }
  if (noReader) notChecked.push(NO_PREIMAGE_READER);
  if (!failed && notChecked.length) report.notChecked = notChecked;
  return report;
}

/**
 * The trace half of `audit`: checks the hashes the caller handed in, then — with a store — walks
 * every record the chain has, fills `report.traces`, `goalReached` and `verifiedSteps`, and says
 * whether anything it found fails the audit. The chain and epoch halves of the verdict are the
 * caller's.
 *
 * "Every record" is three sources, merged by seq and walked in ascending order:
 *
 * - the record accounts (`listEvents`);
 * - under `--recover`, the compact logs the replay refilled from transaction history — they have
 *   no account, so `listEvents` never returned them;
 * - the steps inside each epoch blob that rebuilt its root.
 *
 * The last is the one that matters most. Epoch-batched LLM Actions are a loop's most common
 * event, and without walking them an audit with an empty trace store and `--require-preimages`
 * would print VERIFIED over an epoch whose every preimage was gone — SPEC §14.3's "walkable
 * everywhere except its most common event", with nothing in the report saying so. Epoch steps and
 * recovered records are held to exactly the record rules: a missing leaf always fails, an
 * unavailable preimage fails only under `requirePreimages`.
 *
 * The order is load-bearing, not cosmetic: a session's genesis has to open the session's bundle
 * before any of its later hashes — epoch steps included — is asked for.
 */
async function walkTraces(
  client: LathClient,
  agentId: Uint8Array,
  opts: AuditOptions,
  chain: { recoveredSeqs: bigint[] },
  epochSteps: WalkedRecord[],
  report: AuditReport
): Promise<boolean> {
  const missing: string[] = [];
  const preimagesUnavailable: string[] = [];
  const preimagesEdited: NonNullable<NonNullable<AuditReport["traces"]>["preimagesEdited"]> = [];
  const preimagesEncrypted: string[] = [];
  const kindMismatches: { payloadHash: string; recordKind: number; preimageKind: number }[] = [];
  const fieldMismatches: NonNullable<NonNullable<AuditReport["traces"]>["fieldMismatches"]> = [];
  const unopenable: NonNullable<NonNullable<AuditReport["traces"]>["unopenable"]> = [];
  // A set, because one blob can be named twice — a goal-check hash is both the step's decision
  // and the goal claim's fallback — and the count in `notChecked` is of blobs, not of readings.
  const blobsEncrypted = new Set<string>();
  const stepBlobsMissing: NonNullable<NonNullable<AuditReport["traces"]>["stepBlobsMissing"]> = [];
  const stepBlobsEdited: NonNullable<NonNullable<AuditReport["traces"]>["stepBlobsEdited"]> = [];
  const modelsUncommitted: NonNullable<NonNullable<AuditReport["traces"]>["modelsUncommitted"]> = [];
  // The models the session being walked may call, from its Genesis policy: set at each
  // Genesis, in seq order, so every Action after it is held to the session it belongs to.
  // `undefined` is a policy this reader could not read, which leaves its calls unchecked.
  const modelCache = new Map<string, CommittedModels | null | undefined>();
  let sessionModels: CommittedModels | null | undefined;
  // The whole policy document of the session being walked, for the goal claim's decision: the
  // model and bar a decision blob records are the writer's word, and the policy is what holds them.
  // Reset at every Genesis before anything can return, so an unreadable one is `undefined` — never
  // the previous session's policy standing in for it.
  const policyCache = new Map<string, unknown>();
  let sessionPolicy: unknown;
  let checked = 0;
  let encryptedLegacy = 0;

  for (const h of opts.traceHashes ?? []) {
    checked++;
    if (!opts.store) {
      missing.push(hex(h));
      continue;
    }
    // A hash the caller handed in has no record behind it, so a refusal here is named by the
    // blob alone — the same line the walk below writes, without a seq to hang it on.
    try {
      if (!(await traceIsHere(opts.store, h))) missing.push(hex(h));
    } catch (e) {
      if (!(e instanceof BlobRefused)) throw e;
      unopenable.push({ hash: hex(e.hash), reason: e.reason });
    }
  }

  const goalReached: GoalReachedStep[] = [];
  const verifiedSteps: VerifiedStep[] = [];
  const memoryLinks: MemoryLink[] = [];
  // The resume check's two halves, filled as the ordered walk passes them: every genesis's input
  // blob by session id, and each loop's latest readable checkpoint. `unreadableCheckpoints` counts
  // `loop.step` manifests this reader could not open — one of them may be the latest checkpoint
  // of any loop, so a link across one is `unchecked` rather than compared with an older memory.
  const sessionInputs = new Map<string, Uint8Array>();
  const lastCheckpoint = new Map<string, { memoryHash?: string; unreadableBefore: number }>();
  let unreadableCheckpoints = 0;
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  let recovered = 0;
  let inEpochs = 0;

  if (opts.store) {
    const store = opts.store;

    const walkRecord = async (rec: WalkedRecord): Promise<void> => {
      // The goal claim comes off the record, before any blob: a 201 `loop.step` is a loop saying
      // it finished because it got there. Checking the memory behind it needs the manifest, so
      // that half waits for the preimage below — and so does checking that the record's status
      // is the one its payload encodes, which the program does not bind.
      if (
        rec.kind === EventKind.Action &&
        rec.status === LoopStepStatus.GoalReached &&
        hex(rec.reference) === stepTool
      ) {
        goalReached.push({ seq: rec.seq.toString() });
      }
      const claim = goalReached[goalReached.length - 1]?.seq === rec.seq.toString() ? goalReached.at(-1) : undefined;
      // Every blob read below belongs to this record, and a store handed a key *raises* on bytes
      // it cannot authenticate rather than returning nothing. Catching that here is what lets the
      // report name it — seq, kind, payload hash and the blob that refused — and walk on to the
      // next record, rather than letting the raise out of the whole audit as one library sentence
      // with no agent, no seq and no hash, on a chain whose other blobs open fine.
      // Both are reset here, before the first return below can fire: a Genesis whose preimage is
      // missing, sealed, refused or mis-tagged returns early, and a reset placed after those
      // returns would leave the previous session's models holding this session's `llm.*` calls —
      // failing a chain for a model its own (unread) policy may well commit.
      if (rec.kind === EventKind.Genesis) {
        sessionPolicy = undefined;
        sessionModels = undefined;
      }
      try {
        // A session's preimages and sub-blobs are in one bundle keyed by its genesis payload hash,
        // so a store that reads bundles is handed the session
        // before any of its hashes is asked for. One registry read and one download per session,
        // against one registry read per hash without it. Every other store ignores this.
        if (rec.kind === EventKind.Genesis && isSessionScoped(store)) await store.openSession(rec.payloadHash);
        if (rec.kind === EventKind.Genesis) {
          sessionPolicy = await committedPolicyAt(store, rec, policyCache).catch(() => undefined);
        }
        const preimage = await readBlob(store, rec.payloadHash);
        if (preimage === null || hex(sha256(preimage)) !== hex(rec.payloadHash)) {
          // An LTE2 header naming another hash is a blob filed under the wrong key: nothing here
          // is this record's preimage, and a keyed store would have refused it by raising. It is
          // the same answer without the key, so it fails the same way.
          const named = preimage !== null ? encryptedTraceHash(preimage) : null;
          if (named && hex(named) !== hex(rec.payloadHash)) {
            unopenable.push({
              hash: hex(rec.payloadHash),
              reason: `encrypted blob names another hash ${hex(named)}`,
              seq: rec.seq.toString(),
              kind: rec.kind,
              payloadHash: hex(rec.payloadHash),
            });
            if (claim) claim.terminal = "no-manifest";
            return;
          }
          // Bytes that are there and encrypted are a third answer, not a missing blob: the store
          // served them, they carry the trace header for this hash at the one size ciphertext of
          // this kind's preimage can have, and only the owner's key turns them back into a
          // preimage. A header alone is four bytes anyone can write, so junk carrying a magic, or
          // ciphertext of the wrong length, is unavailable. Nothing below this record can
          // be walked either way, so the leaves are left alone exactly as for an unavailable one.
          const sealed =
            preimage !== null ? encryptedTraceFor(preimage, rec.payloadHash, PREIMAGE_LEN[rec.kind]) : null;
          // Plaintext that is there and re-hashes to something else is neither: the store holds
          // other bytes under this record's hash, which the default audit must not pass over as
          // merely unavailable. It fails like an edited step blob.
          const edited = preimage !== null && !sealed && !isEncryptedTraceBlob(preimage);
          if (sealed) {
            preimagesEncrypted.push(hex(rec.payloadHash));
            if (sealed === "lte1") encryptedLegacy++;
          } else if (edited) {
            preimagesEdited.push({ seq: rec.seq.toString(), payloadHash: hex(rec.payloadHash) });
          } else preimagesUnavailable.push(hex(rec.payloadHash));
          if (claim) claim.terminal = sealed ? "encrypted" : "no-manifest";
          return;
        }
        checked++;
        // The preimage is `kind ‖ encodePayload(payload)`, and `subHashes` reads fixed offsets
        // chosen by kind — so decoding it at the *record's* kind without first checking the
        // preimage's own tag would read whatever happens to sit at those offsets and report the
        // result as a sub-hash. The two disagreeing is a real disagreement between the chain and
        // the bytes it commits to, so it is named rather than papered over; no offset in this
        // preimage is meaningful afterwards, which is why the leaves are not walked.
        if (preimage[0] !== rec.kind) {
          kindMismatches.push({ payloadHash: hex(rec.payloadHash), recordKind: rec.kind, preimageKind: preimage[0] });
          if (claim) claim.terminal = "no-manifest";
          return;
        }
        // `status` and `reference` are record fields folded into the head (§4.4), and the SDK
        // derives both from the payload — but the program stores them beside `payload_hash`
        // without binding them to it, so an authority can write a `loop.step` at 201 over a
        // payload that says 200, or under a tool id the payload does not name. Holding the
        // preimage is the one moment the walk can tell, and a disagreement always fails, for the
        // reason a kind mismatch does: the chain and the bytes describe different events.
        const fields = recordFieldsOf(rec.kind, preimage.slice(1));
        let disputed = false;
        if (fields.status !== undefined && fields.status !== rec.status) {
          disputed = true;
          fieldMismatches.push({
            seq: rec.seq.toString(),
            payloadHash: hex(rec.payloadHash),
            field: "status",
            record: String(rec.status),
            preimage: String(fields.status),
          });
        }
        if (fields.reference && hex(fields.reference) !== hex(rec.reference)) {
          disputed = true;
          fieldMismatches.push({
            seq: rec.seq.toString(),
            payloadHash: hex(rec.payloadHash),
            field: "reference",
            record: hex(rec.reference),
            preimage: hex(fields.reference),
          });
        }
        // A goal claim read off a record its own payload contradicts is the record's word only,
        // and checking its memory would dress that word up as a checked one.
        if (claim && disputed) claim.terminal = "disputed";
        const leaves = subHashes(rec.kind, preimage.slice(1));
        for (const sub of leaves) {
          checked++;
          if (!(await traceIsHere(store, sub))) missing.push(hex(sub));
        }
        // The bytes half of the goal claim, and only when the reader asked for bytes: the memory
        // this step committed has to end with the line that stopped the loop. Without
        // `requirePreimages` the claim is reported from the chain alone and nothing is fetched,
        // because an audit that was not asked for preimages does not fail for want of them.
        if (claim && !disputed && opts.requirePreimages)
          await checkGoalMemory(store, leaves[0], claim, blobsEncrypted, sessionPolicy);
        // The model check: a Genesis sets what its session may call, and each `llm.*` Action
        // after it is held to that — its request's model is the policy's or the committed fallback.
        // A disputed record is the record's word only, as for the goal claim, and is not judged here.
        if (rec.kind === EventKind.Genesis) sessionModels = await committedModelsAt(store, rec, modelCache);
        else if (rec.kind === EventKind.Action && sessionModels && !disputed) {
          const called = await chatModelsAt(store, rec);
          const problem = called ? modelProblem(called.asked, sessionModels) : null;
          if (called && problem)
            modelsUncommitted.push({ seq: rec.seq.toString(), model: called.asked, reason: problem });
        }
        // The first genesis of each session only: a session id is written once per session, and
        // a later genesis under the same id would not be the one the step opened with.
        if (rec.kind === EventKind.Genesis && leaves[0]) {
          const sessionId = hex(preimage.slice(1, 33));
          if (!sessionInputs.has(sessionId)) sessionInputs.set(sessionId, leaves[0]);
        }
        // The verifier half of the same idea, and it runs on every step rather than only under
        // `requirePreimages`: a loop that claimed to be judged should say so in the report whether
        // or not the reader asked for bytes, and the claim is only readable through the manifest.
        if (rec.kind === EventKind.Action && hex(rec.reference) === stepTool) {
          const manifest = await readStepManifest(store, leaves[0]);
          const claimed = await checkStepDecision(store, manifest);
          if (claimed) verifiedSteps.push({ seq: rec.seq.toString(), ...claimed });
          if (claimed?.decision === "encrypted") blobsEncrypted.add(claimed.verifyHash);
          if (manifest) {
            const blobs = await checkStepBlobs(store, manifest);
            const seq = rec.seq.toString();
            for (const b of blobs) {
              checked++;
              if (b.state === "edited") stepBlobsEdited.push({ seq, key: b.key, hash: b.hash });
              else if (b.state === "missing") {
                stepBlobsMissing.push({ seq, key: b.key, hash: b.hash, ...(b.reportOnly ? { reportOnly: true } : {}) });
              } else if (b.state === "encrypted") blobsEncrypted.add(b.hash);
            }
          }
          // A disputed record is not a `loop.step` by its own payload, so it is no checkpoint of
          // any loop: it neither links nor moves the loop's latest memory.
          if (!manifest) unreadableCheckpoints++;
          else if (!disputed) {
            const before = lastCheckpoint.get(manifest.loopId);
            lastCheckpoint.set(manifest.loopId, {
              memoryHash: manifest.memoryHash,
              unreadableBefore: unreadableCheckpoints,
            });
            const link =
              before &&
              (await checkMemoryLink(store, manifest, before, unreadableCheckpoints, sessionInputs, blobsEncrypted));
            if (link) memoryLinks.push({ seq: rec.seq.toString(), ...link });
          }
        }
      } catch (e) {
        // Only a refusal is this walk's to report; anything else — an RPC that died, a bug here
        // — is not something an audit should turn into a line about bytes, so it still throws.
        if (!(e instanceof BlobRefused)) throw e;
        unopenable.push({
          hash: hex(e.hash),
          reason: e.reason,
          seq: rec.seq.toString(),
          kind: rec.kind,
          payloadHash: hex(rec.payloadHash),
        });
      }
    };

    const walked = new Map<string, WalkedRecord>();
    for (const rec of await client.listEvents(agentId)) walked.set(rec.seq.toString(), rec);
    // A second history walk, and only under `--recover`: the replay already refilled these seqs,
    // but `ChainVerification` carries their seqs and not their fields, and reading them again
    // here keeps the write path's client untouched.
    if (opts.recover && chain.recoveredSeqs.length) {
      const wanted = new Set(chain.recoveredSeqs.map(String));
      for (const rec of await client.recoverCompactEvents(agentId)) {
        const seq = rec.seq.toString();
        if (!wanted.has(seq) || walked.has(seq)) continue;
        walked.set(seq, rec);
        recovered++;
      }
    }
    for (const step of epochSteps) {
      const seq = step.seq.toString();
      if (walked.has(seq)) continue;
      walked.set(seq, step);
      inEpochs++;
    }
    const ordered = [...walked.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (const rec of ordered) await walkRecord(rec);
  }

  report.traces = {
    checked,
    missing,
    preimagesUnavailable,
    kindMismatches,
    fieldMismatches,
    preimagesEncrypted,
    unopenable,
  };
  if (preimagesEdited.length) report.traces.preimagesEdited = preimagesEdited;
  if (encryptedLegacy) report.traces.encryptedLegacy = encryptedLegacy;
  if (blobsEncrypted.size) report.traces.blobsEncrypted = [...blobsEncrypted];
  if (stepBlobsMissing.length) report.traces.stepBlobsMissing = stepBlobsMissing;
  if (stepBlobsEdited.length) report.traces.stepBlobsEdited = stepBlobsEdited;
  if (modelsUncommitted.length) report.traces.modelsUncommitted = modelsUncommitted;
  if (inEpochs) report.traces.epochSteps = inEpochs;
  if (recovered) report.traces.recovered = recovered;
  if (goalReached.length) report.goalReached = goalReached;
  if (verifiedSteps.length) report.verifiedSteps = verifiedSteps;
  if (memoryLinks.length) report.memoryLinks = memoryLinks;
  return !(
    missing.length === 0 &&
    kindMismatches.length === 0 &&
    // A record that disagrees with the preimage it commits to is the chain and the bytes
    // describing different events, like a kind mismatch — whether or not preimages were asked for.
    fieldMismatches.length === 0 &&
    // Bytes that are here and will not open are a failure whether or not the reader asked for
    // preimages, and unlike `preimagesEncrypted` they are not the owner withholding anything:
    // a key was given, the blob refused it, and nothing can say what the chain committed there.
    unopenable.length === 0 &&
    // A preimage the store holds as other bytes is the store and the chain disagreeing, with or
    // without the flag; only an absent one waits for the reader to ask.
    preimagesEdited.length === 0 &&
    (!opts.requirePreimages || preimagesUnavailable.length === 0) &&
    // A step that committed a decision hash whose bytes are something else is the chain and the
    // store disagreeing, like a kind mismatch. Bytes merely absent are the reader's gap, and
    // they fail only when the reader said they wanted the bytes.
    !verifiedSteps.some((v) => v.decision === "mismatch") &&
    (!opts.requirePreimages || !verifiedSteps.some((v) => v.decision === "missing")) &&
    // The same two rules for the step's other committed blobs. A member's missing blob is
    // report-only: it is in the member's session, which this walk never opened.
    stepBlobsEdited.length === 0 &&
    // A call to a model the session's policy never allowed is a record the policy does not cover.
    modelsUncommitted.length === 0 &&
    (!opts.requirePreimages || !stepBlobsMissing.some((b) => !b.reportOnly)) &&
    // A step that told the chain it reached the goal and committed memory that says otherwise is
    // the two disagreeing, which is the one thing an audit exists to catch. `encrypted` and
    // `no-manifest` are not that: they are bytes this reader was not given.
    !goalReached.some((g) => g.terminal === "mismatch" || g.terminal === "missing") &&
    // A step whose genesis says it stood on a memory its loop's last checkpoint did not commit is
    // the chain disagreeing with itself about what the loop remembered.
    !memoryLinks.some((l) => l.link === "mismatch")
  );
}

/**
 * The goal claim against the bytes: the memory the step committed must end with the terminal
 * line, because that memory *is* the answer the loop stopped on.
 *
 * The manifest is read through `args_hash` rather than trusted from anywhere else, so this
 * checks the chain's own commitment and not the console's record of it. A step at 201 that
 * committed no `memoryHash` at all is `missing` and not `ok`: it claimed to have reached the
 * goal and left nothing behind that says so.
 *
 * Reads go through `readBlob`, so bytes that are here and refuse the key are raised to the record
 * walk and named against the record — not silently folded into `missing`, which says the opposite
 * (nobody kept them) about a blob that is sitting in the store.
 */
async function checkGoalMemory(
  store: TraceStore,
  argsHash: Uint8Array | undefined,
  claim: GoalReachedStep,
  sealed: Set<string>,
  policy: unknown
): Promise<void> {
  if (!argsHash) {
    claim.terminal = "no-manifest";
    return;
  }
  const manifestBytes = await readBlob(store, argsHash);
  // Header-bound, with no length: a manifest and a memory vary in size, so the header naming this
  // hash is all that separates the owner's ciphertext from bytes that merely start with "LTE" —
  // and that header is cleartext anyone can write, so the blob goes into `sealed`, which keeps
  // `--require-preimages` from passing over it.
  if (manifestBytes && encryptedTraceFor(manifestBytes, argsHash)) {
    sealed.add(hex(argsHash));
    claim.terminal = "encrypted";
    return;
  }
  // Re-hashed before it is decoded, as `readStepManifest` does: the memory hash the claim is held
  // to comes out of these bytes, so other bytes under `args_hash` would pick the memory the goal
  // is checked against. The leaf walk already fails them as missing; this keeps the goal line from
  // reading `ok` over a manifest the chain never committed.
  const manifest =
    manifestBytes && hex(sha256(manifestBytes)) === hex(argsHash) ? decodeLoopManifest(manifestBytes) : null;
  if (!manifest) {
    claim.terminal = "no-manifest";
    return;
  }
  claim.goalHash = manifest.goalHash;
  claim.memoryHash = manifest.memoryHash;
  if (!manifest.memoryHash) {
    claim.terminal = "missing";
    return;
  }
  const memory = await readBlob(store, toBytes32(manifest.memoryHash));
  if (memory && encryptedTraceFor(memory, toBytes32(manifest.memoryHash))) {
    sealed.add(manifest.memoryHash);
    claim.terminal = "encrypted";
    return;
  }
  if (!memory || hex(sha256(memory)) !== manifest.memoryHash) {
    claim.terminal = "missing";
    return;
  }
  if (goalReachedIn(new TextDecoder().decode(memory))) {
    claim.terminal = "ok";
    return;
  }
  // No claim in the memory. On a loop with Jev's goal check that is not a contradiction when the
  // decision the step committed says Jev judged the goal achieved at its bar: the check, not the
  // claim, is what stopped the loop. Read through the same hash-checked
  // path as the memory, and `mismatch` whenever the blob is absent or says anything else.
  const decisionHash = manifest.goalCheckHash ?? manifest.verifyHash;
  if (decisionHash) {
    const raw = await readBlob(store, toBytes32(decisionHash));
    const blob = raw && hex(sha256(raw)) === decisionHash ? decodeGoalCheckBlob(raw) : null;
    // Held to the seat the session's policy commits, not to the model and bar the blob records:
    // the goal check's own on a goal-only blob, the verifier's on a combined one, whose goal answer
    // is held to the goal check's bar — beside the seat, the seat's own.
    // An unreadable policy is a preimage this claim needs and does not have.
    if (blob && policy === undefined) {
      claim.terminal = "missing";
      return;
    }
    const seat = committedSeatOf(policy, manifest.goalCheckHash ? "goalCheck" : "verify");
    if (blob && (!seat || seatProblem(blob.request, seat, decisionHash))) {
      claim.terminal = "mismatch";
      return;
    }
    const goalBar = committedSeatOf(policy, "goalCheck")?.minConfidence ?? seat?.minConfidence;
    const decision = blob ? goalCheckOfBlob(blob, goalBar) : null;
    // The verdict's gate, on a combined blob: the runner never ends a loop on text it did not keep.
    const verdict = blob && !manifest.goalCheckHash ? decodeDecisionBlob(raw!) : null;
    const verdictBar = verdict?.request.minConfidence ?? seat?.minConfidence;
    const remembered = !verdict
      ? true
      : verdictBar === undefined
      ? verdict.answers.verdict.choice === "accept"
      : applyVerdict(verdict.answers, verdictBar).outcome === "accepted";
    if (decision?.outcome === "achieved" && remembered) {
      claim.terminal = "judged";
      claim.judged = { confidence: decision.confidence, hash: decisionHash };
      return;
    }
  }
  claim.terminal = "mismatch";
}

/**
 * The manifest a `loop.step` record's `args_hash` names, read once for every check that needs
 * it. `null` when it is absent, encrypted to a key this reader was not given, or not a manifest.
 */
async function readStepManifest(store: TraceStore, argsHash: Uint8Array | undefined): Promise<LoopStepManifest | null> {
  if (!argsHash) return null;
  const bytes = await readBlob(store, argsHash);
  if (!bytes || encryptedTraceFor(bytes, argsHash) || hex(sha256(bytes)) !== hex(argsHash)) return null;
  return decodeLoopManifest(bytes);
}

/**
 * One step's resume against its loop's previous checkpoint; see `MemoryLink` for the verdicts.
 * `null` when there is nothing to say: the loop committed no memory and the step claims none,
 * which is every step of a loop that keeps no memory and is not worth a line.
 */
async function checkMemoryLink(
  store: TraceStore,
  manifest: LoopStepManifest,
  before: { memoryHash?: string; unreadableBefore: number },
  unreadableNow: number,
  sessionInputs: Map<string, Uint8Array>,
  sealed: Set<string>
): Promise<Omit<MemoryLink, "seq"> | null> {
  const base = { loopId: manifest.loopId, step: manifest.step, committed: before.memoryHash };
  if (before.unreadableBefore !== unreadableNow) return { ...base, link: "unchecked" };
  const inputHash = sessionInputs.get(hex(idFromString(`${manifest.loopId}:step-${manifest.step}`)));
  if (!inputHash) return { ...base, link: "no-session" };
  const raw = await readBlob(store, inputHash);
  // Counted toward `--require-preimages` for the reason `checkGoalMemory` gives.
  if (raw && encryptedTraceFor(raw, inputHash)) {
    sealed.add(hex(inputHash));
    return { ...base, link: "encrypted" };
  }
  if (!raw || hex(sha256(raw)) !== hex(inputHash)) return { ...base, link: "missing" };
  // The input is `toBlob(object)`, JSON, and `memoryHash` is present only on a resumed session —
  // absent rather than empty (`runtime.ts`, the genesis `input` spread). Anything that is not an
  // object with a string there names no memory.
  let resumed: string | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed?.memoryHash === "string") resumed = parsed.memoryHash;
  } catch {
    resumed = undefined;
  }
  if (!before.memoryHash) return resumed ? { ...base, resumed, link: "mismatch" } : null;
  if (!resumed) return { ...base, link: "not-resumed" };
  return { ...base, resumed, link: resumed === before.memoryHash ? "ok" : "mismatch" };
}

/**
 * The verifier claim behind a `loop.step` record: does its manifest name a decision blob, and
 * are those bytes here?
 *
 * `null` for a step that claimed nothing — a loop with verify off, or a step whose verifier was
 * unreachable, both of which write the manifest they always wrote. That is the shape the report
 * needs: no line at all, rather than a line saying a loop was not verified when nothing ever
 * said it would be. Reads go through `readBlob` for the reason `checkGoalMemory` gives.
 */
async function checkStepDecision(
  store: TraceStore,
  manifest: LoopStepManifest | null
): Promise<Omit<VerifiedStep, "seq"> | null> {
  // A goal-check blob is the same kind of commitment under the fourteenth key,
  // on a loop with no verify seat, and is counted with the verdicts: a pruned one is just as unread.
  const verifyHash = manifest?.verifyHash ?? manifest?.goalCheckHash;
  if (!verifyHash) return null;
  const raw = await readBlob(store, toBytes32(verifyHash));
  if (!raw) return { verifyHash, decision: "missing" };
  // Header-bound, as in `checkGoalMemory`: an encrypted-looking blob that names another hash is
  // not this decision withheld, it is other bytes under this hash, and reads `mismatch`. One that
  // names this hash is still only a cleartext claim, so the walk counts it toward
  // `--require-preimages` rather than taking it as the owner's word.
  if (encryptedTraceFor(raw, toBytes32(verifyHash))) return { verifyHash, decision: "encrypted" };
  return { verifyHash, decision: hex(sha256(raw)) === verifyHash ? "ok" : "mismatch" };
}

/**
 * The manifest keys besides the decision and the memory whose bytes a step puts through its own
 * store, so the console's seal puts them in the step's bundle (`frontend/.../loop-step.ts`, sealed after
 * the checkpoint): the trace audit and the gate log (roadmap features, named by manifests that carry
 * them), the Tempo carry (`storeCarry`) and the sandbox's replay record (the ZeroClaw runtime is an
 * `AgentRuntime` and puts through the same store).
 */
const STEP_BLOB_KEYS = ["traceAuditHash", "gateHash", "tempoHash", "replayHash"] as const;

/**
 * The other blobs a readable manifest commits: each of `STEP_BLOB_KEYS`, then each member's
 * `verifyHash`, `routeHash` and `replayHash`. `edited` when the store serves bytes under the hash that
 * do not re-hash to it; `encrypted` when they carry an LTE2 header naming it (a cleartext claim
 * `--trace-key` settles, as for a decision blob); `missing` when the store has nothing; `ok`.
 * Members' reads are `reportOnly`: their blobs sit in the member's own session, a refusal of this
 * reader's key there is not this chain's, and none of them fails or holds back the audit.
 */
async function checkStepBlobs(
  store: TraceStore,
  manifest: LoopStepManifest
): Promise<{ key: string; hash: string; state: "ok" | "missing" | "edited" | "encrypted"; reportOnly?: true }[]> {
  const named: { key: string; hash: string; reportOnly?: true }[] = [];
  for (const key of STEP_BLOB_KEYS) {
    const hash = manifest[key];
    if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) named.push({ key, hash });
  }
  for (const [i, m] of (manifest.members ?? []).entries()) {
    for (const key of ["verifyHash", "routeHash", "replayHash"] as const) {
      const hash = m[key];
      if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) {
        named.push({ key: `members[${i}].${key}`, hash, reportOnly: true });
      }
    }
  }
  const out: { key: string; hash: string; state: "ok" | "missing" | "edited" | "encrypted"; reportOnly?: true }[] = [];
  for (const n of named) {
    const at = toBytes32(n.hash);
    let raw: Uint8Array | null;
    if (n.reportOnly) {
      raw = await store.get(at).catch(() => null);
      // Ciphertext, or nothing: either way the member's business, said and not counted.
      if (!raw || encryptedTraceFor(raw, at)) {
        out.push({ ...n, state: "missing" });
        continue;
      }
    } else {
      // Through `readBlob`, so a refusal of the key is named against the record.
      raw = await readBlob(store, at);
      if (!raw) {
        out.push({ ...n, state: "missing" });
        continue;
      }
      if (encryptedTraceFor(raw, at)) {
        out.push({ ...n, state: "encrypted" });
        continue;
      }
    }
    out.push({ ...n, state: hex(sha256(raw)) === n.hash ? "ok" : "edited" });
  }
  return out;
}

/**
 * Is this report's only complaint that the replay stopped short of `AgentState.head`? That is a
 * different answer from both "verified" and "broken", and the CLI says so in both the last line
 * and the exit code: nothing disagreed, but nothing checked the head either.
 */
function headUnreached(r: AuditReport): boolean {
  return r.chain.headReached === false && r.chain.firstBadSeq === undefined;
}

/** The `notChecked` entry for `--require-preimages` with no store or gateway to read them from. */
const NO_PREIMAGE_READER = "--require-preimages with no preimage reader: pass --store or --gateway";

/**
 * Is the replay's complaint a mid-chain gap nothing explains? Like an unreached head it
 * is "not checked", not "broken": every head that was compared agreed.
 */
function gapsUnexplained(r: AuditReport): boolean {
  return r.chain.firstBadSeq === undefined && (r.chain.unexplainedGaps?.length ?? 0) > 0;
}

/** The last line's reason for each `notChecked` entry, in the order they were recorded. */
function notCheckedLabel(reasons: string[]): string {
  return reasons
    .map((n) =>
      n === NO_PREIMAGE_READER
        ? "no preimage reader given"
        : n.includes("encrypted blob")
        ? "encrypted blobs not opened"
        : n.includes("--trace-key")
        ? "encrypted preimages not opened"
        : "epochs not opened"
    )
    .join(", ");
}

/** The human-readable rendering of a report, as lines. `cli.ts` prints them; tests read them. */
export function formatReport(r: AuditReport): string[] {
  const chainState = r.chain.ok
    ? "OK"
    : r.chain.firstBadSeq !== undefined
    ? `BROKEN at seq ${r.chain.firstBadSeq}`
    : r.chain.headReached === false
    ? "HEAD NOT REACHED"
    : "GAPS NOT ACCOUNTED FOR";
  const out = [
    `agent      ${r.agentId}${r.name ? ` (${r.name})` : ""}`,
    `program    ${r.programId}`,
    `authority  ${r.authority}`,
    `seq        ${r.seq} (${r.chain.records} records replayed)`,
    `head       ${r.head}`,
    `chain      ${chainState}`,
  ];
  if (r.chain.headReached === false) {
    out.push(
      "  the replay stopped at a gap and never reached AgentState.head — nothing above was",
      "  compared with it. A compact log there is refilled by --recover; a closed cell is",
      "  already re-synced from its CellWritten event, so a gap still open without --recover is a",
      "  compact log or a record not shown, and one still open with it is a write this RPC does not return"
    );
  }
  // No account to read at these seqs and no `CellWritten` for them either. On a chain still OK
  // every one is a compact log history names (`--recover` refills those); any other gap is
  // listed again just below and clears `ok`, so this line does not offer "history this RPC no
  // longer has" as a way to pass.
  if (r.chain.missingSeqs.length) {
    out.push(
      `  no account at seq: ${r.chain.missingSeqs.join(", ")} (` +
        (r.chain.unexplainedGaps?.length ? "compact log, or a record not shown" : "compact log") +
        `; --recover refills compact logs)`
    );
  }
  // A mid-chain gap no compact write in history explains: the replay re-synced past it, so it is
  // not a divergence, but the auditor has not seen what sits there. That is a record
  // the indexer is not returning — whether or not history still lists the `log_event` that wrote
  // it — or a write whose history this RPC pruned. `--recover` folds whatever history holds.
  if (r.chain.unexplainedGaps?.length) {
    out.push(
      `  not accounted for: seq ${r.chain.unexplainedGaps.join(", ")} — no account, and no compact write in ` +
        `transaction history; pass --recover against an RPC that still holds the agent's history; a gap that ` +
        `stays open is a write this RPC is not showing`
    );
  }
  if (r.chain.recoveredSeqs.length) out.push(`  recovered from tx history: ${r.chain.recoveredSeqs.join(", ")}`);
  if (r.chain.resyncedSeqs?.length) {
    out.push(
      `  head re-synced from its event (closed/replaced cell, or a dropped header/rewrite under --recover): ` +
        r.chain.resyncedSeqs.join(", ")
    );
  }
  if (r.chain.policyRewrites) out.push(`  policy rewrites folded from AppendPolicySet: ${r.chain.policyRewrites}`);
  if (r.epochs) {
    const opened = r.epochs.checked + r.epochs.missing.length;
    // Said as an instruction, because an unopened epoch is the reader's gap and not the chain's:
    // naming the flag that closes it is the whole of what the reader needs.
    const state =
      opened === 0
        ? "not opened: pass --epochs <dir>, --store or --gateway to open them"
        : r.epochs.missing.length
        ? `${r.epochs.missing.length} MISSING`
        : "all rebuilt";
    out.push(`epochs     ${r.epochs.count} (${r.epochs.steps} steps, ${state})`);
    for (const m of r.epochs.missing.slice(0, 20)) out.push(`  missing epoch: ${m}`);
  }
  if (r.traces) {
    // A chain with a blob that will not open is not "all retrievable" — that word beside a
    // FAILED verdict would contradict it.
    const unopened = r.traces.unopenable?.length ?? 0;
    const edited = r.traces.preimagesEdited?.length ?? 0;
    const state = r.traces.missing.length
      ? `${r.traces.missing.length} MISSING`
      : unopened
      ? `${unopened} UNOPENABLE`
      : edited
      ? `${edited} EDITED`
      : "all retrievable";
    // Where the walked records came from, when not all of them were accounts: an epoch step and a
    // recovered compact log are walked under the record rules, and the reader should see that
    // they were walked at all.
    const sources = [
      r.traces.epochSteps ? `, ${r.traces.epochSteps} steps inside epochs` : "",
      r.traces.recovered ? `, ${r.traces.recovered} recovered from history` : "",
    ].join("");
    out.push(`traces     ${state} (${r.traces.checked} checked${sources})`);
    for (const m of r.traces.missing.slice(0, 20)) out.push(`  missing: ${m}`);
    if (r.traces.preimagesUnavailable.length) {
      out.push(`  payload preimages unavailable: ${r.traces.preimagesUnavailable.length}`);
    }
    for (const e of r.traces.preimagesEdited?.slice(0, 20) ?? []) {
      out.push(`  payload preimage edited: seq ${e.seq} ${e.payloadHash} — the bytes under it hash to something else`);
    }
    // Said with or without --require-preimages: the content is the owner's to hand over, not
    // anything wrong. Under the flag they are also why the audit is NOT VERIFIED (`notChecked`),
    // because a reader who asked for every preimage has read none of these. The LTE1 count is
    // said separately because for those blobs the size is the only thing an audit without the key
    // could check.
    if (r.traces.preimagesEncrypted?.length) {
      const legacy = r.traces.encryptedLegacy
        ? ` (${r.traces.encryptedLegacy} in the older LTE1 format, whose hash only the key can check)`
        : "";
      out.push(
        `  payload preimages encrypted: ${r.traces.preimagesEncrypted.length}${legacy}` +
          ` (pass --trace-key <hex|path> to read them)`
      );
    }
    // Named in the goal, verifier and memory lines below too; counted here because under
    // --require-preimages they are part of why the audit is NOT VERIFIED.
    if (r.traces.blobsEncrypted?.length) {
      out.push(
        `  blobs behind readable preimages encrypted: ${r.traces.blobsEncrypted.length}` +
          ` (pass --trace-key <hex|path> to read them)`
      );
    }
    for (const m of r.traces.kindMismatches.slice(0, 20)) {
      out.push(`  kind disagrees with preimage: ${m.payloadHash} (record ${m.recordKind}, preimage ${m.preimageKind})`);
    }
    for (const m of r.traces.fieldMismatches?.slice(0, 20) ?? []) {
      out.push(`  record disagrees with its preimage: seq ${m.seq} ${m.field} ${m.record} (preimage ${m.preimage})`);
    }
    // The line a refusal is reported on: which blob refused the key, and which record was being
    // walked when it did. `payload` is printed beside the blob because the two are usually
    // different — a leaf under the record refuses far more often than the payload itself — and
    // the store's own words are kept, since they are what a reader would otherwise have to guess.
    for (const u of r.traces.unopenable?.slice(0, 20) ?? []) {
      const where = u.seq !== undefined ? ` (seq ${u.seq}, kind ${u.kind}, payload ${u.payloadHash})` : "";
      out.push(`  could not be opened with this key: ${u.hash}${where}: ${u.reason}`);
    }
    // A step's other committed blobs: edited always fails; missing fails under
    // --require-preimages, and a member's is said and never counted.
    for (const b of r.traces.stepBlobsEdited?.slice(0, 20) ?? []) {
      out.push(`  step blob edited: seq ${b.seq} ${b.key} ${b.hash} — the bytes under it hash to something else`);
    }
    for (const m of r.traces.modelsUncommitted?.slice(0, 20) ?? []) {
      out.push(`  model not in the policy: seq ${m.seq} ${m.reason}`);
    }
    for (const b of r.traces.stepBlobsMissing?.slice(0, 20) ?? []) {
      out.push(
        `  step blob not retrievable: seq ${b.seq} ${b.key} ${b.hash}${
          b.reportOnly ? " (a member's, in its own session; not counted)" : ""
        }`
      );
    }
  }
  // A loop that finished because it got where it was going, said in the one word the sheet puts
  // on this line. Printed after the traces because the memory check below it is a trace answer.
  for (const g of r.goalReached ?? []) {
    out.push(`goal       goal reached at seq ${g.seq}${g.goalHash ? ` (goal ${g.goalHash})` : ""}`);
    if (g.terminal === "ok") out.push(`  memory ${g.memoryHash} ends with "${GOAL_REACHED_LINE}"`);
    if (g.terminal === "judged") {
      const at = g.judged?.confidence !== undefined ? ` at ${g.judged.confidence.toFixed(2)}` : "";
      out.push(
        `  Jev judged the goal achieved${at} in the decision ${g.judged?.hash}; the step made no claim of its own`
      );
    }
    if (g.terminal === "mismatch") {
      out.push(`  the memory ${g.memoryHash} this step committed does not end with "${GOAL_REACHED_LINE}"`);
    }
    if (g.terminal === "missing") {
      out.push(
        g.memoryHash
          ? `  the memory ${g.memoryHash} this step committed is not retrievable here`
          : "  this step committed no memory, so nothing here says the goal was reached"
      );
    }
    if (g.terminal === "encrypted") out.push("  its memory is encrypted (pass --trace-key <hex|path> to read it)");
    if (g.terminal === "no-manifest") out.push("  its manifest is not available here, so the memory was not checked");
    if (g.terminal === "disputed") {
      out.push("  the record's status disagrees with the payload it commits to; the claim is the record's word only");
    }
  }
  // What the loop claimed about being judged, counted rather than listed: a loop of sixty steps
  // with every decision in the store is one line, and the steps whose bytes are not here are
  // named, because those are the ones a reader would otherwise take on trust.
  if (r.verifiedSteps?.length) {
    const count = (d: VerifiedStep["decision"]) => r.verifiedSteps!.filter((v) => v.decision === d).length;
    out.push(`verified   ${r.verifiedSteps.length} steps claim a verifier (${count("ok")} decisions retrievable)`);
    for (const v of r.verifiedSteps.slice(0, 20)) {
      if (v.decision === "missing") out.push(`  seq ${v.seq}: the decision ${v.verifyHash} is not retrievable here`);
      if (v.decision === "mismatch") out.push(`  seq ${v.seq}: the bytes under ${v.verifyHash} are not that decision`);
      if (v.decision === "encrypted") {
        out.push(`  seq ${v.seq}: its decision is encrypted (pass --trace-key <hex|path> to read it)`);
      }
    }
    // The word the audit prints is about hashes: whether each verdict *agreed* with what the
    // step did with its memory is `lath-audit verify-step <agent> <seq>`, one step at a time.
    if (count("ok")) out.push("  what each verdict said is `verify-step <agent> <seq>`");
  }
  // Counted like the verifier line, and only the steps that did not link cleanly are named.
  if (r.memoryLinks?.length) {
    const ok = r.memoryLinks.filter((l) => l.link === "ok").length;
    out.push(
      `memory     ${ok} of ${r.memoryLinks.length} loop steps resumed from the memory their loop's last checkpoint committed`
    );
    for (const l of r.memoryLinks.filter((m) => m.link !== "ok").slice(0, 20)) {
      const at = `  seq ${l.seq}: step ${l.step}`;
      if (l.link === "mismatch") {
        out.push(
          `${at} resumed from ${l.resumed ?? "no memory"}, but the checkpoint before it committed ${
            l.committed ?? "none"
          }`
        );
      }
      if (l.link === "not-resumed") out.push(`${at} started without the memory ${l.committed} its loop had committed`);
      if (l.link === "no-session")
        out.push(`${at}: no genesis for its session was read here, so its resume was not checked`);
      if (l.link === "unchecked") {
        out.push(`${at}: a checkpoint before it could not be read, so which memory it should resume is not known here`);
      }
      if (l.link === "encrypted")
        out.push(`${at}: its genesis input is encrypted (pass --trace-key <hex|path> to read it)`);
      if (l.link === "missing") out.push(`${at}: its genesis input is not retrievable here`);
    }
  }
  // Only for a chain with lifecycle records, so a report without them prints no lifecycle lines.
  if (r.lifecycle) out.push(...formatLifecycle(r.lifecycle));
  out.push(
    "",
    r.ok
      ? "VERIFIED"
      : headUnreached(r)
      ? "NOT VERIFIED (head not reached)"
      : gapsUnexplained(r)
      ? "NOT VERIFIED (gaps not accounted for)"
      : r.notChecked?.length
      ? `NOT VERIFIED (${notCheckedLabel(r.notChecked)})`
      : "FAILED"
  );
  return out;
}

/**
 * The exit code the CLI contract promises: 0 verified, 1 the chain does not replay, 2 traces or
 * epoch blobs are missing, 4 the replay never reached `AgentState.head`, left a mid-chain gap
 * transaction history does not explain, or the chain's epochs (or, under `--require-preimages`,
 * its encrypted preimages) were not opened.
 *
 * 4 is its own code rather than folded into 1 because the two say different things to whoever
 * is reading the status: 1 is "this chain is wrong", 4 is "this chain was not checked" — the
 * answer for a compact-logged agent audited without `--recover`, and for an epoch chain audited
 * with no reader for its epochs. An unreached head ranks above 2 for the same reason 1
 * does: an unreplayed chain makes the trace result beside the point. Unopened epochs rank below
 * 2 instead, and `notChecked` is only set when nothing else failed, so a real failure still
 * exits 2.
 */
export function exitCode(r: AuditReport): number {
  if (r.chain.firstBadSeq !== undefined) return 1;
  if (r.chain.headReached === false) return 4;
  // A gap the fold re-synced past, with no history naming its seq: not a divergence — so not 1 —
  // but not a checked chain either.
  if (gapsUnexplained(r)) return 4;
  if (!r.chain.ok) return 1;
  if (r.notChecked?.length) return 4;
  return r.ok ? 0 : 2;
}
