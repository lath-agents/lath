/**
 * Epochs: many steps, one chain write.
 *
 * An epoch batches N per-step events off-chain and anchors a single Merkle root on-chain with
 * `commit_epoch`, which advances the owner's `seq` from `start_seq` to `end_seq` and folds the
 * root into the chain head. No `EventRecord` accounts are created for the steps.
 *
 * ## What the root commits to
 *
 * Each leaf is the step's `EventInput` — the same 75 bytes a full `log_event` would have put
 * on-chain — plus the seq the step occupies:
 *
 * ```text
 * leaf_i = sha256("lattice.epoch.leaf" ‖ seq_le ‖ timestamp_le ‖ kind ‖ status_le ‖ reference ‖ payload_hash)
 * ```
 *
 * So an auditor holding the epoch blob (the ordered `EventInput`s) rebuilds every leaf, the
 * root, and compares it to the root the chain folded. There is no off-chain "head" per step:
 * the only head is the one `commit_epoch` computes, and it is over the root. That is what makes
 * the blob self-verifying and the design match the on-chain formula rather than approximate it.
 *
 * ## Where the blob lives
 *
 * `EpochStore` keys blobs by their root. `AnchoredEpochStore` publishes `root → locator` in the
 * owner's on-chain `LocatorRegistry`, so a reader with only the chain (the `EpochCommitted`
 * event carries the root) finds the bytes and re-derives the root from them — the same
 * trust-nothing path `AnchoredTraceStore` takes for traces.
 */
import { Bytes32, i64le, sha256, u16le, u32le, u64le, utf8, ZERO32, hex } from "./hash";
import { EventInput, EventKind, EventPayload, toEventInput } from "./events";
import { LAMPORTS_PER_HEADER_WRITE, LAMPORTS_PER_RECORD } from "./storage";

// ─── Leaves and trees ───────────────────────────────────────────────────────

interface EpochMerkleTree {
  root: Bytes32;
  leafCount: number;
  depth: number;
  layers: Bytes32[][];
}

interface EpochMerkleProof {
  root: Bytes32;
  leaf: Bytes32;
  index: number;
  proof: Bytes32[];
}

// Frozen: devnet chains already committed roots built over this tag, so its bytes never change.
// Changing the domain would invalidate every epoch already anchored.
const LEAF_TAG = utf8("lattice.epoch.leaf");

/** The leaf for the step at `seq` with input `e`. See the module note for the formula. */
export function computeEpochLeaf(seq: bigint | number, e: EventInput): Bytes32 {
  return sha256(
    LEAF_TAG,
    u64le(seq),
    i64le(e.timestamp),
    new Uint8Array([e.kind]),
    u16le(e.status),
    e.reference,
    e.payloadHash
  );
}

/** Leaves for a contiguous run of inputs starting at `startSeq`. */
export function epochLeaves(startSeq: bigint | number, inputs: EventInput[]): Bytes32[] {
  const start = BigInt(startSeq);
  return inputs.map((e, i) => computeEpochLeaf(start + BigInt(i), e));
}

/** A balanced SHA-256 Merkle tree over leaves; an odd last node is paired with itself. */
export function createEpochMerkleTree(leaves: Bytes32[]): EpochMerkleTree {
  if (leaves.length === 0) return { root: ZERO32, leafCount: 0, depth: 0, layers: [[ZERO32]] };
  const layers: Bytes32[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: Bytes32[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : left;
      next.push(sha256(left, right));
    }
    layers.push(next);
    current = next;
  }
  return { root: layers[layers.length - 1][0], leafCount: leaves.length, depth: layers.length - 1, layers };
}

/** The root an epoch of `inputs` at `startSeq` anchors. */
export function epochRootOf(startSeq: bigint | number, inputs: EventInput[]): Bytes32 {
  return createEpochMerkleTree(epochLeaves(startSeq, inputs)).root;
}

export function generateEpochProof(tree: EpochMerkleTree, index: number): EpochMerkleProof {
  if (index < 0 || index >= tree.leafCount) {
    throw new Error(`index ${index} out of bounds (0..${tree.leafCount - 1})`);
  }
  const proof: Bytes32[] = [];
  let idx = index;
  for (let layer = 0; layer < tree.depth; layer++) {
    const nodes = tree.layers[layer];
    const sibling = idx % 2 === 1 ? idx - 1 : idx + 1;
    proof.push(sibling < nodes.length ? nodes[sibling] : nodes[idx]);
    idx = Math.floor(idx / 2);
  }
  return { root: tree.root, leaf: tree.layers[0][index], index, proof };
}

