/**
 * Base data structures (SPEC.md §12).
 *
 * Two structures, one cell layout:
 *
 * - **`Log`** — index-addressed, append-only. Cells live at
 *   `["log", owner_address, struct_id, index_le]`; the header holds the length.
 * - **`Map`** — key-addressed, mutable. Cells live at
 *   `["map", owner_address, struct_id, key_slot]`; `put` fails if the address exists, which is
 *   the non-membership proof a `Set` is built on.
 *
 * Every structure is seeded by the **owner's header address**, not its id: ids are arbitrary
 * 32-byte values anyone can pick, addresses are derived by the program, so a structure cannot be
 * squatted under another owner's id. The seed comes from `agentAddress()`.
 *
 * Every write folds into the owner's one hash chain (SPEC §12 #6) and consumes one value of
 * `AgentState.seq`, which is therefore the owner's **operation counter** across events and
 * cells alike — dense, so a replay can order writes from different structures against each
 * other and a gap is still detectable.
 */
import { PublicKey } from "@solana/web3.js";
import { deriveAddressSeedV2, deriveAddressV2 } from "@lightprotocol/stateless.js";
import { Bytes32, sha256, u16le, u64le, utf8 } from "./hash";

const HEADER_SEED = utf8("hdr");
const LOG_SEED = utf8("log");
/** Cells of a consumable `Log` — a queue or mailbox. */
const CONSUMABLE_LOG_SEED = utf8("qlog");
const MAP_SEED = utf8("map");

/** Mirrors `struct_kind` in the program. */
export enum StructKind {
  Log = 0,
  Map = 1,
}

/** Mirrors `struct_mode`. Content-only: existence, count and timing are public either way. */
export enum StructMode {
  Public = 0,
  Private = 1,
}

/** Mirrors `append_policy`. Replacing and closing are always owner-only. */
export enum AppendPolicy {
  OwnerOnly = 0,
  AllowList = 1,
  Anyone = 2,
}

/**
 * Mirrors `cell_op`: the byte folded into the chain, so ops with equal bytes differ. `4` is the
 * program's `EPOCH`, which no cell fold uses — an epoch is domain-separated by its tag
 * (`computeEpochHead`) — so the policy rewrite takes `5`.
 */
export enum CellOp {
  CreateStruct = 0,
  Create = 1,
  Replace = 2,
  Close = 3,
  /** `set_append_policy`: a header's policy rewritten by its owner. Folded over the header, not a cell. */
  SetAppendPolicy = 5,
}

/** Borsh length of a `Cell`'s data, used to tell cells from other accounts in a page. */
export const CELL_LEN = 187;
/** Borsh length of a `StructHeader`'s data. */
export const STRUCT_HEADER_LEN = 116;

/**
 * Byte offsets into a cell — **ABI**. Photon `memcmp` at these offsets is the only way to
 * enumerate cells (SPEC §12 #4).
 */
export const CELL_OFFSETS = {
  ownerId: 0,
  structId: 32,
  indexOrVersion: 64,
  opSeq: 72,
  timestamp: 80,
  tag: 88,
  status: 89,
  keySlot: 91,
  valueSlot: 123,
  head: 155,
} as const;

export interface StructHeader {
  ownerId: Bytes32;
  structId: Bytes32;
  kind: StructKind;
  mode: StructMode;
  /**
   * `Log`: the next index, i.e. the length. `Map`: how many `put`s it has seen — creates, not
   * live cells, since a close touches no header. Count live cells with `listCells`.
   */
  lenOrCount: bigint;
  /** The owner's `op_seq` at creation — where this structure sits in the owner's chain. */
  createdOpSeq: bigint;
  consumable: boolean;
  appendPolicy: AppendPolicy;
  /**
   * `sha256(map_secret)` in private mode, or the allow-list Merkle root under `AllowList`.
   * One slot rather than two: `create_cell`'s SBF stack frame is the binding constraint.
   */
  policyRef: Bytes32;
  /** Address the header was read from; absent when the header was built locally. */
  address?: PublicKey;
}

export interface Cell {
  ownerId: Bytes32;
  structId: Bytes32;
  indexOrVersion: bigint;
  opSeq: bigint;
  timestamp: bigint;
  tag: number;
  status: number;
  keySlot: Bytes32;
  /** 32 bytes: the raw value in public mode, `sha256(salt ‖ value)` in private. */
  valueSlot: Uint8Array;
  head: Bytes32;
  address?: PublicKey;
}

/** What a caller supplies; the program derives everything else. */
export interface CellInput {
  timestamp?: bigint | number;
  tag?: number;
  status?: number;
  keySlot?: Bytes32;
  valueSlot?: Uint8Array;
  /** `AllowList` policy: sibling hashes from `sha256(signer)` up to `allowListRoot`. */
  allowListProof?: Bytes32[];
}

