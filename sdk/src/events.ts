import { PublicKey } from "@solana/web3.js";
import { Bytes32, i64le, sha256, toBytes32, u16le, u32le, u64le, utf8, idFromString, ZERO32 } from "./hash";

/** The four minimal event primitives. Mirrors `kind::*` in the program. */
export enum EventKind {
  Genesis = 0,
  Action = 1,
  Delegation = 2,
  Resolution = 3,
}

export enum ResolutionStatus {
  Success = 0,
  Failed = 1,
  Aborted = 2,
}

/** Genesis / task assignment: proves what prompted the agent and who authorized it. */
interface GenesisPayload {
  kind: EventKind.Genesis;
  sessionId: string | Uint8Array;
  callerPubkey: PublicKey | string | Uint8Array;
  policyVersionHash: Uint8Array | string;
  inputPayloadHash: Uint8Array | string;
}

/** External side-effect / tool mutation: every state-altering boundary cross. */
export interface ActionPayload {
  kind: EventKind.Action;
  toolId: string;
  argsHash: Uint8Array | string;
  resultHash: Uint8Array | string;
  statusCode: number; // u16, e.g. 200 / 500
}

/** Delegation / handshake between agents: chain of custody. */
export interface DelegationPayload {
  kind: EventKind.Delegation;
  parentTaskId: string | Uint8Array;
  fromAgentPubkey: PublicKey | string | Uint8Array;
  toAgentPubkey: PublicKey | string | Uint8Array;
  scopeHash: Uint8Array | string;
}

/** Terminal resolution: closes the task lifecycle. */
interface ResolutionPayload {
  kind: EventKind.Resolution;
  taskId: string | Uint8Array;
  status: ResolutionStatus;
  finalOutputHash: Uint8Array | string;
  totalStepCount: number; // u32
}

export type EventPayload = GenesisPayload | ActionPayload | DelegationPayload | ResolutionPayload;

/** What actually gets sent on-chain (mirrors `EventInput` in the program). */
export interface EventInput {
  timestamp: bigint; // unix ms
  kind: EventKind;
  status: number; // u16
  reference: Bytes32;
  payloadHash: Bytes32;
}

function id32(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? idFromString(v) : toBytes32(v);
}

/**
 * Canonical byte encoding of a typed payload. Fixed-width, little-endian, field order as
 * declared. `payloadHash = sha256(kind || encoding)`. Anyone holding the payload can
 * recompute it without the SDK.
 */
export function encodePayload(p: EventPayload): Uint8Array {
  switch (p.kind) {
    case EventKind.Genesis:
      return concat(
        id32(p.sessionId),
        toBytes32(p.callerPubkey),
        toBytes32(p.policyVersionHash),
        toBytes32(p.inputPayloadHash)
      );
    case EventKind.Action:
      return concat(idFromString(p.toolId), toBytes32(p.argsHash), toBytes32(p.resultHash), u16le(p.statusCode));
    case EventKind.Delegation:
      return concat(
        id32(p.parentTaskId),
        toBytes32(p.fromAgentPubkey),
        toBytes32(p.toAgentPubkey),
        toBytes32(p.scopeHash)
      );
    case EventKind.Resolution:
      return concat(id32(p.taskId), new Uint8Array([p.status]), toBytes32(p.finalOutputHash), u32le(p.totalStepCount));
  }
}

/**
 * The exact bytes `payload_hash` commits to: `kind ‖ encodePayload(p)`.
 *
 * One definition, because two would be a silent way to produce traces nobody can find — a store
 * keyed on the encoding alone hashes to something that is not the `payload_hash` on chain, and
 * nothing complains. `AgentLogger.storePayloads` and `AgentRuntime` both put *this*.
 */
export function payloadPreimage(p: EventPayload): Uint8Array {
  return concat(new Uint8Array([p.kind]), encodePayload(p));
}

export function hashPayload(p: EventPayload): Bytes32 {
  return sha256(payloadPreimage(p));
}

/** The indexable 32-byte `reference` field, chosen per kind so Photon memcmp queries work. */
function referenceOf(p: EventPayload): Bytes32 {
  switch (p.kind) {
    case EventKind.Genesis:
      return toBytes32(p.callerPubkey);
    case EventKind.Action:
      return idFromString(p.toolId);
    case EventKind.Delegation:
      return toBytes32(p.toAgentPubkey);
    case EventKind.Resolution:
      return id32(p.taskId);
  }
}

function statusOf(p: EventPayload): number {
  switch (p.kind) {
    case EventKind.Action:
      if (p.statusCode < 0 || p.statusCode > 0xffff) throw new Error("statusCode must fit u16");
      return p.statusCode;
    case EventKind.Resolution:
      return p.status;
    default:
      return 0;
  }
}

export function toEventInput(p: EventPayload, timestamp: bigint | number = Date.now()): EventInput {
  return {
    timestamp: BigInt(timestamp),
    kind: p.kind,
    status: statusOf(p),
    reference: referenceOf(p),
    payloadHash: hashPayload(p),
  };
}

/**
 * Chain step. Must match `next_head` in the program byte-for-byte:
 * sha256(prev || agent_id || seq_le || ts_le || kind || status_le || reference || payload_hash)
 */
export function computeHead(prev: Bytes32, agentId: Bytes32, seq: bigint | number, e: EventInput): Bytes32 {
  return sha256(
    prev,
    agentId,
    u64le(seq),
    i64le(e.timestamp),
    new Uint8Array([e.kind]),
    u16le(e.status),
    e.reference,
    e.payloadHash
  );
}

export const GENESIS_HEAD: Bytes32 = ZERO32;

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export { utf8 };
