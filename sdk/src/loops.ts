/**
 * Loops, read side: what a scheduled agent writes per step, and how anyone with an RPC checks it.
 *
 * A loop is an agent that keeps running. `LoopRunner` (`runtime/src/loop.ts`) steps it on a
 * schedule, runs one ordinary session per step — one genesis, its steps batched into one epoch,
 * one resolution — and then appends a single full-mode `Action` with `tool_id = "loop.step"`:
 *
 * ```text
 * args_hash   = sha256(manifest)                       // {loopId, step, intervalMs, maxSteps, promptHash, startedAt, memoryHash?}
 * result_hash = sha256(agent_id ‖ seq_le ‖ head)       // `loopStepLeaf`
 * status      = 200 success · 201 goal reached · 499 aborted · 500 failed
 * ```
 *
 * The leaf commits to the chain **as it stood immediately before this record**: `seq` is the seq
 * the step record itself occupies (equivalently, `AgentState.seq` when the leaf was built), and
 * `head` is the head produced by the write at `seq - 1` — the step's own resolution. So a reader
 * needs no trace store to know what the leaf *should* be: `listByTool(agentId, "loop.step")`
 * gives the records, the chain gives the head at each seq, and `loopStepLeaf` gives the leaf.
 *
 * Two ways to check that the record really commits to that leaf, neither of which trusts anyone:
 *
 * - **with the manifest** (what the console has, from its own loop registry): rebuild
 *   `args_hash` from the manifest, take `result_hash` to be the expected leaf, re-derive the
 *   record's `payload_hash` and compare it to the chain's. A manifest that has been altered, or
 *   a leaf that is not the one committed, produces a different `payload_hash`.
 * - **with a trace store**: fetch the payload preimage under `payload_hash`, read `args_hash`
 *   and `result_hash` out of it at the fixed offsets (`audit.ts`, `subHashes`), and compare.
 *   `LoopRunner` stores the leaf preimage — the 72 bytes `agent_id ‖ seq_le ‖ head` — under the
 *   leaf itself, so `lath-audit` walking `result_hash` finds bytes rather than a dead end.
 *
 * Nothing here reaches for a Node built-in, so it ships in the browser entry.
 */
import { LathClient } from "./client";
import { EventKind, hashPayload } from "./events";
import { Bytes32, hex, idFromString, sha256, toBytes32, u64le, utf8 } from "./hash";
import { EventRecord } from "./layout";
import { recordFieldsOf, subHashes } from "./audit/core";
import { type LoopMemberCommit, type LoopMemberOutcome } from "./team";
import { type TraceStore } from "./trace-store";

// The goal half of a loop is pure string work and ships in the browser entry on its own
// (`goal.ts`); it is re-exported here so a reader who has the manifest has the parser too. The
// team half (`team.ts`) is here for the same reason: the manifest's eleventh key is a list of
// `LoopMemberCommit`, so a reader who has the manifest has the type with it.
export * from "./goal";
export * from "./team";

/** `tool_id` of the one record a step appends. */
export const LOOP_STEP_TOOL = "loop.step";

/** `status` on a `loop.step` action — the step's session outcome, kept where a `memcmp` can see it. */
export enum LoopStepStatus {
  Success = 200,
  /**
   * The step succeeded *and* said the loop's goal was reached: its
   * answer's last non-empty line was `GOAL REACHED`, and the loop stopped after this record.
   * A distinct code rather than the stop reason alone because the stop reason is the server's
   * state and `status` is a record field folded into the head (SPEC §4.4) — so a reader with an
   * RPC and nothing else sees that this loop ended because it got there, not because it ran out
   * of steps. The SDK derives it from the payload, but the program does not bind it to
   * `payload_hash`: a chain-only read is the record's word, and `lath-audit` cross-checks it
   * against the preimage whenever it holds one.
   */
  GoalReached = 201,
  /** The step hit its per-step budget or the session step ceiling. */
  Aborted = 499,
  /** The step's session resolved `failed`, or the session never resolved at all. */
  Failed = 500,
}

/**
 * What `args_hash` commits to. Everything in it is fixed for the life of a loop except `step`,
 * so a reader who knows the loop can rebuild any step's manifest from its index alone — which
 * is what makes the manifest path below a check rather than a lookup.
 */