export interface CreateStructParams {
  structId: Bytes32;
  kind: StructKind;
  mode?: StructMode;
  /** `Log` only: may its cells be closed? A mailbox is consumable; an audit log is not. */
  consumable?: boolean;
  appendPolicy?: AppendPolicy;
  /** `sha256(map_secret)` in private mode, or the allow-list root under `AllowList`. */
  policyRef?: Bytes32;
  createdAt?: bigint | number;
}

const ZERO32 = new Uint8Array(32);

/** Pads a value into the fixed 32-byte `value_slot`. Anything larger is committed by hash. */
export function valueSlot(v: Uint8Array | string = new Uint8Array(0)): Uint8Array {
  const bytes = typeof v === "string" ? utf8(v) : v;
  if (bytes.length > 32) throw new Error(`value_slot holds 32 bytes, got ${bytes.length}; commit by hash instead`);
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

/** `sha256(salt ‖ value)` in the value slot — the private-mode commitment. */
export function commitment(salt: Bytes32, value: Uint8Array | string): Uint8Array {
  return valueSlot(sha256(salt, typeof value === "string" ? utf8(value) : value));
}

/** Public-mode Map key slot: anyone who knows the key can check membership. */
export function publicKeySlot(key: Uint8Array | string): Bytes32 {
  return sha256(typeof key === "string" ? utf8(key) : key);
}

/** Private-mode Map key slot: only holders of `mapSecret` can derive the address. */
export function privateKeySlot(mapSecret: Uint8Array, key: Uint8Array | string): Bytes32 {
  return sha256(mapSecret, typeof key === "string" ? utf8(key) : key);
}

/** Address of a structure header, given the owner's own header address. */
export function headerAddress(
  ownerAddress: PublicKey,
  structId: Bytes32,
  addressTree: PublicKey,
  programId: PublicKey
): PublicKey {
  return deriveAddressV2(deriveAddressSeedV2([HEADER_SEED, ownerAddress.toBytes(), structId]), addressTree, programId);
}

/**
 * A `Log` cell's address. Consumable Logs — queues and mailboxes — live under their own seed,
 * so `close_cell` can tell from the address alone that a cell may be closed and needs no header
 * account to check it.
 */
export function logCellAddress(
  ownerAddress: PublicKey,
  structId: Bytes32,
  index: bigint | number,
  addressTree: PublicKey,
  programId: PublicKey,
  consumable = false
): PublicKey {
  return deriveAddressV2(
    deriveAddressSeedV2([consumable ? CONSUMABLE_LOG_SEED : LOG_SEED, ownerAddress.toBytes(), structId, u64le(index)]),
    addressTree,
    programId
  );
}

export function mapCellAddress(
  ownerAddress: PublicKey,
  structId: Bytes32,
  keySlot: Bytes32,
  addressTree: PublicKey,
  programId: PublicKey
): PublicKey {
  return deriveAddressV2(
    deriveAddressSeedV2([MAP_SEED, ownerAddress.toBytes(), structId, keySlot]),
    addressTree,
    programId
  );
}

/** Every cell field except `head`, in declaration order — must match Rust `cell_preimage`. */
function cellPreimage(c: Cell): Uint8Array {
  const out = new Uint8Array(155);
  out.set(c.ownerId, 0);
  out.set(c.structId, 32);
  out.set(u64le(c.indexOrVersion), 64);
  out.set(u64le(c.opSeq), 72);
  out.set(u64le(c.timestamp), 80); // i64 two's complement == u64 little-endian for ts > 0
  out[88] = c.tag;
  out.set(u16le(c.status), 89);
  out.set(c.keySlot, 91);
  out.set(c.valueSlot, 123);
  return out;
}

/**
 * `head_{n+1} = sha256(head_n ‖ struct_id ‖ op ‖ cell_bytes_without_head)`.
 * Must match Rust `next_cell_head` byte-for-byte (pinned by a vector on both sides).
 */
export function computeCellHead(prev: Bytes32, op: CellOp, c: Cell): Bytes32 {
  return sha256(prev, c.structId, Uint8Array.of(op), cellPreimage(c));
}

/**
 * The same fold for a header write, over the header's policy fields: its creation
 * (`CellOp.CreateStruct`, the default, at `createdOpSeq`) or a policy rewrite
 * (`CellOp.SetAppendPolicy`, at the rewrite's own `opSeq`, over the header as it stands after it).
 * Must match Rust `next_header_head` byte-for-byte; `lenOrCount` is not in the preimage, so a
 * header read back after cells were added still recomputes its creation fold.
 */
export function computeStructHead(
  prev: Bytes32,
  h: StructHeader,
  opSeq: bigint | number,
  op: CellOp.CreateStruct | CellOp.SetAppendPolicy = CellOp.CreateStruct
): Bytes32 {
  const out = new Uint8Array(108);
  out.set(h.ownerId, 0);
  out.set(h.structId, 32);
  out.set(u64le(opSeq), 64);
  out[72] = h.kind;
  out[73] = h.mode;
  out[74] = h.consumable ? 1 : 0;
  out[75] = h.appendPolicy;
  out.set(h.policyRef, 76);
  return sha256(prev, h.structId, Uint8Array.of(op), out);
}

/**
 * One `set_append_policy`, as its `AppendPolicySet` event carries it (`LathClient.readHistory`
 * returns them as `policies`). The header account keeps only the policy it has *now*, so the
 * policy it had before lives here and nowhere else on chain — which is why a replay needs these
 * at all: without them the structure's `CREATE_STRUCT` fold is recomputed from the rewritten
 * header and disagrees at the next recorded head.
 */
export interface AppendPolicyRewrite {
  /** The owner's counter at the rewrite: the one seq the write consumed. */
  opSeq: bigint;
  structId: Bytes32;
  /** The header's policy fields as they were before this rewrite. */
  previousPolicy: AppendPolicy;
  previousPolicyRef: Bytes32;
  /** …and as the rewrite left them. */
  appendPolicy: AppendPolicy;
  policyRef: Bytes32;
  /** The head the rewrite folded to, as the program emitted it. */
  head: Bytes32;
}

/**
 * One header write a replay recomputes: `computeStructHead(prev, header, opSeq, op)`. A creation
 * records no head anywhere (the header account has no slot for it), so it can only be folded
 * forward; a rewrite's event names the head it produced, so it is checked like a cell write.
 */
export interface HeaderFold {
  opSeq: bigint;
  op: CellOp.CreateStruct | CellOp.SetAppendPolicy;
  /** The header's bytes as the program hashed them at this write. */
  header: StructHeader;
  head?: Bytes32;
}

/**
 * Every fold a structure header contributed to its owner's chain, from the header as it reads
 * today plus the policy rewrites history holds for it: the creation at `createdOpSeq` over the
 * header as `create_struct` wrote it — the earliest rewrite's `previousPolicy` /
 * `previousPolicyRef` put back, since the account no longer shows them — then one
 * `SetAppendPolicy` fold per rewrite over the header as that rewrite left it, at its own `opSeq`.
 * With no rewrites it is exactly the creation fold over the header as read, so a structure whose
 * policy was never rewritten replays byte-for-byte as a plain creation.
 *
 * Every other header field (`kind`, `mode`, `consumable`, `createdOpSeq`, the ids) is fixed for
 * the structure's life and `lenOrCount` is not in the preimage, so the header as read supplies
 * them for every fold. Rewrites of other structures are ignored, so a caller can pass the whole
 * history. Shared by `LathClient.verifyChain`, the verification export and `scripts/verify-bundle.ts`
 * so the three cannot drift.
 */
export function headerFolds(header: StructHeader, rewrites: readonly AppendPolicyRewrite[]): HeaderFold[] {
  const own = rewrites
    .filter((r) => sameBytes(r.structId, header.structId))
    .sort((a, b) => (a.opSeq < b.opSeq ? -1 : a.opSeq > b.opSeq ? 1 : 0));
  const atCreation: StructHeader =
    own.length === 0 ? header : { ...header, appendPolicy: own[0].previousPolicy, policyRef: own[0].previousPolicyRef };
  const folds: HeaderFold[] = [{ opSeq: header.createdOpSeq, op: CellOp.CreateStruct, header: atCreation }];
  for (const r of own) {
    folds.push({
      opSeq: r.opSeq,
      op: CellOp.SetAppendPolicy,
      header: { ...header, appendPolicy: r.appendPolicy, policyRef: r.policyRef },
      head: r.head,
    });
  }
  return folds;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Sorted-pair Merkle root, matching the program's `merkle_root_of`. */
export function allowListRoot(pubkeys: PublicKey[]): Bytes32 {
  let level = pubkeys.map((p) => sha256(p.toBytes()));
  if (level.length === 0) return ZERO32;
  while (level.length > 1) {
    const next: Bytes32[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i];
      next.push(pairHash(a, b));
    }
    level = next;
  }
  return level[0];
}

/** Sibling path for one pubkey in the tree `allowListRoot` builds. */
export function allowListProof(pubkeys: PublicKey[], of: PublicKey): Bytes32[] {
  let level = pubkeys.map((p) => sha256(p.toBytes()));
  let index = pubkeys.findIndex((p) => p.equals(of));
  if (index < 0) throw new Error("pubkey is not in the allow list");
  const proof: Bytes32[] = [];
  while (level.length > 1) {
    const sibling = index % 2 === 0 ? level[index + 1] ?? level[index] : level[index - 1];
    proof.push(sibling);
    const next: Bytes32[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i], level[i + 1] ?? level[i]));
    level = next;
    index = Math.floor(index / 2);
  }
  return proof;
}

function pairHash(a: Bytes32, b: Bytes32): Bytes32 {
  return compare(a, b) <= 0 ? sha256(a, b) : sha256(b, a);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
