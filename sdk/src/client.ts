import * as anchor from "@coral-xyz/anchor";
import { BN, BorshInstructionCoder, EventParser, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  bn,
  batchAddressTree,
  calculateComputeUnitPrice,
  CompressedAccountWithMerkleContext,
  featureFlags,
  PackedAccounts,
  Rpc,
  selectStateTreeInfo,
  SystemAccountMetaConfig,
  TreeInfo,
  VERSION,
} from "@lightprotocol/stateless.js";
import bs58 from "bs58";
import { LATH_IDL, type Lath } from "./idl";
import { confirmByPolling, isTransientRpcError, TRANSIENT_RPC_ERROR, withTransientReadRetries } from "./confirm";
import { LathSigner, SignerLike, toAnchorWallet, toLathSigner } from "./signer";
import { Bytes32, hex, idFromString } from "./hash";
import {
  AGENT_STATE_LEN,
  AGENT_STATE_OFFSETS,
  AgentState,
  EVENT_OFFSETS,
  EVENT_RECORD_LEN,
  EventRecord,
  agentAddress,
  decodeAgentState,
  decodeEventRecord,
  eventAddress,
} from "./layout";
import { computeHead, EventInput, EventKind, EventPayload, GENESIS_HEAD, toEventInput } from "./events";
import {
  AppendPolicy,
  AppendPolicyRewrite,
  Cell,
  CELL_LEN,
  CELL_OFFSETS,
  CellInput,
  CellOp,
  computeCellHead,
  computeStructHead,
  CreateStructParams,
  headerAddress,
  HeaderFold,
  headerFolds,
  logCellAddress,
  mapCellAddress,
  STRUCT_HEADER_LEN,
  StructHeader,
  StructKind,
  StructMode,
} from "./cells";
import {
  ChainSignals,
  computeEpochHead,
  createEpochMerkleTree,
  encodeEpochBlob,
  EpochCommit,
  EpochCommitter,
  epochLeaves,
  EpochStore,
} from "./rollup";

// Lath targets Light Protocol v2 (batched) trees.
(featureFlags as any).version = VERSION.V2;

/** Mirrors `MAX_TIMESTAMP_SKEW_MS` in the program: writes may not be future-dated past this. */
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
/**
 * Mirrors `MAX_EVENTS_PER_TX` in the program: the largest `log_events` batch. Capped at 2 by
 * the pinned prover, which only has combined circuits for 1–2 new addresses per proof.
 */
export const MAX_EVENTS_PER_TX = 2;

/**
 * Mirrors `MAX_EPOCH_SPAN` in the program: the most steps one `commit_epoch` may cover. The LEP1
 * blob counts its steps in a u32 (SPEC §15), so a longer epoch is one no reader could open, and a
 * commit that pushed `seq` to `u64::MAX` would leave the agent unable to append.
 */
export const MAX_EPOCH_SPAN = 0xffff_ffffn;

/**
 * Refuses an epoch `[startSeq, endSeq)` the program would refuse, before anything is uploaded or
 * sent: an empty or inverted span (`InvalidEpochBounds`), or one longer than `MAX_EPOCH_SPAN`
 * (`EpochTooLong`). The program checks the same bounds; this names them without a round trip.
 */
export function assertEpochSpan(startSeq: bigint, endSeq: bigint): void {
  if (endSeq <= startSeq) throw new Error(`epoch [${startSeq}, ${endSeq}) is empty: end must be after start`);
  if (endSeq - startSeq > MAX_EPOCH_SPAN) {
    throw new Error(
      `epoch [${startSeq}, ${endSeq}) spans ${endSeq - startSeq} steps; at most ${MAX_EPOCH_SPAN} fit a LEP1 blob`
    );
  }
}

/** A point on an owner's chain: the `(seq, head)` `AgentState` shows before or after a write. */
interface ChainPoint {
  seq: bigint;
  head: Bytes32;
}

/** What `setAuthority` and `closeAgent` answer: the signature, and the state they left untouched. */
type StateMutation = { signature: string; finalSeq: bigint; finalHead: Bytes32 };

/**
 * A write sent by an earlier attempt of the same call whose confirmation never came back. It may
 * have landed, so no later attempt of that call may simply build and send it again.
 * `result` is built from the state the write was built on, before it was sent, so answering
 * with it later returns exactly what a clean confirmation would have.
 */
interface InDoubt<T> {
  agentId: Bytes32;
  from: ChainPoint;
  to: ChainPoint;
  signature: string;
  result: (signature: string) => T;
}

/** A status that says the transaction executed without error and will not roll back. */
function settledStatus(s: anchor.web3.SignatureStatus | null): boolean {
  return !!s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
}

/**
 * The instructions that append an `EventRecord`. Recovery from transaction history decodes only
 * these — every other Lath instruction in an owner's history carries different arguments.
 * Both spellings are listed because the coder's `name` follows the IDL, and the IDL's casing
 * differs between Anchor versions.
 */
const EVENT_INSTRUCTIONS = new Set([
  "logEvent",
  "logEventCompact",
  "logEvents",
  "log_event",
  "log_event_compact",
  "log_events",
]);

/** One agent header, as returned by `listOwnersByAuthority`. */
export interface OwnerHeader {
  /** The compressed address, which is what makes the header attributable. */
  address: PublicKey;
  state: AgentState;
}

/** What a cell write returns: the address touched and the cell as it now stands. */
export interface CellWriteResult {
  signature: string;
  address: PublicKey;
  cell: Cell;
  op: CellOp;
}

/** What `setAppendPolicy` returns: the header as rewritten, and the seq and head the rewrite folded to. */
export interface PolicyWriteResult {
  signature: string;
  /** The header's address, which does not change. */
  address: PublicKey;
  header: StructHeader;
  opSeq: bigint;
  head: Bytes32;
}

export interface LogResult {
  signature: string;
  seq: bigint;
  head: Bytes32;
  input: EventInput;
  /** Address of the per-event compressed account (undefined for compact logs). */
  eventAddress?: PublicKey;
}

/**
 * The store `createEpochCommitter` writes epoch blobs through, and where they go when it cannot.
 * `fallback` is a second `EpochStore` — the console's own trace directory — used only when the
 * primary `put` has run out of attempts, so an uploader that is down or out of credit costs the
 * epoch its locator and nothing else. `AnchoredEpochStore` carries whatever fallback and retry
 * policy it was given; a plain `EpochStore` has neither and a failed `put` still throws.
 */
type EpochCommitterStore = EpochStore & { fallback?: EpochStore; retry?: UploadRetryPolicy };

/**
 * How hard `createEpochCommitter` tries to upload an epoch blob before it writes it to the
 * fallback store. A hiccup at the uploader — a dropped connection, a 502 from a gateway — is a
 * few seconds, not an outage, and retrying it is the difference between a delayed anchor and an
 * epoch nobody points at until an operator runs `lath-audit reanchor`.
 */