export interface LoopStepManifest {
  loopId: string;
  /** 1-based index of this step. */
  step: number;
  /** Scheduled gap between steps, ms. */
  intervalMs: number;
  maxSteps: number;
  /** `sha256(prompt)` in hex — the standing instruction, committed without publishing it. */
  promptHash: string;
  /** Unix ms the loop was created. */
  startedAt: number;
  /**
   * `sha256(memory)` in hex — the memory this step ended with, which is what the next step is
   * told. The bytes live in the trace store under this hash. Absent on a step that had no
   * memory to carry (the first step of a loop that produced none, or an older step whose manifest
   * has no memory key), and equal to the previous step's when this step produced nothing new.
   */
  memoryHash?: string;
  /**
   * Base58 address of the oracle `Request` this step was woken by, so the chain says which
   * request woke which step. The eighth key, written only on a step a request triggered: a
   * schedule-driven step's manifest is the seven-key one. Request triggers are on the roadmap and
   * this build writes no such step; the key is decoded so a manifest that carries one still rebuilds.
   */
  requestAddress?: string;
  /**
   * `sha256` of the decision blob a second model's verdict on this step was written to, hex. The
   * ninth key, written only on a step a verifier answered for: a loop with no verify, and a verify
   * the endpoint could not answer, write the manifest without it, so the chain says *not verified*
   * rather than saying nothing.
   */
  verifyHash?: string;
  /**
   * `sha256(goal)` in hex (`goalHash` in `goal.ts`) — what this loop is working toward,
   * committed without publishing it. The tenth key, written only on a loop that has a goal, so
   * a loop without one hashes without it. Because `args_hash` commits to it,
   * a console that misreported the goal cannot rebuild a step's `payload_hash`.
   */
  goalHash?: string;
  /**
   * What each member of the loop's team did with the task this step gave it, in roster order. The
   * eleventh key, written only on a step that opened at least one delegation, so a loop that runs
   * one agent hashes without it. Teams are on the roadmap: this build writes no such step, and
   * decodes the key so a manifest that carries one still rebuilds.
   *
   * The roster itself is not here; it is in the step's `policy_version_hash`. What this commits
   * is stronger: each member's own chain state when the step closed, so *these agents did this
   * step's work* is a claim anyone with an RPC can check (this build does not check it).
   *
   * What a second model made of each answer, and which `choice` routed a task addressed to
   * nobody, are committed **inside** the member object as its sixth and seventh keys and not as a
   * twelfth key here — so a member object that carries neither rebuilds exactly the bytes it
   * committed.
   *
   * So is each member's own replay record, as the member object's eighth key: members run in
   * sandboxes of their own, and the thirteenth key below names session A's record only.
   */
  members?: LoopMemberCommit[];
  /**
   * `sha256` of the gate log this step closed, hex: what a gated loop's second model was asked
   * between the last step and this one, and why this step woke. The twelfth key, emitted on every
   * step of a gated loop whatever woke it and on no other, so an ungated step hashes without it.
   * Gated loops are on the roadmap: this build writes no such step and does not decode the log.
   */
  gateHash?: string;
  /**
   * `sha256` of the step's replay record (`replayRecordBytes` in `runtime/src/zeroclaw/replay.ts`),
   * hex: the binary, the posture, the message, the clock, the workspace before and after, and the
   * step's call seqs — everything a sandboxed step ran on except the model's replies, which the
   * `llm.*` Actions already commit. The thirteenth key, emitted only on a step that ran in the
   * sandbox, as every loop step does: an older in-process step has no replay record to commit (its
   * tools ran in the operator's process, where nobody can reconstruct them), so its manifest has no
   * such key and keeps its bytes. A replay record cannot be backfilled.
   */
  replayHash?: string;
  /**
   * `sha256` of the goal-check blob, hex: what Jev said about whether the goal is reached, on a
   * goal loop whose owner turned the check on and which has **no** verify seat. The fourteenth key,
   * emitted only on such a step and only when Jev answered. A loop with the verify seat carries the
   * goal answer inside the blob `verifyHash` already names, one call and one blob, so it never
   * writes this key; a loop without the check, or a check Jev could not answer, writes the manifest
   * without it.
   */
  goalCheckHash?: string;
  /**
   * `sha256` of the step's Tempo carry blob (`TempoCarry` in `runtime/src/loop-tempo.ts`), hex:
   * the `storage.put` Actions written since the last leaf that carried one, each with the hash of
   * its receipt blob — the payment, which no Action hash can name because it comes back after the
   * request fixed them. The fifteenth key, emitted only on a step of a loop whose host pays Tempo's
   * own services and only when there is something to carry, so a step of a loop without a
   * treasury, or with nothing to carry, hashes without it.
   */
  tempoHash?: string;
  /**
   * `sha256` of the step's trace-audit blob, hex: what the trace reader said about how the step got
   * to its output, and, on a vetoed step, the confirm call's verdict. The sixteenth key, emitted
   * only on a step of a loop whose policy has `traceAudit` and only when the model answered, so a
   * loop with the audit off hashes without it. The trace audit is on the roadmap: this build writes
   * no such step and does not decode the blob.
   */
  traceAuditHash?: string;
  /**
   * `sha256` of the step's protocol-plugin record, hex: every proposal the step's output ended in,
   * each rule verdict, decision and outcome, refusals and holds included. The **eighteenth** key —
   * the seventeenth, `benchHash`, is reserved and is emitted before it when it lands — and the
   * last, emitted only on a step of a loop whose policy carries `grants`, so a loop without them
   * hashes without it. Grant plugins are on the roadmap: this build writes no such step and does
   * not decode the record.
   */
  pluginHash?: string;
}