/** Verifies an inclusion proof. Pure; no RPC. */
export function verifyEpochProof(root: Bytes32, leaf: Bytes32, proof: Bytes32[], index: number): boolean {
  let current = leaf;
  let idx = index;
  for (const sibling of proof) {
    current = idx % 2 === 1 ? sha256(sibling, current) : sha256(current, sibling);
    idx = Math.floor(idx / 2);
  }
  return hex(current) === hex(root);
}

// ─── The blob ───────────────────────────────────────────────────────────────

/** `timestamp i64 ‖ kind u8 ‖ status u16 ‖ reference 32 ‖ payload_hash 32` — the on-chain `EventInput`. */
const EPOCH_STEP_LEN = 75;
const BLOB_MAGIC = utf8("LEP1");
const BLOB_HEADER_LEN = 4 + 4 + 8;

/** `"LEP1" ‖ count u32 ‖ start_seq u64 ‖ count × EventInput`. */
export function encodeEpochBlob(startSeq: bigint | number, inputs: EventInput[]): Uint8Array {
  const out = new Uint8Array(BLOB_HEADER_LEN + inputs.length * EPOCH_STEP_LEN);
  out.set(BLOB_MAGIC, 0);
  out.set(u32le(inputs.length), 4);
  out.set(u64le(startSeq), 8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  inputs.forEach((e, i) => {
    const o = BLOB_HEADER_LEN + i * EPOCH_STEP_LEN;
    view.setBigInt64(o, BigInt(e.timestamp), true);
    out[o + 8] = e.kind;
    view.setUint16(o + 9, e.status, true);
    out.set(e.reference, o + 11);
    out.set(e.payloadHash, o + 43);
  });
  return out;
}

interface DecodedEpochBlob {
  startSeq: bigint;
  inputs: EventInput[];
}

export function decodeEpochBlob(blob: Uint8Array): DecodedEpochBlob {
  if (blob.length < BLOB_HEADER_LEN) throw new Error("epoch blob too short");
  if (hex(blob.subarray(0, 4)) !== hex(BLOB_MAGIC)) throw new Error("epoch blob has the wrong magic");
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = view.getUint32(4, true);
  const startSeq = view.getBigUint64(8, true);
  const expected = BLOB_HEADER_LEN + count * EPOCH_STEP_LEN;
  if (blob.length !== expected) {
    throw new Error(`epoch blob corrupted: expected ${expected} bytes for ${count} steps, got ${blob.length}`);
  }
  const inputs: EventInput[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = BLOB_HEADER_LEN + i * EPOCH_STEP_LEN;
    inputs[i] = {
      timestamp: view.getBigInt64(o, true),
      kind: blob[o + 8] as EventKind,
      status: view.getUint16(o + 9, true),
      reference: blob.slice(o + 11, o + 43),
      payloadHash: blob.slice(o + 43, o + 75),
    };
  }
  return { startSeq, inputs };
}

/**
 * Is `blob` really the epoch `[startSeq, endSeq)` whose root the chain folded? Decodes,
 * checks the bounds, rebuilds the root. Returns the steps when it does, `null` when it does not.
 */
export function verifyEpochBlob(
  blob: Uint8Array,
  root: Bytes32,
  startSeq: bigint,
  endSeq: bigint
): DecodedEpochBlob | null {
  let decoded: DecodedEpochBlob;
  try {
    decoded = decodeEpochBlob(blob);
  } catch {
    return null;
  }
  if (decoded.startSeq !== startSeq) return null;
  if (BigInt(decoded.inputs.length) !== endSeq - startSeq) return null;
  if (hex(epochRootOf(startSeq, decoded.inputs)) !== hex(root)) return null;
  return decoded;
}

// ─── Chain step ─────────────────────────────────────────────────────────────

/**
 * The chain step for an epoch commit. Must match `epoch_head` in the program byte-for-byte:
 *
 * ```text
 * head = sha256(prev ‖ agent_id ‖ "lattice.epoch" ‖ start_seq_le ‖ end_seq_le ‖ epoch_root)
 * ```
 *
 * Domain-separated from `computeHead` and `computeCellHead`. The `"lattice.epoch"` domain is a
 * frozen hash input — devnet chains already folded it into their heads, and a changed domain
 * would make every epoch commit on them fail to verify.
 */
export function computeEpochHead(
  prev: Bytes32,
  agentId: Bytes32,
  epochRoot: Bytes32,
  startSeq: bigint | number,
  endSeq: bigint | number
): Bytes32 {
  return sha256(prev, agentId, utf8("lattice.epoch"), u64le(startSeq), u64le(endSeq), epochRoot);
}

// ─── Stores ─────────────────────────────────────────────────────────────────

/**
 * Where epoch blobs live, keyed by the root the chain committed.
 *
 * `put` runs **before** `commit_epoch` — the chain must never point at bytes nobody kept — and
 * `anchor`, when a store has one, runs **after** it: publishing `root → locator` is itself a
 * write on the owner's chain, and it cannot go in front of the epoch whose seq it would take.
 */
export interface EpochStore {
  put(root: Bytes32, blob: Uint8Array): Promise<void>;
  get(root: Bytes32): Promise<Uint8Array | null>;
  /**
   * Publishes the blob's location on chain. May answer `{ published: false }` when the store
   * batches locators (`AnchoredEpochStore` with `every > 1`): the epoch is anchored, its
   * locator is queued for the next manifest, and `flush()` writes it.
   */
  anchor?(root: Bytes32): Promise<void | { published: boolean }>;
  /** Writes whatever `anchor` queued. Stores that publish per epoch have nothing to flush. */
  flush?(): Promise<unknown>;
}

export class MemoryEpochStore implements EpochStore {
  private blobs = new Map<string, Uint8Array>();
  async put(root: Bytes32, blob: Uint8Array): Promise<void> {
    this.blobs.set(hex(root), blob);
  }
  async get(root: Bytes32): Promise<Uint8Array | null> {
    return this.blobs.get(hex(root)) ?? null;
  }
  /** Test seam: a store that hands back the wrong bytes. */
  tamper(root: Bytes32, blob: Uint8Array): void {
    this.blobs.set(hex(root), blob);
  }
  get size(): number {
    return this.blobs.size;
  }
}

// ─── Batcher ────────────────────────────────────────────────────────────────

/**
 * Two things the chain knows that a count-or-timer batcher does not: what a write costs right
 * now, and whether the payer can afford one. Both are one RPC call (`LathClient.chainSignals`
 * builds them), and both turn "dynamic" batching into a behaviour:
 *
 * - **fees**: when the priority-fee market is at or below `lowFeeMicroLamports`, an epoch that
 *   is at least `earlyFlushFraction` full is committed now rather than waiting for the count or
 *   the timer — the commit is as cheap as it is going to get.
 * - **balance**: an epoch is not *opened* (its first step is refused) while the payer holds less
 *   than `minPayerLamports`. Queued steps whose flush could not be paid for would sit in memory
 *   with nothing on chain behind them; refusing at the door is the honest failure. An epoch that
 *   is already open still flushes — the chain must not be left short.
 *
 * Signals are sampled at most every `sampleIntervalMs`, so a busy session does not turn every
 * step into an RPC call.
 */
export interface ChainSignals {
  /** Current priority-fee estimate, micro-lamports per compute unit (e.g. the recent median). */
  priorityFee?: () => Promise<number>;
  /** The payer's lamports. */
  payerBalance?: () => Promise<number>;
  /** Flush early at or below this fee. Default 0: only when the market asks for no priority fee. */
  lowFeeMicroLamports?: number;
  /** How full the epoch must be before a low fee flushes it. Default 0.5. */
  earlyFlushFraction?: number;
  /** Refuse to open an epoch below this balance. Default: one epoch commit plus one record plus one locator cell. */
  minPayerLamports?: number;
  /** Default 5 000 ms. */
  sampleIntervalMs?: number;
}

/** What a `ChainSignals` refusal looks like, so a caller can tell it from a chain error. */
export class InsufficientPayerBalance extends Error {
  constructor(readonly balance: number, readonly required: number) {
    super(`payer holds ${balance} lamports; an epoch needs at least ${required} to commit and anchor`);
    this.name = "InsufficientPayerBalance";
  }
}

/** `commit_epoch` + the locator cell that anchors the blob + one record after it. */
export const DEFAULT_MIN_PAYER_LAMPORTS = LAMPORTS_PER_HEADER_WRITE + 2 * LAMPORTS_PER_RECORD;

interface RollupBatcherConfig {
  /** Steps per epoch before an automatic flush. */
  batchSize: number;
  /** Maximum ms an incomplete epoch waits before flushing. 0 disables the timer. */
  maxFlushDelayMs: number;
  /** Fee- and balance-aware behaviour. Off when absent. */
  signals?: ChainSignals;
  /**
   * Every commit, whichever trigger produced it. The only way to see a `time` flush, which
   * runs from a timer and has no caller to return to.
   */
  onCommit?: (commit: EpochCommit) => void;
  /** A timer flush that failed. Without it the rejection would be unhandled. */
  onError?: (error: unknown, trigger: EpochFlushTrigger) => void;
}

const DEFAULT_ROLLUP_BATCHER_CONFIG: RollupBatcherConfig = { batchSize: 1000, maxFlushDelayMs: 300_000 };

/** Why an epoch was committed. */
export type EpochFlushTrigger = "count" | "time" | "fee" | "manual";

/** What one flush produced. `tree` is kept so proofs can be generated afterwards. */
export interface EpochCommit {
  signature: string;
  /** What caused the flush. Set by the batcher; a committer called directly leaves it `manual`. */
  trigger?: EpochFlushTrigger;
  epochRoot: Bytes32;
  startSeq: bigint;
  endSeq: bigint;
  head: Bytes32;
  tree: EpochMerkleTree;
  blob: Uint8Array;
  inputs: EventInput[];
  /** False when the commit landed but the locator cell did not; `anchorError` says why. */
  anchored?: boolean;
  anchorError?: string;
  /** True when the locator is queued for a manifest rather than on chain yet (`anchored` stays true). */
  anchorPending?: boolean;
}

/**
 * Turns a run of inputs into an anchored epoch. The committer decides `startSeq` — it has to be
 * the owner's current `seq`, which only a read of `AgentState` at commit time knows — stores the
 * blob, sends `commit_epoch`, and returns the commit. `createEpochCommitter` is the one
 * `LathClient` provides.
 */
export type EpochCommitter = (inputs: EventInput[]) => Promise<EpochCommit>;

/**
 * Buffers per-step inputs and flushes them as one epoch on a count or time trigger. Seqs are
 * not assigned at push time: an epoch occupies `[seq, seq + n)` as of the moment it commits, so
 * any individually logged event must be preceded by a `flush()` or the two would race for the
 * same seq. `DynamicStorageEngine` enforces that ordering.
 */
export class RollupBatcher {
  private buffer: EventInput[] = [];
  private commits: EpochCommit[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<EpochCommit | null> | null = null;
  private lastFee: { at: number; value: number } | null = null;
  private lastBalance: { at: number; value: number } | null = null;

  constructor(
    public readonly config: RollupBatcherConfig = DEFAULT_ROLLUP_BATCHER_CONFIG,
    private readonly committer: EpochCommitter
  ) {}

  /**
   * The balance half of `signals` on its own: throws `InsufficientPayerBalance` when the next
   * step would open an epoch (nothing is buffered) and the payer holds less than one epoch
   * costs. A no-op while an epoch is already open, which still flushes whatever the balance —
   * the chain must not be left short — and a no-op without `signals.payerBalance`.
   *
   * Public so a caller that must pay for a step before queuing it can be refused before the
   * money moves. `push` asks the same question, but only after the caller has already charged
   * the user and paid the model for the step it is pushing, which is a refusal that leaves the
   * user paying for a step no epoch carries. Sampled at most every `sampleIntervalMs`,
   * so asking twice in one step costs one RPC call at most.
   */
  async admit(): Promise<void> {
    if (this.buffer.length !== 0 || !this.config.signals?.payerBalance) return;
    const balance = await this.sampleBalance();
    const required = this.config.signals.minPayerLamports ?? DEFAULT_MIN_PAYER_LAMPORTS;
    if (balance < required) throw new InsufficientPayerBalance(balance, required);
  }

  /**
   * Queues a step. Returns the commit when this push completed an epoch, else `null`.
   * Throws `InsufficientPayerBalance` when `signals.payerBalance` says a new epoch could not be
   * paid for — before the step is queued, so nothing is held that the chain will never see.
   *
   * `admitted` skips that check for a step the caller already ran through `admit()` before it
   * paid for it: a sample taken after a slow charge must not refuse a step the user has already
   * been debited for, because the refusal would drop the only copy of it.
   */
  async push(
    step: EventInput | EventPayload,
    timestamp?: bigint | number,
    opts?: { admitted?: boolean }
  ): Promise<EpochCommit | null> {
    const input = "payloadHash" in step ? step : toEventInput(step, timestamp ?? Date.now());
    if (!opts?.admitted) await this.admit();
    this.buffer.push(input);
    if (this.buffer.length >= this.config.batchSize) return this.flush("count");
    if (this.config.signals?.priorityFee && (await this.feesAreLow())) return this.flush("fee");
    if (!this.flushTimer && this.config.maxFlushDelayMs > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush("time").catch((e) => this.config.onError?.(e, "time"));
      }, this.config.maxFlushDelayMs);
    }
    return null;
  }

  /**
   * Commits whatever is buffered. Waits for every in-progress flush first, so nothing interleaves,
   * and returns only once no epoch is in flight.
   *
   * A loop, not one wait: when two flushes wait on the same epoch, the first to wake takes the
   * buffer and starts the next one, and after a single wait the second would find an empty buffer
   * and return `null` while that epoch is still committing — so `flushEpochs` would let a write
   * logged on its own race an epoch whose seqs it would take. An in-flight epoch that fails has
   * already put its steps back (below), and they are this flush's to commit, so its error is not
   * this caller's to rethrow.
   */
  async flush(trigger: EpochFlushTrigger = "manual"): Promise<EpochCommit | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.inFlight) await this.inFlight.catch(() => {});
    if (this.buffer.length === 0) return null;
    const inputs = this.buffer;
    this.buffer = [];
    this.inFlight = this.committer(inputs)
      .then((commit) => {
        const tagged = { ...commit, trigger };
        this.commits.push(tagged);
        this.config.onCommit?.(tagged);
        return tagged;
      })
      .catch((e) => {
        // The steps exist nowhere else. Put them back ahead of anything queued meanwhile so
        // the next flush carries them in order; the caller decides whether to retry.
        this.buffer = [...inputs, ...this.buffer];
        throw e;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The last fee and balance the batcher saw, for a console or a metric. */
  get signalsSeen(): { priorityFee: number | null; payerBalance: number | null } {
    return { priorityFee: this.lastFee?.value ?? null, payerBalance: this.lastBalance?.value ?? null };
  }

  private get sampleInterval(): number {
    return this.config.signals?.sampleIntervalMs ?? 5_000;
  }

  private async sampleBalance(): Promise<number> {
    const now = Date.now();
    if (this.lastBalance && now - this.lastBalance.at < this.sampleInterval) return this.lastBalance.value;
    const value = await this.config.signals!.payerBalance!();
    this.lastBalance = { at: now, value };
    return value;
  }

  private async feesAreLow(): Promise<boolean> {
    const s = this.config.signals!;
    const fraction = s.earlyFlushFraction ?? 0.5;
    if (this.buffer.length < Math.max(1, Math.ceil(this.config.batchSize * fraction))) return false;
    const now = Date.now();
    if (!this.lastFee || now - this.lastFee.at >= this.sampleInterval) {
      this.lastFee = { at: now, value: await s.priorityFee!() };
    }
    return this.lastFee.value <= (s.lowFeeMicroLamports ?? 0);
  }

  /** An inclusion proof for the step at `seq`, from whichever committed epoch covers it. */
  proofForSeq(seq: bigint | number): EpochMerkleProof {
    const s = BigInt(seq);
    const epoch = this.commits.find((c) => s >= c.startSeq && s < c.endSeq);
    if (!epoch) throw new Error(`seq ${seq} is not in any committed epoch`);
    return generateEpochProof(epoch.tree, Number(s - epoch.startSeq));
  }

  get epochs(): ReadonlyArray<EpochCommit> {
    return this.commits;
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}
