/**
 * Wire layout of everything Lath stores in a compressed account, as pure functions.
 *
 * `LathClient` is the ergonomic way to reach these, but it carries an
 * Anchor `Program`, a `Provider` and a signer — none of which a read-only page needs. A browser
 * that only wants to *decode* what an RPC returned, or to derive the address it should ask for,
 * imports from here and bundles none of that.
 *
 * The decoders are hand-rolled rather than Anchor's `coder.types.decode`, for the same reason.
 * Every account here is fixed-width Borsh in declaration order, so the offsets below are the
 * whole format — and they are already **ABI**: Photon `memcmp` is the only query language,
 * so a field cannot move without breaking every deployed query. See SPEC §4.
 */
import { PublicKey } from "@solana/web3.js";
import { deriveAddressSeedV2, deriveAddressV2 } from "@lightprotocol/stateless.js";
import { Bytes32, u64le, utf8 } from "./hash";
import { EventKind } from "./events";
import {
  AppendPolicy,
  Cell,
  CELL_LEN,
  CELL_OFFSETS,
  StructHeader,
  STRUCT_HEADER_LEN,
  StructKind,
  StructMode,
} from "./cells";

const AGENT_SEED = utf8("agent");
const EVENT_SEED = utf8("event");

export const AGENT_STATE_LEN = 120;
export const EVENT_RECORD_LEN = 147;

/**
 * Byte offsets into `AgentState` account data.
 */
export const AGENT_STATE_OFFSETS = {
  authority: 0,
  agentId: 32,
  seq: 64,
  head: 72,
  createdAt: 104,
  updatedAt: 112,
} as const;

/**
 * Byte offsets into `EventRecord` account data (SPEC §4.2). These are **ABI**: Photon `memcmp`
 * filters are the only way to query records without an index, so moving a field breaks every
 * deployed query. The layout is Borsh, fixed-width, in declaration order.
 */
export const EVENT_OFFSETS = {
  agentId: 0,
  seq: 32,
  timestamp: 40,
  kind: 48,
  status: 49,
  reference: 51,
  payloadHash: 83,
  head: 115,
} as const;

export interface AgentState {
  authority: PublicKey;
  agentId: Bytes32;
  seq: bigint;
  head: Bytes32;
  createdAt: bigint;
  updatedAt: bigint;
}

export interface EventRecord {
  agentId: Bytes32;
  seq: bigint;
  timestamp: bigint;
  kind: EventKind;
  status: number;
  reference: Bytes32;
  payloadHash: Bytes32;
  head: Bytes32;
  /**
   * The compressed account the record was read from. Present for records read as accounts,
   * absent for ones reconstructed from transaction history. It is what makes a record
   * *attributable*: `agent_id` is a field anyone can write, the address is not.
   */
  address?: PublicKey;
}

// -------------------------------------------------------------------------------------------
// Addresses
// -------------------------------------------------------------------------------------------

export function agentAddress(agentId: Bytes32, addressTree: PublicKey, programId: PublicKey): PublicKey {
  return deriveAddressV2(deriveAddressSeedV2([AGENT_SEED, agentId]), addressTree, programId);
}

export function eventAddress(
  agentId: Bytes32,
  seq: bigint | number,
  addressTree: PublicKey,
  programId: PublicKey
): PublicKey {
  return deriveAddressV2(deriveAddressSeedV2([EVENT_SEED, agentId, u64le(seq)]), addressTree, programId);
}

/**
 * An owner's header address. Every owner is an agent, so this is `agentAddress` under the name
 * the reads use — kept because a caller that has an owner id and wants its header should not
 * have to know that the two words mean the same thing.
 */
export function ownerAddress(ownerId: Bytes32, addressTree: PublicKey, programId: PublicKey): PublicKey {
  return agentAddress(ownerId, addressTree, programId);
}

// -------------------------------------------------------------------------------------------
// Decoders
// -------------------------------------------------------------------------------------------

/**
 * A little-endian reader over account data. Node hands back a `Buffer` and a browser a plain
 * `Uint8Array`; a `Buffer` *is* a `Uint8Array`, so one `DataView` covers both and the SDK need
 * not assume a `Buffer` polyfill exists.
 */