export interface UploadRetryPolicy {
  /** Total `put` attempts including the first. 1 disables the retry. Default 3. */
  attempts?: number;
  /** Wait before the second attempt, doubling for each one after it. Default 1000 ms. */
  backoffMs?: number;
  /**
   * Upper bound on the *total* wait for one epoch. A session must never be held longer than
   * this by a backend that is down: past the cap the blob goes to the fallback. Default 10 s.
   */
  totalCapMs?: number;
  /** Test seam: what a wait is made of, so a suite does not sleep for a real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `anchorAttempts` is produced here — `createEpochCommitter` is the only thing that uploads an
 * epoch blob — while `EpochCommit` is `rollup.ts`'s type, which knows nothing about uploading.
 * Declared as an augmentation rather than moved so every reader of a commit (the runtime's
 * `epoch` event, the console's session summary) sees the count without `rollup.ts` growing a
 * field it never sets. Optional, so a commit no committer uploaded still types.
 */
declare module "./rollup" {
  interface EpochCommit {
    /** `store.put` attempts the blob took: 1 when the first upload worked, more after a retry. */
    anchorAttempts?: number;
  }
}

export const DEFAULT_UPLOAD_RETRY: Required<Omit<UploadRetryPolicy, "sleep">> = {
  attempts: 3,
  backoffMs: 1000,
  totalCapMs: 10_000,
};

/**
 * Whether an upload error is worth another attempt.
 *
 * Retryable: anything transport-shaped — a refused, reset or timed-out connection, a DNS
 * failure, a 408/429, any 5xx — because the same bytes and the same signature can succeed a
 * second later. Final: a 4xx the request itself caused, which is every way an Irys upload is
 * *wrong* rather than unlucky — no balance at Irys (402), a bundle over the node's size limit
 * (413), a bad signature (400/401/403). Those cost a wait and fail identically, so they fall
 * back at once.
 *
 * The telling is by the error object alone — `status`/`statusCode`/`response.status` when the
 * uploader's HTTP client sets one, `code` for Node's socket errors, and otherwise the message
 * text, because `@irys/upload` reports "Not enough balance for transaction" and the like as a
 * plain `Error`. Reading it this way keeps `IrysBackend`'s surface as it is: the committer
 * classifies what it caught and the backend still just throws.
 *
 * An error that matches nothing is treated as retryable: an unknown fault is more often a
 * transient one, and the cost of being wrong is one capped wait.
 */
function isRetryableUploadError(e: unknown): boolean {
  const err = e as any;
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? NaN);
  if (Number.isFinite(status)) {
    if (status === 408 || status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  const code = String(err?.code ?? "");
  if (
    /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(
      code
    )
  )
    return true;
  const message = String(err?.message ?? err ?? "");
  // The final ones, spelled out the way the uploader reports them when it carries no status.
  if (
    /not enough balance|insufficient (balance|funds)|no balance|unfunded|too large|size limit|invalid signature|bad signature|unauthorized|forbidden|\b(400|401|402|403|404|413)\b/i.test(
      message
    )
  )
    return false;
  return true;
}

/** One `commit_epoch`, read back from the `EpochCommitted` event in transaction history. */
export interface EpochRecord {
  agentId: Bytes32;
  epochRoot: Bytes32;
  /** First seq the epoch covers (inclusive). */
  startSeq: bigint;
  /** One past the last seq it covers — the owner's `seq` after the commit. */
  endSeq: bigint;
  /** Chain head after the commit. */
  head: Bytes32;
  signature: string;
  slot: number;
  /** Unix seconds, when the RPC knows it. */
  blockTime: number | null;
}

/**
 * One `create_cell` / `replace_cell` / `close_cell`, read back from its `CellWritten` event. The
 * event carries the head the write produced but not the cell's contents, so this can re-sync a
 * replay across a cell that is gone (closed, or replaced away) — it cannot recompute that fold.
 */
export interface CellWriteRecord {
  opSeq: bigint;
  /** One of `CellOp`. */
  op: number;
  /** Chain head after the write, as the program emitted it. */
  head: Bytes32;
  signature: string;
}

/**
 * One `create_struct`, read back from its `StructCreated` event. A struct create is not a cell
 * write — it has no `CellOp` and touches no cell — but it spends a seq on the same counter and
 * folds a head, so a reader resolving "the head at seq n" needs it alongside `CellWriteRecord`.
 */
export interface StructCreateRecord {
  opSeq: bigint;
  /** The struct this create minted. */
  structId: Bytes32;
  /** `StructKind` — Log or Map. */
  kind: number;
  /** The structure's mode byte, as declared at creation. */
  mode: number;
  /** Chain head after the create, as the program emitted it. */
  head: Bytes32;
  signature: string;
}

/** An `EventRecord` reconstructed from transaction history rather than a compressed account. */
interface RecoveredEventRecord extends EventRecord {
  /** Transaction the record was recovered from. */
  signature: string;
  /**
   * Whether the instruction that wrote it was `log_event_compact` — the one write that leaves no
   * account by design. A `log_event` / `log_events` write always created one, so a recovered
   * record with this false is a record the account view should have returned and did not:
   * history names it, but that is not an explanation for its absence.
   */
  compact: boolean;
}

export interface VerifyChainOptions {
  /**
   * Fill gaps left by `log_event_compact` from transaction history
   * (`getCompressionSignaturesForAddress` → `EventLogged` + instruction data). Requires an RPC
   * that still has the history; default RPCs prune it.
   */
  recover?: boolean;
}

export interface ChainVerification {
  /**
   * The chain replayed *and* the replay reached `AgentState.head`. Both halves matter: a fold
   * that diverges is a broken chain, and a fold that never gets as far as the head has not
   * checked the one value the whole audit is about. See `headReached`.
   */
  ok: boolean;
  /**
   * Did the fold survive every gap and land on `AgentState.head`?
   *
   * A gap sets the running head to "unknown", because a compact log, a closed cell or a
   * replaced-away version leaves no account to read the produced head from (SPEC §12 #11). The
   * replay re-synchronises at the next write that *does* record its head — but if the gap runs
   * to the tail there is no such write, and nothing is ever compared with `AgentState.head`.
   * That is an agent logged entirely with `compact: true`, or one whose last write was compact,
   * audited without `{ recover: true }` — or any tail gap whose transaction history this RPC no
   * longer has. A tail `close_cell` re-syncs from its `CellWritten` event (`resyncedSeqs`).
   *
   * Reported separately from `firstBadSeq` because the two are different claims: `firstBadSeq`
   * means a head was checked and was wrong, `headReached: false` means a head was not checked.
   * Neither is a verified chain, so both clear `ok`.
   */
  headReached: boolean;
  /** Number of on-chain records replayed. */
  records: number;
  /** seq the agent state reports (records + compact logs). */
  seq: bigint;
  head: Bytes32;
  /**
   * First seq at which the replay diverged, if any. Never set by a fold the replay could not
   * rebuild for want of history: a header's creation fold is not carried forward when an
   * unexplained gap after it could be the `set_append_policy` that rewrote it, so that
   * chain reads as `unexplainedGaps` (unchecked), not as broken.
   */
  firstBadSeq?: bigint;
  /** Seqs with no per-event record (logged via `log_event_compact`). */
  missingSeqs: bigint[];
  /**
   * The part of `missingSeqs` nothing accounts for: every missing seq except those transaction
   * history shows written by `log_event_compact`.
   *
   * A compact write has no account by design, but the program still emitted `EventLogged` for it,
   * so the history walk (which runs whenever the record walk leaves a gap) names its seq — that
   * gap is explained whether or not `recover` folded it. Any other missing seq is a write this
   * reader has not seen: a `log_event` record an indexer dropped (whether or not its signature is
   * still in history — that write created an account), or history the RPC pruned. The fold
   * re-syncs at the next record's stored head, so without this the chain would read `ok` with
   * events hidden from it. Non-empty clears `ok`, as an unreached head does: nothing
   * disagreed, but part of the chain was not checked. `lath-audit` exits 4 for it and tells the
   * auditor to pass `--recover` against an RPC that still holds the history.
   */
  unexplainedGaps: bigint[];
  /** Seqs that were reconstructed from transaction history rather than read as accounts. */
  recoveredSeqs: bigint[];
  /**
   * Seqs with no account whose head was taken from the write's `CellWritten` event — a closed
   * cell or a replaced-away Map version. The replay re-syncs there rather than recomputing the
   * fold: the event names the head the program produced, not the cell bytes it hashed.
   */
  resyncedSeqs: bigint[];
  /** Live cells folded into the replay. */
  cells?: number;
  /** Structure headers folded into the replay. */
  structs?: number;
  /**
   * `set_append_policy` rewrites folded into the replay, from `AppendPolicySet` events — each
   * recomputed over the header as the rewrite left it and checked against the head the event
   * names, with the structure's creation fold rebuilt over its creation-time policy. Zero for a
   * chain with no gaps, which reads no history and has no rewrites to find.
   */
  policyRewrites?: number;
  /**
   * Epochs folded into the replay, from `EpochCommitted` events. Read only when the record walk
   * left gaps, because it is a walk over transaction history; an owner with no epochs and no
   * compact writes never pays for it.
   */
  epochs: EpochRecord[];
}

interface LogEventOptions {
  /** Client-attested unix ms; defaults to now. */
  timestamp?: bigint | number;
  /** Skip the per-event compressed account (cheaper, recoverable only from tx history). */
  compact?: boolean;
  /**
   * Instructions to run **before** the Lath instruction, in the same transaction. Used to
   * bind an event to something that must succeed with it or not at all — a USDC `charge` for
   * the step being logged. A failure in any of them fails the whole transaction,
   * so no event ever claims work that was not paid for.
   */
  instructions?: TransactionInstruction[];
}

interface LathClientOptions {
  addressTree?: PublicKey;
  computeUnits?: number;
  /**
   * Priority fee in micro-lamports per compute unit. Takes precedence over
   * `priorityFeeLamports`. Omit both (the default) for no priority fee.
   */
  priorityFeeMicroLamports?: number;
  /**
   * Target total priority payment for one transaction, in lamports. Converted to a per-CU
   * price against `computeUnits` with `calculateComputeUnitPrice`.
   */
  priorityFeeLamports?: number;
  /**
   * How many times a write is rebuilt and resent after a *transient* failure — an expired
   * blockhash, a stale validity proof, or an RPC hiccup. Each attempt re-fetches the agent
   * state, the proof and the blockhash, because all three go stale together. Default 3.
   */
  maxRetries?: number;
  /** Base delay between attempts in ms; doubles each time. Default 400. */
  retryDelayMs?: number;
  /**
   * How long `getAgentState` waits for the indexer to show this client's own last write to
   * that chain. Photon indexes a confirmed transaction a moment after the RPC confirms it, and
   * a read in that moment reports the chain one or more writes short — so a caller that reads
   * right after writing built its next step on stale state. The wait is bounded, and only ever
   * for writes this client made itself. Default 15 s; 0 disables it.
   */
  indexerWaitMs?: number;
}

/**
 * Transient write failures worth rebuilding for. A stale blockhash, an expired or superseded
 * validity proof (someone else advanced the tree), and transport errors all resolve by
 * re-fetching state and proof — which is exactly what a retry does. Anything else (a program
 * error such as `Unauthorized` or `InvalidKind`, insufficient funds) is deterministic and is
 * rethrown immediately.
 */
const RETRYABLE = [
  /blockhashnotfound/i,
  /blockhash not found/i,
  /block height exceeded/i,
  /transaction was not confirmed/i,
  /proof verification failed/i,
  /proofverificationfailed/i,
  /invalid root|root not found|cannot find root|stale root/i,
  /leaf( |_)?index/i,
  /account not found in tree|nullifier queue/i,
  /0x179b/i,
  TRANSIENT_RPC_ERROR,
  // `confirmByPolling` gave up after the RPC answered nothing but transient errors for its whole
  // wait. Retrying is safe: the wait outlasts the blockhash, and every write that folds into a
  // chain checks its in-doubt ledger (`priorLanded`) before it builds again.
  /confirmation of .* unknown/i,
];

/** The program's seq guard: `commit_epoch` sent with a `start_seq` the chain has moved past. */
function isEpochSeqMismatch(e: unknown): boolean {
  const err = e as any;
  const text = [err?.message, err?.toString?.(), JSON.stringify(err?.logs ?? [])].join(" ");
  return /EpochSeqMismatch/i.test(text);
}

export function isRetryableWriteError(e: unknown): boolean {
  const err = e as any;
  const text = [err?.message, err?.toString?.(), JSON.stringify(err?.logs ?? [])].join(" ");
  return RETRYABLE.some((re) => re.test(text));
}

/**
 * The cursor to page on with, or `undefined` to stop. Photon's cursor is unreliable past page
 * one. One this walk has already been handed would page forever, whether it
 * came back unchanged or after a detour (A → B → A), so `visited` holds every cursor the walk has
 * used and a repeat ends it: what was read is then the answer.
 */
function nextCursor(next: string | null | undefined, visited: Set<string>): string | undefined {
  if (!next || visited.has(next)) return undefined;
  visited.add(next);
  return next;
}

/**
 * Puts `value` in `kept` under the account it is — its address, or `fallback` when it came back
 * without one — unless the copy already there is at least as far along. Photon repeats accounts
 * across pages, and a write can land between two pages, so a repeat may be a newer version
 * of the same account: `later(a, b)` says whether `a` is past `b`, and without it the first copy
 * stands (a record is never rewritten). Every list a replay folds must hold each account once,
 * and it must be the version the chain has now.
 */
function keepLatest<T>(
  kept: Map<string, T>,
  address: PublicKey | undefined,
  fallback: string,
  value: T,
  later?: (a: T, b: T) => boolean
): void {
  const key = address ? `a:${address.toBase58()}` : `k:${fallback}`;
  const have = kept.get(key);
  if (have === undefined || (later !== undefined && later(value, have))) kept.set(key, value);
}

/** A cell rewritten in place (`replace_cell`) takes the owner's later `op_seq`. */
const laterCell = (a: Cell, b: Cell) => a.opSeq > b.opSeq;

/**
 * A structure header's version has no seq of its own. `len_or_count` only grows (each
 * `create_cell` adds one); at the same count a `set_append_policy` re-created the leaf, which lands
 * after the one it spent in the same tree (`selectOutputTree` pins the output to the input's tree),
 * so the higher leaf index there is the later one. Across a rolled-over tree nothing in the account
 * orders the two and the first copy stands — the replay does not hash the header's live policy
 * when history holds the rewrite (`headerFolds`), so only the policy shown could be stale.
 */
type PagedHeader = StructHeader & { leaf?: { tree: string; index: number } };
const laterHeader = (a: PagedHeader, b: PagedHeader) =>
  a.lenOrCount !== b.lenOrCount
    ? a.lenOrCount > b.lenOrCount
    : !!a.leaf && !!b.leaf && a.leaf.tree === b.leaf.tree && a.leaf.index > b.leaf.index;

/** The leaf a Photon item sits at, when it says; read loosely, because a stub may omit it. */
function leafOf(a: { treeInfo?: { tree?: PublicKey }; leafIndex?: number }): PagedHeader["leaf"] {
  const tree = a.treeInfo?.tree;
  return tree && typeof a.leafIndex === "number" ? { tree: tree.toBase58(), index: a.leafIndex } : undefined;
}

/** A cell's slot within its structure, for a cell that came back without an address. */
function cellSlot(c: Cell, kind: StructKind | undefined): string {
  return kind === StructKind.Log ? `log:${c.indexOrVersion}` : `map:${hex(c.keySlot)}`;
}

/**
 * Which state tree a write's outputs are inserted into, given the trees its inputs are spent
 * from.
 *
 * The protocol lets an output go into any active state tree, and `selectStateTreeInfo` picks one
 * at random — devnet runs five, so a client process wrote every agent it touched into whichever
 * one it happened to draw. The consequence is scatter: an agent's header, each of its structure
 * headers and each of its cells end up in different trees, and a two-input write then spends its
 * owner header from one tree and its structure header from another. That is legal, but it means
 * the trees a transaction touches depend on when each account was written and by which process,
 * which is not something a failure should be able to vary over.
 *
 * So the output is pinned to the tree the spent header already lives in. A chain then stays in
 * one tree for its whole life: a structure header created from the owner's header lands beside
 * it, and the cell write that later spends both finds them together. Nothing about an existing
 * chain changes — the accounts already written stay where they are, and their addresses, hashes
 * and offsets are independent of the tree holding them.
 *
 * `fallback` is the tree discovered from the RPC and is used only by a write that spends nothing
 * (`register_agent`, where the agent's tree is chosen for the first time). When inputs disagree —
 * a chain whose accounts are already scattered across trees — the first one wins: it is the owner
 * header, the account the chain's head lives in, and the one every write of that owner has in
 * common. A tree that has rolled over names its successor in `nextTreeInfo` and accepts no more
 * leaves, so the successor is used instead.
 */
export function selectOutputTree(inputs: TreeInfo[], fallback: TreeInfo): TreeInfo {
  const pinned = inputs.length > 0 ? inputs[0] : fallback;
  return pinned.nextTreeInfo ?? pinned;
}

/**
 * Thin, stateless wrapper over the Lath program: derives compressed addresses, fetches
 * validity proofs, packs Light system accounts and submits transactions.
 */
export class LathClient {
  readonly addressTree: PublicKey;
  readonly computeUnits: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly indexerWaitMs: number;
  /** Per agent id: the seq the indexer must show before a read of that chain is believed. */
  private readonly written = new Map<string, bigint>();
  /** Per agent id: a confirmed rotation or close the indexer must show first (`noteEffect`). */
  private readonly effects = new Map<string, { authority: PublicKey } | { closed: true }>();
  /** Priority fee in micro-lamports per CU, or 0 when none is configured. */
  readonly priorityFeeMicroLamports: number;
  /** The agent authority. A `Keypair` passed here is wrapped into a `LathSigner`. */
  readonly authority: LathSigner;
  private stateTree?: TreeInfo;

  constructor(readonly rpc: Rpc, readonly program: Program<Lath>, authority: SignerLike, opts: LathClientOptions = {}) {
    this.authority = toLathSigner(authority);
    this.addressTree = opts.addressTree ?? new PublicKey(batchAddressTree);
    this.computeUnits = opts.computeUnits ?? 1_000_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    // Every indexer and proof read this client makes goes through one bounded retry on transient
    // failures, so a read path without a retry loop of its own cannot crash a step on one bad
    // answer (`withTransientReadRetries`). Same budget and backoff as a write.
    this.rpc = withTransientReadRetries(rpc, this.maxRetries + 1, this.retryDelayMs);
    this.indexerWaitMs = opts.indexerWaitMs ?? 15_000;
    this.priorityFeeMicroLamports =
      opts.priorityFeeMicroLamports ??
      (opts.priorityFeeLamports ? calculateComputeUnitPrice(opts.priorityFeeLamports, this.computeUnits) : 0);
  }

  /** Compute-budget instructions prepended to every Lath transaction. */
  protected budgetInstructions() {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnits })];
    if (this.priorityFeeMicroLamports > 0) {
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeMicroLamports }));
    }
    return ixs;
  }

  /**
   * Runs `attempt` until it succeeds or a failure is not retryable. Everything that goes stale
   * — agent state, validity proof, blockhash — is fetched *inside* `attempt`, so a retry is a
   * full rebuild rather than a resend of a dead transaction.
   *
   * `sent` is this call's in-doubt ledger: every transaction an attempt sent whose send or
   * confirmation failed (`sendWrite` records it; a send that failed may still have been
   * forwarded). Each attempt checks it before building (`priorLanded`), and
   * before the last error is thrown the ledger is asked once more, over transaction history,
   * whether any of them landed. That is what turns the `EpochSeqMismatch` or spent-account
   * failure that follows a landed-but-unconfirmed write into the success it was.
   */
  protected async withRetry<T>(
    what: string,
    attempt: (tryIndex: number, sent: InDoubt<T>[]) => Promise<T>
  ): Promise<T> {
    const sent: InDoubt<T>[] = [];
    let lastError: unknown;
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        return await attempt(i, sent);
      } catch (e) {
        lastError = e;
        if (i === this.maxRetries || !isRetryableWriteError(e)) {
          if (sent.length > 0) {
            // A status read that fails here proves nothing either way; the attempt's own error is
            // the one to report.
            const hit = await this.confirmedAmong(sent).catch(() => undefined);
            if (hit) return this.resolveInDoubt(hit);
          }
          throw e;
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** i));
      }
    }
    throw lastError;
  }

  /**
   * The first transaction in `sent` the cluster reports confirmed or finalized without error,
   * read over history. Throws when the statuses cannot be read at all, so that a caller deciding
   * whether to build again never takes "could not ask" for "did not land".
   */
  private async confirmedAmong<T>(sent: InDoubt<T>[]): Promise<InDoubt<T> | undefined> {
    const k = (await this.statusesOf(sent)).findIndex(settledStatus);
    return k >= 0 ? sent[k] : undefined;
  }

  /** The cluster's status of each of `sent`, read over history, with the client's retries. Throws as `confirmedAmong` does. */
  private async statusesOf<T>(sent: InDoubt<T>[]): Promise<(anchor.web3.SignatureStatus | null)[]> {
    const signatures = sent.map((s) => s.signature);
    for (let i = 0; ; i++) {
      try {
        return (await this.rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true })).value;
      } catch (e) {
        if (i >= this.maxRetries || !isTransientRpcError(e)) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** i));
      }
    }
  }

  /**
   * Before an attempt builds a write: did a write an earlier attempt sent land after all? `state`
   * is the owner's state this attempt just read.
   *
   * 1. The state is exactly one entry's `to`: that write landed. Its result is the answer.
   * 2. The state is every entry's `from`: nothing has moved, or the indexer has not caught up.
   *    Build again — the rebuild spends the same `AgentState` account hash as the write in doubt,
   *    so at most one of the two can land, and the next attempt (or `withRetry`'s last look)
   *    finds whichever did.
   * 3. Anything else — another writer, such as a `Mailbox` sender, moved the chain, possibly past
   *    our landing — is asked of the cluster by signature. A confirmed one is the answer; none
   *    confirmed means none landed (each spent a state hash that is now gone), so build again.
   */
  private async priorLanded<T>(sent: InDoubt<T>[], state: AgentState): Promise<T | undefined> {
    if (sent.length === 0) return undefined;
    const at = (p: ChainPoint) => p.seq === state.seq && Buffer.from(p.head).equals(Buffer.from(state.head));
    // Two attempts built on the same state with the same input lead to the same `(seq, head)`, so
    // the state can say one of them landed and not which — a send that failed before it was
    // forwarded and the rebuild that then landed, since every failed send is journaled.
    // `whichLanded` asks the cluster, so the result names the transaction on chain.
    const landed = sent.filter((s) => at(s.to));
    if (landed.length > 0) return this.resolveInDoubt(await this.whichLanded(landed));
    if (sent.every((s) => at(s.from))) return undefined;
    const hit = await this.confirmedAmong(sent);
    return hit ? this.resolveInDoubt(hit) : undefined;
  }

  private resolveInDoubt<T>(entry: InDoubt<T>): T {
    this.noteWrite(entry.agentId, entry.to.seq);
    return entry.result(entry.signature);
  }

  /**
   * Builds a client from the bundled IDL — no Anchor workspace, no `target/` directory and no
   * on-chain IDL fetch. This is the entry point for consumers of the published package.
   *
   * ```ts
   * const rpc = createRpc(RPC_URL, RPC_URL, PROVER_URL);
   * const client = LathClient.fromIdl(rpc, keypair);
   * ```
   */
  static fromIdl(rpc: Rpc, authority: SignerLike, opts: LathClientOptions = {}): LathClient {
    const signer = toLathSigner(authority);
    const provider = new anchor.AnchorProvider(rpc, toAnchorWallet(signer), {
      commitment: rpc.commitment ?? "confirmed",
    });
    const program = new Program<Lath>(LATH_IDL, provider);
    return new LathClient(rpc, program, signer, opts);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  agentAddress(agentId: Bytes32): PublicKey {
    return agentAddress(agentId, this.addressTree, this.programId);
  }

  eventAddress(agentId: Bytes32, seq: bigint | number): PublicKey {
    return eventAddress(agentId, seq, this.addressTree, this.programId);
  }

  /**
   * The tree a write with no inputs goes into. Discovered once per client and cached: it is a
   * choice, not a fact about any account, and a write that spends something does not use it (see
   * `outputTreeFor`).
   */
  async outputStateTree(): Promise<TreeInfo> {
    if (!this.stateTree) this.stateTree = selectStateTreeInfo(await this.rpc.getStateTreeInfos());
    return this.stateTree;
  }

  /**
   * The output tree for a write that spends `inputs` — the spent header's own tree, per
   * `selectOutputTree`. The discovered tree is fetched as the fallback for the no-input case and
   * is otherwise unused.
   */
  private async outputTreeFor(...inputs: TreeInfo[]): Promise<TreeInfo> {
    return selectOutputTree(inputs, await this.outputStateTree());
  }

  // ---------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------

  async registerAgent(
    agentId: Bytes32,
    createdAt: bigint | number = Date.now()
  ): Promise<{ signature: string; address: PublicKey }> {
    return this.withRetry("registerAgent", (_, sent) => this.registerAgentOnce(agentId, createdAt, sent));
  }

  /**
   * The registration as instructions — the compute budget first, then `register_agent` with
   * its validity proof — for a caller that wants to put something else in the same transaction
   * (an allowance for the agent's runtime, say) and sign once. The proof is fetched here, so
   * the instructions should be sent promptly: a proof is against a recent root.
   */
  async registerAgentIx(
    agentId: Bytes32,
    createdAt: bigint | number = Date.now()
  ): Promise<{ instructions: TransactionInstruction[]; address: PublicKey }> {
    const address = this.agentAddress(agentId);
    const stateTree = await this.outputStateTree();
    const proof = await this.rpc.getValidityProofV0(
      [],
      [{ address: bn(address.toBytes()), tree: this.addressTree, queue: this.addressTree }]
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const addressTreeIndex = packed.insertOrGet(this.addressTree);
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);

    const ix = await this.program.methods
      .registerAgent(
        { 0: proof.compressedProof },
        {
          rootIndex: proof.rootIndices[0],
          addressMerkleTreePubkeyIndex: addressTreeIndex,
          addressQueuePubkeyIndex: addressTreeIndex,
        },
        outputStateTreeIndex,
        Array.from(agentId),
        new BN(createdAt.toString())
      )
      .accounts({ authority: this.authority.publicKey })
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .instruction();

    return { instructions: [...this.budgetInstructions(), ix], address };
  }

  /**
   * One attempt at the registration, with the in-doubt ledger every chain write has. Without it
   * a registration whose confirmation was lost — 180 s of transient poll errors, or a send that
   * failed after forwarding — would be retried as if nothing had landed: the retry asks for a
   * non-inclusion proof of an address that now exists, is refused, and `withRetry` throws with no
   * ledger to look in. The deploy would answer 500, the next deploy would find a header it has no
   * record of and refuse to adopt it, and the name would be spent for good.
   *
   * So an attempt that follows a send in doubt asks the cluster about those signatures before it
   * fetches a proof, and `withRetry` asks once more before it gives up. Only a signature this call
   * sent decides it, never a header read: a header under this key with no confirmed signature from
   * this call is still an orphan, and the refusal to adopt one must stand. The `(seq, head)`
   * comparison `priorLanded` makes does not apply — there is no state before a registration — so
   * the entry's `from` and `to` only carry the seq the indexer wait is noted at.
   */
  private async registerAgentOnce(
    agentId: Bytes32,
    createdAt: bigint | number,
    sent: InDoubt<{ signature: string; address: PublicKey }>[] = []
  ): Promise<{ signature: string; address: PublicKey }> {
    if (sent.length > 0) {
      // Throws when the statuses cannot be read at all: "could not ask" is not "did not land".
      const hit = await this.confirmedAmong(sent);
      if (hit) return this.resolveInDoubt(hit);
    }
    const { instructions, address } = await this.registerAgentIx(agentId, createdAt);
    const result = (signature: string) => ({ signature, address });
    let signature: string;
    try {
      signature = await this.send(new Transaction().add(...instructions));
    } catch (e) {
      const inDoubt = (e as any)?.signature as string | undefined;
      if (inDoubt) {
        const genesis = { seq: 0n, head: GENESIS_HEAD };
        sent.push({ agentId, from: genesis, to: genesis, signature: inDoubt, result });
      }
      throw e;
    }
    this.noteWrite(agentId, 0n);
    return result(signature);
  }

  /**
   * Appends one event. `compact: true` skips the per-event compressed account (cheaper; the
   * record is only recoverable from the transaction's Anchor event).
   */
  async logEvent(agentId: Bytes32, payload: EventPayload, opts: LogEventOptions = {}): Promise<LogResult> {
    const input = toEventInput(payload, opts.timestamp ?? Date.now());
    return this.logEventInput(agentId, input, opts.compact ?? false, opts.instructions);
  }

  async logEventInput(
    agentId: Bytes32,
    input: EventInput,
    compact: boolean,
    instructions?: TransactionInstruction[]
  ): Promise<LogResult> {
    return this.withRetry("logEvent", (_, sent) => this.logEventInputOnce(agentId, input, compact, instructions, sent));
  }

  private async logEventInputOnce(
    agentId: Bytes32,
    input: EventInput,
    compact: boolean,
    instructions: TransactionInstruction[] = [],
    sent: InDoubt<LogResult>[] = []
  ): Promise<LogResult> {
    const found = await this.getAgentState(agentId);
    if (!found) throw new Error(`agent ${hex(agentId)} is not registered`);
    const { account, state } = found;
    if (!state.authority.equals(this.authority.publicKey)) {
      throw new Error("client authority does not own this agent");
    }
    // Before the rebuild: a landed earlier attempt is the answer, and a second send would be a
    // duplicate record — debited twice when a charge rides in `instructions`.
    const prior = await this.priorLanded(sent, state);
    if (prior !== undefined) return prior;
    const seq = state.seq;
    const eventAddress = compact ? undefined : this.eventAddress(agentId, seq);
    const stateTree = await this.outputTreeFor(account.treeInfo);

    const proof = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      eventAddress ? [{ address: bn(eventAddress.toBytes()), tree: this.addressTree, queue: this.addressTree }] : []
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const merkleTreePubkeyIndex = packed.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = packed.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);

    const agentMeta = {
      treeInfo: {
        rootIndex: proof.rootIndices[0],
        proveByIndex: proof.proveByIndices[0],
        merkleTreePubkeyIndex,
        queuePubkeyIndex,
        leafIndex: account.leafIndex,
      },
      address: account.address!,
      outputStateTreeIndex,
    };
    const current = {
      authority: state.authority,
      agentId: Array.from(state.agentId),
      seq: new BN(state.seq.toString()),
      head: Array.from(state.head),
      createdAt: new BN(state.createdAt.toString()),
      updatedAt: new BN(state.updatedAt.toString()),
    };
    const ixInput = {
      timestamp: new BN(input.timestamp.toString()),
      kind: input.kind,
      status: input.status,
      reference: Array.from(input.reference),
      payloadHash: Array.from(input.payloadHash),
    };
    const validityProof = { 0: proof.compressedProof };

    let builder;
    if (eventAddress) {
      const addressTreeIndex = packed.insertOrGet(this.addressTree);
      const eventTreeInfo = {
        rootIndex: proof.rootIndices[1],
        addressMerkleTreePubkeyIndex: addressTreeIndex,
        addressQueuePubkeyIndex: addressTreeIndex,
      };
      builder = this.program.methods.logEvent(
        validityProof,
        current,
        agentMeta,
        eventTreeInfo,
        outputStateTreeIndex,
        ixInput
      );
    } else {
      builder = this.program.methods.logEventCompact(validityProof, current, agentMeta, ixInput);
    }

    const tx = await builder
      .accounts({ authority: this.authority.publicKey })
      .preInstructions([...this.budgetInstructions(), ...instructions])
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    const head = computeHead(state.head, agentId, seq, input);
    const result = (signature: string): LogResult => ({ signature, seq, head, input, eventAddress });
    const signature = await this.sendWrite(tx, agentId, state, seq + 1n, head, sent, result);
    this.noteWrite(agentId, seq + 1n);
    return result(signature);
  }

  /**
   * Appends up to `MAX_EVENTS_PER_TX` events in a single transaction and a single validity
   * proof. Equivalent to calling `logEvent` once per payload — same chain, same addresses —
   * at roughly one base fee and one proof instead of N.
   */
  async logEvents(
    agentId: Bytes32,
    payloads: EventPayload[],
    opts: { timestamps?: (bigint | number)[]; timestamp?: bigint | number } = {}
  ): Promise<LogResult[]> {
    const base = opts.timestamp ?? Date.now();
    const inputs = payloads.map((p, i) => toEventInput(p, opts.timestamps?.[i] ?? base));
    return this.logEventInputs(agentId, inputs);
  }

  async logEventInputs(agentId: Bytes32, inputs: EventInput[]): Promise<LogResult[]> {
    if (inputs.length === 0 || inputs.length > MAX_EVENTS_PER_TX) {
      throw new Error(`batch must hold 1..${MAX_EVENTS_PER_TX} events, got ${inputs.length}`);
    }
    return this.withRetry("logEvents", (_, sent) => this.logEventInputsOnce(agentId, inputs, sent));
  }

  private async logEventInputsOnce(
    agentId: Bytes32,
    inputs: EventInput[],
    sent: InDoubt<LogResult[]>[]
  ): Promise<LogResult[]> {
    const found = await this.getAgentState(agentId);
    if (!found) throw new Error(`agent ${hex(agentId)} is not registered`);
    const { account, state } = found;
    if (!state.authority.equals(this.authority.publicKey)) {
      throw new Error("client authority does not own this agent");
    }
    const prior = await this.priorLanded(sent, state);
    if (prior !== undefined) return prior;
    const firstSeq = state.seq;
    const eventAddresses = inputs.map((_, i) => this.eventAddress(agentId, firstSeq + BigInt(i)));
    const stateTree = await this.outputTreeFor(account.treeInfo);

    const proof = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      eventAddresses.map((a) => ({ address: bn(a.toBytes()), tree: this.addressTree, queue: this.addressTree }))
    );
    // The instruction carries one `PackedAddressTreeInfo` for the whole batch, which is only
    // sound because every new address sits in the same tree under the same root.
    const addressRootIndices = proof.rootIndices.slice(1);
    if (addressRootIndices.some((r) => r !== addressRootIndices[0])) {
      throw new Error("batch addresses returned differing root indices; retry or split the batch");
    }

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const merkleTreePubkeyIndex = packed.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = packed.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const addressTreeIndex = packed.insertOrGet(this.addressTree);

    const tx = await this.program.methods
      .logEvents(
        { 0: proof.compressedProof },
        {
          authority: state.authority,
          agentId: Array.from(state.agentId),
          seq: new BN(state.seq.toString()),
          head: Array.from(state.head),
          createdAt: new BN(state.createdAt.toString()),
          updatedAt: new BN(state.updatedAt.toString()),
        },
        {
          treeInfo: {
            rootIndex: proof.rootIndices[0],
            proveByIndex: proof.proveByIndices[0],
            merkleTreePubkeyIndex,
            queuePubkeyIndex,
            leafIndex: account.leafIndex,
          },
          address: account.address!,
          outputStateTreeIndex,
        },
        {
          rootIndex: addressRootIndices[0],
          addressMerkleTreePubkeyIndex: addressTreeIndex,
          addressQueuePubkeyIndex: addressTreeIndex,
        },
        outputStateTreeIndex,
        inputs.map((input) => ({
          timestamp: new BN(input.timestamp.toString()),
          kind: input.kind,
          status: input.status,
          reference: Array.from(input.reference),
          payloadHash: Array.from(input.payloadHash),
        }))
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    // Folded before the send, not after: a batch lands as one transaction, so the state it
    // produces is `firstSeq + n` folded over every input in order, and that is what tells a lost
    // confirmation from a write that never happened.
    let head = state.head;
    const results = inputs.map((input, i) => {
      const seq = firstSeq + BigInt(i);
      head = computeHead(head, agentId, seq, input);
      return { seq, head, input, eventAddress: eventAddresses[i] };
    });
    const endSeq = firstSeq + BigInt(inputs.length);

    const result = (signature: string): LogResult[] => results.map((r) => ({ signature, ...r }));
    const signature = await this.sendWrite(tx, agentId, state, endSeq, head, sent, result);
    this.noteWrite(agentId, endSeq);
    return result(signature);
  }

  /**
   * Anchors an off-chain epoch of batched steps on-chain. Advances the agent's `seq` from
   * `startSeq` to `endSeq` and folds `epochRoot` into the hash chain in one compressed-state
   * update — no `EventRecord` accounts are created.
   *
   * The individual steps remain in the caller's `TraceStore` or gateway; only the Merkle root
   * is committed. Cost is ~\$0.0027 regardless of how many steps the epoch covers.
   */
  async commitEpoch(
    agentId: Bytes32,
    epochRoot: Bytes32,
    startSeq: bigint,
    endSeq: bigint
  ): Promise<{ signature: string; head: Bytes32 }> {
    assertEpochSpan(startSeq, endSeq);
    return this.withRetry("commitEpoch", async (_, sent: InDoubt<{ signature: string; head: Bytes32 }>[]) => {
      const found = await this.getAgentState(agentId);
      if (!found) throw new Error(`agent ${hex(agentId)} is not registered`);
      const { account, state } = found;
      if (!state.authority.equals(this.authority.publicKey)) {
        throw new Error("client authority does not own this agent");
      }
      // A commit an earlier attempt sent may have landed: resending it would fail the seq guard
      // at best and, through `createEpochCommitter`'s rebuild, commit the same steps twice.
      const prior = await this.priorLanded(sent, state);
      if (prior !== undefined) return prior;
      const stateTree = await this.outputTreeFor(account.treeInfo);

      // commit_epoch only mutates the AgentState — no new addresses, no new accounts.
      const proof = await this.rpc.getValidityProofV0(
        [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
        []
      );

      const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
      const merkleTreePubkeyIndex = packed.insertOrGet(account.treeInfo.tree);
      const queuePubkeyIndex = packed.insertOrGet(account.treeInfo.queue);
      const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);

      const agentMeta = {
        treeInfo: {
          rootIndex: proof.rootIndices[0],
          proveByIndex: proof.proveByIndices[0],
          merkleTreePubkeyIndex,
          queuePubkeyIndex,
          leafIndex: account.leafIndex,
        },
        address: account.address!,
        outputStateTreeIndex,
      };

      const current = {
        authority: state.authority,
        agentId: Array.from(state.agentId),
        seq: new BN(state.seq.toString()),
        head: Array.from(state.head),
        createdAt: new BN(state.createdAt.toString()),
        updatedAt: new BN(state.updatedAt.toString()),
      };

      const validityProof = { 0: proof.compressedProof };

      const tx = await this.program.methods
        .commitEpoch(
          validityProof,
          current,
          agentMeta,
          Array.from(epochRoot),
          new BN(startSeq.toString()),
          new BN(endSeq.toString())
        )
        .accounts({ authority: this.authority.publicKey })
        .preInstructions(this.budgetInstructions())
        .remainingAccounts(packed.toAccountMetas().remainingAccounts)
        .transaction();

      const head = computeEpochHead(state.head, agentId, epochRoot, startSeq, endSeq);
      // An epoch is the one write that covers more than one seq: it advances straight to
      // `endSeq`, so that — not `seq + 1` — is the state a landed commit leaves behind.
      const result = (signature: string) => ({ signature, head });
      const signature = await this.sendWrite(tx, agentId, state, endSeq, head, sent, result);
      this.noteWrite(agentId, endSeq);
      return result(signature);
    });
  }

  /**
   * The `EpochCommitter` a `RollupBatcher` or `DynamicStorageEngine` needs: reads the owner's
   * current `seq` (an epoch starts exactly there), builds the tree and the blob, stores the blob
   * under its root **before** sending the commit — the chain must never point at bytes nobody
   * kept — and returns everything a caller needs to prove any step later.
   *
   * A `put` that throws is retried while the error looks transient (`isRetryableUploadError`),
   * up to `store.retry.attempts` times with a doubling backoff and a hard cap on the total wait;
   * only then does the blob go to `store.fallback` and the epoch commit anyway, reporting
   * `anchored: false` with the last upload error.
   * `anchorAttempts` says how many uploads it took either way. Throwing instead would cost the
   * caller the epoch *and*, in the runtime, the session's resolution.
   */
  createEpochCommitter(agentId: Bytes32, store: EpochCommitterStore): EpochCommitter {
    return async (inputs): Promise<EpochCommit> => {
      if (inputs.length === 0) throw new Error("an epoch needs at least one step");
      // The seq is read, the leaves built and the blob stored inside the attempt, so a
      // `commit_epoch` that fails its seq guard — another signer advanced this owner's chain
      // between the read and the send, which `Mailbox` under `AppendPolicy.Anyone` allows —
      // is rebuilt from the new seq rather than resent against a stale one. `commitEpoch` still
      // retries transport failures on its own; this loop only handles the mismatch.
      //
      // The mismatch reaches this loop only when the commit in doubt did *not* land:
      // `commitEpoch` resolves its own lost confirmations (`priorLanded`, and `withRetry`'s last
      // look over history) before it throws. Otherwise a 429 while confirming a landed commit
      // would come back here as a mismatch, and the same steps would be committed a second time
      // at the new seq.
      let attempt = 0;
      for (;;) {
        const found = await this.getAgentState(agentId);
        if (!found) throw new Error(`agent ${hex(agentId)} is not registered`);
        const startSeq = found.state.seq;
        const endSeq = startSeq + BigInt(inputs.length);
        assertEpochSpan(startSeq, endSeq);
        const tree = createEpochMerkleTree(epochLeaves(startSeq, inputs));
        const blob = encodeEpochBlob(startSeq, inputs);
        // The bytes have to exist somewhere before the commit; which store kept them is what
        // `anchored` reports. Without a fallback this throws, because a committed root whose bytes
        // nobody kept is worse than an epoch not committed.
        const { error: uploadError, attempts: anchorAttempts } = await this.putEpochBlob(store, tree.root, blob);
        let committed: { signature: string; head: Bytes32 };
        try {
          committed = await this.commitEpoch(agentId, tree.root, startSeq, endSeq);
        } catch (e) {
          if (attempt++ < this.maxRetries && isEpochSeqMismatch(e)) {
            await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
            continue;
          }
          throw e;
        }
        return this.finishEpochCommit(store, {
          ...committed,
          tree,
          blob,
          inputs,
          startSeq,
          endSeq,
          uploadError,
          anchorAttempts,
        });
      }
    };
  }

  /**
   * One epoch blob into the store, retried while the failure looks transient and the total wait
   * is under the cap, then into the fallback. Returns the last error when the bytes ended up in
   * the fallback and `undefined` when the backend took them, plus the number of attempts made.
   *
   * The cap is on the sum of the waits rather than on each of them, because what must be bounded
   * is how long one epoch can hold a session: three attempts at 1 s and 2 s cost 3 s of wall
   * clock, and a policy with more attempts stops waiting at `totalCapMs` however many are left.
   */
  private async putEpochBlob(
    store: EpochCommitterStore,
    root: Bytes32,
    blob: Uint8Array
  ): Promise<{ error?: string; attempts: number }> {
    const policy = { ...DEFAULT_UPLOAD_RETRY, ...(store.retry ?? {}) };
    const sleep = store.retry?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxAttempts = Math.max(1, Math.floor(policy.attempts));
    let waited = 0;
    let delay = Math.max(0, policy.backoffMs);
    for (let attempts = 1; ; attempts++) {
      try {
        await store.put(root, blob);
        return { attempts };
      } catch (e) {
        const message = (e as any)?.message ?? String(e);
        const wait = Math.min(delay, Math.max(0, policy.totalCapMs - waited));
        const again = attempts < maxAttempts && isRetryableUploadError(e) && wait > 0;
        if (!again) {
          // Out of attempts, out of time, or an error another attempt cannot fix. Without a
          // fallback there is nowhere else for the bytes, so the epoch is not committed at all.
          if (!store.fallback) throw e;
          await store.fallback.put(root, blob);
          return { error: message, attempts };
        }
        await sleep(wait);
        waited += wait;
        delay *= 2;
      }
    }
  }

  private async finishEpochCommit(
    store: EpochCommitterStore,
    c: {
      signature: string;
      head: Bytes32;
      tree: ReturnType<typeof createEpochMerkleTree>;
      blob: Uint8Array;
      inputs: EventInput[];
      startSeq: bigint;
      endSeq: bigint;
      /** Set when the blob went to the fallback store because the backend's `put` threw. */
      uploadError?: string;
      /** `put` attempts the blob took, successful or not. */
      anchorAttempts: number;
    }
  ): Promise<EpochCommit> {
    const { signature, head, tree, blob, inputs, startSeq, endSeq, uploadError, anchorAttempts } = c;
    // Anchoring is a cell write on this same chain, so it has to follow the commit. Once the
    // commit has landed the epoch exists whether or not the locator cell is written, so a
    // failure here is reported on the commit rather than thrown: throwing would make the
    // batcher forget an epoch that is on chain and make the session resolve `failed`.
    //
    // A blob that fell back to the local store is not on the backend at all, so there is no
    // locator to write and `anchor` is skipped: the epoch is already `anchored: false` with the
    // upload's error, and a cell write here would point at an id that was never uploaded.
    let anchored = uploadError === undefined;
    let anchorPending = false;
    let anchorError = uploadError;
    if (store.anchor && uploadError === undefined) {
      try {
        const outcome = await store.anchor(tree.root);
        anchorPending = !!outcome && outcome.published === false;
      } catch (e) {
        anchored = false;
        anchorError = (e as any)?.message ?? String(e);
      }
    }
    return {
      signature,
      epochRoot: tree.root,
      startSeq,
      endSeq,
      head,
      tree,
      blob,
      inputs,
      anchored,
      anchorPending,
      anchorError,
      anchorAttempts,
    };
  }

  /**
   * The chain inputs a fee- and balance-aware batcher reads (`ChainSignals` in `rollup.ts`):
   * the median of the cluster's recent prioritization fees, and this client's payer balance.
   * Each is one RPC call; the batcher samples them at its own interval.
   *
   * ```ts
   * new RollupBatcher({ batchSize: 100, maxFlushDelayMs: 0, signals: client.chainSignals() }, committer)
   * ```
   */
  chainSignals(overrides: Omit<ChainSignals, "priorityFee" | "payerBalance"> = {}): ChainSignals {
    return {
      priorityFee: async () => {
        const fees = await this.rpc.getRecentPrioritizationFees();
        const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
        return values.length ? values[Math.floor(values.length / 2)] : 0;
      },
      payerBalance: () => this.rpc.getBalance(this.authority.publicKey),
      ...overrides,
    };
  }

  /**
   * Hands the agent to `newAuthority`. The current authority must still be this client's
   * signer; afterwards it can no longer append, and a client built on the new key can.
   *
   * `seq` and `head` are untouched — the frozen chain formula has no slot for a non-event
   * transition — so an auditor reads rotations from `AuthorityChanged` in the ledger, not
   * from the chain. Rotate *between* tasks: events on either side of a rotation are
   * indistinguishable in the chain itself.
   */
  async setAuthority(agentId: Bytes32, newAuthority: PublicKey): Promise<{ signature: string }> {
    return this.withRetry<StateMutation>("setAuthority", (_, sent) =>
      this.mutateStateOnce(agentId, sent, "setAuthority", newAuthority)
    );
  }

  /**
   * Retires the agent: its `AgentState` compressed account is closed, so nothing more can be
   * appended. `EventRecord`s are separate accounts and remain listable and replayable.
   */
  async closeAgent(agentId: Bytes32): Promise<StateMutation> {
    return this.withRetry<StateMutation>("closeAgent", (_, sent) => this.mutateStateOnce(agentId, sent, "closeAgent"));
  }

  /**
   * Shared build+send for the two instructions that spend `AgentState` and produce no record.
   *
   * `sent` is the call's in-doubt ledger, as for every other write: a send that failed after it was
   * forwarded is journaled before the error goes back to `withRetry`. Without it a rotation that
   * landed behind a 502 would be read back stale, rebuilt, and on the next fresh read refused as
   * "client authority does not own this agent" — not retryable — so the caller would be told the
   * rotation failed after it happened (a close likewise, as "not registered"). Each attempt and
   * `withRetry`'s last look ask the cluster by signature first. `priorLanded` is not used here:
   * neither instruction moves `(seq, head)`, so its state test would read the untouched state as a
   * landing.
   */
  private async mutateStateOnce(
    agentId: Bytes32,
    sent: InDoubt<StateMutation>[],
    op: "setAuthority" | "closeAgent",
    newAuthority?: PublicKey
  ): Promise<StateMutation> {
    if (sent.length > 0) {
      // A read that cannot be made throws, so "could not ask" is never taken for "did not land";
      // a write not yet confirmed is rebuilt on the same account hash, so at most one lands.
      const hit = await this.confirmedAmong(sent);
      if (hit) return this.resolveInDoubt(hit);
    }
    const found = await this.getAgentState(agentId);
    if (!found) throw new Error(`agent ${hex(agentId)} is not registered`);
    const { account, state } = found;
    if (!state.authority.equals(this.authority.publicKey)) {
      throw new Error("client authority does not own this agent");
    }
    const stateTree = await this.outputTreeFor(account.treeInfo);

    const proof = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      []
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const merkleTreePubkeyIndex = packed.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = packed.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);

    const validityProof = { 0: proof.compressedProof };
    const current = {
      authority: state.authority,
      agentId: Array.from(state.agentId),
      seq: new BN(state.seq.toString()),
      head: Array.from(state.head),
      createdAt: new BN(state.createdAt.toString()),
      updatedAt: new BN(state.updatedAt.toString()),
    };
    const agentMeta = {
      treeInfo: {
        rootIndex: proof.rootIndices[0],
        proveByIndex: proof.proveByIndices[0],
        merkleTreePubkeyIndex,
        queuePubkeyIndex,
        leafIndex: account.leafIndex,
      },
      address: account.address!,
      outputStateTreeIndex,
    };

    const builder =
      op === "setAuthority"
        ? this.program.methods.setAuthority(validityProof, current, agentMeta, newAuthority!)
        : this.program.methods.closeAgent(validityProof, current, agentMeta);

    const tx = await builder
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    // Not `sendWrite`: neither instruction advances `seq` or `head` (SPEC §5), so the
    // `(seq, head)` test would pass on a state the write never touched — a false *positive*,
    // which is the one answer a landed check must never give. The post-state to look for is the
    // effect itself: a rotation leaves an otherwise unchanged state under the new authority, a
    // close leaves no state to read at all.
    const result = (signature: string) => {
      this.noteEffect(agentId, op === "setAuthority" ? { authority: newAuthority! } : { closed: true });
      return { signature, finalSeq: state.seq, finalHead: state.head };
    };
    let signature: string;
    try {
      signature = await this.send(tx);
    } catch (e) {
      const forwarded = (e as any)?.signature as string | undefined;
      if (!forwarded) throw e;
      // Recorded before the landed read, so a read that itself fails cannot lose the entry. `from`
      // and `to` are the same point: nothing reads them for this entry but `resolveInDoubt`'s seq.
      const at = { seq: state.seq, head: state.head };
      sent.push({ agentId, from: at, to: at, signature: forwarded, result });
      const after = await this.getAgentState(agentId).catch(() => undefined);
      const done =
        after !== undefined &&
        (op === "setAuthority"
          ? !!after && after.state.authority.equals(newAuthority!) && after.state.seq === state.seq
          : // A close that landed nullified the leaf, so the account reads as gone. An indexer
            // that has not caught up still shows it; the next attempt asks the ledger by
            // signature before it rebuilds, and a rebuild fails proof verification against a
            // spent account — it cannot close anything twice.
            after === null);
      if (!done) throw e;
      signature = forwarded;
    }
    return result(signature);
  }

  // ---------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------

  async getAgentState(
    agentId: Bytes32
  ): Promise<{ account: CompressedAccountWithMerkleContext; state: AgentState } | null> {
    const key = hex(agentId);
    const expected = this.written.get(key);
    const effect = this.effects.get(key);
    const deadline = Date.now() + (expected === undefined && !effect ? 0 : this.indexerWaitMs);
    let delay = 300;
    for (;;) {
      const found = await this.getAgentStateOnce(agentId);
      const seqShown = expected === undefined || (!!found && found.state.seq >= expected);
      // A close leaves no state, so no seq can be waited for once one is confirmed: the effect
      // alone decides. A rotation leaves the seq where it was, so it is waited for beside it.
      const shown = !effect
        ? seqShown
        : "closed" in effect
        ? found === null
        : seqShown && !!found && found.state.authority.equals(effect.authority);
      if (shown || Date.now() >= deadline) {
        // Waited for once: a later rotation by the new authority, which this client never hears
        // of, must not make every read of the chain wait out `indexerWaitMs`.
        if (effect) this.effects.delete(key);
        if (shown && effect && "closed" in effect) this.written.delete(key);
        return found;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 2_000);
    }
  }

  private async getAgentStateOnce(
    agentId: Bytes32
  ): Promise<{ account: CompressedAccountWithMerkleContext; state: AgentState } | null> {
    // The read retries the same transient failures a write does — a 429 or 5xx from Photon, a
    // dropped socket, Photon's intermittent `Method not found`. Writes re-read state inside
    // `withRetry`; a reader outside it, such as `ensureRegistered`, would otherwise turn one
    // rate-limited call into a failed session while the writes around it retried. The retry lives
    // on `this.rpc` (`withTransientReadRetries`, `maxRetries + 1` attempts — the same budget as a
    // write), so a limit that holds still surfaces, as the same error.
    const account = await this.rpc.getCompressedAccount(bn(this.agentAddress(agentId).toBytes()));
    if (!account || !account.data || account.data.data.length === 0) return null;
    return { account, state: this.decodeAgentState(account.data.data) };
  }

  /**
   * A `set_authority` or `close_agent` this client confirmed; the next read waits for the indexer
   * to show it. `noteWrite` cannot say this — neither moves `seq` — and noting the unchanged seq
   * of a closed agent would make every later read wait out `indexerWaitMs` for a state that is gone.
   */
  private noteEffect(agentId: Bytes32, effect: { authority: PublicKey } | { closed: true }): void {
    this.effects.set(hex(agentId), effect);
  }

  /** A write this client confirmed left the chain at least at `seq`; reads wait for it. */
  private noteWrite(agentId: Bytes32, seq: bigint): void {
    const key = hex(agentId);
    const have = this.written.get(key);
    if (have === undefined || seq > have) this.written.set(key, seq);
  }

  /**
   * Every agent header signed for by `authority`, in one Photon scan.
   *
   * `authority` is the first field of `AgentState`, so this is a single `memcmp` at offset 0 —
   * the same trick `listRecords` plays with `EVENT_OFFSETS`. Headers are told apart from
   * records (and from cells) by their fixed 120-byte length, and a header is kept only if it
   * sits at the address this client derives for the id inside it: the id is a field anyone can
   * write, the address is not.
   *
   * Note this is the *signer* half of ownership. A wallet that merely funds an agent through
   * an `Allowance` does not appear here — resolve those through
   * `BillingClient.listAllowancesByUser` and call this again with each `agentAuthority`.
   */
  async listOwnersByAuthority(authority: PublicKey): Promise<OwnerHeader[]> {
    return this.scanHeaders([
      { memcmp: { offset: AGENT_STATE_OFFSETS.authority, bytes: bs58.encode(authority.toBytes()) } },
    ]);
  }

  /**
   * Every agent header on the program, whoever signs for it.
   *
   * `AgentState` has no constant field, but `created_at` is unix **milliseconds**, and every such
   * value in [2^40, 2^41) — 2004-11-02 to 2039-09-07 — has byte 5 = 0x01 and bytes 6–7 = 0. A
   * `memcmp` on those three bytes is therefore a header filter that Photon can apply, and the rest
   * (length, derived address) is checked here as for any scan.
   *
   * It is not the unfiltered scan, because that one does not return the program's accounts:
   * measured on devnet, it stopped after 1,875 accounts carrying 84 headers, and 27 at a page
   * size of 500, while this filter returned 487 in one page in 1.8 s, the per-authority scans
   * agreeing. The same measurement found Photon's cursor unreliable
   * past the first page — duplicates and gaps at `limit: 100` — which is why `scanHeaders` dedupes
   * by address, and why a program past one default page of headers needs a second look here.
   */
  async listAgents(): Promise<OwnerHeader[]> {
    return this.scanHeaders([
      { memcmp: { offset: AGENT_STATE_OFFSETS.createdAt + 5, bytes: bs58.encode(Uint8Array.of(1, 0, 0)) } },
    ]);
  }

  private async scanHeaders(filters: { memcmp: { offset: number; bytes: string } }[]): Promise<OwnerHeader[]> {
    const byAddress = new Map<string, OwnerHeader>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressedAccountsByOwner(this.programId, { filters, cursor });
      for (const a of page.items) {
        if (!a.data || a.data.data.length !== AGENT_STATE_LEN || !a.address) continue;
        const address = new PublicKey(a.address);
        const state = decodeAgentState(a.data.data);
        // Not a header this client can address — ignore rather than guess.
        if (!this.agentAddress(state.agentId).equals(address)) continue;
        // A page that repeats a header is the cursor misbehaving, not a second agent: keep one,
        // the furthest along.
        const key = address.toBase58();
        const seen = byAddress.get(key);
        if (!seen || state.seq > seen.state.seq) byAddress.set(key, { address, state });
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);
    return [...byAddress.values()].sort((a, b) => hex(a.state.agentId).localeCompare(hex(b.state.agentId)));
  }

  async getEvent(agentId: Bytes32, seq: bigint | number): Promise<EventRecord | null> {
    const account = await this.rpc.getCompressedAccount(bn(this.eventAddress(agentId, seq).toBytes()));
    if (!account || !account.data || account.data.data.length === 0) return null;
    return this.decodeEventRecord(account.data.data);
  }

  /**
   * Every `EventRecord` owned by the program that matches `memcmp` filters at the fixed
   * `EVENT_OFFSETS`, sorted by `(agent_id, seq)`. All the query helpers below are thin wrappers
   * around this — there is no on-chain iteration, so the offsets *are* the query language.
   */
  async listRecords(filters: { offset: number; bytes: Uint8Array }[] = []): Promise<EventRecord[]> {
    const kept = new Map<string, EventRecord>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressedAccountsByOwner(this.programId, {
        filters: filters.map((f) => ({ memcmp: { offset: f.offset, bytes: bs58.encode(f.bytes) } })),
        cursor,
      });
      for (const a of page.items) {
        if (a.data && a.data.data.length === EVENT_RECORD_LEN) {
          const address = a.address ? new PublicKey(a.address) : undefined;
          const rec = this.decodeEventRecord(a.data.data);
          // Photon's cursor repeats accounts across pages. A record folded
          // twice reads as a divergence at its seq, so an honest chain audited BROKEN. A record
          // is never rewritten, so whichever copy came first is the record.
          keepLatest(kept, address, `${hex(rec.agentId)}:${rec.seq}`, { ...rec, address });
        }
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);
    return [...kept.values()].sort((a, b) => {
      const byAgent = hex(a.agentId).localeCompare(hex(b.agentId));
      if (byAgent !== 0) return byAgent;
      return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
    });
  }

  /**
   * Records that really belong to this owner: the ones whose *address* is the one this client
   * derives for `(agent_id, seq)`.
   *
   * `agent_id` is a field inside a record, so anything the program lets you write can carry any
   * id. The address is derived by the program and cannot be spoofed, so checking it turns
   * "records tagged with this id" into "records this owner wrote". Records with no address
   * (recovered from history) are kept.
   */
  private onlyAuthentic(agentId: Bytes32, records: EventRecord[]): EventRecord[] {
    return records.filter((r) => !r.address || r.address.equals(this.eventAddress(agentId, r.seq)));
  }

  /** All per-event records for an agent, ascending by seq (compact logs are not included). */
  async listEvents(agentId: Bytes32): Promise<EventRecord[]> {
    return this.onlyAuthentic(agentId, await this.listRecords([{ offset: EVENT_OFFSETS.agentId, bytes: agentId }]));
  }

  /**
   * Every record whose `reference` matches, **across all agents**. What that answers depends
   * on the kind that wrote it: a tool id (`sha256(tool_id)`, kind 1), a caller pubkey (kind 0),
   * a delegate pubkey (kind 2) or a task id (kind 3). Pass `kind` to disambiguate.
   */
  async listByReference(reference: Bytes32 | PublicKey, kind?: EventKind): Promise<EventRecord[]> {
    const ref = reference instanceof PublicKey ? reference.toBytes() : reference;
    const filters: { offset: number; bytes: Uint8Array }[] = [{ offset: EVENT_OFFSETS.reference, bytes: ref }];
    if (kind !== undefined) filters.push({ offset: EVENT_OFFSETS.kind, bytes: Uint8Array.of(kind) });
    return this.listRecords(filters);
  }

  /** One agent's records of a single kind, ascending by seq. */
  async listByKind(agentId: Bytes32, kind: EventKind): Promise<EventRecord[]> {
    return this.onlyAuthentic(
      agentId,
      await this.listRecords([
        { offset: EVENT_OFFSETS.agentId, bytes: agentId },
        { offset: EVENT_OFFSETS.kind, bytes: Uint8Array.of(kind) },
      ])
    );
  }

  /**
   * Every delegation handed to `peer`, from any agent — the inbound half of a handoff.
   * `reference` for kind 2 is the delegate's pubkey, so this is one memcmp pair.
   */
  async listDelegationsTo(peer: PublicKey | Bytes32): Promise<EventRecord[]> {
    return this.listByReference(peer instanceof PublicKey ? peer.toBytes() : peer, EventKind.Delegation);
  }

  /** Every action an agent performed with a given tool, ascending by seq. */
  async listByTool(agentId: Bytes32, toolId: string): Promise<EventRecord[]> {
    return this.onlyAuthentic(
      agentId,
      await this.listRecords([
        { offset: EVENT_OFFSETS.agentId, bytes: agentId },
        { offset: EVENT_OFFSETS.kind, bytes: Uint8Array.of(EventKind.Action) },
        { offset: EVENT_OFFSETS.reference, bytes: idFromString(toolId) },
      ])
    );
  }

  /**
   * Reconstructs every event from the agent's transaction history: `EventLogged` supplies
   * `seq`, `kind` and `head`; the Lath instruction data in the same transaction supplies
   * `timestamp`, `status`, `reference` and `payload_hash`. This is the only way to read back
   * `log_event_compact` writes, which leave no compressed account.
   *
   * Returns records ascending by seq. Coverage depends on how much history the RPC retains.
   */
  async recoverEventsFromHistory(agentId: Bytes32): Promise<RecoveredEventRecord[]> {
    return (await this.readHistory(agentId)).events;
  }

  /** Every epoch this owner committed, ascending by `startSeq`, from transaction history. */
  async listEpochs(agentId: Bytes32): Promise<EpochRecord[]> {
    return (await this.readHistory(agentId)).epochs;
  }

  /**
   * One walk over the owner's transaction history, yielding both the events it can reconstruct
   * and the epochs it committed. `EventLogged` and `EpochCommitted` come from the same logs, so
   * reading them separately would fetch every transaction twice. `CellWritten` rides along for
   * the same reason: a closed cell leaves nothing but that event to say which head it produced,
   * and `StructCreated` for the same reason again — a v0.2 owner's seqs interleave events, cell
   * writes and struct creates on one counter, so a reader that decodes only some of them sees
   * gaps where a head it needs actually exists. `AppendPolicySet` (`policies`) is the one of these
   * a replay cannot do without: a rewritten header no longer shows the policy `create_struct`
   * folded, and only this event carries it.
   */
  async readHistory(agentId: Bytes32): Promise<{
    events: RecoveredEventRecord[];
    epochs: EpochRecord[];
    cells: CellWriteRecord[];
    structs: StructCreateRecord[];
    policies: AppendPolicyRewrite[];
  }> {
    const address = this.agentAddress(agentId);
    const signatures: string[] = [];
    const seenSignatures = new Set<string>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressionSignaturesForAddress(address, { cursor });
      for (const s of page.items) {
        if (seenSignatures.has(s.signature)) continue;
        seenSignatures.add(s.signature);
        signatures.push(s.signature);
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);

    const parser = new EventParser(this.programId, this.program.coder);
    const bySeq = new Map<string, RecoveredEventRecord>();
    const epochs = new Map<string, EpochRecord>();
    const cellWrites = new Map<string, CellWriteRecord>();
    const structCreates = new Map<string, StructCreateRecord>();
    const policyRewrites = new Map<string, AppendPolicyRewrite>();

    for (const signature of signatures) {
      const tx = await this.rpc.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) continue;

      // Every `EventInput` the transaction submitted, in instruction order.
      const inputs = this.decodeEventInputs(tx);
      // Every `EventLogged` it emitted, in emission order. The two lists line up 1:1 because
      // each accepted input emits exactly one event.
      const logged: { seq: bigint; kind: number; head: Bytes32 }[] = [];
      for (const ev of parser.parseLogs(tx.meta?.logMessages ?? [], false)) {
        const d = ev.data as any;
        if (ev.name === "epochCommitted") {
          if (hex(Uint8Array.from(d.agentId)) !== hex(agentId)) continue;
          const startSeq = BigInt(d.startSeq.toString());
          epochs.set(startSeq.toString(), {
            agentId,
            epochRoot: Uint8Array.from(d.epochRoot),
            startSeq,
            endSeq: BigInt(d.endSeq.toString()),
            head: Uint8Array.from(d.head),
            signature,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
          });
          continue;
        }
        if (ev.name === "cellWritten") {
          if (hex(Uint8Array.from(d.ownerId)) !== hex(agentId)) continue;
          const opSeq = BigInt(d.opSeq.toString());
          cellWrites.set(opSeq.toString(), { opSeq, op: d.op, head: Uint8Array.from(d.head), signature });
          continue;
        }
        if (ev.name === "structCreated") {
          if (hex(Uint8Array.from(d.ownerId)) !== hex(agentId)) continue;
          const opSeq = BigInt(d.opSeq.toString());
          structCreates.set(opSeq.toString(), {
            opSeq,
            structId: Uint8Array.from(d.structId),
            kind: d.kind,
            mode: d.mode,
            head: Uint8Array.from(d.head),
            signature,
          });
          continue;
        }
        if (ev.name === "appendPolicySet") {
          if (hex(Uint8Array.from(d.ownerId)) !== hex(agentId)) continue;
          const opSeq = BigInt(d.opSeq.toString());
          policyRewrites.set(opSeq.toString(), {
            opSeq,
            structId: Uint8Array.from(d.structId),
            previousPolicy: d.previousPolicy,
            previousPolicyRef: Uint8Array.from(d.previousPolicyRef),
            appendPolicy: d.appendPolicy,
            policyRef: Uint8Array.from(d.policyRef),
            head: Uint8Array.from(d.head),
          });
          continue;
        }
        if (ev.name !== "eventLogged") continue;
        if (hex(Uint8Array.from(d.agentId)) !== hex(agentId)) continue;
        logged.push({ seq: BigInt(d.seq.toString()), kind: d.kind, head: Uint8Array.from(d.head) });
      }
      if (logged.length !== inputs.length) continue; // unexpected shape; skip rather than guess

      logged.forEach((ev, i) => {
        const input = inputs[i];
        bySeq.set(ev.seq.toString(), {
          agentId,
          seq: ev.seq,
          timestamp: input.timestamp,
          kind: ev.kind as EventKind,
          status: input.status,
          reference: input.reference,
          payloadHash: input.payloadHash,
          head: ev.head,
          signature,
          compact: input.compact,
        });
      });
    }

    const asc = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      events: [...bySeq.values()].sort((a, b) => asc(a.seq, b.seq)),
      epochs: [...epochs.values()].sort((a, b) => asc(a.startSeq, b.startSeq)),
      cells: [...cellWrites.values()].sort((a, b) => asc(a.opSeq, b.opSeq)),
      structs: [...structCreates.values()].sort((a, b) => asc(a.opSeq, b.opSeq)),
      policies: [...policyRewrites.values()].sort((a, b) => asc(a.opSeq, b.opSeq)),
    };
  }

  /**
   * Only the records the compressed-account view is missing (i.e. compact logs).
   * `verifyChain({ recover: true })` calls this for you.
   */
  async recoverCompactEvents(agentId: Bytes32): Promise<RecoveredEventRecord[]> {
    const onChain = new Set((await this.listEvents(agentId)).map((r) => r.seq.toString()));
    return (await this.recoverEventsFromHistory(agentId)).filter((r) => !onChain.has(r.seq.toString()));
  }

  /**
   * Decodes the `EventInput`s carried by the event-logging instructions of a transaction, in
   * order.
   *
   * The instruction filter is load-bearing, not defensive. A cell write spends the owner's
   * header, so `create_cell` / `replace_cell` / `close_cell` transactions show up in the same
   * `getCompressionSignaturesForAddress` page as events — and `create_cell` also takes an
   * argument called `input`, of an entirely different type. Without the name check, an owner
   * that uses v0.2 structures at all makes `verifyChain({ recover: true })` throw on the first
   * cell it meets.
   */
  private decodeEventInputs(tx: anchor.web3.VersionedTransactionResponse): (EventInput & { compact: boolean })[] {
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
    });
    const out: (EventInput & { compact: boolean })[] = [];
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (!keys.get(ix.programIdIndex)?.equals(this.programId)) continue;
      const coder = this.program.coder.instruction as BorshInstructionCoder;
      const decoded = coder.decode(Buffer.from(ix.data));
      if (!decoded) continue;
      if (!EVENT_INSTRUCTIONS.has(decoded.name)) continue;
      const args = decoded.data as any;
      const inputs = args.inputs ?? (args.input ? [args.input] : []);
      // Kept, not discarded: which instruction wrote a seq is what tells a gap that is meant to be
      // there (a compact write) from a record the indexer is not returning.
      const compact = decoded.name === "logEventCompact" || decoded.name === "log_event_compact";
      for (const i of inputs) {
        out.push({
          timestamp: BigInt(i.timestamp.toString()),
          kind: i.kind as EventKind,
          status: i.status,
          reference: Uint8Array.from(i.reference),
          payloadHash: Uint8Array.from(i.payloadHash),
          compact,
        });
      }
    }
    return out;
  }

  /**
   * Replays every on-chain record and checks the hash chain against the agent head.
   * With `{ recover: true }`, gaps left by compact logs are filled from transaction history,
   * so a fully-available history yields `missingSeqs: []`.
   *
   * Gaps are *reported*, not replayed across: a seq with no account leaves the running head
   * unknown and the replay re-synchronises at the next write that records its own head. When
   * the gap runs to the tail there is no such write, so `AgentState.head` is never compared
   * with anything (a closed cell is the exception: its `CellWritten` event names the head it
   * produced, and the replay re-syncs from that) — `headReached` is false and `ok` is false with it. That is not the same
   * failure as a divergence (`firstBadSeq`), and `lath-audit` prints and exits differently
   * for the two. A gap in the middle that transaction history does not explain either
   * (`unexplainedGaps`) clears `ok` the same way: the fold re-synced past it, but whatever was
   * written there was not seen.
   */
  async verifyChain(agentId: Bytes32, opts: VerifyChainOptions = {}): Promise<ChainVerification> {
    const found = await this.getAgentState(agentId);
    if (!found) throw new Error("agent not registered");
    const { state } = found;
    const onChain = await this.listEvents(agentId);

    // Cells and structure headers share the owner's operation counter with events, so a mixed
    // history replays as one ordered stream. Every write records the head it produced,
    // so each one is checked against a recomputation of it.
    const headers = await this.listStructs(agentId);
    const cells = await this.listOwnerCells(agentId, headers);
    const byStruct = new Map(headers.map((h) => [hex(h.structId), h]));

    /**
     * One write: occupies `[op, next)` — a single seq for everything but an epoch. `header` is
     * set on a structure's creation fold only, so the fold can be swapped for one over the
     * creation-time header once history shows the header was rewritten since. A `check` that
     * answers `null` produces no head: the replay carries nothing forward from it and re-syncs at
     * the next write that records one.
     */
    type Write = {
      op: bigint;
      next: bigint;
      check: (prev: Bytes32) => Bytes32 | null;
      head?: Bytes32;
      header?: string;
    };
    const asc = (a: Write, b: Write) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0);
    const eventWrite = (r: EventRecord): Write => ({
      op: r.seq,
      next: r.seq + 1n,
      check: (prev) => computeHead(prev, agentId, r.seq, r),
      head: r.head,
    });
    // A header's folds come from `headerFolds`, which the verification export and
    // `scripts/verify-bundle.ts` also use. Given no rewrites it is the creation fold over the
    // header as read — a structure header does not store the head it produced, so that fold can
    // only be carried forward, never checked against a recorded value. A `set_append_policy`
    // fold does carry its head, from the event, and is checked like a cell write.
    const headerWrite = (h: StructHeader, f: HeaderFold): Write => ({
      op: f.opSeq,
      next: f.opSeq + 1n,
      check: (prev: Bytes32) => computeStructHead(prev, f.header, f.opSeq, f.op),
      head: f.head,
      header: f.op === CellOp.CreateStruct ? hex(h.structId) : undefined,
    });
    let writes: Write[] = [
      ...onChain.map(eventWrite),
      ...headers.flatMap((h) => headerFolds(h, []).map((f) => headerWrite(h, f))),
      ...cells.map((c) => {
        const isMap = byStruct.get(hex(c.structId))?.kind === StructKind.Map;
        const op = isMap && c.indexOrVersion > 0n ? CellOp.Replace : CellOp.Create;
        return {
          op: c.opSeq,
          next: c.opSeq + 1n,
          check: (prev: Bytes32) => computeCellHead(prev, op, c),
          head: c.head,
        };
      }),
    ].sort(asc);

    // Is every seq up to `state.seq` accounted for? If not, the gaps are epochs, compact
    // writes, or closed cells — and the first two live only in transaction history.
    const hasGaps = (ws: Write[]) => {
      let expected = 0n;
      for (const w of ws) {
        if (w.op > expected) return true;
        expected = w.next;
      }
      return expected < state.seq;
    };

    const recoveredSeqs: bigint[] = [];
    const resyncedSeqs: bigint[] = [];
    // Every seq history shows written by `log_event_compact` — the one write with no account by
    // design, so the one gap history can explain. Seeing a `log_event` / `log_events` write in
    // history does not explain a missing record: that write created an account, and a reader
    // that is not shown it has not seen the event. Nor does a `StructCreated`: a
    // structure header is never closed. `CellWritten` needs no entry here — a cell seq with no
    // account is re-synced from the event below and never reaches `missingSeqs`.
    const compactInHistory = new Set<string>();
    let epochs: EpochRecord[] = [];
    let records = onChain.length;
    let policyRewrites = 0;
    if (hasGaps(writes)) {
      const history = await this.readHistory(agentId);
      epochs = history.epochs;
      for (const r of history.events) if (r.compact) compactInHistory.add(r.seq.toString());
      for (const e of epochs) {
        writes.push({
          op: e.startSeq,
          next: e.endSeq,
          check: (prev) => computeEpochHead(prev, agentId, e.epochRoot, e.startSeq, e.endSeq),
          head: e.head,
        });
      }
      // A `set_append_policy` always lands here: the rewrite spends a seq and leaves no account
      // of its own (the header is re-created at the same address, carrying the *new* policy), so
      // its seq is a gap and the creation fold recomputed from that header above is wrong — it
      // hashes a policy the structure did not have at seq `createdOpSeq`. `AppendPolicySet` is the
      // only place the previous policy survives, so for every rewritten structure the creation
      // fold is rebuilt over the header as `create_struct` wrote it and each rewrite is folded at
      // its own seq against the head its event names (recomputed, not re-synced: the fold's whole
      // preimage is in hand). Not gated on `recover`, for the reason the cell re-sync below is
      // not — the history is already read, and a chain that used the instruction is otherwise
      // FAILED for every reader. Old stubs and old histories carry no `policies`.
      const policies = history.policies ?? [];
      if (policies.length > 0) {
        const rewritten = new Set(policies.map((p) => hex(p.structId)));
        writes = writes.filter((w) => w.header === undefined || !rewritten.has(w.header));
        for (const h of headers) {
          if (!rewritten.has(hex(h.structId))) continue;
          for (const f of headerFolds(h, policies)) {
            if (f.op === CellOp.SetAppendPolicy && f.opSeq >= state.seq) continue;
            writes.push(headerWrite(h, f));
            if (f.op === CellOp.SetAppendPolicy) policyRewrites++;
          }
        }
      }
      if (opts.recover) {
        const have = new Set(onChain.map((r) => r.seq.toString()));
        for (const r of history.events) {
          if (have.has(r.seq.toString())) continue;
          writes.push(eventWrite(r));
          recoveredSeqs.push(r.seq);
          records++;
        }
      }
      // A cell write whose account is gone — closed, or a Map version replaced away — still
      // emitted `CellWritten` with the head it produced. Take that head for any seq nothing
      // above covers, so a gap at the tail (an agent whose last write was a `close_cell`) is
      // compared with `AgentState.head` instead of left unchecked. It is a re-sync, like a
      // structure header: the event has no cell bytes, so the fold into it is not recomputed.
      // Not gated on `recover`: the history is already in hand, and this costs no RPC.
      const covered = (op: bigint) => writes.some((w) => w.op <= op && op < w.next);
      for (const c of history.cells) {
        if (c.opSeq >= state.seq || covered(c.opSeq)) continue;
        writes.push({ op: c.opSeq, next: c.opSeq + 1n, check: () => c.head, head: c.head });
        resyncedSeqs.push(c.opSeq);
      }
      // A structure header always has an account, so one missing is an indexer not returning it.
      // Asked to `recover`, re-sync from the head its `StructCreated` names — the same trust as a
      // closed cell — so that the `--recover` an unexplained gap asks for can actually close it.
      if (opts.recover) {
        for (const h of history.structs ?? []) {
          if (h.opSeq >= state.seq || covered(h.opSeq)) continue;
          writes.push({ op: h.opSeq, next: h.opSeq + 1n, check: () => h.head, head: h.head });
          resyncedSeqs.push(h.opSeq);
        }
        // A rewrite whose header the indexer did not return either: its fold needs the header's
        // fixed fields, which only the account holds, so it is re-synced from the event's head on
        // the same terms as the missing header itself. One with a header was folded above.
        for (const p of policies) {
          if (p.opSeq >= state.seq || covered(p.opSeq)) continue;
          writes.push({ op: p.opSeq, next: p.opSeq + 1n, check: () => p.head, head: p.head });
          resyncedSeqs.push(p.opSeq);
        }
      }
      // A creation fold records no head, so it is carried forward and only the next recorded
      // head checks it — and it hashes the header's policy as read unless an `AppendPolicySet`
      // above gave the creation-time one back. `readHistory` skips a transaction `getTransaction`
      // does not return, so the one rewrite that matters can be missing: the fold then hashes
      // the rewritten policy, and an intact chain read as BROKEN at its next recorded head where
      // every other missing transaction reads as a gap nobody checked. A missing
      // rewrite always leaves a gap (it has no account), between the creation and the earliest
      // rewrite history does hold for that structure, or the tail when it holds none. So a header
      // with an unexplained gap there may be folding the wrong policy: its creation produces no
      // head and the replay re-syncs at the next recorded one, while the gap still keeps the
      // chain from verifying. Without such a gap the fold is exactly the one above, so a chain
      // whose history is whole is checked at full strictness. The seqs counted here are the
      // ones the replay below reports in `unexplainedGaps`: uncovered, and not a compact write.
      const unexplained: bigint[] = [];
      const uncovered = (from: bigint, to: bigint) => {
        for (let s = from; s < to; s++) if (!compactInHistory.has(s.toString())) unexplained.push(s);
      };
      let reach = 0n;
      for (const w of [...writes].sort(asc)) {
        if (w.op > reach) uncovered(reach, w.op);
        if (w.next > reach) reach = w.next;
      }
      uncovered(reach, state.seq);
      const suspect = new Set<string>();
      for (const h of headers) {
        const key = hex(h.structId);
        const earliest = policies
          .filter((p) => hex(p.structId) === key)
          .reduce<bigint>((m, p) => (p.opSeq < m ? p.opSeq : m), state.seq);
        if (unexplained.some((s) => s > h.createdOpSeq && s < earliest)) suspect.add(key);
      }
      if (suspect.size > 0) {
        writes = writes.map((w) => (w.header !== undefined && suspect.has(w.header) ? { ...w, check: () => null } : w));
      }
      writes.sort(asc);
    }

    const missingSeqs: bigint[] = [];
    let firstBadSeq: bigint | undefined;
    // `prev` is null while the previous head is unknown — a compact log, a closed cell or a
    // replaced-away version leaves no account to read it from (SPEC §12 #11).
    let prev: Bytes32 | null = GENESIS_HEAD;
    let expected = 0n;
    const markMissingUntil = (op: bigint) => {
      while (expected < op) {
        missingSeqs.push(expected);
        prev = null;
        expected++;
      }
    };
    for (const w of writes) {
      markMissingUntil(w.op);
      const produced: Bytes32 | null = prev !== null ? w.check(prev) : null;
      if (produced && w.head && hex(produced) !== hex(w.head) && firstBadSeq === undefined) firstBadSeq = w.op;
      prev = w.head ?? produced;
      expected = w.next;
    }
    markMissingUntil(state.seq);
    // Read `prev` once into a const: what matters at the tail is whether the fold is still
    // carried, and `null` there is not "nothing to disagree with" but "nothing was checked".
    // A test of the form `prev === null || hex(prev) === hex(state.head)` would short-circuit a
    // tail gap into a pass, so an agent logged entirely with `compact: true` would audit VERIFIED
    // having compared nothing to `AgentState.head`.
    const tail: Bytes32 | null = prev;
    const headReached = tail !== null;
    if (tail !== null && hex(tail) !== hex(state.head) && firstBadSeq === undefined) {
      // The last write is the one that produced the wrong head; seq 0 has no predecessor.
      firstBadSeq = state.seq > 0n ? state.seq - 1n : 0n;
    }
    // A mid-chain gap is re-synced across at the next record's stored head, so it never shows up
    // as a divergence or an unreached head. Every stored head was computed by the program, so a
    // gap cannot forge history — but a gap history does not explain can hide it: the chain would
    // read `ok` over an event an indexer declined to return. Only a compact write is
    // explained; a `log_event` record whose signature history still lists is as unseen as one it
    // does not — without `recover` it is neither folded nor walked for its preimage.
    const unexplainedGaps = missingSeqs.filter((s) => !compactInHistory.has(s.toString()));
    return {
      ok: firstBadSeq === undefined && headReached && unexplainedGaps.length === 0,
      headReached,
      records,
      cells: cells.length,
      structs: headers.length,
      policyRewrites,
      seq: state.seq,
      head: state.head,
      firstBadSeq,
      missingSeqs,
      unexplainedGaps,
      recoveredSeqs,
      resyncedSeqs,
      epochs,
    };
  }

  /** Every structure header this owner really owns, ascending by creation. */
  async listStructs(ownerId: Bytes32): Promise<StructHeader[]> {
    const kept = new Map<string, PagedHeader>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressedAccountsByOwner(this.programId, {
        filters: [{ memcmp: { offset: CELL_OFFSETS.ownerId, bytes: bs58.encode(ownerId) } }],
        cursor,
      });
      for (const a of page.items) {
        if (a.data && a.data.data.length === STRUCT_HEADER_LEN) {
          const header = this.decodeStructHeader(a.data.data);
          const address = a.address ? new PublicKey(a.address) : undefined;
          if (!address || address.equals(this.headerAddress(ownerId, header.structId))) {
            // A repeated header would fold its creation twice (see `listRecords`); a repeat that is
            // a newer version replaces the older (`laterHeader`).
            keepLatest(kept, address, hex(header.structId), { ...header, address, leaf: leafOf(a) }, laterHeader);
          }
        }
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);
    const out: StructHeader[] = [...kept.values()].map(({ leaf: _leaf, ...header }) => header);
    return out.sort((a, b) => (a.createdOpSeq < b.createdOpSeq ? -1 : a.createdOpSeq > b.createdOpSeq ? 1 : 0));
  }

  /** Every live cell across all of this owner's structures, ascending by `op_seq`. */
  async listOwnerCells(ownerId: Bytes32, headers?: StructHeader[]): Promise<Cell[]> {
    const structs = headers ?? (await this.listStructs(ownerId));
    const byStruct = new Map(structs.map((h) => [hex(h.structId), h]));
    const kept = new Map<string, Cell>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressedAccountsByOwner(this.programId, {
        filters: [{ memcmp: { offset: CELL_OFFSETS.ownerId, bytes: bs58.encode(ownerId) } }],
        cursor,
      });
      for (const a of page.items) {
        if (!a.data || a.data.data.length !== CELL_LEN) continue;
        const cell = this.decodeCell(a.data.data);
        const header = byStruct.get(hex(cell.structId));
        if (!header) continue;
        const address = a.address ? new PublicKey(a.address) : undefined;
        const expected =
          header.kind === StructKind.Log
            ? this.logCellAddress(ownerId, cell.structId, cell.indexOrVersion, header.consumable)
            : this.mapCellAddress(ownerId, cell.structId, cell.keySlot);
        // A repeated cell would fold twice at its `opSeq` (see `listRecords`), and a `replace_cell`
        // landing between pages makes the repeat a newer version: the later `opSeq` is kept. A cell
        // with no address is keyed by its slot in its structure, which is what its address derives.
        if (!address || address.equals(expected)) {
          keepLatest(
            kept,
            address,
            `${hex(cell.structId)}:${cellSlot(cell, header.kind)}`,
            { ...cell, address },
            laterCell
          );
        }
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);
    return [...kept.values()].sort((a, b) => (a.opSeq < b.opSeq ? -1 : a.opSeq > b.opSeq ? 1 : 0));
  }

  // ---------------------------------------------------------------------------------------
  // Codec
  // ---------------------------------------------------------------------------------------

  decodeAgentState(data: Buffer | Uint8Array): AgentState {
    return decodeAgentState(data);
  }

  decodeEventRecord(data: Buffer | Uint8Array): EventRecord {
    return decodeEventRecord(data);
  }

  // ---------------------------------------------------------------------------------------
  // Base data structures — see sdk/src/cells.ts
  // ---------------------------------------------------------------------------------------

  /** Address of this owner's `struct_id` header. Seeded by the owner's header address. */
  headerAddress(ownerId: Bytes32, structId: Bytes32): PublicKey {
    return headerAddress(this.agentAddress(ownerId), structId, this.addressTree, this.programId);
  }

  /**
   * Address of a `Log` cell at `index`. Consumable Logs (queues, mailboxes) have their own
   * address space, so pass `consumable` to match how the structure was created.
   */
  logCellAddress(ownerId: Bytes32, structId: Bytes32, index: bigint | number, consumable = false): PublicKey {
    return logCellAddress(this.agentAddress(ownerId), structId, index, this.addressTree, this.programId, consumable);
  }

  /** Address of a `Map` cell for a key slot (`publicKeySlot` / `privateKeySlot`). */
  mapCellAddress(ownerId: Bytes32, structId: Bytes32, keySlot: Bytes32): PublicKey {
    return mapCellAddress(this.agentAddress(ownerId), structId, keySlot, this.addressTree, this.programId);
  }

  /** Creates a `Log` or `Map` header. Fails if the structure already exists. */
  async createStruct(ownerId: Bytes32, params: CreateStructParams): Promise<{ signature: string; address: PublicKey }> {
    return this.withRetry("createStruct", (_, sent) => this.createStructOnce(ownerId, params, sent));
  }

  private async createStructOnce(
    ownerId: Bytes32,
    params: CreateStructParams,
    sent: InDoubt<{ signature: string; address: PublicKey }>[]
  ): Promise<{ signature: string; address: PublicKey }> {
    const { account, state } = await this.ownedState(ownerId);
    const prior = await this.priorLanded(sent, state);
    if (prior !== undefined) return prior;
    const address = this.headerAddress(ownerId, params.structId);
    const stateTree = await this.outputTreeFor(account.treeInfo);
    const proof = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      [{ address: bn(address.toBytes()), tree: this.addressTree, queue: this.addressTree }]
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const merkleTreePubkeyIndex = packed.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = packed.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const addressTreeIndex = packed.insertOrGet(this.addressTree);

    // The header the program is about to write, in exactly the fields the fold covers, built
    // once and used for both the instruction argument and the expected head — two spellings of
    // the same defaults would be a chain formula that drifts from what is sent.
    const created: StructHeader = {
      ownerId: state.agentId,
      structId: params.structId,
      kind: params.kind,
      mode: params.mode ?? StructMode.Public,
      lenOrCount: 0n,
      createdOpSeq: state.seq,
      consumable: params.consumable ?? false,
      appendPolicy: params.appendPolicy ?? AppendPolicy.OwnerOnly,
      policyRef: params.policyRef ?? new Uint8Array(32),
    };

    const tx = await this.program.methods
      .createStruct(
        { 0: proof.compressedProof },
        this.agentStateArg(state),
        this.agentMetaArg(account, proof, merkleTreePubkeyIndex, queuePubkeyIndex, outputStateTreeIndex),
        {
          rootIndex: proof.rootIndices[1],
          addressMerkleTreePubkeyIndex: addressTreeIndex,
          addressQueuePubkeyIndex: addressTreeIndex,
        },
        outputStateTreeIndex,
        {
          structId: Array.from(created.structId),
          kind: created.kind,
          mode: created.mode,
          consumable: created.consumable,
          appendPolicy: created.appendPolicy,
          policyRef: Array.from(created.policyRef),
          createdAt: new BN((params.createdAt ?? Date.now()).toString()),
        }
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    const head = computeStructHead(state.head, created, created.createdOpSeq);
    const result = (signature: string) => ({ signature, address });
    const signature = await this.sendWrite(tx, ownerId, state, state.seq + 1n, head, sent, result);
    this.noteWrite(ownerId, state.seq + 1n);
    return result(signature);
  }

  /**
   * Appends a `Log` cell or `put`s a `Map` cell. The write folds into the owner's chain and
   * consumes one `op_seq`, exactly like an event.
   */
  async createCell(ownerId: Bytes32, structId: Bytes32, input: CellInput = {}): Promise<CellWriteResult> {
    return this.withRetry("createCell", (_, sent) => this.createCellOnce(ownerId, structId, input, sent));
  }

  private async createCellOnce(
    ownerId: Bytes32,
    structId: Bytes32,
    input: CellInput,
    sent: InDoubt<CellWriteResult>[]
  ): Promise<CellWriteResult> {
    const owner = await this.getAgentState(ownerId);
    if (!owner) throw new Error(`owner ${hex(ownerId)} is not registered`);
    // No authority check here: a non-owner may append under an open `append_policy`. The in-doubt
    // check needs only the state, which is what both a landed and a rebuilt write spend.
    const prior = await this.priorLanded(sent, owner.state);
    if (prior !== undefined) return prior;
    const found = await this.getHeader(ownerId, structId);
    if (!found) throw new Error(`structure ${hex(structId)} does not exist for this owner`);
    const { account: headerAccount, header } = found;

    const isLog = header.kind === StructKind.Log;
    const index = isLog ? header.lenOrCount : 0n;
    const keySlot = input.keySlot ?? new Uint8Array(32);
    const address = isLog
      ? this.logCellAddress(ownerId, structId, index, header.consumable)
      : this.mapCellAddress(ownerId, structId, keySlot);

    const stateTree = await this.outputTreeFor(owner.account.treeInfo, headerAccount.treeInfo);
    // The proof's leaves in the order the program hands its inputs to the Light system program
    // (`with_light_account` in `programs/lath/src/lib.rs`: the header, then the agent's state). Leaves proven
    // by root are folded into the proof's public input in that order, so the other order verifies
    // only while at least one of the two is still in the output queue and proven by index — and
    // fails with 0x179b (ProofVerificationFailed) on every write once both are in the tree, which
    // leaves an agent idle for half an hour unwritable.
    const proof = await this.rpc.getValidityProofV0(
      [
        { hash: headerAccount.hash, tree: headerAccount.treeInfo.tree, queue: headerAccount.treeInfo.queue },
        { hash: owner.account.hash, tree: owner.account.treeInfo.tree, queue: owner.account.treeInfo.queue },
      ],
      [{ address: bn(address.toBytes()), tree: this.addressTree, queue: this.addressTree }]
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const headerMeta = this.metaFor(headerAccount, proof, 0, packed, outputStateTreeIndex);
    const agentMeta = this.metaFor(owner.account, proof, 1, packed, outputStateTreeIndex);
    const addressTreeIndex = packed.insertOrGet(this.addressTree);

    const timestamp = BigInt(input.timestamp ?? Date.now());
    const tx = await this.program.methods
      .createCell(
        { 0: proof.compressedProof },
        this.agentStateArg(owner.state),
        agentMeta,
        this.headerArg(header),
        headerMeta,
        {
          rootIndex: proof.rootIndices[2],
          addressMerkleTreePubkeyIndex: addressTreeIndex,
          addressQueuePubkeyIndex: addressTreeIndex,
        },
        outputStateTreeIndex,
        this.cellInputArg(input, timestamp)
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    const cell: Cell = {
      ownerId,
      structId,
      indexOrVersion: index,
      opSeq: owner.state.seq,
      timestamp,
      tag: input.tag ?? 0,
      status: input.status ?? 0,
      keySlot,
      valueSlot: input.valueSlot ?? new Uint8Array(32),
      head: new Uint8Array(32),
    };
    cell.head = computeCellHead(owner.state.head, CellOp.Create, cell);

    const result = (signature: string): CellWriteResult => ({ signature, address, cell, op: CellOp.Create });
    const signature = await this.sendWrite(tx, ownerId, owner.state, owner.state.seq + 1n, cell.head, sent, result);
    this.noteWrite(ownerId, owner.state.seq + 1n);
    return result(signature);
  }

  /** Rewrites a `Map` cell, bumping its version. `Log` cells are append-only. */
  async replaceCell(
    ownerId: Bytes32,
    structId: Bytes32,
    keySlot: Bytes32,
    input: CellInput = {}
  ): Promise<CellWriteResult> {
    return this.withRetry("replaceCell", (_, sent) => this.replaceCellOnce(ownerId, structId, keySlot, input, sent));
  }

  private async replaceCellOnce(
    ownerId: Bytes32,
    structId: Bytes32,
    keySlot: Bytes32,
    input: CellInput,
    sent: InDoubt<CellWriteResult>[]
  ): Promise<CellWriteResult> {
    const owner = await this.ownedState(ownerId);
    const prior = await this.priorLanded(sent, owner.state);
    if (prior !== undefined) return prior;
    const address = this.mapCellAddress(ownerId, structId, keySlot);
    const existing = await this.getCellAt(address);
    if (!existing) throw new Error(`no cell at ${address.toBase58()}`);

    const stateTree = await this.outputTreeFor(owner.account.treeInfo, existing.account.treeInfo);
    // The proof's leaves in the order the program hands its inputs to the Light system program
    // (`with_light_account` in `programs/lath/src/lib.rs`: the cell, then the agent's state). Leaves proven
    // by root are folded into the proof's public input in that order, so the other order verifies
    // only while at least one of the two is still in the output queue and proven by index — and
    // fails with 0x179b (ProofVerificationFailed) on every write once both are in the tree, which
    // leaves an agent idle for half an hour unwritable.
    const proof = await this.rpc.getValidityProofV0(
      [
        { hash: existing.account.hash, tree: existing.account.treeInfo.tree, queue: existing.account.treeInfo.queue },
        { hash: owner.account.hash, tree: owner.account.treeInfo.tree, queue: owner.account.treeInfo.queue },
      ],
      []
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const cellMeta = this.metaFor(existing.account, proof, 0, packed, outputStateTreeIndex);
    const agentMeta = this.metaFor(owner.account, proof, 1, packed, outputStateTreeIndex);

    const timestamp = BigInt(input.timestamp ?? Date.now());
    const tx = await this.program.methods
      .replaceCell(
        { 0: proof.compressedProof },
        this.agentStateArg(owner.state),
        agentMeta,
        this.cellArg(existing.cell),
        cellMeta,
        this.cellInputArg(input, timestamp)
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    const cell: Cell = {
      ownerId,
      structId,
      indexOrVersion: existing.cell.indexOrVersion + 1n,
      opSeq: owner.state.seq,
      timestamp,
      tag: input.tag ?? 0,
      status: input.status ?? 0,
      keySlot: existing.cell.keySlot,
      valueSlot: input.valueSlot ?? new Uint8Array(32),
      head: new Uint8Array(32),
    };
    cell.head = computeCellHead(owner.state.head, CellOp.Replace, cell);

    // The one write where a blind retry cannot even fail cheaply: the first attempt nullified
    // the cell this one re-reads, so every remaining attempt dies on a spent account and the
    // caller is told the replace failed after it succeeded.
    const result = (signature: string): CellWriteResult => ({ signature, address, cell, op: CellOp.Replace });
    const signature = await this.sendWrite(tx, ownerId, owner.state, owner.state.seq + 1n, cell.head, sent, result);
    this.noteWrite(ownerId, owner.state.seq + 1n);
    return result(signature);
  }

  /** Closes a `Map` cell, or dequeues one from a consumable `Log`. */
  async closeCell(
    ownerId: Bytes32,
    structId: Bytes32,
    at: { index?: bigint | number; keySlot?: Bytes32 },
    timestamp: bigint | number = Date.now()
  ): Promise<CellWriteResult> {
    return this.withRetry("closeCell", (_, sent) => this.closeCellOnce(ownerId, structId, at, BigInt(timestamp), sent));
  }

  private async closeCellOnce(
    ownerId: Bytes32,
    structId: Bytes32,
    at: { index?: bigint | number; keySlot?: Bytes32 },
    timestamp: bigint,
    sent: InDoubt<CellWriteResult>[]
  ): Promise<CellWriteResult> {
    const owner = await this.ownedState(ownerId);
    const prior = await this.priorLanded(sent, owner.state);
    if (prior !== undefined) return prior;
    if (at.keySlot === undefined) {
      const header = (await this.getHeader(ownerId, structId))?.header;
      if (header && !header.consumable) {
        throw new Error(`Log ${hex(structId)} is not consumable, so its cells cannot be closed`);
      }
    }
    const address =
      at.keySlot !== undefined
        ? this.mapCellAddress(ownerId, structId, at.keySlot)
        : this.logCellAddress(ownerId, structId, at.index!, true);
    const existing = await this.getCellAt(address);
    if (!existing) throw new Error(`no cell at ${address.toBase58()}`);

    const stateTree = await this.outputTreeFor(owner.account.treeInfo, existing.account.treeInfo);
    // The proof's leaves in the order the program hands its inputs to the Light system program
    // (`with_light_account` in `programs/lath/src/lib.rs`: the cell, then the agent's state). Leaves proven
    // by root are folded into the proof's public input in that order, so the other order verifies
    // only while at least one of the two is still in the output queue and proven by index — and
    // fails with 0x179b (ProofVerificationFailed) on every write once both are in the tree, which
    // leaves an agent idle for half an hour unwritable.
    const proof = await this.rpc.getValidityProofV0(
      [
        { hash: existing.account.hash, tree: existing.account.treeInfo.tree, queue: existing.account.treeInfo.queue },
        { hash: owner.account.hash, tree: owner.account.treeInfo.tree, queue: owner.account.treeInfo.queue },
      ],
      []
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const cellMeta = this.metaFor(existing.account, proof, 0, packed, outputStateTreeIndex);
    const agentMeta = this.metaFor(owner.account, proof, 1, packed, outputStateTreeIndex);

    const tx = await this.program.methods
      .closeCell(
        { 0: proof.compressedProof },
        this.agentStateArg(owner.state),
        agentMeta,
        this.cellArg(existing.cell),
        cellMeta,
        new BN(timestamp.toString())
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    const head = computeCellHead(owner.state.head, CellOp.Close, existing.cell);
    const result = (signature: string): CellWriteResult => ({
      signature,
      address,
      cell: { ...existing.cell, head },
      op: CellOp.Close,
    });
    const signature = await this.sendWrite(tx, ownerId, owner.state, owner.state.seq + 1n, head, sent, result);
    this.noteWrite(ownerId, owner.state.seq + 1n);
    return result(signature);
  }

  /**
   * Rewrites a structure header's `append_policy` and `policy_ref` in place (`set_append_policy`).
   * Owner-only, whatever the header's current policy: it is how an older `runtime-inbox` created
   * `Anyone` is taken to `OwnerOnly`, which is what the runtime creates, without losing the
   * mailbox — closing the header would spend its address for
   * good and leave `ensureCreated` failing on every later session.
   *
   * `policyRef` is required under `AllowList` (the senders' root, `allowListRoot`), and otherwise
   * defaults to what the header already holds: a private structure's `sha256(secret)` stays
   * committed across the rewrite, and under `OwnerOnly` or `Anyone` the slot is not read.
   *
   * The rewrite consumes one `op_seq` and folds into the owner's chain like every other write,
   * under `CellOp.SetAppendPolicy` over the header as it stands afterwards. A replay that
   * recomputes the structure's creation fold from the account alone would disagree — the account
   * no longer shows its creation policy — so `AppendPolicySet` in transaction history carries it
   * as `previousPolicy` / `previousPolicyRef`, and `verifyChain` reads it back through
   * `readHistory().policies` and `headerFolds`.
   */
  async setAppendPolicy(
    ownerId: Bytes32,
    structId: Bytes32,
    appendPolicy: AppendPolicy,
    opts: { policyRef?: Bytes32; timestamp?: bigint | number } = {}
  ): Promise<PolicyWriteResult> {
    return this.withRetry("setAppendPolicy", (_, sent) =>
      this.setAppendPolicyOnce(ownerId, structId, appendPolicy, opts, sent)
    );
  }

  private async setAppendPolicyOnce(
    ownerId: Bytes32,
    structId: Bytes32,
    appendPolicy: AppendPolicy,
    opts: { policyRef?: Bytes32; timestamp?: bigint | number },
    sent: InDoubt<PolicyWriteResult>[]
  ): Promise<PolicyWriteResult> {
    if (appendPolicy === AppendPolicy.AllowList && !opts.policyRef) {
      throw new Error("an AllowList policy needs its senders' root as policyRef (allowListRoot)");
    }
    const owner = await this.ownedState(ownerId);
    const prior = await this.priorLanded(sent, owner.state);
    if (prior !== undefined) return prior;
    const found = await this.getHeader(ownerId, structId);
    if (!found) throw new Error(`structure ${hex(structId)} does not exist for this owner`);
    const { account: headerAccount, header } = found;
    const address = header.address ?? this.headerAddress(ownerId, structId);

    const stateTree = await this.outputTreeFor(owner.account.treeInfo, headerAccount.treeInfo);
    // The proof's leaves in the order the program hands its inputs to the Light system program
    // (`with_light_account` in `programs/lath/src/lib.rs`: the header, then the agent's state), for
    // the reason `createCellOnce` gives.
    const proof = await this.rpc.getValidityProofV0(
      [
        { hash: headerAccount.hash, tree: headerAccount.treeInfo.tree, queue: headerAccount.treeInfo.queue },
        { hash: owner.account.hash, tree: owner.account.treeInfo.tree, queue: owner.account.treeInfo.queue },
      ],
      []
    );

    const packed = PackedAccounts.newWithSystemAccountsV2(SystemAccountMetaConfig.new(this.programId));
    const outputStateTreeIndex = packed.insertOrGet(stateTree.queue);
    const headerMeta = this.metaFor(headerAccount, proof, 0, packed, outputStateTreeIndex);
    const agentMeta = this.metaFor(owner.account, proof, 1, packed, outputStateTreeIndex);

    const policyRef = opts.policyRef ?? header.policyRef;
    const timestamp = BigInt(opts.timestamp ?? Date.now());
    const tx = await this.program.methods
      .setAppendPolicy(
        { 0: proof.compressedProof },
        this.agentStateArg(owner.state),
        agentMeta,
        this.headerArg(header),
        headerMeta,
        appendPolicy,
        Array.from(policyRef),
        new BN(timestamp.toString())
      )
      .accounts({ authority: this.authority.publicKey })
      .preInstructions(this.budgetInstructions())
      .remainingAccounts(packed.toAccountMetas().remainingAccounts)
      .transaction();

    // The header the program is about to write — every field as read, the two policy fields
    // replaced — is both what the fold covers and what the caller gets back.
    const rewritten: StructHeader = { ...header, appendPolicy, policyRef, address };
    const opSeq = owner.state.seq;
    const head = computeStructHead(owner.state.head, rewritten, opSeq, CellOp.SetAppendPolicy);
    const result = (signature: string): PolicyWriteResult => ({ signature, address, header: rewritten, opSeq, head });
    const signature = await this.sendWrite(tx, ownerId, owner.state, opSeq + 1n, head, sent, result);
    this.noteWrite(ownerId, opSeq + 1n);
    return result(signature);
  }

  async getHeader(
    ownerId: Bytes32,
    structId: Bytes32
  ): Promise<{ account: CompressedAccountWithMerkleContext; header: StructHeader } | null> {
    const address = this.headerAddress(ownerId, structId);
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    if (!account || !account.data || account.data.data.length === 0) return null;
    return { account, header: { ...this.decodeStructHeader(account.data.data), address } };
  }

  /**
   * Whether a cell address holds a live cell, a **closed** one, or nothing at all. `getCellAt`
   * (and so `getMapCell`, `LathMap.has`) answers `null` for both of the last two, and for a
   * reader that is right. A writer needs the difference: `close_cell` leaves an empty account at
   * the address (Light's `new_close` keeps the address and zeroes the data), and the address tree
   * never drops an address, so a closed key can be neither created (no non-inclusion proof) nor
   * replaced (no `Cell` to spend) again — SPEC §12 #5.
   */
  async cellStateAt(address: PublicKey): Promise<"live" | "closed" | "absent"> {
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    if (!account) return "absent";
    return !account.data || account.data.data.length === 0 ? "closed" : "live";
  }

  /** One cell by its address. */
  private async getCellAt(
    address: PublicKey
  ): Promise<{ account: CompressedAccountWithMerkleContext; cell: Cell } | null> {
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    if (!account || !account.data || account.data.data.length === 0) return null;
    return { account, cell: { ...this.decodeCell(account.data.data), address } };
  }

  async getLogCell(
    ownerId: Bytes32,
    structId: Bytes32,
    index: bigint | number,
    consumable = false
  ): Promise<Cell | null> {
    return (await this.getCellAt(this.logCellAddress(ownerId, structId, index, consumable)))?.cell ?? null;
  }

  async getMapCell(ownerId: Bytes32, structId: Bytes32, keySlot: Bytes32): Promise<Cell | null> {
    return (await this.getCellAt(this.mapCellAddress(ownerId, structId, keySlot)))?.cell ?? null;
  }

  /**
   * Every live cell of one structure, ascending by `op_seq`, keeping only cells at the address
   * this client derives — `owner_id` and `struct_id` are fields any writer can set, the address
   * is not.
   */
  async listCells(
    ownerId: Bytes32,
    structId: Bytes32,
    extra: { offset: number; bytes: Uint8Array }[] = []
  ): Promise<Cell[]> {
    const kept = new Map<string, Cell>();
    const visited = new Set<string>();
    // Read once, on the first cell, rather than once per cell, which would be one RPC round trip
    // per cell of every page. Only the kind and `consumable` are read off it, and neither changes
    // over a header's life (`set_append_policy` rewrites the policy alone), so one read answers for
    // all.
    let header: StructHeader | null | undefined;
    let cursor: string | undefined;
    do {
      const page = await this.rpc.getCompressedAccountsByOwner(this.programId, {
        filters: [
          { memcmp: { offset: CELL_OFFSETS.ownerId, bytes: bs58.encode(ownerId) } },
          { memcmp: { offset: CELL_OFFSETS.structId, bytes: bs58.encode(structId) } },
          ...extra.map((f) => ({ memcmp: { offset: f.offset, bytes: bs58.encode(f.bytes) } })),
        ],
        cursor,
      });
      for (const a of page.items) {
        if (a.data && a.data.data.length === CELL_LEN) {
          const address = a.address ? new PublicKey(a.address) : undefined;
          const cell = { ...this.decodeCell(a.data.data), address };
          if (header === undefined) header = (await this.getHeader(ownerId, structId))?.header ?? null;
          const expected =
            header?.kind === StructKind.Log
              ? this.logCellAddress(ownerId, structId, cell.indexOrVersion, header.consumable)
              : this.mapCellAddress(ownerId, structId, cell.keySlot);
          // Photon repeats accounts across pages: one copy per cell, the
          // later `opSeq` when a `replace_cell` landed between the pages (see `listOwnerCells`).
          if (!address || address.equals(expected)) {
            keepLatest(kept, address, cellSlot(cell, header?.kind), cell, laterCell);
          }
        }
      }
      cursor = nextCursor(page.cursor, visited);
    } while (cursor);
    return [...kept.values()].sort((a, b) => (a.opSeq < b.opSeq ? -1 : a.opSeq > b.opSeq ? 1 : 0));
  }

  decodeStructHeader(data: Buffer | Uint8Array): StructHeader {
    const d = this.program.coder.types.decode("structHeader", Buffer.from(data)) as any;
    return {
      ownerId: Uint8Array.from(d.ownerId),
      structId: Uint8Array.from(d.structId),
      kind: d.kind as StructKind,
      mode: d.mode as StructMode,
      lenOrCount: BigInt(d.lenOrCount.toString()),
      createdOpSeq: BigInt(d.createdOpSeq.toString()),
      consumable: d.consumable,
      appendPolicy: d.appendPolicy as AppendPolicy,
      policyRef: Uint8Array.from(d.policyRef),
    };
  }

  decodeCell(data: Buffer | Uint8Array): Cell {
    const d = this.program.coder.types.decode("cell", Buffer.from(data)) as any;
    return {
      ownerId: Uint8Array.from(d.ownerId),
      structId: Uint8Array.from(d.structId),
      indexOrVersion: BigInt(d.indexOrVersion.toString()),
      opSeq: BigInt(d.opSeq.toString()),
      timestamp: BigInt(d.timestamp.toString()),
      tag: d.tag,
      status: d.status,
      keySlot: Uint8Array.from(d.keySlot),
      valueSlot: Uint8Array.from(d.valueSlot),
      head: Uint8Array.from(d.head),
    };
  }

  /** The owner's state, with the authority check every cell write needs. */
  private async ownedState(
    ownerId: Bytes32
  ): Promise<{ account: CompressedAccountWithMerkleContext; state: AgentState }> {
    const found = await this.getAgentState(ownerId);
    if (!found) throw new Error(`owner ${hex(ownerId)} is not registered`);
    if (!found.state.authority.equals(this.authority.publicKey)) {
      throw new Error("client authority does not own this agent");
    }
    return found;
  }

  /** `CompressedAccountMeta` for the `i`-th input account of a proof. */
  private metaFor(
    account: CompressedAccountWithMerkleContext,
    proof: { rootIndices: number[]; proveByIndices: boolean[] },
    i: number,
    packed: PackedAccounts,
    outputStateTreeIndex: number
  ) {
    return {
      treeInfo: {
        rootIndex: proof.rootIndices[i],
        proveByIndex: proof.proveByIndices[i],
        merkleTreePubkeyIndex: packed.insertOrGet(account.treeInfo.tree),
        queuePubkeyIndex: packed.insertOrGet(account.treeInfo.queue),
        leafIndex: account.leafIndex,
      },
      address: account.address!,
      outputStateTreeIndex,
    };
  }

  private agentStateArg(state: AgentState) {
    return {
      authority: state.authority,
      agentId: Array.from(state.agentId),
      seq: new BN(state.seq.toString()),
      head: Array.from(state.head),
      createdAt: new BN(state.createdAt.toString()),
      updatedAt: new BN(state.updatedAt.toString()),
    };
  }

  private agentMetaArg(
    account: CompressedAccountWithMerkleContext,
    proof: { rootIndices: number[]; proveByIndices: boolean[] },
    merkleTreePubkeyIndex: number,
    queuePubkeyIndex: number,
    outputStateTreeIndex: number
  ) {
    return {
      treeInfo: {
        rootIndex: proof.rootIndices[0],
        proveByIndex: proof.proveByIndices[0],
        merkleTreePubkeyIndex,
        queuePubkeyIndex,
        leafIndex: account.leafIndex,
      },
      address: account.address!,
      outputStateTreeIndex,
    };
  }

  private headerArg(h: StructHeader) {
    return {
      ownerId: Array.from(h.ownerId),
      structId: Array.from(h.structId),
      kind: h.kind,
      mode: h.mode,
      lenOrCount: new BN(h.lenOrCount.toString()),
      createdOpSeq: new BN(h.createdOpSeq.toString()),
      consumable: h.consumable,
      appendPolicy: h.appendPolicy,
      policyRef: Array.from(h.policyRef),
    };
  }

  private cellArg(c: Cell) {
    return {
      ownerId: Array.from(c.ownerId),
      structId: Array.from(c.structId),
      indexOrVersion: new BN(c.indexOrVersion.toString()),
      opSeq: new BN(c.opSeq.toString()),
      timestamp: new BN(c.timestamp.toString()),
      tag: c.tag,
      status: c.status,
      keySlot: Array.from(c.keySlot),
      valueSlot: Array.from(c.valueSlot),
      head: Array.from(c.head),
    };
  }

  private cellInputArg(input: CellInput, timestamp: bigint) {
    return {
      timestamp: new BN(timestamp.toString()),
      tag: input.tag ?? 0,
      status: input.status ?? 0,
      keySlot: Array.from(input.keySlot ?? new Uint8Array(32)),
      valueSlot: Array.from(input.valueSlot ?? new Uint8Array(32)),
      allowListProof: (input.allowListProof ?? []).map((h) => Array.from(h)),
    };
  }

  protected async send(tx: anchor.web3.Transaction): Promise<string> {
    tx.feePayer = this.authority.publicKey;
    const bh = await this.rpc.getLatestBlockhash();
    tx.recentBlockhash = bh.blockhash;
    const signed = await this.authority.signTransaction(tx);
    const raw = signed.serialize();
    // The fee payer's signature is the transaction's id, and the signed bytes already fix it. Taken
    // here rather than from `sendRawTransaction`'s answer, because the send itself can fail after
    // the RPC forwarded the transaction — a gateway's 502 or 504, `fetch failed`, a dropped socket
    // — and an error with no signature on it would be rebuilt by `withRetry` on the chain the first
    // transaction had already advanced: the same record would land twice, with a second debit when
    // a charge rode along, and `createEpochCommitter` would commit the same steps at the new seq.
    if (!signed.signature) throw new Error("the transaction carries no fee-payer signature");
    const sig = bs58.encode(signed.signature);
    try {
      await this.rpc.sendRawTransaction(raw);
      // Polled, not subscribed: the server runtime confirms the same way the browser does.
      await confirmByPolling(this.rpc, sig, bh.lastValidBlockHeight);
    } catch (e) {
      // The transaction may have gone out; only what became of it is in doubt. Callers that can
      // tell from chain state or by signature whether it landed (`sendWrite`, `mutateStateOnce`,
      // `registerAgent`) read the signature off the error and return it instead of resending a
      // write that already happened. A send the node refused carries it too: that transaction
      // never reached the cluster, and asking about it costs one status read.
      if (e !== null && typeof e === "object") {
        (e as any).signature = sig;
        throw e;
      }
      throw Object.assign(new Error(String(e)), { signature: sig });
    }
    return sig;
  }

  /**
   * `send` for a write that folds into an owner's chain, with the question a lost confirmation
   * raises answered before `withRetry` ever sees it: did the transaction land anyway?
   *
   * Every appending instruction advances `AgentState` to exactly one `(seq, head)` the client
   * can compute before sending, so "landed" is a fact about the chain rather than a guess. The
   * alternative — a bare `await this.send(tx)` under `withRetry` — turns one confirmation
   * timeout into a second, identical write: a duplicate event (debited twice when a charge
   * rides in the same transaction), a duplicate cell, a second header, or, for `replace_cell`,
   * every remaining attempt spent on a cell the first attempt already nullified.
   *
   * The immediate check below is one Photon read, and a read that has not caught up with the
   * write reports "did not land". That false negative does not become a duplicate: the
   * transaction is recorded in the call's in-doubt ledger (`sent`) before the error goes back to
   * `withRetry`, and the next attempt asks `priorLanded` before it builds — which either finds
   * the write's own `(seq, head)`, rebuilds on the very state hash the write in doubt spends (so
   * at most one of them lands), or asks the cluster by signature. `withRetry` asks once more
   * before it gives up. `getAgentState` still waits for the indexer only up to the seq this
   * client has already confirmed, and deliberately not for `expectedSeq` — recording an
   * expectation a failed write will never satisfy would make every later read of this chain wait
   * out `indexerWaitMs`.
   *
   * `from` is the state the write was built on and `result` the value the call returns for it,
   * built before the send; both go into the ledger entry.
   */
  protected async sendWrite<T>(
    tx: anchor.web3.Transaction,
    agentId: Bytes32,
    from: ChainPoint,
    expectedSeq: bigint,
    expectedHead: Bytes32,
    sent: InDoubt<T>[],
    result: (signature: string) => T
  ): Promise<string> {
    try {
      return await this.send(tx);
    } catch (e) {
      const signature = (e as any)?.signature as string | undefined;
      if (!signature) throw e;
      // Recorded before the landed read, so a read that itself fails cannot lose the entry.
      sent.push({
        agentId,
        from: { seq: from.seq, head: from.head },
        to: { seq: expectedSeq, head: expectedHead },
        signature,
        result,
      });
      const landed = await this.landed(agentId, expectedSeq, expectedHead).catch(() => false);
      // The state shows this write's `(seq, head)`, which an earlier attempt of the same call
      // leads to as well: the rebuild that a lagging indexer let through and the node refused
      // over a spent state hash is in the ledger too, and it is not the one that landed.
      if (landed) {
        const to = (s: InDoubt<T>) =>
          s.to.seq === expectedSeq && Buffer.from(s.to.head).equals(Buffer.from(expectedHead));
        return (await this.whichLanded(sent.filter(to))).signature;
      }
      throw e;
    }
  }

  /**
   * Of several in-doubt writes that all lead to the `(seq, head)` the chain now shows, the one the
   * cluster confirms. The state proves one of them landed and cannot say which: two attempts built
   * on the same state with the same input fold to the same head.
   *
   * A confirmed or finalized status is the answer. Failing that, any status without an error is: the
   * attempts spend the same state hash, so at most one of them can have executed, and a node that
   * has seen one execute — even only `processed`, the indexer having run ahead of the status — has
   * seen the one that landed. Answering the earliest there instead could name a signature that
   * was dropped or failed. Only when the statuses cannot be read at all, or name none of them, is
   * the earliest answered, which is the one a lost confirmation leaves behind.
   */
  private async whichLanded<T>(matches: InDoubt<T>[]): Promise<InDoubt<T>> {
    if (matches.length === 1) return matches[0];
    const statuses = await this.statusesOf(matches).catch(() => undefined);
    if (!statuses) return matches[0];
    const confirmed = statuses.findIndex(settledStatus);
    if (confirmed >= 0) return matches[confirmed];
    const seen = statuses.findIndex((s) => !!s && !s.err);
    return seen >= 0 ? matches[seen] : matches[0];
  }

  /**
   * After a send whose confirmation failed: did the write land anyway? True when the owner's
   * state now shows exactly the seq and head this write would have produced. A resend of a
   * landed `log_event` would append a duplicate record and, with a charge in the same
   * transaction, debit the user twice. A resend of a landed `commit_epoch` fails the seq guard
   * or spends a gone state hash, and without `priorLanded` `createEpochCommitter` would then
   * rebuild it at the new seq and commit the same steps twice.
   */
  private async landed(agentId: Bytes32, expectedSeq: bigint, expectedHead: Bytes32): Promise<boolean> {
    const after = await this.getAgentState(agentId);
    if (!after) return false;
    return after.state.seq === expectedSeq && Buffer.from(after.state.head).equals(Buffer.from(expectedHead));
  }
}
