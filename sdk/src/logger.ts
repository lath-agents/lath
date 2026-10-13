import { PublicKey } from "@solana/web3.js";
import { ChainVerification, LathClient, LogResult, VerifyChainOptions } from "./client";
import { EventRecord } from "./layout";
import { EventKind, EventPayload, payloadPreimage, ResolutionStatus } from "./events";
import { Bytes32, hex, idFromString, sha256, toBytes32, utf8 } from "./hash";
import { MemoryTraceStore, TraceStore, verifyTrace } from "./trace-store";

type Blob = Uint8Array | string | object;

function toBlob(v: Blob): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return utf8(v);
  return utf8(JSON.stringify(v));
}

/**
 * Where a write actually goes. The default is the client: one transaction per call, the head
 * read back from the chain that accepted it.
 *
 * The runtime's anchor queue supplies another (`runtime/src/anchor.ts`): it journals the record,
 * folds the §4.4 head locally, and answers with an empty signature, so a session can give its
 * answer before the chain confirms. Nothing else about this logger changes — same payloads, same
 * trace-store writes, same `LogResult` shape.
 */
export interface LogWriter {
  logEvent(
    agentId: Bytes32,
    payload: EventPayload,
    opts: { compact?: boolean; timestamp?: number }
  ): Promise<LogResult>;
}

interface AgentLoggerOptions {
  /** Where verbose traces go. Defaults to in-memory (nothing persisted). */
  store?: TraceStore;
  /** Log events without per-event compressed accounts (cheaper, not address-queryable). */
  compact?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /**
   * Also store each event's payload preimage — `kind ‖ encodePayload(payload)` — under its
   * `payload_hash`, in addition to the leaf blobs.
   *
   * Off by default, because it is a second write per event and the leaves are what a runtime
   * actually needs. Turn it on when an auditor must be able to get from the chain *alone* to
   * the arguments a step ran with: the sub-hashes live inside this preimage and nowhere else,
   * so without it `payload_hash` resolves to nothing, `lath-audit --require-preimages`
   * fails by construction, and a reader holding the chain cannot enumerate what to fetch.
   */
  storePayloads?: boolean;
  /** Where writes go. Defaults to the client; see `LogWriter`. */
  writer?: LogWriter;
}

/**
 * High-level logger an agent runtime embeds. Each call stores the verbose material in the
 * trace store, commits only hashes on-chain, and returns the chain head so the caller can
 * persist it alongside its own state.
 */
/**
 * The event log's `struct_id`. The four primitives *are* a `Log` — private mode,
 * `log_id = sha256("events")` — and this is its id, so it can be named alongside an owner's
 * other structures.
 *
 * It is not a `LathLog` instance, and cannot be: `EventRecord` is frozen at 147 bytes with
 * its own typed schema (SPEC §4.2) and its own address seed, while a generic `Log` writes the
 * 187-byte cell of `cells.ts`. Re-basing it literally would change every event address and
 * record layout on chain, which SPEC §12 forbids and no existing chain could survive. What is
 * shared is the model — one owner, one chain, dense indices, `TraceStore` behind the hashes —
 * and the operation counter: events and cells advance the same `AgentState.seq`,
 * so `verifyChain` replays them as one ordered history.
 */
const EVENTS_LOG_ID: Bytes32 = idFromString("events");

export class AgentLogger {
  readonly store: TraceStore;
  readonly compact: boolean;
  /** See `AgentLoggerOptions.storePayloads`. */
  readonly storePayloads: boolean;
  /** `sha256("events")` — see `EVENTS_LOG_ID`. */
  readonly logId: Bytes32 = EVENTS_LOG_ID;
  private readonly now: () => number;
  private readonly writer: LogWriter;

  constructor(readonly client: LathClient, readonly agentId: Bytes32, opts: AgentLoggerOptions = {}) {
    this.store = opts.store ?? new MemoryTraceStore();
    this.compact = opts.compact ?? false;
    this.storePayloads = opts.storePayloads ?? false;
    this.now = opts.now ?? Date.now;
    this.writer = opts.writer ?? client;
  }

  /** Registers the agent if it has no state yet. Idempotent. */
  async ensureRegistered(): Promise<boolean> {
    if (await this.client.getAgentState(this.agentId)) return false;
    await this.client.registerAgent(this.agentId, this.now());
    return true;
  }

  /**
   * One write, with the payload preimage stored first when asked for. The preimage is
   * `kind ‖ encodePayload(p)` because that is exactly what `payload_hash` commits to — store
   * the encoding alone and the store's key is a different hash, which is a silent way to
   * produce traces nobody can find.
   */
  private async emit(payload: EventPayload): Promise<LogResult> {
    if (this.storePayloads) {
      await this.store.put(payloadPreimage(payload));
    }
    return this.writer.logEvent(this.agentId, payload, { compact: this.compact, timestamp: this.now() });
  }