/** The four outcomes, as `decodeLoopManifest` holds a member's to. */
const MEMBER_OUTCOMES: readonly LoopMemberOutcome[] = ["done", "failed", "crashed", "refused"];

/**
 * One member's commit as it is emitted and as it is accepted back: these keys in this order and
 * nothing else. Written out for the same reason the manifest's own keys are — the encoding has
 * to be legible from the type, and a field added later goes at the end.
 *
 * `verifyHash` is the sixth, `routeHash` the seventh and `replayHash` the eighth, each emitted only
 * when set, the same absent-when-unset rule the manifest's own optional keys follow: a member
 * object that carries none of them hashes to exactly the five-key JSON, and so does the whole
 * manifest around it. A member's `replayHash` is here and not a fourteenth manifest key because it
 * is one member's record, and a key per member outside the member object would have to repeat the
 * roster to say whose it is.
 */
function memberJson(c: LoopMemberCommit): Record<string, string> {
  const json: Record<string, string> = {
    agentId: c.agentId,
    taskId: c.taskId,
    outcome: c.outcome,
    seq: c.seq,
    head: c.head,
  };
  if (c.verifyHash !== undefined) json.verifyHash = c.verifyHash;
  if (c.routeHash !== undefined) json.routeHash = c.routeHash;
  if (c.replayHash !== undefined) json.replayHash = c.replayHash;
  return json;
}

/** Each field checked the way `memoryHash` is: the shape, not whether the chain agrees with it. */
function decodeMembers(value: unknown): LoopMemberCommit[] | null {
  if (!Array.isArray(value)) return null;
  const out: LoopMemberCommit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { agentId, taskId, outcome, seq, head } = entry as Record<string, unknown>;
    if (typeof agentId !== "string" || !/^[0-9a-f]{64}$/.test(agentId)) return null;
    if (typeof taskId !== "string" || taskId.length === 0) return null;
    if (typeof outcome !== "string" || !MEMBER_OUTCOMES.includes(outcome as LoopMemberOutcome)) return null;
    // A decimal string, not a number: a seq is a u64 and JSON numbers are not.
    if (typeof seq !== "string" || !/^\d+$/.test(seq)) return null;
    // An empty head is only ever the refused case — the delegation never opened, so there is no
    // chain state to name. Any other outcome claims the member's chain moved, and a claim about
    // a chain has to say where.
    if (typeof head !== "string") return null;
    if (!(/^[0-9a-f]{64}$/.test(head) || (head === "" && outcome === "refused"))) return null;
    const member: LoopMemberCommit = { agentId, taskId, outcome: outcome as LoopMemberOutcome, seq, head };
    // Both hashes are held to the shape `memoryHash` is held to and for the same reason: 64 hex
    // or absent, and anything else is a manifest this reader will not claim to have decoded.
    // Whether the bytes under them are the decision they say they are is a verification question,
    // not a decoding one, and this build does not verify members.
    // The member's `replayHash` is held to the same shape: whether a record is stored under
    // it is a fetch, not a decoding question, and a member object that carries one is otherwise
    // the object it was.
    const { verifyHash, routeHash, replayHash } = entry as Record<string, unknown>;
    for (const value of [verifyHash, routeHash, replayHash]) {
      if (value !== undefined && !(typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) return null;
    }
    if (typeof verifyHash === "string") member.verifyHash = verifyHash;
    if (typeof routeHash === "string") member.routeHash = routeHash;
    if (typeof replayHash === "string") member.replayHash = replayHash;
    out.push(member);
  }
  return out;
}

