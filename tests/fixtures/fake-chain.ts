import { PublicKey } from "@solana/web3.js";
import {
  AgentState,
  Bytes32,
  EventInput,
  EventPayload,
  LathClient,
  LogResult,
  computeEpochHead,
  computeHead,
  hex,
  sha256,
  toBytes32,
  toEventInput,
  u64le,
  utf8,
} from "../../sdk/src";

/**
 * An in-memory stand-in for the subset of `LathClient` the anchor queue and the runtime
 * touch: read the agent header, append an event, commit an epoch.
 *
 * It applies the **real** `computeHead` and `computeEpochHead`, so a chain built here folds
 * exactly as one built on devnet does — the point of the fixture is to exercise the queue's
 * ordering and its head check without a validator, not to approximate the formula.
 *
 * Two knobs stand in for the two ways a chain write goes wrong in practice:
 *
 * - `failNext(n)` — the next `n` writes throw without touching the chain, the ordinary transient
 *   failure the queue retries;
 * - `loseNext(n)` — the next `n` writes are *applied* and then throw, which is a confirmation
 *   lost after the transaction landed. That is the case the head check exists for, and the one
 *   a naive retry turns into a duplicate record.
 *
 * And one for the reader's side: `lagReads(n)` makes the next `n` reads report the state as it
 * stood before the most recent write, which is what Photon does for a moment after every
 * confirmation. The first devnet run seeded a session's tip from such a read.
 */
export class FakeChain {
  readonly authority = { publicKey: new PublicKey("11111111111111111111111111111112") };
  /** Every write that reached the chain, in order, whether or not its caller was told. */
  readonly applied: { kind: "event" | "epoch"; agentId: string; seq: string; head: string }[] = [];
  /** Extra instructions each `logEventInput` was handed, by call — the composed charge. */
  readonly instructionCounts: number[] = [];
  private readonly agents = new Map<string, AgentState>();
  /**
   * Runs before a write reads the chain, so a test can make something else happen first — the
   * other signer of the head-divergence case. Cleared by whoever sets it.
   */
  beforeWrite?: () => void;
  private failures = 0;
  private losses = 0;
  private signatures = 0;
  private lag = 0;
  /** The state before the most recent write, per agent — what a lagging read reports. */
  private readonly stale = new Map<string, AgentState>();

  lagReads(n: number): void {
    this.lag += n;
  }

  failNext(n: number): void {
    this.failures += n;
  }

  loseNext(n: number): void {
    this.losses += n;
  }

  /** Casts to the client the queue and the runtime are typed against. */
  asClient(): LathClient {
    return this as unknown as LathClient;
  }

  state(agentId: Bytes32): AgentState | undefined {
    return this.agents.get(hex(agentId));
  }

  async registerAgent(agentId: Bytes32, createdAt: bigint | number = Date.now()): Promise<{ signature: string }> {
    this.agents.set(hex(agentId), {
      authority: this.authority.publicKey,
      agentId: toBytes32(agentId),
      seq: 0n,
      head: new Uint8Array(32),
      createdAt: BigInt(createdAt),
      updatedAt: BigInt(createdAt),
    });
    return { signature: this.signature() };
  }

  async getAgentState(agentId: Bytes32): Promise<{ account: unknown; state: AgentState } | null> {
    const key = hex(agentId);
    let state = this.agents.get(key);
    if (this.lag > 0) {
      this.lag -= 1;
      state = this.stale.get(key) ?? state;
    }
    return state ? { account: {}, state: { ...state } } : null;
  }

  eventAddress(agentId: Bytes32, seq: bigint | number): PublicKey {
    return new PublicKey(sha256(utf8("event"), toBytes32(agentId), u64le(seq)));
  }

  async logEvent(agentId: Bytes32, payload: EventPayload, opts: { compact?: boolean; timestamp?: number } = {}) {
    return this.logEventInput(agentId, toEventInput(payload, opts.timestamp ?? Date.now()), !!opts.compact);
  }