class Reader {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array, expected: number, what: string) {
    if (bytes.length !== expected) throw new Error(`${what} is ${expected} bytes, got ${bytes.length}`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u64(offset: number): bigint {
    return this.view.getBigUint64(offset, true);
  }

  i64(offset: number): bigint {
    return this.view.getBigInt64(offset, true);
  }

  u16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }

  bytes32(offset: number): Bytes32 {
    return this.bytes.slice(offset, offset + 32);
  }

  pubkey(offset: number): PublicKey {
    return new PublicKey(this.bytes32(offset));
  }
}

export function decodeAgentState(data: Uint8Array): AgentState {
  const r = new Reader(data, AGENT_STATE_LEN, "AgentState");
  const o = AGENT_STATE_OFFSETS;
  return {
    authority: r.pubkey(o.authority),
    agentId: r.bytes32(o.agentId),
    seq: r.u64(o.seq),
    head: r.bytes32(o.head),
    createdAt: r.i64(o.createdAt),
    updatedAt: r.i64(o.updatedAt),
  };
}

export function decodeEventRecord(data: Uint8Array): EventRecord {
  const r = new Reader(data, EVENT_RECORD_LEN, "EventRecord");
  const o = EVENT_OFFSETS;
  return {
    agentId: r.bytes32(o.agentId),
    seq: r.u64(o.seq),
    timestamp: r.i64(o.timestamp),
    kind: r.u8(o.kind) as EventKind,
    status: r.u16(o.status),
    reference: r.bytes32(o.reference),
    payloadHash: r.bytes32(o.payloadHash),
    head: r.bytes32(o.head),
  };
}

export function decodeStructHeader(data: Uint8Array): StructHeader {
  const r = new Reader(data, STRUCT_HEADER_LEN, "StructHeader");
  return {
    ownerId: r.bytes32(0),
    structId: r.bytes32(32),
    kind: r.u8(64) as StructKind,
    mode: r.u8(65) as StructMode,
    lenOrCount: r.u64(66),
    createdOpSeq: r.u64(74),
    consumable: r.u8(82) !== 0,
    appendPolicy: r.u8(83) as AppendPolicy,
    policyRef: r.bytes32(84),
  };
}

export function decodeCell(data: Uint8Array): Cell {
  const r = new Reader(data, CELL_LEN, "Cell");
  const o = CELL_OFFSETS;
  return {
    ownerId: r.bytes32(o.ownerId),
    structId: r.bytes32(o.structId),
    indexOrVersion: r.u64(o.indexOrVersion),
    opSeq: r.u64(o.opSeq),
    timestamp: r.i64(o.timestamp),
    tag: r.u8(o.tag),
    status: r.u16(o.status),
    keySlot: r.bytes32(o.keySlot),
    valueSlot: r.bytes32(o.valueSlot),
    head: r.bytes32(o.head),
  };
}

// -------------------------------------------------------------------------------------------
// Billing (`lath-billing`) — ordinary Solana accounts, same fixed-width Borsh treatment
// -------------------------------------------------------------------------------------------
//
// These are here rather than in `billing.ts` for the same reason as the decoders above: reading
// a balance is the one thing every page does, and it should not drag Anchor's `Program`,
// `Provider` and coder into a browser bundle. All amounts are micro-USDC.

const TREASURY_SEED = utf8("treasury");
const VAULT_SEED = utf8("vault");
const BALANCE_SEED = utf8("balance");
const ALLOWANCE_SEED = utf8("allow");

/** USDC has 6 decimals, so one micro-USDC is one native token unit. */
export const USDC_DECIMALS = 6;

/** Anchor prefixes every account with an 8-byte discriminator. */
const DISCRIMINATOR_LEN = 8;

const TREASURY_LEN = 226;
export const USER_BALANCE_LEN = 73;
export const ALLOWANCE_LEN = 137;

/**
 * `Allowance` without its appended `reserved` field. An older grant is this size until
 * `migrate_allowance` grows it, and it decodes as a grant holding nothing — which is what a grant
 * with no field to record a hold in holds.
 */
export const ALLOWANCE_LEGACY_LEN = 129;

/** Offsets past the discriminator, for `getProgramAccounts` memcmp filters. */
export const ALLOWANCE_OFFSETS = {
  user: 8,
  agentAuthority: 40,
  cap: 72,
  spent: 80,
  expiresAt: 88,
  policyVersionHash: 96,
  bump: 128,
  /** Appended after `bump`, because every offset above it is already ABI. */
  reserved: 129,
} as const;