/**
 * The manifest's canonical bytes: JSON with these keys in this order. Written out rather than
 * sorted generically so the encoding is legible from the type alone and cannot drift when a
 * field is added — a new field goes at the end, and old steps keep hashing as they did.
 *
 * `memoryHash` is the seventh key, `requestAddress` the eighth, `verifyHash` the ninth,
 * `goalHash` the tenth, `members` the eleventh, `gateHash` the twelfth, `replayHash` the
 * thirteenth, `goalCheckHash` the fourteenth, `tempoHash` the fifteenth, `traceAuditHash` the
 * sixteenth and `pluginHash` the eighteenth (the seventeenth, `benchHash`, is reserved and goes
 * before it when it lands). Each is emitted only when set, so a manifest that lacks any of them —
 * down to the six-key one with no optional key at all — re-hashes exactly to the bytes it was
 * written with. So old steps still verify.
 */
export function loopManifestBytes(m: LoopStepManifest): Uint8Array {
  const json: Record<string, string | number | Record<string, string>[]> = {
    loopId: m.loopId,
    step: m.step,
    intervalMs: m.intervalMs,
    maxSteps: m.maxSteps,
    promptHash: m.promptHash,
    startedAt: m.startedAt,
  };
  if (m.memoryHash !== undefined) json.memoryHash = m.memoryHash;
  if (m.requestAddress !== undefined) json.requestAddress = m.requestAddress;
  if (m.verifyHash !== undefined) json.verifyHash = m.verifyHash;
  if (m.goalHash !== undefined) json.goalHash = m.goalHash;
  if (m.members !== undefined) json.members = m.members.map(memberJson);
  if (m.gateHash !== undefined) json.gateHash = m.gateHash;
  if (m.replayHash !== undefined) json.replayHash = m.replayHash;
  if (m.goalCheckHash !== undefined) json.goalCheckHash = m.goalCheckHash;
  if (m.tempoHash !== undefined) json.tempoHash = m.tempoHash;
  if (m.traceAuditHash !== undefined) json.traceAuditHash = m.traceAuditHash;
  if (m.pluginHash !== undefined) json.pluginHash = m.pluginHash;
  return utf8(JSON.stringify(json));
}

