import { PublicKey } from "@solana/web3.js";
import { LathClient } from "./client";
import { EventRecord } from "./layout";
import { EventKind, EventPayload, hashPayload } from "./events";
import { Bytes32, hex, idFromString, toBytes32 } from "./hash";

/**
 * Cross-owner acknowledgement.
 *
 * There is no on-chain link between two agents' chains — each owner has its own chain and the
 * program never reads another owner's account (SPEC §12 #6). What ties them together is a
 * *convention*: the initiator logs an event whose `reference` names the other party, and the
 * acknowledger logs an event whose `reference` names the initiator. Both halves are ordinary
 * `EventRecord`s, so the pairing is verifiable by anyone with an indexer and no extra state.
 *
 * `reference` is the only payload field on-chain (SPEC §4.2), so the pairing binds *who*
 * unconditionally and *what* (task id, role, scope) only when the caller supplies the payload
 * material — see `PairingOptions.initiatorPayload` / `acknowledgerPayload`.
 */
interface PairingSide {
  /** `agent_id` of the chain this half must live on. */
  ownerId: Bytes32;
  kind: EventKind;
  /** Expected `reference`: the *other* party's identifier. */
  reference: Bytes32 | PublicKey;
  /** Optional `status` narrowing (membership uses it to separate join / leave / retire). */
  status?: number;
  /**
   * Client to read this half with. A client only recognises records at the addresses *it*
   * derives, so a pairing whose halves are configured differently — a different program id or
   * address tree — must read each half with the matching client. Defaults to the client passed
   * to `verifyPairing`.
   */
  client?: LathClient;
}

interface PairingOptions {
  /**
   * Payload the initiator claims to have hashed. When given, its `payloadHash` must match the
   * record — which is what upgrades the pairing from "these two referenced each other" to
   * "these two agreed on this task id, this scope, this role".
   */
  initiatorPayload?: EventPayload;
  acknowledgerPayload?: EventPayload;
  /**
   * Reject an acknowledgement that is timestamped before its initiator. Timestamps are
   * self-attested (SPEC §9) so this is a sanity check, not a proof of causality; slot time is
   * the arbiter if disputed. Default true.
   */
  requireOrder?: boolean;
}

interface PairingResult {
  ok: boolean;
  initiator?: EventRecord;
  acknowledger?: EventRecord;
  /** Every check that failed, in the order checked. Empty iff `ok`. */
  reasons: string[];
  /** True when a supplied payload was hash-checked against its record. */
  initiatorPayloadVerified: boolean;
  acknowledgerPayloadVerified: boolean;
}

function ref32(v: Bytes32 | PublicKey): Bytes32 {
  return v instanceof PublicKey ? v.toBytes() : toBytes32(v);
}

async function findSide(client: LathClient, side: PairingSide): Promise<EventRecord[]> {
  const reference = ref32(side.reference);
  const records = await (side.client ?? client).listByKind(side.ownerId, side.kind);
  return records.filter(
    (r) => hex(r.reference) === hex(reference) && (side.status === undefined || r.status === side.status)
  );
}

/**
 * Generic two-sided pairing: the earliest `initiator` record on one chain matched with the
 * earliest `acknowledger` record on the other that does not precede it.
 *
 * Only full-mode records participate — `log_event_compact` leaves no compressed account, so a
 * compact half is invisible to `memcmp` and the pairing reports it as missing. Log both halves
 * of an acknowledgement with `compact: false`.
 */
async function verifyPairing(
  client: LathClient,
  initiatorSide: PairingSide,
  acknowledgerSide: PairingSide,
  opts: PairingOptions = {}
): Promise<PairingResult> {
  const reasons: string[] = [];
  const [initiators, acknowledgers] = await Promise.all([
    findSide(client, initiatorSide),
    findSide(client, acknowledgerSide),
  ]);

  const initiator = initiators[0];
  if (!initiator) reasons.push("no matching initiating record on the initiator's chain");

  const requireOrder = opts.requireOrder ?? true;
  const acknowledger =
    initiator && requireOrder ? acknowledgers.find((a) => a.timestamp >= initiator.timestamp) : acknowledgers[0];
  if (!acknowledger) {
    reasons.push(
      acknowledgers.length > 0 && requireOrder
        ? "acknowledgement predates the initiating record"
        : "no matching acknowledging record on the acknowledger's chain"
    );
  }

  let initiatorPayloadVerified = false;
  if (initiator && opts.initiatorPayload) {
    initiatorPayloadVerified = hex(hashPayload(opts.initiatorPayload)) === hex(initiator.payloadHash);
    if (!initiatorPayloadVerified) reasons.push("initiator payload does not hash to the on-chain payload_hash");
  }
  let acknowledgerPayloadVerified = false;
  if (acknowledger && opts.acknowledgerPayload) {
    acknowledgerPayloadVerified = hex(hashPayload(opts.acknowledgerPayload)) === hex(acknowledger.payloadHash);
    if (!acknowledgerPayloadVerified) reasons.push("acknowledger payload does not hash to the on-chain payload_hash");
  }

  return {
    ok: reasons.length === 0,
    initiator,
    acknowledger,
    reasons,
    initiatorPayloadVerified,
    acknowledgerPayloadVerified,
  };
}

interface HandoffParty {
  /** The agent's `agent_id` (the chain to look on). */
  agentId: Bytes32;
  /** The agent's authority pubkey (what the other half's `reference` names). */
  authority: PublicKey;
}

interface HandoffOptions extends PairingOptions {
  /**
   * Also require a terminal `Resolution` on the delegate's chain whose `reference` is the task
   * id — the only place a task id appears on-chain (SPEC §4.2, kind 3). Default false: a
   * handoff is acknowledged at genesis, long before it resolves.
   */
  requireResolution?: boolean;
}

interface HandoffResult extends PairingResult {
  /** The delegate's terminal record for this task, when one was found. */
  resolution?: EventRecord;
}

/**
 * Verifies a delegation handoff between two agents.
 *
 * Convention: the delegating agent logs `Delegation{to_agent = delegate authority,
 * parent_task_id = taskId}`; the delegate acknowledges by logging `Genesis{caller_pubkey =
 * delegator authority, session_id = taskId}`. Neither half can be forged by the other — each
 * is signed into its own owner's hash chain — so the pair is evidence that both agents claim
 * the same handoff.
 *
 * `taskId` is bound cryptographically only when the payloads are supplied: pass
 * `initiatorPayload` / `acknowledgerPayload` (they hash-check against `payload_hash`), or
 * `requireResolution: true`, which anchors the task id through the delegate's kind-3
 * `reference`.
 */
export async function verifyHandoff(
  client: LathClient,
  from: HandoffParty,
  to: HandoffParty,
  taskId: string | Uint8Array,
  opts: HandoffOptions = {}
): Promise<HandoffResult> {
  const result = await verifyPairing(
    client,
    { ownerId: from.agentId, kind: EventKind.Delegation, reference: to.authority },
    { ownerId: to.agentId, kind: EventKind.Genesis, reference: from.authority },
    opts
  );

  const reasons = [...result.reasons];
  let resolution: EventRecord | undefined;
  if (opts.requireResolution) {
    const task = typeof taskId === "string" ? idFromString(taskId) : toBytes32(taskId);
    const resolutions = await client.listByKind(to.agentId, EventKind.Resolution);
    resolution = resolutions.find(
      (r) => hex(r.reference) === hex(task) && (!result.acknowledger || r.seq >= result.acknowledger.seq)
    );
    if (!resolution) reasons.push("delegate has no resolution for this task id");
  }

  return { ...result, resolution, reasons, ok: reasons.length === 0 };
}