  async logEventInput(agentId: Bytes32, input: EventInput, compact: boolean, instructions?: unknown[]) {
    this.instructionCounts.push(instructions?.length ?? 0);
    this.beforeWrite?.();
    const state = this.require(agentId);
    const seq = state.seq;
    const head = computeHead(state.head, state.agentId, seq, input);
    this.write(() => {
      state.seq = seq + 1n;
      state.head = head;
      this.applied.push({ kind: "event", agentId: hex(agentId), seq: seq.toString(), head: hex(head) });
    });
    const result: LogResult = {
      signature: this.signature(),
      seq,
      head,
      input,
      eventAddress: compact ? undefined : this.eventAddress(agentId, seq),
    };
    return result;
  }

  async commitEpoch(
    agentId: Bytes32,
    epochRoot: Bytes32,
    startSeq: bigint,
    endSeq: bigint
  ): Promise<{ signature: string; head: Bytes32 }> {
    const state = this.require(agentId);
    if (state.seq !== startSeq) throw new Error(`epoch starts at ${startSeq} but the chain is at ${state.seq}`);
    const head = computeEpochHead(state.head, state.agentId, epochRoot, startSeq, endSeq);
    this.write(() => {
      state.seq = endSeq;
      state.head = head;
      this.applied.push({ kind: "epoch", agentId: hex(agentId), seq: endSeq.toString(), head: hex(head) });
    });
    return { signature: this.signature(), head };
  }

  /**
   * Another signer advancing this chain — the case rule 3 catches. Folds a real event, so the
   * head the queue then reads back is a legitimate head that its journal simply did not predict.
   */
  foreignWrite(agentId: Bytes32, input: EventInput): void {
    const state = this.require(agentId);
    const head = computeHead(state.head, state.agentId, state.seq, input);
    state.seq += 1n;
    state.head = head;
    this.applied.push({ kind: "event", agentId: hex(agentId), seq: (state.seq - 1n).toString(), head: hex(head) });
  }

  private require(agentId: Bytes32): AgentState {
    const state = this.agents.get(hex(agentId));
    if (!state) throw new Error(`agent ${hex(agentId)} is not registered`);
    return state;
  }

  /** Applies a write under the two failure knobs; see the class docs for what each stands for. */
  private write(apply: () => void): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("fake chain: send failed");
    }
    for (const [key, state] of this.agents) this.stale.set(key, { ...state });
    apply();
    if (this.losses > 0) {
      this.losses -= 1;
      throw new Error("fake chain: confirmation lost");
    }
  }

  private signature(): string {
    return `sig-${++this.signatures}`;
  }
}

/** A billing backend that records what it was asked to move, in order. */
export class RecordingBilling {
  readonly charges: { user: string; amountMicroUsdc: string }[] = [];
  private failures = 0;

  failNext(n: number): void {
    this.failures += n;
  }

  async charge(user: PublicKey, amountMicroUsdc: bigint): Promise<string | null> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("fake billing: charge failed");
    }
    this.charges.push({ user: user.toBase58(), amountMicroUsdc: amountMicroUsdc.toString() });
    return `charge-${this.charges.length}`;
  }

  /**
   * What anything debited through `chargeAndLog` — a `loop.step` checkpoint does not, since Lath
   * pays Jev's decisions — kept apart from `charges` so a
   * suite counting the session's own debits counts what it always did, and one proving the
   * checkpoint charges nothing has a list to find empty.
   */
  readonly checkpointCharges: { user: string; amountMicroUsdc: string }[] = [];

  async chargeAndLog(req: { user: PublicKey; amountMicroUsdc: bigint }): Promise<LogResult | null> {
    // The anchored path never calls it: a journaled record composes the charge instead
    // (`AnchorQueue.chargeInstructions`), and a checkpoint does not. A caller that does gets
    // `null` back — the answer of a backend that writes no record itself — with the debit here.
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("fake billing: charge failed");
    }
    this.checkpointCharges.push({ user: req.user.toBase58(), amountMicroUsdc: req.amountMicroUsdc.toString() });
    return null;
  }
}