const USER_BALANCE_OFFSETS = {
  user: 8,
  deposited: 40,
  spent: 48,
  reserved: 56,
  nonce: 64,
  bump: 72,
} as const;

export interface Treasury {
  admin: PublicKey;
  usdcMint: PublicKey;
  vault: PublicKey;
  sweepDestination: PublicKey;
  sweeper: PublicKey;
  totalDeposited: bigint;
  totalSpent: bigint;
  totalSwept: bigint;
  maxSweepPerCall: bigint;
  maxSweepPerDay: bigint;
  sweptToday: bigint;
  dayStart: bigint;
}

export interface UserBalance {
  user: PublicKey;
  deposited: bigint;
  spent: bigint;
  reserved: bigint;
  nonce: bigint;
}

export interface Allowance {
  user: PublicKey;
  agentAuthority: PublicKey;
  cap: bigint;
  spent: bigint;
  expiresAt: bigint;
  policyVersionHash: Bytes32;
  /** Held by this agent's live sessions: `cap` bounds `spent + reserved`, not `spent` alone. */
  reserved: bigint;
  /** True for an older 129-byte grant that `migrate_allowance` has not grown yet. */
  legacy: boolean;
}

/**
 * Treasuries are namespaced by their admin, and every balance, allowance and vault hangs off
 * the treasury PDA — so a client that is not the admin must say which treasury it means.
 */
export function treasuryAddress(admin: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TREASURY_SEED, admin.toBytes()], programId)[0];
}

export function vaultAddress(treasury: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, treasury.toBytes()], programId)[0];
}

export function balanceAddress(treasury: PublicKey, user: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([BALANCE_SEED, treasury.toBytes(), user.toBytes()], programId)[0];
}

export function allowanceAddress(
  treasury: PublicKey,
  user: PublicKey,
  agentAuthority: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ALLOWANCE_SEED, treasury.toBytes(), user.toBytes(), agentAuthority.toBytes()],
    programId
  )[0];
}

export function decodeTreasury(data: Uint8Array): Treasury {
  const r = new Reader(data, TREASURY_LEN, "Treasury");
  return {
    admin: r.pubkey(8),
    usdcMint: r.pubkey(40),
    vault: r.pubkey(72),
    sweepDestination: r.pubkey(104),
    sweeper: r.pubkey(136),
    totalDeposited: r.u64(168),
    totalSpent: r.u64(176),
    totalSwept: r.u64(184),
    maxSweepPerCall: r.u64(192),
    maxSweepPerDay: r.u64(200),
    sweptToday: r.u64(208),
    dayStart: r.i64(216),
  };
}

export function decodeUserBalance(data: Uint8Array): UserBalance {
  const r = new Reader(data, USER_BALANCE_LEN, "UserBalance");
  const o = USER_BALANCE_OFFSETS;
  return {
    user: r.pubkey(o.user),
    deposited: r.u64(o.deposited),
    spent: r.u64(o.spent),
    reserved: r.u64(o.reserved),
    nonce: r.u64(o.nonce),
  };
}

/**
 * Both sizes decode: the field is appended, so an older grant without it is the same bytes with
 * the tail missing, and a missing tail is a hold of zero. Anchor's own deserialisation is
 * exact, which is why the program cannot be that forgiving and `migrate_allowance` exists.
 */
export function decodeAllowance(data: Uint8Array): Allowance {
  const legacy = data.length === ALLOWANCE_LEGACY_LEN;
  const r = new Reader(data, legacy ? ALLOWANCE_LEGACY_LEN : ALLOWANCE_LEN, "Allowance");
  const o = ALLOWANCE_OFFSETS;
  return {
    user: r.pubkey(o.user),
    agentAuthority: r.pubkey(o.agentAuthority),
    cap: r.u64(o.cap),
    spent: r.u64(o.spent),
    expiresAt: r.i64(o.expiresAt),
    policyVersionHash: r.bytes32(o.policyVersionHash),
    reserved: legacy ? 0n : r.u64(o.reserved),
    legacy,
  };
}

/** `deposited − spent − reserved`: what a charge or a hold may draw on. */
export function spendableOf(balance: UserBalance | null): bigint {
  return balance ? balance.deposited - balance.spent - balance.reserved : 0n;
}