/** The inverse, for bytes fetched from a trace store. `null` for anything that is not a manifest. */
export function decodeLoopManifest(bytes: Uint8Array): LoopStepManifest | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return null;
    const {
      loopId,
      step,
      intervalMs,
      maxSteps,
      promptHash,
      startedAt,
      memoryHash,
      requestAddress,
      verifyHash,
      goalHash,
      members,
      gateHash,
      replayHash,
      goalCheckHash,
      tempoHash,
      traceAuditHash,
      pluginHash,
    } = parsed as Record<string, unknown>;
    if (typeof loopId !== "string" || typeof promptHash !== "string") return null;
    if (![step, intervalMs, maxSteps, startedAt].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (memoryHash !== undefined && !(typeof memoryHash === "string" && /^[0-9a-f]{64}$/.test(memoryHash))) return null;
    // A base58 address, not a hash: checked for shape only, because whether it is *the* request
    // this step answered is a chain question and not a decoding one.
    if (
      requestAddress !== undefined &&
      !(typeof requestAddress === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(requestAddress))
    ) {
      return null;
    }
    if (verifyHash !== undefined && !(typeof verifyHash === "string" && /^[0-9a-f]{64}$/.test(verifyHash))) return null;
    if (goalHash !== undefined && !(typeof goalHash === "string" && /^[0-9a-f]{64}$/.test(goalHash))) return null;
    if (gateHash !== undefined && !(typeof gateHash === "string" && /^[0-9a-f]{64}$/.test(gateHash))) return null;
    if (replayHash !== undefined && !(typeof replayHash === "string" && /^[0-9a-f]{64}$/.test(replayHash))) {
      return null;
    }
    if (goalCheckHash !== undefined && !(typeof goalCheckHash === "string" && /^[0-9a-f]{64}$/.test(goalCheckHash))) {
      return null;
    }
    if (tempoHash !== undefined && !(typeof tempoHash === "string" && /^[0-9a-f]{64}$/.test(tempoHash))) return null;
    if (
      traceAuditHash !== undefined &&
      !(typeof traceAuditHash === "string" && /^[0-9a-f]{64}$/.test(traceAuditHash))
    ) {
      return null;
    }
    if (pluginHash !== undefined && !(typeof pluginHash === "string" && /^[0-9a-f]{64}$/.test(pluginHash))) return null;
    const decodedMembers = members === undefined ? undefined : decodeMembers(members);
    if (members !== undefined && !decodedMembers) return null;
    const manifest: LoopStepManifest = {
      loopId,
      step: step as number,
      intervalMs: intervalMs as number,
      maxSteps: maxSteps as number,
      promptHash,
      startedAt: startedAt as number,
    };
    if (typeof memoryHash === "string") manifest.memoryHash = memoryHash;
    if (typeof requestAddress === "string") manifest.requestAddress = requestAddress;
    if (typeof verifyHash === "string") manifest.verifyHash = verifyHash;
    if (typeof goalHash === "string") manifest.goalHash = goalHash;
    if (decodedMembers) manifest.members = decodedMembers;
    if (typeof gateHash === "string") manifest.gateHash = gateHash;
    if (typeof replayHash === "string") manifest.replayHash = replayHash;
    if (typeof goalCheckHash === "string") manifest.goalCheckHash = goalCheckHash;
    if (typeof tempoHash === "string") manifest.tempoHash = tempoHash;
    if (typeof traceAuditHash === "string") manifest.traceAuditHash = traceAuditHash;
    if (typeof pluginHash === "string") manifest.pluginHash = pluginHash;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * What a step remembers for the next one: the text the step ended with, as UTF-8. The next step
 * is given it verbatim, after the bytes have been fetched by hash and re-hashed. Kept as plain
 * text on purpose — it is the one part of a loop a reader can look at and understand, and a
 * model can be handed without a schema.
 */
export function loopMemoryBytes(text: string): Uint8Array {
  return utf8(text);
}

/** `sha256(loopMemoryBytes(text))`, hex — the value `memoryHash` carries. */
export function loopMemoryHash(text: string): string {
  return hex(sha256(loopMemoryBytes(text)));
}

/** Whether a step is allowed to be told these bytes: they must re-hash to the hash it was promised. */
export function memoryMatches(bytes: Uint8Array, memoryHash: string): boolean {
  return hex(sha256(bytes)) === memoryHash.toLowerCase();
}

/**
 * The 72 bytes the leaf hashes: `agent_id ‖ seq_le ‖ head`. Stored under the leaf so an auditor
 * walking `result_hash` gets the seq and head back rather than an opaque 32 bytes.
 */
export function loopLeafPreimage(agentId: Bytes32, seq: bigint | number, head: Bytes32): Uint8Array {
  const out = new Uint8Array(72);
  out.set(agentId, 0);
  out.set(u64le(seq), 32);
  out.set(head, 40);
  return out;
}

/**
 * The leaf a step commits: `sha256(agent_id ‖ seq_le ‖ head)`.
 *
 * The seq is in the leaf because an agent that batches its calls into epochs advances its head
 * in jumps: a head alone does not say which epoch boundary it stands on, and a reader comparing
 * the leaf to the chain needs to know *where* to compare. With the seq, "the chain at seq N has
 * head H" is one `verifyChain` away.
 */
export function loopStepLeaf(agentId: Bytes32, seq: bigint | number, head: Bytes32): Bytes32 {
  return sha256(agentId, u64le(seq), head);
}

/** One step, as the chain has it. */
export interface LoopStep {
  /** The `loop.step` record itself. */
  record: EventRecord;
  /** Seq of the step record — and the seq its leaf commits to. */
  seq: bigint;
  /** Head after the step record. */
  head: Bytes32;
  /**
   * Head at `seq - 1`, which is what the leaf commits to: the head the step's own resolution
   * produced. `null` when the chain write at that seq left no head this reader can see — a write
   * whose transaction history the RPC has pruned, or any write at all when the caller supplied
   * `opts.epochs` and so skipped the history walk.
   */
  priorHead: Bytes32 | null;
  /** Client-attested unix ms, from the record. */
  timestamp: bigint;
  /** `LoopStepStatus`. */
  statusCode: number;
  /** Transaction that wrote the record, when transaction history still has it. */
  signature?: string;
}

/**
 * Every step on an agent's chain, ascending by seq, each carrying the head its leaf commits to.
 *
 * Three reads: the `memcmp` scan for the records, one for every record's head, and one walk over
 * transaction history for the epoch heads and the signatures. The history walk is the expensive
 * one and it is the same walk `listEpochs` makes, so a caller that already holds an owner's
 * epochs is paying for it twice — pass them in as `epochs` to pay once.
 */
export async function listSteps(
  client: LathClient,
  agentId: Bytes32,
  opts: { epochs?: { endSeq: bigint; head: Bytes32; signature: string }[] } = {}
): Promise<LoopStep[]> {
  const steps = await client.listByTool(agentId, LOOP_STEP_TOOL);
  if (steps.length === 0) return [];

  const heads = new Map<string, Bytes32>();
  const signatures = new Map<string, string>();
  for (const r of await client.listEvents(agentId)) heads.set(r.seq.toString(), r.head);

  // Epochs cover `[startSeq, endSeq)` and produce one head, which stands at `endSeq - 1`. A step
  // whose predecessor is an epoch is not the shape `LoopRunner` writes (the resolution always
  // sits between), but a chain assembled some other way is still readable this way.
  let epochs = opts.epochs;
  if (!epochs) {
    // One walk, both answers: the epochs' heads and, from the same transactions, the signature
    // that wrote each record.
    const history = await client.readHistory(agentId);
    epochs = history.epochs;
    for (const e of history.events) {
      heads.set(e.seq.toString(), e.head);
      signatures.set(e.seq.toString(), e.signature);
    }
    // Cell writes and struct creates spend a seq on the same counter as events and fold a head
    // the same way, so the write immediately before a checkpoint is often one of them — an epoch's
    // locator cell is published asynchronously and lands wherever it lands. Without these the
    // reader reports `no-prior-head` and zero verified leaves for a chain that is entirely intact.
    // Caveat: a caller that passes `opts.epochs` skips this walk and gets neither; the console
    // passes none, so it is covered there.
    for (const c of [...history.cells, ...history.structs]) {
      heads.set(c.opSeq.toString(), c.head);
      if (!signatures.has(c.opSeq.toString())) signatures.set(c.opSeq.toString(), c.signature);
    }
  }
  for (const e of epochs) {
    heads.set((e.endSeq - 1n).toString(), e.head);
    if (e.signature) signatures.set((e.endSeq - 1n).toString(), e.signature);
  }

  return steps
    .map((record) => ({
      record,
      seq: record.seq,
      head: record.head,
      priorHead: record.seq > 0n ? heads.get((record.seq - 1n).toString()) ?? null : null,
      timestamp: record.timestamp,
      statusCode: record.status,
      signature: signatures.get(record.seq.toString()),
    }))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

/** Why a step is not verified. Each is a different sentence on screen, never a bare `false`. */
type LoopStepVerdict =
  /** The head at `seq - 1` is not readable here, so there is no leaf to rebuild. */
  | "no-head"
  /** Neither a manifest nor a store was given: the expected leaf is known, the commitment is not. */
  | "chain-only"
  /** The payload preimage is not retrievable, so `result_hash` cannot be read. */
  | "no-preimage"
  /** The preimage came back and is not an `Action` encoding. */
  | "unreadable"
  /** The record commits to a different leaf (or a different manifest) than the chain implies. */
  | "mismatch"
  | "ok";

export interface LoopStepVerification {
  verdict: LoopStepVerdict;
  /** How the commitment was checked. */
  via: "manifest" | "store" | "none";
  /** `loopStepLeaf(agent_id, seq, head_at_seq-1)`, rebuilt from chain data, hex. */
  expectedLeaf?: string;
  /** The leaf the record actually commits to, hex, when it could be read or rebuilt. */
  leaf?: string;
  /** `args_hash`, hex. */
  argsHash?: string;
  /** The manifest, as supplied or as decoded from the store. */
  manifest?: LoopStepManifest | null;
  /**
   * The memory the manifest commits to, when it commits to one and a store was given to look in.
   * `ok` means bytes came back under `memoryHash` and re-hash to it; `missing` that the store
   * has nothing there; `mismatch` that it returned bytes that hash to something else.
   */
  memory?: { hash: string; verdict: "ok" | "missing" | "mismatch"; bytes?: Uint8Array };
}

/** The leaf a step's record ought to commit to, from chain data alone. */
function expectedStepLeaf(agentId: Bytes32, step: LoopStep): Bytes32 | null {
  if (!step.priorHead) return null;
  return loopStepLeaf(agentId, step.seq, step.priorHead);
}

/**
 * Checks one step: is the leaf this record commits to the leaf the chain says it should be?
 *
 * With `manifest` the check needs no bytes at all beyond the chain — `payload_hash` commits to
 * the tool id, the manifest hash, the leaf and the status together, so re-deriving it from the
 * manifest and the expected leaf either reproduces the on-chain hash or does not. With `store`
 * the preimage is fetched and the two sub-hashes are read out of it directly, which is what
 * `lath-audit` does. Given both, the manifest path runs first and the store only supplies the
 * manifest's own bytes for display.
 */
export async function verifyStep(
  agentId: Bytes32,
  step: LoopStep,
  opts: { manifest?: LoopStepManifest; store?: Pick<TraceStore, "get"> } = {}
): Promise<LoopStepVerification> {
  const expected = expectedStepLeaf(agentId, step);
  if (!expected) return { verdict: "no-head", via: "none" };
  const expectedLeaf = hex(expected);

  if (opts.manifest) {
    const argsHash = sha256(loopManifestBytes(opts.manifest));
    const rebuilt = hashPayload({
      kind: EventKind.Action,
      toolId: LOOP_STEP_TOOL,
      argsHash,
      resultHash: expected,
      statusCode: step.statusCode,
    });
    const ok = hex(rebuilt) === hex(step.record.payloadHash);
    return {
      verdict: ok ? "ok" : "mismatch",
      via: "manifest",
      expectedLeaf,
      leaf: ok ? expectedLeaf : undefined,
      argsHash: hex(argsHash),
      manifest: opts.manifest,
      memory: ok ? await checkMemory(opts.manifest, opts.store) : undefined,
    };
  }

  if (!opts.store) return { verdict: "chain-only", via: "none", expectedLeaf };

  const preimage = await opts.store.get(step.record.payloadHash);
  if (!preimage || hex(sha256(preimage)) !== hex(step.record.payloadHash)) {
    return { verdict: "no-preimage", via: "store", expectedLeaf };
  }
  // `kind ‖ encodePayload(payload)`; the offsets are into the encoding.
  const [argsHash, resultHash] = subHashes(step.record.kind, preimage.slice(1));
  if (!argsHash || !resultHash) return { verdict: "unreadable", via: "store", expectedLeaf };
  // The record's tool id and status are fields beside `payload_hash` that the program does not
  // bind to it. The manifest path above gets this for free — it rebuilds the payload from
  // `step.statusCode` and `loop.step` and compares hashes — so the store path checks the same two
  // fields explicitly, or a record at 201 over a payload that says 200 would verify here.
  const fields = recordFieldsOf(step.record.kind, preimage.slice(1));
  if (
    !fields.reference ||
    hex(fields.reference) !== hex(idFromString(LOOP_STEP_TOOL)) ||
    fields.status !== step.record.status
  ) {
    return { verdict: "mismatch", via: "store", expectedLeaf, leaf: hex(resultHash), argsHash: hex(argsHash) };
  }
  const manifestBytes = await opts.store.get(argsHash);
  const manifest = manifestBytes ? decodeLoopManifest(manifestBytes) : null;
  return {
    verdict: hex(resultHash) === expectedLeaf ? "ok" : "mismatch",
    via: "store",
    expectedLeaf,
    leaf: hex(resultHash),
    argsHash: hex(argsHash),
    manifest,
    memory: manifest ? await checkMemory(manifest, opts.store) : undefined,
  };
}

/** The memory half of `verifyStep`: only when the manifest names one and there is a store to ask. */
async function checkMemory(
  manifest: LoopStepManifest,
  store: Pick<TraceStore, "get"> | undefined
): Promise<LoopStepVerification["memory"]> {
  if (!manifest.memoryHash || !store) return undefined;
  const hash = manifest.memoryHash;
  const bytes = await store.get(toBytes32(hash));
  if (!bytes) return { hash, verdict: "missing" };
  if (!memoryMatches(bytes, hash)) return { hash, verdict: "mismatch" };
  return { hash, verdict: "ok", bytes };
}