  /** Genesis / task assignment. `input` is the full prompt/task spec; stored off-chain. */
  async genesis(p: {
    sessionId: string | Uint8Array;
    caller: PublicKey | string | Uint8Array;
    policyVersionHash: Uint8Array | string;
    input: Blob;
  }): Promise<LogResult & { inputHash: Bytes32 }> {
    const inputHash = await this.store.put(toBlob(p.input));
    const res = await this.emit({
      kind: EventKind.Genesis,
      sessionId: p.sessionId,
      callerPubkey: p.caller,
      policyVersionHash: p.policyVersionHash,
      inputPayloadHash: inputHash,
    });
    return { ...res, inputHash };
  }

  /** External side-effect. `args`/`result` are stored off-chain; only hashes go on-chain. */
  async action(p: {
    toolId: string;
    args: Blob;
    result: Blob;
    statusCode: number;
  }): Promise<LogResult & { argsHash: Bytes32; resultHash: Bytes32 }> {
    const [argsHash, resultHash] = await Promise.all([
      this.store.put(toBlob(p.args)),
      this.store.put(toBlob(p.result)),
    ]);
    const res = await this.emit({
      kind: EventKind.Action,
      toolId: p.toolId,
      argsHash,
      resultHash,
      statusCode: p.statusCode,
    });
    return { ...res, argsHash, resultHash };
  }

  /** Delegation to another agent. `scope` is the delegated capability spec; stored off-chain. */
  async delegate(p: {
    parentTaskId: string | Uint8Array;
    to: PublicKey | string | Uint8Array;
    from?: PublicKey | string | Uint8Array;
    scope: Blob;
  }): Promise<LogResult & { scopeHash: Bytes32 }> {
    const scopeHash = await this.store.put(toBlob(p.scope));
    const res = await this.emit({
      kind: EventKind.Delegation,
      parentTaskId: p.parentTaskId,
      fromAgentPubkey: p.from ?? this.client.authority.publicKey,
      toAgentPubkey: p.to,
      scopeHash,
    });
    return { ...res, scopeHash };
  }

  /** Terminal resolution. `output` is the final artifact; stored off-chain. */
  async resolve(p: {
    taskId: string | Uint8Array;
    status: ResolutionStatus;
    output: Blob;
    totalStepCount: number;
  }): Promise<LogResult & { outputHash: Bytes32 }> {
    const outputHash = await this.store.put(toBlob(p.output));
    const res = await this.emit({
      kind: EventKind.Resolution,
      taskId: p.taskId,
      status: p.status,
      finalOutputHash: outputHash,
      totalStepCount: p.totalStepCount,
    });
    return { ...res, outputHash };
  }

  // -----------------------------------------------------------------------------------------
  // The Log-shaped read surface: the same questions one asks of a `LathLog`.
  // -----------------------------------------------------------------------------------------

  /** Number of writes the owner has made — the next `seq`, and the owner's operation counter. */
  async length(): Promise<bigint> {
    const found = await this.client.getAgentState(this.agentId);
    if (!found) throw new Error(`agent ${hex(this.agentId)} is not registered`);
    return found.state.seq;
  }

  /** One event by index. `null` for a compact write, which left no account to read. */
  async get(seq: bigint | number): Promise<EventRecord | null> {
    return this.client.getEvent(this.agentId, seq);
  }

  /**
   * Every event with a record, ascending. Compact writes are absent; `recover` reconstructs
   * them from transaction history, which is the only place they exist.
   */
  async entries(opts: { recover?: boolean } = {}): Promise<EventRecord[]> {
    const onChain = await this.client.listEvents(this.agentId);
    if (!opts.recover) return onChain;
    const have = new Set(onChain.map((r) => r.seq.toString()));
    const extra = (await this.client.recoverEventsFromHistory(this.agentId)).filter((r) => !have.has(r.seq.toString()));
    return [...onChain, ...extra].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }

  /** Events of one kind, via the `EVENT_OFFSETS` memcmp filter. */
  async entriesByKind(kind: EventKind): Promise<EventRecord[]> {
    return this.client.listByKind(this.agentId, kind);
  }

  /**
   * Replays the on-chain chain and checks that every referenced trace is still retrievable.
   * `opts` is forwarded to `verifyChain`, so `{ recover: true }` also fills compact-mode gaps
   * from transaction history.
   */
  async audit(
    traceHashes: Bytes32[] = [],
    opts: VerifyChainOptions = {}
  ): Promise<ChainVerification & { tracesOk: boolean; missingTraces: Bytes32[] }> {
    const chain = await this.client.verifyChain(this.agentId, opts);
    const missingTraces: Bytes32[] = [];
    for (const h of traceHashes) if (!(await verifyTrace(this.store, h))) missingTraces.push(h);
    return { ...chain, tracesOk: missingTraces.length === 0, missingTraces };
  }
}

export { sha256, toBytes32 };
