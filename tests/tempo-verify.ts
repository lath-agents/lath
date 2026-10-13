/**
 * The payment verifier, over a fake chain and a fake Tempo.
 *
 * The chain proves what a call was owed: the voucher is in the blob the Action's `result_hash`
 * commits to, so it cannot be edited without breaking the record that names it. Tempo proves the
 * channel paid it. `verifyInference` joins the two, and this suite is the contract for what each
 * of its four verdicts means — including the two that need no network at all, the monotonic check
 * and the missing blob.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money. The one thing here
 * that touches viem is the selector and topic pin, which is pure computation over a signature.
 */
import { assert } from "chai";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { PublicKey } from "@solana/web3.js";
import {
  audit,
  billingChargeDebit,
  DEFAULT_MARGIN_BPS,
  formatReport,
  gateChargeMicroUsdc,
  LATH_BILLING_IDL,
  LATH_BILLING_PROGRAM_ID,
  recordFieldsOf,
  type LathClient,
  CHANNEL_CLOSED_SIGNATURE,
  ESCROW_ABI,
  TempoRpcReader,
  channelClosedTopic,
  channelsExitCode,
  channelStateCalldata,
  encodeEpochBlob,
  epochRootOf,
  EventKind,
  formatChannels,
  formatInference,
  hex,
  idFromString,
  inferenceExitCode,
  LOOP_SETTLEMENT_TOOL,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  MemoryEpochStore,
  MemoryTraceStore,
  type TraceStore,
  paymentFromBlob,
  payloadPreimage,
  ResolutionStatus,
  settlementFromBlob,
  sha256,
  TEMPO_ESCROW,
  toEventInput,
  utf8,
  verifyChannels,
  verifyInference,
  NO_TEMPO_KEY,
  TEMPO_KEY_POLICY_UNREAD,
  tempoKeyOfPolicy,
  normaliseScopes,
  type AllowedCallsLog,
  type ChannelOpenedLog,
  type EventInput,
  type InferenceEpoch,
  type KeyAuthorizedLog,
  type InferenceRecord,
  type LoopStepManifest,
  type TempoChannelState,
  type TempoCloseReceipt,
  type TempoReader,
} from "../sdk/src";
import { CHANNEL_CLOSED_TOPIC, TEMPO_ESCROW_ADDRESS } from "../frontend/src/lib/tempo-close";
import { toMicroUsdcFromBase } from "../runtime/src";

const AGENT = sha256(utf8("tempo-verify-agent"));
const PAYER = "0x749d38880f1974de12E841B5D4a23FC980a89117";
const PAYEE = "0xca4e000000000000000000000000000000000000";
const CHANNEL = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

/**
 * The chain, as much of it as a verdict reads: the records, ascending, the epochs it committed,
 * and nothing else.
 *
 * Between `openEpoch` and `commitEpoch` the writes below produce no record — the rollup batches
 * them into one root, which is what a console session does to every Action it writes — so a
 * verifier that only reads `listEvents` cannot see them at all.
 */
class FakeChain {
  readonly records: InferenceRecord[] = [];
  readonly store = new MemoryTraceStore();
  readonly epochs: InferenceEpoch[] = [];
  readonly epochStore = new MemoryEpochStore();
  private batch: EventInput[] | null = null;
  private batchStart = 0;

  async listEvents(): Promise<readonly InferenceRecord[]> {
    return this.records;
  }

  async listEpochs(): Promise<readonly InferenceEpoch[]> {
    return this.epochs;
  }

  /** Everything written from here until `commitEpoch` occupies `[startSeq, …)` inside one epoch. */
  openEpoch(startSeq: number): void {
    this.batch = [];
    this.batchStart = startSeq;
  }

  /** One `commit_epoch`: the blob under its root, and the root on the chain. No accounts. */
  async commitEpoch(): Promise<InferenceEpoch> {
    const inputs = this.batch!;
    this.batch = null;
    const root = epochRootOf(this.batchStart, inputs);
    await this.epochStore.put(root, encodeEpochBlob(this.batchStart, inputs));
    const epoch: InferenceEpoch = {
      epochRoot: root,
      startSeq: BigInt(this.batchStart),
      endSeq: BigInt(this.batchStart + inputs.length),
    };
    this.epochs.push(epoch);
    return epoch;
  }

  /**
   * One LLM call. `payment` is what the transport returned and the runtime put beside the body, and
   * the tool id is `llm.<model>` for the model the request and the body name, as `paidChat` writes it.
   */
  async action(seq: number, payment: Record<string, unknown> | null, toolId = "llm.openai/gpt-4o-mini") {
    const model = toolId.replace(/^llm\./, "");
    const argsHash = await this.store.put(utf8(JSON.stringify({ model })));
    const body = { id: `gen-${seq}`, model, choices: [], ...(payment ? { payment } : {}) };
    const resultHash = await this.store.put(utf8(JSON.stringify(body)));
    return this.record({ kind: EventKind.Action, toolId, argsHash, resultHash, statusCode: 200 }, seq, toolId);
  }

  /**
   * One chat attempt as `paidChat` records it: the request asked for
   * `asked`; an answer names the build that `served` it and its id is `llm.<served>`, a failure
   * (`{ error, payment }`, 502) names no model and its id is `llm.<asked>`. `absorbed` writes the
   * marker a no-answer attempt Lath paid for carries.
   */
  async chatCall(
    seq: number,
    o: { asked: string; served?: string; payment: Record<string, unknown>; failed?: boolean; absorbed?: boolean }
  ) {
    const argsHash = await this.store.put(utf8(JSON.stringify({ model: o.asked, messages: [] })));
    const result = o.failed
      ? {
          error: "the gateway sent no part of the model's answer in 45 s",
          payment: o.payment,
          ...(o.absorbed ? { paidBy: "lath" } : {}),
        }
      : { id: `gen-${seq}`, model: o.served ?? o.asked, choices: [], payment: o.payment };
    const resultHash = await this.store.put(utf8(JSON.stringify(result)));
    const toolId = `llm.${o.failed ? o.asked : o.served ?? o.asked}`;
    return this.record(
      { kind: EventKind.Action, toolId, argsHash, resultHash, statusCode: o.failed ? 502 : 200 },
      seq,
      toolId
    );
  }

  /**
   * Any other Action whose result is bytes a tool chose: a `storage.put` commits the report the
   * sandboxed model wrote, raw, and a sandbox file tool the text it handed back.
   */
  async toolAction(seq: number, toolId: string, result: string, args: unknown = { key: `k-${seq}` }) {
    const argsHash = await this.store.put(utf8(JSON.stringify(args)));
    const resultHash = await this.store.put(utf8(result));
    return this.record({ kind: EventKind.Action, toolId, argsHash, resultHash, statusCode: 200 }, seq, toolId);
  }

  /** The Resolution of a one-shot session: the settlement rides in its output blob. */
  async resolution(seq: number, settlement?: { txHash: string; spent?: string; channelId?: string }) {
    const output = { output: "done", steps: 1, ...(settlement ? { settlement } : {}) };
    const finalOutputHash = await this.store.put(utf8(JSON.stringify(output)));
    return this.resolutionNaming(seq, finalOutputHash);
  }

  /** A Resolution whose output blob this store never held: `final_output_hash` names bytes nobody kept. */
  async resolutionUnstored(seq: number) {
    return this.resolutionNaming(seq, sha256(utf8(`lost output ${seq}`)));
  }

  /** A loop checkpoint: `loop.step` with the manifest as its args blob and a leaf as its result. */
  async step(seq: number, manifest: LoopStepManifest) {
    const argsHash = await this.store.put(loopManifestBytes(manifest));
    return this.record(
      {
        kind: EventKind.Action,
        toolId: LOOP_STEP_TOOL,
        argsHash,
        resultHash: sha256(utf8(`leaf ${seq}`)),
        statusCode: 200,
      },
      seq,
      LOOP_STEP_TOOL
    );
  }

  /** A blob under its hash, as a decision or a gate log is stored; returns the hex hash a manifest names. */
  async blob(value: unknown): Promise<string> {
    return hex(await this.store.put(utf8(JSON.stringify(value))));
  }

  private async resolutionNaming(seq: number, finalOutputHash: Uint8Array) {
    return this.record(
      {
        kind: EventKind.Resolution,
        taskId: "task",
        status: ResolutionStatus.Success,
        finalOutputHash,
        totalStepCount: 1,
      },
      seq
    );
  }

  /** A loop's settlement: one Action under `loop.settlement`, whose result blob is the receipt. */
  async loopSettlement(seq: number, settlement: Record<string, unknown>) {
    const argsHash = await this.store.put(utf8(JSON.stringify({ loopId: "loop-1" })));
    const resultHash = await this.store.put(utf8(JSON.stringify(settlement)));
    return this.record(
      { kind: EventKind.Action, toolId: LOOP_SETTLEMENT_TOOL, argsHash, resultHash, statusCode: 200 },
      seq,
      LOOP_SETTLEMENT_TOOL
    );
  }

  /**
   * A session's Genesis, with the policy document stored under the hash it commits — what the
   * runtime does (`store.put(utf8(policyDocument))`) and what the loop key checks read the policy by.
   */
  async genesis(seq: number, policy: Record<string, unknown>) {
    const policyVersionHash = await this.store.put(utf8(JSON.stringify(policy)));
    const inputPayloadHash = await this.store.put(utf8(JSON.stringify({ input: `step at ${seq}` })));
    return this.record(
      {
        kind: EventKind.Genesis,
        sessionId: idFromString(`loop-1:step-${seq}`),
        callerPubkey: new Uint8Array(32),
        policyVersionHash,
        inputPayloadHash,
      },
      seq
    );
  }

  private async record(payload: any, seq: number, toolId?: string) {
    const preimage = payloadPreimage(payload);
    await this.store.put(preimage);
    const rec: InferenceRecord = {
      seq: BigInt(seq),
      kind: payload.kind,
      reference: toolId ? idFromString(toolId) : new Uint8Array(32),
      payloadHash: sha256(preimage),
    };
    // Inside an open epoch the step is a leaf and never an account, which is the whole point of
    // the cases below: the record exists as 75 bytes in a blob and nowhere else.
    if (this.batch) this.batch.push(toEventInput(payload, 0));
    else this.records.push(rec);
    return rec;
  }
}

const voucher = (before: string, after: string, over: Partial<Record<string, unknown>> = {}) => ({
  rail: "tempo",
  chainId: 4217,
  payer: PAYER,
  channelId: CHANNEL,
  cumulativeBefore: before,
  cumulativeAfter: after,
  ...over,
});

/** Tempo, as the two reads a verdict makes. Every case below decides what it answers. */
class FakeTempoReader implements TempoReader {
  calls = 0;
  readonly state: TempoChannelState | null;
  readonly receipt: TempoCloseReceipt | null;
  constructor(state: TempoChannelState | null, receipt: TempoCloseReceipt | null = null) {
    this.state = state;
    this.receipt = receipt;
  }
  async channelState(): Promise<TempoChannelState | null> {
    this.calls++;
    return this.state;
  }
  async closeReceipt(): Promise<TempoCloseReceipt | null> {
    this.calls++;
    return this.receipt;
  }
}

const closedLog = (over: Partial<Record<string, unknown>> = {}) => ({
  channelId: CHANNEL,
  payer: PAYER,
  payee: PAYEE,
  finalAmount: BigInt(1500),
  refund: BigInt(0),
  ...over,
});

/** A settled channel: status 1, sent to the escrow, one matching `ChannelClosed`. */
const settledReader = (over: Partial<TempoCloseReceipt> = {}, log = closedLog()) =>
  new FakeTempoReader(
    // A closed channel reads as zeros: the receipt is the only thing that can verify it.
    { settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 },
    { status: 1, to: TEMPO_ESCROW, closed: log as any, ...over }
  );

/** A two-call session on one channel, resolved with a settlement transaction. */
async function settledSession() {
  const chain = new FakeChain();
  await chain.action(1, voucher("0", "750"));
  await chain.action(2, voucher("750", "1500"));
  await chain.resolution(3, { txHash: TX, spent: "1500" });
  return chain;
}

describe("verifyInference: the voucher a record commits, against the channel it was signed on", () => {
  it("verifies a call whose channel closed for at least what the voucher committed to", async () => {
    const chain = await settledSession();
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.payer, PAYER);
    assert.equal(r.channelId, CHANNEL);
    assert.equal(r.cumulativeBefore, "750");
    assert.equal(r.cumulativeAfter, "1500");
    assert.equal(r.settled, "1500");
    assert.equal(r.txHash, TX);
    assert.equal(inferenceExitCode(r), 0);
    assert.equal(formatInference(r).pop(), "VERIFIED");
  });

  it("verifies a loop's call against the loop.settlement record that follows it", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2); // the step's own Resolution settles nothing: the channel is the loop's
    await chain.action(3, voucher("750", "1500"));
    await chain.resolution(4);
    await chain.loopSettlement(5, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1500" });
    const r = await verifyInference(chain, AGENT, 3, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.txHash, TX);
  });

  it("is pending while the channel is open and holds enough for the call", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    const reader = new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(750), closeRequestedAt: 0 });
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader });
    assert.equal(r.verdict, "pending", r.reason);
    assert.equal(r.settled, "750");
    assert.include(r.reason ?? "", "has not settled yet");
    assert.equal(inferenceExitCode(r), 4);
    assert.equal(formatInference(r).pop(), "PENDING");
  });

  it("is pending, not wrong, when there is no Tempo reader at all", async () => {
    const chain = await settledSession();
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store });
    assert.equal(r.verdict, "pending");
    assert.include(r.reason ?? "", "Tempo RPC");
    assert.equal(r.txHash, TX, "the settlement the chain names is still reported");
  });

  it("fails a record whose payer is not the one the caller expects", async () => {
    const chain = await settledSession();
    const r = await verifyInference(chain, AGENT, 1, {
      store: chain.store,
      reader: settledReader(),
      expectedPayer: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", PAYER);
    assert.equal(inferenceExitCode(r), 2);
    assert.equal(formatInference(r).pop(), "FAILED");
  });

  it("fails a close that paid out less than the voucher committed to", async () => {
    const chain = await settledSession();
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(1499) }));
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "1499");
  });

  it("fails a close that reverted, and one sent somewhere other than the escrow", async () => {
    const chain = await settledSession();
    const reverted = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader({ status: 0 }),
    });
    assert.equal(reverted.verdict, "failed");
    assert.include(reverted.reason ?? "", "reverted");

    const elsewhere = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader({ to: "0x00000000000000000000000000000000000000ff" }),
    });
    assert.equal(elsewhere.verdict, "failed");
    assert.include(elsewhere.reason ?? "", TEMPO_ESCROW);
  });

  it("fails a close whose ChannelClosed names another channel, another payer, or nothing", async () => {
    const chain = await settledSession();
    const other = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader({}, closedLog({ channelId: `0x${"99".repeat(32)}` })),
    });
    assert.equal(other.verdict, "failed");
    assert.include(other.reason ?? "", "closed channel");

    const stranger = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader({}, closedLog({ payer: PAYEE })),
    });
    assert.equal(stranger.verdict, "failed");
    assert.include(stranger.reason ?? "", "payer");

    const noLog = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: new FakeTempoReader(null, { status: 1, to: TEMPO_ESCROW }),
    });
    assert.equal(noLog.verdict, "failed");
    assert.include(noLog.reason ?? "", "ChannelClosed");
  });

  it("fails a cumulative that goes backwards, with no reader involved at all", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "1500"));
    // The same channel, opening below what seq 1 had already committed to: a replayed or edited
    // voucher, and the chain says so without anyone asking Tempo.
    await chain.action(2, voucher("750", "2000"));
    const reader = new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(9000), closeRequestedAt: 0 });
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "never goes down");
    assert.equal(reader.calls, 0, "the chain refuted itself before any Tempo call");

    const withoutReader = await verifyInference(chain, AGENT, 2, { store: chain.store });
    assert.equal(withoutReader.verdict, "failed");
  });

  it("fails a chain whose vouchers disagree about who paid", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750", { payer: PAYEE }));
    await chain.action(2, voucher("750", "1500"));
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", PAYEE);
  });

  /**
   * Two payers. On older chains an agent signed its vouchers with a wallet derived from its own
   * Solana key; on current ones the operator's treasury signs them (the pool). A chain may carry
   * both, in that order, and these four cases are the whole rule: a
   * channel has one payer, a chain changes payer at most once, and only towards the payer the
   * record being verified names.
   */
  const POOL = "0x18fBE5E0A83DCA440072059F91D1a23BaBE6e0B0";
  const POOL_CHANNEL = `0x${"33".repeat(32)}`;

  it("verifies a chain written entirely before the pool, with and without --payer", async () => {
    const chain = await settledSession();
    const named = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader(),
      expectedPayer: PAYER,
    });
    assert.equal(named.verdict, "verified", named.reason);
    const anonymous = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(anonymous.verdict, "verified", anonymous.reason);
  });

  it("verifies a chain that moved to the pool once, against the treasury as --payer", async () => {
    const chain = new FakeChain();
    // Two calls on the agent's own wallet, then the switch: a new channel, paid by the pool.
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("750", "1500"));
    await chain.action(3, voucher("0", "750", { payer: POOL, channelId: POOL_CHANNEL }));
    await chain.action(4, voucher("750", "1500", { payer: POOL, channelId: POOL_CHANNEL }));
    await chain.loopSettlement(5, { payer: POOL, channelId: POOL_CHANNEL, closed: true, txHash: TX, spent: "1500" });
    const r = await verifyInference(chain, AGENT, 4, {
      store: chain.store,
      reader: settledReader({}, closedLog({ channelId: POOL_CHANNEL, payer: POOL })),
      expectedPayer: POOL,
    });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.payer, POOL);
  });

  it("fails a chain whose payer moves back to the agent's own wallet", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("0", "750", { payer: POOL, channelId: POOL_CHANNEL }));
    await chain.action(3, voucher("750", "1500", { channelId: `0x${"44".repeat(32)}` }));
    const reader = settledReader();
    // Verified at the record that moved back: the chain reached the pool and left it again, so
    // the pool's seqs are not on the way to the payer this record names.
    const r = await verifyInference(chain, AGENT, 3, { store: chain.store, reader, expectedPayer: PAYER });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "only to the payer this record names");
    assert.equal(reader.calls, 0, "the chain refuted itself before any Tempo call");

    // And with the pool asserted, at a later pool record: the change to the pool was allowed, the
    // move away from it was not, and a second change is refused whatever it is towards.
    await chain.action(4, voucher("1500", "2250", { payer: POOL, channelId: POOL_CHANNEL }));
    const twice = await verifyInference(chain, AGENT, 4, { store: chain.store, reader, expectedPayer: POOL });
    assert.equal(twice.verdict, "failed");
    assert.include(twice.reason ?? "", "more than once");
  });

  it("fails two records on one channel that name different payers", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    // The same channel id, a different payer: a channel has one signer, so one of these is edited.
    await chain.action(2, voucher("750", "1500", { payer: POOL }));
    const r = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader(),
      expectedPayer: POOL,
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "one channel has one payer");
  });

  it("fails a channel that holds less than the call owes, and one that reads as zeros unsettled", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    const short = await verifyInference(chain, AGENT, 1, {
      store: chain.store,
      reader: new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(500), closeRequestedAt: 0 }),
    });
    assert.equal(short.verdict, "failed");
    assert.include(short.reason ?? "", "below");

    // Zeros with no settlement record: the channel was closed by a transaction this chain never
    // named, which is the one case a reader cannot turn into evidence.
    const gone = await verifyInference(chain, AGENT, 1, {
      store: chain.store,
      reader: new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 }),
    });
    assert.equal(gone.verdict, "failed");
    assert.include(gone.reason ?? "", "no settlement record");
  });

  it("says no-preimage rather than guessing when the blob is unavailable", async () => {
    const chain = await settledSession();
    const empty = new MemoryTraceStore();
    const r = await verifyInference(chain, AGENT, 2, { store: empty, reader: settledReader() });
    assert.equal(r.verdict, "no-preimage");
    assert.equal(inferenceExitCode(r), 2);
    assert.equal(formatInference(r).pop(), "NOT VERIFIED (no preimage)", "the text must not read as a failed payment");

    const none = await verifyInference(chain, AGENT, 2, { reader: settledReader() });
    assert.equal(none.verdict, "no-preimage", "no store at all is the same answer");
  });

  it("says no-preimage for a vault-rail record, which commits no voucher", async () => {
    const chain = new FakeChain();
    await chain.action(1, null);
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "no-preimage");
    assert.include(r.reason ?? "", "vault-rail");
  });

  it("never throws: a missing seq, a non-Action, a foreign chain id and a broken chain read are verdicts", async () => {
    const chain = await settledSession();
    const missing = await verifyInference(chain, AGENT, 99, { store: chain.store });
    assert.equal(missing.verdict, "failed");
    assert.include(missing.reason ?? "", "no record at seq 99");

    const resolution = await verifyInference(chain, AGENT, 3, { store: chain.store });
    assert.equal(resolution.verdict, "failed");
    assert.include(resolution.reason ?? "", "only an Action carries a voucher");

    const foreign = new FakeChain();
    await foreign.action(1, voucher("0", "750", { chainId: 1 }));
    const wrongChain = await verifyInference(foreign, AGENT, 1, { store: foreign.store, reader: settledReader() });
    assert.equal(wrongChain.verdict, "failed");
    assert.include(wrongChain.reason ?? "", "chain 1");

    const broken = {
      async listEvents(): Promise<readonly InferenceRecord[]> {
        throw new Error("rpc is down");
      },
    };
    const unread = await verifyInference(broken, AGENT, 1, {});
    assert.equal(unread.verdict, "pending", "a chain that could not be read is unchecked, not wrong");
    assert.include(unread.reason ?? "", "rpc is down");
  });

  /**
   * Epoch-batched records. The console commits every Action through the
   * rollup, so the seq a voucher lives at is a *member* of an epoch and `listEvents` returns
   * nothing for it. The step is the same 75 bytes a record would have carried, inside the blob
   * the committed root names, so resolving it makes the verdict identical to the per-event one.
   */
  async function epochSession() {
    const chain = new FakeChain();
    chain.openEpoch(1);
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("750", "1500"));
    await chain.commitEpoch();
    await chain.resolution(3, { txHash: TX, spent: "1500" });
    return chain;
  }

  it("verifies a voucher that an epoch batched, and says which epoch it came out of", async () => {
    const chain = await epochSession();
    assert.lengthOf(chain.records, 1, "only the Resolution has an account of its own");
    const r = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      epochs: chain.epochStore,
      reader: settledReader(),
    });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.cumulativeBefore, "750");
    assert.equal(r.cumulativeAfter, "1500");
    assert.equal(r.txHash, TX, "the settlement after the epoch still covers the call");
    assert.deepEqual(r.epoch, { startSeq: "1", endSeq: "3", member: 1 });
    assert.include(formatInference(r)[1], "seq        2 (epoch 1–3, member 1)");
  });

  it("says no-preimage for an epoch member whose blob is out of reach, and keeps the old wording for a seq in neither", async () => {
    const chain = await epochSession();
    const blind = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(blind.verdict, "no-preimage");
    assert.include(blind.reason ?? "", "is a step of the epoch 1–3");
    assert.include(blind.reason ?? "", "pass an epoch store");

    const empty = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      epochs: new MemoryEpochStore(),
      reader: settledReader(),
    });
    assert.equal(empty.verdict, "no-preimage");
    assert.include(empty.reason ?? "", "not available here");

    // A seq no epoch covers and no record carries is still the answer it always was.
    const nowhere = await verifyInference(chain, AGENT, 99, { store: chain.store, epochs: chain.epochStore });
    assert.equal(nowhere.verdict, "failed");
    assert.include(nowhere.reason ?? "", "no record at seq 99");
  });

  it("fails an epoch member that is not an Action, naming the epoch it was resolved through", async () => {
    const chain = new FakeChain();
    chain.openEpoch(1);
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2, { txHash: TX, spent: "750" });
    await chain.commitEpoch();
    const r = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      epochs: chain.epochStore,
      reader: settledReader(),
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "(epoch 1–3, member 1)");
    assert.include(r.reason ?? "", "only an Action carries a voucher");
  });

  it("catches a bad payer inside an epoch, which the per-event walk could not see at all", async () => {
    const chain = new FakeChain();
    // The edited voucher is a member of the epoch; the record being verified has an account.
    chain.openEpoch(1);
    await chain.action(1, voucher("0", "750", { payer: PAYEE }));
    await chain.commitEpoch();
    await chain.action(2, voucher("750", "1500"));
    await chain.resolution(3, { txHash: TX, spent: "1500" });

    const r = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      epochs: chain.epochStore,
      reader: settledReader(),
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "one channel has one payer");

    // Without the epoch resolved, seq 1 is invisible and the cross-seq check has nothing to walk:
    // this is the verdict a reader that never resolves epochs hides behind "has no record at seq N".
    const blind = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(blind.verdict, "verified", blind.reason);
  });

  it("reads a voucher and a settlement out of the blobs, and ignores bytes that carry neither", () => {
    const blob = utf8(JSON.stringify({ choices: [], payment: voucher("0", "750", { usageCost: 0.000123 }) }));
    const p = paymentFromBlob(blob);
    assert.equal(p?.channelId, CHANNEL);
    assert.equal(p?.usageCost, 0.000123);
    assert.isNull(paymentFromBlob(utf8(JSON.stringify({ choices: [] }))), "a vault blob carries none");
    assert.isNull(paymentFromBlob(utf8("not json at all")));

    assert.equal(settlementFromBlob(utf8(JSON.stringify({ settlement: { txHash: TX } })))?.txHash, TX);
    assert.equal(settlementFromBlob(utf8(JSON.stringify({ txHash: TX, channelId: CHANNEL })))?.channelId, CHANNEL);
    assert.isNull(settlementFromBlob(utf8(JSON.stringify({ output: "done" }))));
  });
});

/**
 * The loop-level check. A loop holds one channel for all of its steps and closes it once, so
 * a chain that ran a loop holds the whole of that channel: the deltas of its vouchers are what the
 * calls cost and `ChannelClosed.finalAmount` is what the escrow paid, and a chain that saw the
 * channel from its open (`cumulativeBefore` 0 on the first voucher) must make those equal. A chain
 * that saw only part of one can claim the weaker thing and no more.
 */
describe("verifyInference: a settlement belongs to the session that wrote it", () => {
  const CHANNEL_B = `0x${"33".repeat(32)}`;
  const TX_B = `0x${"44".repeat(32)}`;
  /** A closed channel A (zeros), and a close receipt that settled channel B only. */
  const readerClosedB = () =>
    new FakeTempoReader(
      { settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 },
      { status: 1, to: TEMPO_ESCROW, closed: closedLog({ channelId: CHANNEL_B, finalAmount: BigInt(900) }) as any }
    );

  it("does not judge a session whose close did not land by the next session's settlement", async () => {
    const chain = new FakeChain();
    // Session 1 on channel A: its close failed, so its Resolution names no settlement.
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2);
    // Session 2 opens channel B and settles it, as an older Resolution does: no channelId.
    await chain.action(3, voucher("0", "900", { channelId: CHANNEL_B }));
    await chain.resolution(4, { txHash: TX_B, spent: "900" });

    const first = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: readerClosedB() });
    assert.equal(first.verdict, "pending", first.reason);
    assert.include(first.reason ?? "", "seq 2");
    assert.include(first.reason ?? "", "names no settlement");
    assert.isUndefined(first.txHash, "channel B's settlement is not reported as this call's");
    assert.equal(inferenceExitCode(first), 4);

    const second = await verifyInference(chain, AGENT, 3, { store: chain.store, reader: readerClosedB() });
    assert.equal(second.verdict, "verified", second.reason);
    assert.equal(second.txHash, TX_B);
  });

  it("stops reading Resolutions at the next Genesis when the call's session never resolved", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.genesis(2, { model: "openai/gpt-4o-mini" });
    await chain.action(3, voucher("0", "900", { channelId: CHANNEL_B }));
    await chain.resolution(4, { txHash: TX_B, spent: "900" });
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: readerClosedB() });
    // No Resolution of session 1 is on the chain, so zeros are what they always were: a channel
    // settled by a transaction no record names.
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "no settlement record names it");
    assert.notInclude(r.reason ?? "", CHANNEL_B, "session 2's settlement is not held against session 1");
  });

  it("skips a Resolution whose settlement names another channel, as the runtime writes it", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2);
    await chain.action(3, voucher("0", "900", { channelId: CHANNEL_B }));
    await chain.resolution(4, { txHash: TX_B, spent: "900", channelId: CHANNEL_B });
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: readerClosedB() });
    assert.equal(r.verdict, "pending", r.reason);
    assert.isUndefined(r.txHash);
  });

  it("says no-preimage, not failed, when the session's own Resolution is unreadable and the channel reads closed", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.resolutionUnstored(2);
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: readerClosedB() });
    assert.equal(r.verdict, "no-preimage");
    assert.include(r.reason ?? "", "seq 2");
  });

  it("still verifies a loop step's call against the loop.settlement many Resolutions later", async () => {
    const chain = new FakeChain();
    await chain.genesis(1, { model: "openai/gpt-4o-mini" });
    await chain.action(2, voucher("0", "750"));
    await chain.resolution(3);
    await chain.genesis(4, { model: "openai/gpt-4o-mini" });
    await chain.action(5, voucher("750", "1500"));
    await chain.resolution(6);
    await chain.loopSettlement(7, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1500" });
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.txHash, TX);
  });

  it("still fails a loop step's channel that reads closed with no loop.settlement: a step's Resolution never settles", async () => {
    const chain = new FakeChain();
    await chain.genesis(1, { model: "openai/gpt-4o-mini" });
    await chain.action(2, voucher("0", "750"));
    await chain.resolution(3);
    // The step's checkpoint follows its Resolution: this was a loop step, whose silence is routine.
    await chain.step(4, {
      loopId: "loop-1",
      step: 1,
      intervalMs: 10_000,
      maxSteps: 5,
      promptHash: hex(sha256(utf8("prompt"))),
      startedAt: 1_790_000_000_000,
    });
    await chain.genesis(5, { model: "openai/gpt-4o-mini" });
    const r = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: readerClosedB() });
    assert.equal(r.verdict, "failed");
    assert.include(r.reason ?? "", "no settlement record names it");
  });

  it("says the same of the session's channel under verify-channel, rather than failing it", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2);
    await chain.action(3, voucher("0", "900", { channelId: CHANNEL_B }));
    await chain.resolution(4, { txHash: TX_B, spent: "900" });
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: readerClosedB() });
    assert.deepEqual(
      r.channels.map((c) => [c.channelId, c.verdict]),
      [
        [CHANNEL, "pending"],
        [CHANNEL_B, "verified"],
      ],
      r.channels.map((c) => c.reason).join("; ")
    );
    assert.include(r.channels[0].reason ?? "", "seq 2");
    assert.include(r.channels[0].reason ?? "", "names no settlement");
    assert.equal(r.verdict, "pending");
    assert.equal(channelsExitCode(r), 4, "the exit code verify-inference gives the same call");
    const call = await verifyInference(chain, AGENT, 1, { store: chain.store, reader: readerClosedB() });
    assert.equal(inferenceExitCode(call), channelsExitCode(r));

    // A later session that paid through no voucher this walk reads still writes a channel-less
    // `{ txHash, spent }`. It closes its own session, not channel A's, which ended at seq 2;
    // attributed to the last channel walked it would fail A as "closed channel B".
    const later = new FakeChain();
    await later.action(1, voucher("0", "750"));
    await later.resolution(2);
    await later.genesis(3, { model: "openai/gpt-4o-mini" });
    await later.resolution(4, { txHash: TX_B, spent: "900" });
    const own = await verifyChannels(later, AGENT, { store: later.store, reader: readerClosedB() });
    assert.equal(own.channels[0].verdict, "pending", own.channels[0].reason);
    assert.include(own.channels[0].reason ?? "", "seq 2");
    assert.notEqual(own.channels[0].txHash, TX_B, "session 2's settlement is not channel A's");

    // Its Resolution unreadable: whether it named a settlement is unknown, as verify-inference says.
    const lost = new FakeChain();
    await lost.action(1, voucher("0", "750"));
    await lost.resolutionUnstored(2);
    const unread = await verifyChannels(lost, AGENT, { store: lost.store, reader: readerClosedB() });
    assert.equal(unread.channels[0].verdict, "no-preimage");

    // A loop step's silent Resolution still says nothing: its channel reads closed, and that fails.
    const loop = new FakeChain();
    await loop.genesis(1, { model: "openai/gpt-4o-mini" });
    await loop.action(2, voucher("0", "750"));
    await loop.resolution(3);
    await loop.step(4, {
      loopId: "loop-1",
      step: 1,
      intervalMs: 10_000,
      maxSteps: 5,
      promptHash: hex(sha256(utf8("prompt"))),
      startedAt: 1_790_000_000_000,
    });
    const step = await verifyChannels(loop, AGENT, { store: loop.store, reader: readerClosedB() });
    assert.equal(step.verdict, "failed");
    assert.include(step.channels[0].reason ?? "", "no settlement record names it");
  });

  it("is still pending while a channel whose close did not land is open and holds enough", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.resolution(2);
    const reader = new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(750), closeRequestedAt: 0 });
    const r = await verifyInference(chain, AGENT, 1, { store: chain.store, reader });
    assert.equal(r.verdict, "pending");
    assert.include(r.reason ?? "", "has not settled yet");
  });
});

describe("verifyChannels: a whole channel's vouchers against what the escrow paid out", () => {
  /** Three calls on one channel, the way a three-step loop writes them, then its settlement. */
  async function loopChain(total = 2250) {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("750", "1500"));
    await chain.action(3, voucher("1500", "2250"));
    await chain.loopSettlement(4, {
      payer: PAYER,
      channelId: CHANNEL,
      closed: true,
      txHash: TX,
      spent: String(total),
    });
    return chain;
  }

  it("verifies a loop whose calls add up to exactly what the channel paid out", async () => {
    const chain = await loopChain();
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(2250) }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "verified", r.reason ?? r.channels[0]?.reason);
    assert.equal(r.channels.length, 1, "one channel for the whole loop");
    const c = r.channels[0];
    assert.deepEqual(c.seqs, ["1", "2", "3"]);
    assert.equal(c.payer, PAYER);
    assert.equal(c.openedAt, "0");
    assert.equal(c.closedAt, "2250");
    assert.equal(c.delta, "2250");
    assert.equal(c.settled, "2250");
    assert.equal(c.txHash, TX);
    assert.isUndefined(c.reason, "a whole channel that balances has nothing to explain");
    assert.equal(channelsExitCode(r), 0);
    assert.equal(formatChannels(r).pop(), "VERIFIED");
  });

  it("fails a channel that paid out more than every call on the chain bought", async () => {
    const chain = await loopChain();
    // The escrow paid 3 000 and the chain accounts for 2 250: a call nobody anchored, or a
    // cumulative signed for something the records do not carry. Either way the two disagree.
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(3000) }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "3000");
    assert.include(r.channels[0].reason ?? "", "exactly what it bought");
    assert.equal(channelsExitCode(r), 2);
  });

  it("fails a channel that paid out less than the calls on it commit to", async () => {
    const chain = await loopChain();
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(1500) }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "1500");
  });

  it("claims only what it can account for when the chain joins a channel mid-life", async () => {
    // A chain written after a restart: the first voucher opens above zero, because the calls
    // before it were paid on the same channel by a process whose records are elsewhere.
    const chain = new FakeChain();
    await chain.action(1, voucher("3000", "3750"));
    await chain.loopSettlement(2, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "3750" });
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(3750) }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.equal(r.channels[0].delta, "750");
    assert.include(r.channels[0].reason ?? "", "holds part of channel");
  });

  it("keeps the arithmetic honest when a voucher between two calls is not readable", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    // The call between them is on the chain but its blob is not in this store, so the verifier
    // sees seq 3 open at 1500 where seq 1 closed at 750. That gap is what stops it from claiming
    // the deltas it can add up are the whole channel — it is a floor, not the total.
    await chain.action(3, voucher("1500", "2250"));
    await chain.loopSettlement(4, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "2250" });
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(2250) }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.equal(r.channels[0].delta, "1500", "two readable calls, not the channel's 2250");
    assert.include(r.channels[0].reason ?? "", "not readable here");
  });

  it("fails two payers on one channel before it opens a socket", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("750", "1500", { payer: "0x0000000000000000000000000000000000000002" }));
    const reader = settledReader();
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "one channel has one payer");
    assert.equal(reader.calls, 0, "the chain disagrees with itself; Tempo has nothing to add");
  });

  it("is pending for the channel a running loop is still paying through", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    const reader = new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(3000), closeRequestedAt: 0 });
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "pending");
    assert.equal(r.channels[0].settled, "3000");
    assert.include(r.channels[0].reason ?? "", "has not settled yet");
    assert.equal(channelsExitCode(r), 4);
    assert.equal(formatChannels(r).pop(), "PENDING");
  });

  it("fails a channel that reads as closed with no settlement record naming it", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    // Zeros are what a closed channel reads as: someone closed it and the chain says so
    // nowhere, which is the whole failure the per-loop settlement exists to make impossible.
    const reader = new FakeTempoReader({ settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 });
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "holds nothing");
  });

  it("checks each channel of a loop that settled and reopened, and one on request", async () => {
    const SECOND = `0x${"33".repeat(32)}`;
    const TX2 = `0x${"44".repeat(32)}`;
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.loopSettlement(2, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "750" });
    // The idle timer settled the first channel; the next step opened a second one, whose
    // cumulative starts again at zero because a channel is its own meter.
    await chain.action(3, voucher("0", "900", { channelId: SECOND }));
    await chain.loopSettlement(4, { payer: PAYER, channelId: SECOND, closed: true, txHash: TX2, spent: "900" });

    const reader: TempoReader = {
      async channelState() {
        return null;
      },
      async closeReceipt(txHash: string) {
        const closed =
          txHash === TX
            ? closedLog({ finalAmount: BigInt(750) })
            : closedLog({ channelId: SECOND, finalAmount: BigInt(900) });
        return { status: 1, to: TEMPO_ESCROW, closed: closed as any };
      },
    };
    const all = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(all.verdict, "verified", all.channels.map((c) => c.reason).join("; "));
    assert.deepEqual(
      all.channels.map((c) => c.channelId),
      [CHANNEL, SECOND],
      "in the order the chain first names them"
    );

    const one = await verifyChannels(chain, AGENT, { store: chain.store, reader, channelId: SECOND });
    assert.equal(one.channels.length, 1);
    assert.equal(one.channels[0].delta, "900");

    const absent = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader,
      channelId: `0x${"99".repeat(32)}`,
    });
    assert.equal(absent.verdict, "failed");
    assert.include(absent.reason ?? "", "no readable voucher");
  });

  it("says a vault-rail chain has nothing to check rather than failing it", async () => {
    const chain = new FakeChain();
    await chain.action(1, null);
    await chain.resolution(2);
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "no-preimage");
    assert.include(r.reason ?? "", "vault-rail");
    assert.equal(channelsExitCode(r), 2);
  });

  it("resolves the calls an epoch batched, which is every Action a console loop writes", async () => {
    const chain = new FakeChain();
    chain.openEpoch(1);
    await chain.action(1, voucher("0", "750"));
    await chain.action(2, voucher("750", "1500"));
    await chain.commitEpoch();
    await chain.loopSettlement(3, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1500" });
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(1500) }));

    const blind = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(blind.verdict, "no-preimage", "without the epoch store no voucher is visible at all");

    const seen = await verifyChannels(chain, AGENT, { store: chain.store, reader, epochs: chain.epochStore });
    assert.equal(seen.verdict, "verified", seen.channels[0]?.reason);
    assert.deepEqual(seen.channels[0].seqs, ["1", "2"]);
  });

  it("is pending, not wrong, when there is no Tempo reader at all", async () => {
    const chain = await loopChain();
    const r = await verifyChannels(chain, AGENT, { store: chain.store });
    assert.equal(r.verdict, "pending");
    assert.include(r.channels[0].reason ?? "", "pass a Tempo RPC");
    assert.equal(r.channels[0].txHash, TX, "the settlement the chain names is still reported");
  });
});

describe("verifyChannels: the decisions a loop's checkpoints commit, and the user's debit", () => {
  const manifest = (step: number, extra: Partial<LoopStepManifest> = {}): LoopStepManifest => ({
    loopId: "loop-1",
    step,
    intervalMs: 10_000,
    maxSteps: 5,
    promptHash: hex(sha256(utf8("prompt"))),
    startedAt: 1_790_000_000_000,
    ...extra,
  });

  /**
   * A verified loop: step 1's call, Jev's verdict on it (paid on the loop's channel, recorded only
   * through the checkpoint's `verifyHash`), step 2's call, then the settlement.
   */
  async function verifiedLoop(decision = voucher("750", "792")) {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    const verifyHash = await chain.blob({ payment: decision, model: "jev", id: "d1" });
    await chain.step(2, manifest(1, { verifyHash }));
    await chain.action(3, voucher("792", "1542"));
    await chain.loopSettlement(4, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1542" });
    return chain;
  }

  it("counts a decision's bracket, so the channel is checked whole and an inflated payout fails", async () => {
    const chain = await verifiedLoop();
    const exact = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(1542) })),
    });
    assert.equal(exact.verdict, "verified", exact.channels[0]?.reason);
    const c = exact.channels[0];
    assert.deepEqual(c.seqs, ["1", "3"], "the decision is not an Action");
    assert.deepEqual(c.decisions, { count: 1, delta: "42" });
    assert.equal(c.delta, "1542");
    assert.equal(c.closedAt, "1542");
    assert.isUndefined(c.reason, "the decision closes the gap between the calls, so the channel is whole");
    assert.include(formatChannels(exact).join("\n"), "decisions  1 committed");

    // Left as a gap, the decision would make the channel a part, held only to Σdelta ≤ paid, and 2000 would pass.
    const inflated = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(2000) })),
    });
    assert.equal(inflated.verdict, "failed");
    assert.include(inflated.channels[0].reason ?? "", "2 calls and 1 decisions");
    assert.include(inflated.channels[0].reason ?? "", "exactly what it bought");
  });

  it("fails a decision whose bracket overlaps a call's, and leaves a missing decision blob as the gap it is", async () => {
    const overlapping = await verifiedLoop(voucher("700", "792"));
    const r = await verifyChannels(overlapping, AGENT, {
      store: overlapping.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(1542) })),
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "overlapping vouchers");

    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.step(2, manifest(1, { verifyHash: "ab".repeat(32) }));
    await chain.action(3, voucher("792", "1542"));
    await chain.loopSettlement(4, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1542" });
    const part = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(1542) })),
    });
    assert.equal(part.verdict, "verified", part.channels[0]?.reason);
    assert.isUndefined(part.channels[0].decisions);
    assert.include(part.channels[0].reason ?? "", "holds part of channel");
  });

  it("leaves a roadmap step's gate asks and trace-audit calls as gaps: the weaker claim, never a failure", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.step(2, manifest(1));
    // Two gate asks between the steps, the second one the wake; then the woken step's call and its
    // trace audit with a confirm call. Those are roadmap features this build does not verify, so it
    // names none of them a bracket: the channel is held to what its calls show.
    const ask0 = await chain.blob({ payment: voucher("750", "792") });
    const ask1 = await chain.blob({ payment: voucher("792", "834") });
    const gateHash = await chain.blob({
      v: 1,
      loopId: "loop-1",
      sinceStep: 1,
      from: 1,
      to: 2,
      quiet: { ticks: 0, unreadable: 0 },
      costBase: "84",
      asks: [
        { t: 1, refs: [], readingsHash: "00".repeat(32), decisionHash: ask0 },
        { t: 2, refs: [], readingsHash: "00".repeat(32), decisionHash: ask1 },
      ],
      wake: { t: 2, reason: "gate", decisionHash: ask1, readings: [] },
      readingsAtLastStep: [],
    });
    await chain.action(3, voucher("834", "1584"));
    const traceAuditHash = await chain.blob({
      payment: voucher("1584", "1626"),
      confirm: { payment: voucher("1626", "1700") },
    });
    await chain.step(4, manifest(2, { gateHash, traceAuditHash }));
    await chain.loopSettlement(5, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1700" });
    const r = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(1700) })),
    });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.isUndefined(r.channels[0].decisions, "no decision of a roadmap feature is counted");
    assert.include(r.channels[0].reason ?? "", "holds part of channel");
  });

  it("holds a debit to the runtime's rule, applied once to the summed cost", () => {
    assert.equal(gateChargeMicroUsdc(84n), 93n, "84 → 93, not 2 × 47");
    assert.equal(gateChargeMicroUsdc(42n), 47n);
    assert.equal(gateChargeMicroUsdc(0n), 0n);
    assert.equal(DEFAULT_MARGIN_BPS, 1_000);
    for (const base of [0n, 1n, 42n, 84n, 99n, 1_234_567n]) {
      for (const margin of [0, 0.1, 0.25, 0.0333]) {
        assert.equal(
          gateChargeMicroUsdc(base, Math.round(margin * 10_000)),
          toMicroUsdcFromBase(base, margin),
          `${base} at ${margin}`
        );
      }
    }
  });

  it("reads a transaction's lath-billing charge and nothing else", () => {
    const disc = (name: string) =>
      (LATH_BILLING_IDL.instructions as unknown as { name: string; discriminator: number[] }[]).find(
        (i) => i.name === name
      )!.discriminator;
    const ix = (name: string, amount: bigint, programId: string = LATH_BILLING_PROGRAM_ID) => {
      const data = new Uint8Array(16);
      data.set(disc(name), 0);
      for (let i = 0; i < 8; i++) data[8 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
      return { programId, data };
    };
    assert.equal(billingChargeDebit([]), 0n);
    assert.equal(billingChargeDebit([ix("charge", 93n)]), 93n);
    assert.equal(billingChargeDebit([ix("charge", 93n), ix("charge", 7n)]), 100n);
    assert.equal(billingChargeDebit([ix("reserve", 93n)]), 0n, "a hold is not a debit");
    assert.equal(billingChargeDebit([ix("charge", 93n, "11111111111111111111111111111111")]), 0n);
    assert.equal(billingChargeDebit([ix("charge", 2n ** 40n + 3n)]), 2n ** 40n + 3n, "a u64, little-endian");
  });

  it("holds each per-event call's debit to ceil(delta × (1 + margin)) when asked, and never asks for an epoch member", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    chain.openEpoch(2);
    await chain.action(2, voucher("750", "1500"));
    await chain.commitEpoch();
    await chain.loopSettlement(3, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1500" });
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(1500) }));
    const asked: string[] = [];
    const debits = (answer: (seq: bigint) => bigint | null) => async (_agent: string, seq: bigint) => {
      asked.push(seq.toString());
      return answer(seq);
    };

    // 750 base units at the default 0.10 margin is 825 µUSDC.
    const ok = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader,
      epochs: chain.epochStore,
      debitOf: debits(() => 825n),
    });
    assert.equal(ok.verdict, "verified", ok.channels[0]?.reason);
    assert.deepEqual(asked, ["1"], "the epoch member at seq 2 has no transaction of its own to read");
    assert.deepEqual(ok.channels[0].debits, [
      { seq: "1", deltaBase: "750", expectedMicroUsdc: "825", debitMicroUsdc: "825", status: "ok" },
    ]);
    assert.include(formatChannels(ok).join("\n"), "debits     1 per-event calls: 1 match");

    const epochs = chain.epochStore;
    const wrong = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader,
      epochs,
      debitOf: debits(() => 900n),
    });
    assert.equal(wrong.verdict, "failed");
    assert.include(wrong.channels[0].reason ?? "", "900 µUSDC");
    assert.include(wrong.channels[0].reason ?? "", "--margin");

    const atMargin = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader,
      epochs,
      debitOf: debits(() => 900n),
      marginBps: 2_000,
    });
    assert.equal(atMargin.verdict, "verified", "750 × 1.2 is 900");

    const free = await verifyChannels(chain, AGENT, { store: chain.store, reader, epochs, debitOf: debits(() => 0n) });
    assert.equal(free.verdict, "verified", "a call the user was not debited for is not an overcharge");
    assert.equal(free.channels[0].debits![0].status, "uncharged");

    const unread = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader,
      epochs,
      debitOf: debits(() => null),
    });
    assert.equal(unread.verdict, "verified");
    assert.equal(unread.channels[0].debits![0].status, "unchecked");
    assert.include(formatChannels(unread).join("\n"), "1 not read");

    const unasked = await verifyChannels(chain, AGENT, { store: chain.store, reader, epochs });
    assert.isUndefined(unasked.channels[0].debits, "no debitOf, no debit line: the report is the one it was");
  });
});

describe("a voucher is an LLM call's, and a payment in a tool's output is not one", () => {
  /** What a prompt-injected loop can write into a report: a voucher-shaped object at an absurd height. */
  const forged = (payer = PAYER) => JSON.stringify({ payment: voucher("0", "999999999999", { payer }) });
  const settledAt = (amount: number) => settledReader({}, closedLog({ finalAmount: BigInt(amount) }));

  async function reportedLoop(toolId: string, report: string) {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "100"));
    await chain.action(2, voucher("100", "200"));
    await chain.toolAction(3, toolId, report);
    await chain.action(4, voucher("200", "300"));
    await chain.loopSettlement(5, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "300" });
    return chain;
  }

  it("verifies an honest chain whose sandboxed model stored or read a report shaped like a voucher", async () => {
    for (const toolId of ["storage.put", "zc.file_read"]) {
      const chain = await reportedLoop(toolId, forged());
      const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader: settledAt(300) });
      assert.equal(channels.verdict, "verified", `${toolId}: ${channels.channels.map((c) => c.reason).join("; ")}`);
      assert.deepEqual(
        channels.channels.map((c) => c.seqs),
        [["1", "2", "4"]]
      );
      const call = await verifyInference(chain, AGENT, 4, { store: chain.store, reader: settledAt(300) });
      assert.equal(call.verdict, "verified", `${toolId}: ${call.reason}`);
      const report = await verifyInference(chain, AGENT, 3, { store: chain.store, reader: settledAt(300) });
      assert.equal(report.verdict, "no-preimage");
      assert.include(report.reason ?? "", "is not a paid call");
    }
  });

  it("reads a paid failure's voucher, whose result names no model, by the model its request names", async () => {
    const chain = new FakeChain();
    // `paidChat`'s failure path: `llm.${policy.model}`, the request as args, `{ error, payment }` as result.
    const request = { model: "openai/gpt-4o-mini", messages: [], usage: { include: true } };
    const failure = JSON.stringify({ error: "upstream 502", payment: voucher("0", "100") });
    await chain.toolAction(1, "llm.openai/gpt-4o-mini", failure, request);
    await chain.action(2, voucher("100", "200"));
    await chain.loopSettlement(3, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "200" });
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: settledAt(200) });
    assert.equal(r.verdict, "verified", r.channels.map((c) => c.reason).join("; "));
    assert.deepEqual(r.channels[0].seqs, ["1", "2"]);
    // The same bytes under a tool id that names another model are not that call's voucher.
    const other = new FakeChain();
    await other.toolAction(1, "llm.anthropic/claude", failure, request);
    const none = await verifyChannels(other, AGENT, { store: other.store, reader: settledAt(200) });
    assert.equal(none.verdict, "no-preimage");
  });
});

describe("the escrow calls the reader makes", () => {
  it("encodes getChannelState under the selector the probe measured", async () => {
    const data = await channelStateCalldata(CHANNEL);
    assert.equal(data.slice(0, 10), "0xd18da8b1", "the selector the probe read the channel with");
    assert.equal(data.length, 10 + 64, "one 32-byte word of channel id");
  });

  it("derives the ChannelClosed topic the probe read off the close transaction", async () => {
    assert.equal(CHANNEL_CLOSED_SIGNATURE, "ChannelClosed(bytes32,address,address,uint96,uint96)");
    const topic = await channelClosedTopic();
    assert.equal(topic.slice(0, 10).toLowerCase(), "0x5613aed9");
    assert.equal(topic.slice(-4).toLowerCase(), "06e6");
    assert.equal(hex(sha256(utf8(topic))).length, 64, "a 32-byte topic prints as one");
  });

  it("is the topic and escrow the browser's close check compares against, so the two cannot drift", async () => {
    // `frontend/src/lib/tempo-close.ts` restates both so viem stays out of the browser bundle;
    // the badge's VERIFIED rests on them.
    assert.equal(CHANNEL_CLOSED_TOPIC, (await channelClosedTopic()).toLowerCase());
    assert.equal(TEMPO_ESCROW_ADDRESS, TEMPO_ESCROW.toLowerCase());
  });
});

describe("whom a close paid, and in what", () => {
  const OPERATOR = "0x000000000000000000000000000000000000beef";
  const SECOND = `0x${"33".repeat(32)}`;
  const TX2 = `0x${"44".repeat(32)}`;

  /** A settled reader that also reads the channel's open, in `token`. */
  const openingReader = (token: string, log = closedLog({ finalAmount: BigInt(1500) })) => {
    const r = settledReader({}, log) as FakeTempoReader & TempoReader;
    r.channelOpened = async (channelId: string) => ({
      channelId,
      payer: PAYER,
      payee: PAYEE,
      token,
      authorizedSigner: PAYER,
      deposit: BigInt(2500),
    });
    return r;
  };

  it("fails a channel the treasury opened to itself, whose close pays its finalAmount straight back", async () => {
    const chain = await settledSession();
    const reader = settledReader({}, closedLog({ payee: PAYER }));
    const call = await verifyInference(chain, AGENT, 2, { store: chain.store, reader, expectedPayer: PAYER });
    assert.equal(call.verdict, "failed");
    assert.include(call.reason ?? "", "closed to its own payer");
    assert.equal(call.payee, PAYER);
    const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(channels.verdict, "failed");
    assert.include(channels.channels[0].reason ?? "", "it paid no provider");
    assert.include(formatChannels(channels).join("\n"), `payee      ${PAYER}`);
  });

  it("holds the close to --payee, and prints whom it paid", async () => {
    const chain = await settledSession();
    const reader = settledReader({}, closedLog({ payee: OPERATOR }));
    const wrong = await verifyInference(chain, AGENT, 2, { store: chain.store, reader, expectedPayee: PAYEE });
    assert.equal(wrong.verdict, "failed");
    assert.include(wrong.reason ?? "", `paid ${OPERATOR}, not ${PAYEE}, the gateway --payee names`);
    const right = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader(),
      expectedPayee: PAYEE.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(right.verdict, "verified", right.reason);
    assert.include(formatInference(right), `payee      ${PAYEE}`);
    // A reader that cannot read the open leaves the token unchecked, and the verdict as it was.
    assert.equal(right.token?.status, "unchecked");
    const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader, expectedPayee: PAYEE });
    assert.equal(channels.verdict, "failed");
  });

  it("holds every channel of a chain to the payee of its first verified close when --payee is absent", async () => {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "750"));
    await chain.loopSettlement(2, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "750" });
    await chain.action(3, voucher("0", "900", { channelId: SECOND }));
    await chain.loopSettlement(4, { payer: PAYER, channelId: SECOND, closed: true, txHash: TX2, spent: "900" });
    const reader = (secondPayee: string): TempoReader => ({
      async channelState() {
        return null;
      },
      async closeReceipt(txHash: string) {
        const closed =
          txHash === TX
            ? closedLog({ finalAmount: BigInt(750) })
            : closedLog({ channelId: SECOND, finalAmount: BigInt(900), payee: secondPayee });
        return { status: 1, to: TEMPO_ESCROW, closed: closed as any };
      },
    });
    const mixed = await verifyChannels(chain, AGENT, { store: chain.store, reader: reader(OPERATOR) });
    assert.equal(mixed.verdict, "failed");
    assert.deepEqual(
      mixed.channels.map((c) => [c.verdict, c.payee]),
      [
        ["verified", PAYEE],
        ["failed", OPERATOR],
      ]
    );
    assert.include(mixed.channels[1].reason ?? "", "whom this chain's first settled channel paid");
    const one = await verifyChannels(chain, AGENT, { store: chain.store, reader: reader(PAYEE) });
    assert.equal(one.verdict, "verified", one.channels.map((c) => c.reason).join("; "));
  });

  it("fails a channel opened in a token other than USDC.e, read from its ChannelOpened", async () => {
    const chain = await settledSession();
    const FAKE = "0x00000000000000000000000000000000000f4ce0";
    const fake = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: openingReader(FAKE) });
    assert.equal(fake.verdict, "failed");
    assert.include(fake.reason ?? "", `opened in ${FAKE}, not USDC.e`);
    const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader: openingReader(FAKE) });
    assert.equal(channels.verdict, "failed");
    assert.equal(channels.channels[0].token?.status, "failed");
    const real = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: openingReader("0x20C000000000000000000000b9537d11c60E8b50"),
    });
    assert.equal(real.verdict, "verified", real.channels[0]?.reason);
    assert.include(formatChannels(real), "token      ok: USDC.e");
  });
});

describe("a close transaction that closed several channels", () => {
  const SECOND = `0x${"33".repeat(32)}`;

  async function secondChannelLoop() {
    const chain = new FakeChain();
    await chain.action(1, voucher("0", "900", { channelId: SECOND }));
    await chain.loopSettlement(2, { payer: PAYER, channelId: SECOND, closed: true, txHash: TX, spent: "900" });
    return chain;
  }

  it("judges a channel by its own ChannelClosed in the receipt, not by the first one", async () => {
    const chain = await secondChannelLoop();
    // The gateway batched two closes into one transaction, and this chain's channel is the second.
    const first = closedLog({ finalAmount: BigInt(750) });
    const mine = closedLog({ channelId: SECOND, finalAmount: BigInt(900) });
    const reader = settledReader({ closures: [first, mine] as any }, first);
    const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(channels.verdict, "verified", channels.channels.map((c) => c.reason).join("; "));
    assert.equal(channels.channels[0].settled, "900");
    const call = await verifyInference(chain, AGENT, 1, { store: chain.store, reader });
    assert.equal(call.verdict, "verified", call.reason);
    assert.equal(call.settled, "900");
    // A receipt that closed only some other channel still fails, naming the one it closed.
    const other = await verifyChannels(chain, AGENT, { store: chain.store, reader: settledReader({}, first) });
    assert.equal(other.verdict, "failed");
    assert.include(other.channels[0].reason ?? "", `closed channel ${CHANNEL}, not ${SECOND}`);
  });

  it("reads every escrow ChannelClosed off the receipt and answers with the one asked for", async () => {
    const log = (channelId: string, finalAmount: bigint, address = TEMPO_ESCROW) => ({
      address,
      topics: encodeEventTopics({
        abi: ESCROW_ABI as any,
        eventName: "ChannelClosed",
        args: { channelId, payer: PAYER, payee: PAYEE },
      } as any) as string[],
      data: encodeAbiParameters([{ type: "uint96" }, { type: "uint96" }], [finalAmount, BigInt(0)] as any),
    });
    const reader = new TempoRpcReader({
      request: async (method: string) => {
        if (method !== "eth_getTransactionReceipt") throw new Error(`unexpected ${method}`);
        return {
          status: "0x1",
          to: TEMPO_ESCROW,
          // A lookalike from another contract first: only the escrow's own logs are closes.
          logs: [log(SECOND, BigInt(1), PAYEE), log(CHANNEL, BigInt(750)), log(SECOND, BigInt(900))],
        };
      },
    });
    const asked = await reader.closeReceipt(TX, SECOND);
    assert.equal(asked?.closed?.channelId.toLowerCase(), SECOND);
    assert.equal(asked?.closed?.finalAmount, BigInt(900));
    assert.deepEqual(
      asked?.closures?.map((c) => c.finalAmount),
      [BigInt(750), BigInt(900)]
    );
    // Asked nothing, it answers with the first, as it always did.
    const first = await reader.closeReceipt(TX);
    assert.equal(first?.closed?.channelId.toLowerCase(), CHANNEL);
  });
});

/**
 * The loop key checks (docs/ARCHITECTURE.md §7.3). A loop that pays through its
 * own access key commits `tempoKey` in its Genesis policy, and only then are (a) the authorize and
 * (b) each channel's signer checked. Every chain above has no Genesis policy with a key and is
 * judged exactly as it was; the first cases here say so of a chain that *has* a policy, without one.
 */
describe("the loop key checks, gated on the committed policy", () => {
  const TREASURY = PAYER;
  const KEY = "0x5eed00000000000000000000000000000000c0de";
  const STRANGER = "0x0000000000000000000000000000000000000bad";
  const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
  const AUTH_TX = `0x${"55".repeat(32)}`;
  const EXPIRY = 1_762_000_000;
  const tempoKey = { address: KEY, token: USDC_E, limitBase: "2500", expiry: EXPIRY, authorizeTx: AUTH_TX };
  const policyWith = (k?: Record<string, unknown>) => ({
    model: "openai/gpt-4o-mini",
    rail: "tempo",
    ...(k ? { tempoKey: k } : {}),
  });

  const openedLog = (over: Partial<ChannelOpenedLog> = {}): ChannelOpenedLog => ({
    channelId: CHANNEL,
    payer: TREASURY,
    payee: PAYEE,
    token: USDC_E,
    authorizedSigner: KEY,
    deposit: BigInt(2500),
    blockNumber: "4100",
    ...over,
  });
  const authLog = (over: Partial<KeyAuthorizedLog> = {}): KeyAuthorizedLog => ({
    status: 1,
    account: TREASURY,
    publicKey: KEY,
    expiry: EXPIRY,
    limits: [{ token: USDC_E, amount: BigInt(2500) }],
    limitsFrom: "authorization",
    blockNumber: "4000",
    ...over,
  });

  /** A settled reader that also answers the two key reads, and records what it was asked. */
  class KeyReader extends FakeTempoReader {
    opened: [string, string | undefined][] = [];
    authorized: string[] = [];
    readonly open: ChannelOpenedLog | null;
    readonly auth: KeyAuthorizedLog | null;
    constructor(open: ChannelOpenedLog | null = openedLog(), auth: KeyAuthorizedLog | null = authLog()) {
      super(
        { settled: BigInt(0), deposit: BigInt(0), closeRequestedAt: 0 },
        { status: 1, to: TEMPO_ESCROW, closed: closedLog({ finalAmount: BigInt(2250) }) as any }
      );
      this.open = open;
      this.auth = auth;
    }
    async channelOpened(channelId: string, fromBlock?: string): Promise<ChannelOpenedLog | null> {
      this.opened.push([channelId, fromBlock]);
      return this.open;
    }
    async keyAuthorized(txHash: string): Promise<KeyAuthorizedLog | null> {
      this.authorized.push(txHash);
      return this.auth;
    }
  }

  /** A three-step loop: each step opens with a Genesis naming the policy, then pays one call. */
  async function keyedLoop(
    policy: Record<string, unknown>,
    signed: (seq: number) => Record<string, unknown> = () => ({})
  ) {
    const chain = new FakeChain();
    await chain.genesis(1, policy);
    await chain.action(2, voucher("0", "750", { signer: KEY, openBlock: "4200", ...signed(2) }));
    await chain.genesis(3, policy);
    await chain.action(4, voucher("750", "1500", { signer: KEY, openBlock: "4100", ...signed(4) }));
    await chain.genesis(5, policy);
    await chain.action(6, voucher("1500", "2250", { signer: KEY, ...signed(6) }));
    await chain.loopSettlement(7, { payer: TREASURY, channelId: CHANNEL, closed: true, txHash: TX, spent: "2250" });
    return chain;
  }

  it("leaves a chain whose policy commits no tempoKey exactly as it was: no key field, no key read", async () => {
    const chain = await keyedLoop(policyWith());
    const reader = new KeyReader();
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.notProperty(r, "key");
    assert.notProperty(r.channels[0], "key");
    assert.isUndefined(r.reason);
    // The one ChannelOpened read is the token's, which every close that verifies gets;
    // nothing about a key is read or reported.
    assert.deepEqual(reader.opened, [[CHANNEL, "4100"]], "one open read, for the channel's token");
    assert.equal(r.channels[0].token?.status, "ok");
    assert.deepEqual(reader.authorized, [], "no authorize read either");
    assert.notInclude(formatChannels(r).join("\n"), "key ");

    const one = await verifyInference(chain, AGENT, 4, { store: chain.store, reader });
    assert.equal(one.verdict, "verified", one.reason);
    assert.notProperty(one, "key");
    assert.notInclude(formatInference(one).join("\n"), "key ");
  });

  it("verifies a keyed loop: authorized on the treasury with the committed terms, every channel opened by the key", async () => {
    const chain = await keyedLoop(policyWith(tempoKey));
    const reader = new KeyReader();
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "verified", r.reason ?? r.channels[0]?.reason);
    assert.equal(r.key?.status, "ok", r.key?.detail);
    assert.equal(r.key?.address, KEY);
    assert.equal(r.channels[0].key?.status, "ok", r.channels[0].key?.detail);
    assert.deepEqual(reader.authorized, [AUTH_TX], "the one receipt the policy names");
    assert.deepEqual(reader.opened, [[CHANNEL, "4100"]], "read from the lowest open block the records carry");

    const lines = formatChannels(r);
    assert.equal(lines[1], `key        ${KEY}`);
    assert.equal(
      lines[2],
      `  (a) authorized   ok: authorize ${AUTH_TX} ok (root ${TREASURY}, expiry ${EXPIRY}, limit 2500 of ${USDC_E})`
    );
    assert.equal(lines[3], "  (b) signed       ok: 1 of 1 channels opened with the key as authorizedSigner");
    assert.equal(
      lines[4],
      "  limit reconciles: unchecked (audit (c), every SpendingLimitUpdated against the reconcile, is Q4)"
    );
    assert.include(
      lines.join("\n"),
      `key        ok: channel ${CHANNEL} opened at block 4100 with the key as authorizedSigner; ` +
        "3 of 3 vouchers name the key as signer"
    );
    assert.equal(lines.pop(), "VERIFIED");
    assert.equal(channelsExitCode(r), 0);

    const one = await verifyInference(chain, AGENT, 4, { store: chain.store, reader });
    assert.equal(one.verdict, "verified", one.reason);
    assert.equal(one.key?.status, "ok", one.key?.detail);
    assert.include(formatInference(one).join("\n"), `key        ${KEY} ok: (a) authorize ${AUTH_TX} ok`);
  });

  it("fails (b) for a channel the escrow says was opened by another authorizedSigner", async () => {
    const chain = await keyedLoop(policyWith(tempoKey));
    const reader = new KeyReader(openedLog({ authorizedSigner: STRANGER }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.equal(r.channels[0].verdict, "failed", "the channel's own amounts balance; its signer does not");
    assert.equal(r.channels[0].key?.status, "failed");
    assert.include(r.channels[0].reason ?? "", `authorizedSigner ${STRANGER}, not the committed key ${KEY}`);
    assert.equal(r.key?.status, "ok", "(a) is about the authorize, which is fine");
    assert.include(formatChannels(r)[3], "  (b) signed       failed: 1 of 1 channels");
    assert.equal(channelsExitCode(r), 2);

    const one = await verifyInference(chain, AGENT, 2, { store: chain.store, reader });
    assert.equal(one.verdict, "failed");
    assert.include(one.reason ?? "", `authorizedSigner ${STRANGER}`);
  });

  it("fails (b) for a voucher that names another signer, with no Tempo read needed", async () => {
    const chain = await keyedLoop(policyWith(tempoKey), (seq) => (seq === 4 ? { signer: STRANGER } : {}));
    const r = await verifyChannels(chain, AGENT, { store: chain.store });
    assert.equal(r.verdict, "failed");
    assert.equal(r.channels[0].key?.status, "failed");
    assert.include(r.channels[0].reason ?? "", `seq 4's voucher on channel ${CHANNEL} was signed by ${STRANGER}`);

    const one = await verifyInference(chain, AGENT, 6, { store: chain.store });
    assert.equal(one.verdict, "failed");
    assert.include(one.reason ?? "", "seq 4's voucher");
  });

  for (const [name, auth, words] of [
    ["a lower limit", authLog({ limits: [{ token: USDC_E, amount: BigInt(2000) }] }), "set a limit of 2000"],
    // The receipt's later `SpendingLimitUpdated` is the limit in force, not the first one.
    [
      "a limit lowered later in the same transaction",
      authLog({
        limits: [
          { token: USDC_E, amount: BigInt(2500) },
          { token: USDC_E, amount: BigInt(2000) },
        ],
        limitsFrom: "logs",
      }),
      "set a limit of 2000",
    ],
    ["another expiry", authLog({ expiry: EXPIRY + 86_400 }), `not the committed ${EXPIRY}`],
    ["another root", authLog({ account: STRANGER }), `on ${STRANGER}, not on the chain's payer ${TREASURY}`],
    ["another key", authLog({ publicKey: STRANGER }), `authorized key ${STRANGER}`],
    ["a reverted transaction", authLog({ status: 0 }), "reverted"],
    ["no limit on the token", authLog({ limits: [] }), "set no limit on"],
    ["no KeyAuthorized at all", authLog({ account: "", publicKey: "" }), "carries no KeyAuthorized"],
  ] as [string, KeyAuthorizedLog, string][]) {
    it(`fails (a) for an authorize with ${name}`, async () => {
      const chain = await keyedLoop(policyWith(tempoKey));
      const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: new KeyReader(openedLog(), auth) });
      assert.equal(r.key?.status, "failed");
      assert.include(r.key?.detail ?? "", words);
      assert.equal(r.verdict, "failed", "the cap Tempo enforces is not the cap the chain committed");
      assert.include(r.reason ?? "", "the loop's Tempo key:");
      assert.equal(r.channels[0].verdict, "verified", "the channel itself still balances");
      assert.include(formatChannels(r)[2], "  (a) authorized   failed:");

      const one = await verifyInference(chain, AGENT, 4, {
        store: chain.store,
        reader: new KeyReader(openedLog(), auth),
      });
      assert.equal(one.verdict, "failed");
      assert.include(one.reason ?? "", words);
    });
  }

  it("holds the key to the last limit its authorize set, so a later update to the committed one passes", async () => {
    const chain = await keyedLoop(policyWith(tempoKey));
    const auth = authLog({
      limits: [
        { token: USDC_E, amount: BigInt(2000) },
        { token: USDC_E, amount: BigInt(2500) },
      ],
      limitsFrom: "logs",
    });
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: new KeyReader(openedLog(), auth) });
    assert.equal(r.key?.status, "ok", r.key?.detail);
    assert.include(r.key?.detail ?? "", "limit 2500");
  });

  // Pending, not verified: the cap is the half of (a) the policy commits the key for, and VERIFIED
  // with exit 0 would say it was held to Tempo when nothing said what Tempo enforces. Not failed
  // either: the receipt did not contradict the policy, it was silent.
  it("leaves the limit half unchecked, not failed, and the verdict pending, when nothing said what the limit was", async () => {
    const chain = await keyedLoop(policyWith(tempoKey));
    const reader = new KeyReader(openedLog(), authLog({ limits: [], limitsFrom: undefined }));
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(r.key?.status, "unchecked");
    assert.include(r.key?.detail ?? "", "limit unchecked");
    assert.equal(r.channels[0].verdict, "verified", "the channel itself balances");
    assert.equal(r.verdict, "pending");
    assert.include(r.reason ?? "", "the loop's Tempo key is unchecked: (a) authorize");
    assert.equal(formatChannels(r).pop(), "PENDING");
    assert.equal(channelsExitCode(r), 4);
  });

  it("is unchecked and never failed for a reader without the key reads, one answering null, and one that throws", async () => {
    const chain = await keyedLoop(policyWith(tempoKey));
    const old = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(2250) })),
    });
    // An unread key holds the verdict at pending (exit 4), as an unread close does: not wrong, not checked.
    assert.equal(old.verdict, "pending", old.reason ?? old.channels[0]?.reason);
    assert.equal(old.channels[0].verdict, "verified", "the channel's own amounts were read and balance");
    assert.equal(channelsExitCode(old), 4);
    assert.equal(old.key?.status, "unchecked");
    assert.include(old.key?.detail ?? "", "no Tempo reader that reads KeyAuthorized");
    assert.equal(old.channels[0].key?.status, "unchecked");
    assert.include(old.channels[0].key?.detail ?? "", "no Tempo reader that reads ChannelOpened");

    const silent = await verifyChannels(chain, AGENT, { store: chain.store, reader: new KeyReader(null, null) });
    assert.equal(silent.verdict, "pending");
    assert.equal(silent.key?.status, "unchecked");
    assert.equal(silent.channels[0].key?.status, "unchecked");
    assert.include(silent.channels[0].key?.detail ?? "", "could not be read from block 4100");
    assert.include(formatChannels(silent)[3], "  (b) signed       unchecked: 1 of 1 channels not read");

    const throwing = new KeyReader();
    throwing.channelOpened = async () => {
      throw new Error("node is down");
    };
    throwing.keyAuthorized = async () => {
      throw new Error("node is down");
    };
    const down = await verifyChannels(chain, AGENT, { store: chain.store, reader: throwing });
    assert.equal(down.verdict, "pending");
    assert.equal(down.key?.status, "unchecked");
    assert.include(down.channels[0].key?.detail ?? "", "node is down");

    // `verify-inference` holds the same gap the same way: the call settled, its key was not read.
    const one = await verifyInference(chain, AGENT, 4, { store: chain.store, reader: new KeyReader(null, null) });
    assert.equal(one.verdict, "pending", one.reason);
    assert.equal(one.key?.status, "unchecked");
    assert.include(one.reason, "the loop's Tempo key is unchecked");

    // No reader at all: (b)'s chain-only half still runs, and the verdict is the old pending.
    const none = await verifyChannels(chain, AGENT, { store: chain.store });
    assert.equal(none.verdict, "pending");
    assert.equal(none.channels[0].key?.status, "unchecked");
  });

  it("holds only the channels written under the key to it, not a chat session's channel beside it", async () => {
    const CHAT = `0x${"66".repeat(32)}`;
    const chain = new FakeChain();
    await chain.genesis(1, policyWith(tempoKey));
    await chain.action(2, voucher("0", "750", { signer: KEY, openBlock: "4100" }));
    await chain.genesis(3, policyWith());
    await chain.action(4, voucher("0", "900", { channelId: CHAT }));
    const reader = new KeyReader();
    const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    const [loopChannel, chatChannel] = r.channels;
    assert.equal(loopChannel.key?.status, "ok", loopChannel.key?.detail);
    assert.notProperty(chatChannel, "key", "a treasury-signed session's channel is judged as before");
    assert.deepEqual(reader.opened, [[CHANNEL, "4100"]]);
  });

  it("says why under --key when the policy commits no key, or when no policy is readable", async () => {
    const chain = await keyedLoop(policyWith());
    const asked = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: new KeyReader(),
      requireKey: true,
    });
    assert.equal(asked.verdict, "verified");
    assert.deepEqual(asked.key, { status: "unchecked", detail: NO_TEMPO_KEY });
    assert.equal(formatChannels(asked)[1], `key        ${NO_TEMPO_KEY}`);
    assert.equal(NO_TEMPO_KEY, "no tempoKey committed: this loop's payments were treasury-signed");

    const bare = await settledSession();
    const unread = await verifyChannels(bare, AGENT, { store: bare.store, reader: settledReader(), requireKey: true });
    assert.deepEqual(unread.key, { status: "unchecked", detail: TEMPO_KEY_POLICY_UNREAD });

    const one = await verifyInference(chain, AGENT, 4, {
      store: chain.store,
      reader: new KeyReader(),
      requireKey: true,
    });
    assert.equal(one.verdict, "verified");
    assert.deepEqual(one.key, { status: "unchecked", detail: NO_TEMPO_KEY });
  });

  it("round-trips signer and openBlock through paymentFromBlob, and drops them when they are not strings", () => {
    const kept = paymentFromBlob(
      utf8(JSON.stringify({ payment: voucher("0", "750", { signer: KEY, openBlock: "4100" }) }))
    );
    assert.equal(kept?.signer, KEY);
    assert.equal(kept?.openBlock, "4100");
    const dropped = paymentFromBlob(
      utf8(JSON.stringify({ payment: voucher("0", "750", { signer: 7, openBlock: 4100 }) }))
    );
    assert.notProperty(dropped, "signer");
    assert.notProperty(dropped, "openBlock");
    const old = paymentFromBlob(utf8(JSON.stringify({ payment: voucher("0", "750") })));
    assert.deepEqual(Object.keys(old!).sort(), [
      "chainId",
      "channelId",
      "cumulativeAfter",
      "cumulativeBefore",
      "payer",
      "rail",
    ]);
  });

  it("reads tempoKey out of a policy document, and nothing out of one without it", () => {
    assert.deepEqual(tempoKeyOfPolicy(policyWith(tempoKey)), tempoKey);
    assert.isNull(tempoKeyOfPolicy(policyWith()));
    assert.isNull(tempoKeyOfPolicy(null));
    assert.deepEqual(tempoKeyOfPolicy({ tempoKey: { address: KEY, expiry: "soon" } }), { address: KEY });
  });

  /**
   * Audit (d): a key whose policy commits call scopes
   * is held to the scopes Tempo enforces, the keychain's live `getAllowedCalls` first and the
   * authorize transaction's signed key authorization when the key is revoked or the live read fails.
   */
  describe("(d) the key's call scopes", () => {
    const ESCROW = TEMPO_ESCROW;
    const OPEN = "0x11aa11aa";
    const TOP_UP = "0x22bb22bb";
    const TRANSFER_WITH_MEMO = "0x95777d59";
    const STORAGE_PAYEE = "0x5701a6e000000000000000000000000000000abc";
    // As the policy commits them: lower case, sorted — and as Tempo reports them, in its own case and order.
    const committed = normaliseScopes([
      { address: ESCROW, selector: OPEN },
      { address: ESCROW, selector: TOP_UP },
      { address: USDC_E, selector: TRANSFER_WITH_MEMO, recipients: [STORAGE_PAYEE] },
    ]);
    const scopedKey = { ...tempoKey, scopes: committed };
    const live = (over: Partial<AllowedCallsLog> = {}): AllowedCallsLog => ({
      isScoped: true,
      scopes: [
        {
          address: USDC_E.toUpperCase().replace("0X", "0x"),
          selector: TRANSFER_WITH_MEMO,
          recipients: [STORAGE_PAYEE],
        },
        { address: ESCROW, selector: TOP_UP.toUpperCase().replace("0X", "0x") },
        { address: ESCROW, selector: OPEN },
      ],
      revoked: false,
      ...over,
    });

    /** `KeyReader` that also answers `getAllowedCalls`, and records who it was asked about. */
    class ScopeReader extends KeyReader {
      asked: [string, string][] = [];
      readonly answer: AllowedCallsLog | null | Error;
      constructor(answer: AllowedCallsLog | null | Error, auth: KeyAuthorizedLog | null = authLog()) {
        super(openedLog(), auth);
        this.answer = answer;
      }
      async allowedCalls(account: string, key: string): Promise<AllowedCallsLog | null> {
        this.asked.push([account, key]);
        if (this.answer instanceof Error) throw this.answer;
        return this.answer;
      }
    }

    it("reads the committed scopes normalised, and flags a scopes member that is not a list", () => {
      const k = tempoKeyOfPolicy(policyWith({ ...tempoKey, scopes: [...committed].reverse() }));
      assert.deepEqual(k?.scopes, committed);
      assert.deepEqual(
        committed.map((s) => s.address),
        [ESCROW.toLowerCase(), ESCROW.toLowerCase(), USDC_E].sort()
      );
      assert.deepEqual(normaliseScopes([{ address: KEY, selector: OPEN, recipients: [] }]), [
        { address: KEY, selector: OPEN },
      ]);
      assert.equal(tempoKeyOfPolicy(policyWith({ ...tempoKey, scopes: "all" }))?.badScopes, true);
      assert.equal(tempoKeyOfPolicy(policyWith({ ...tempoKey, scopes: [{ selector: OPEN }] }))?.badScopes, true);
      assert.notProperty(tempoKeyOfPolicy(policyWith(tempoKey)), "scopes");
    });

    it("is ok when getAllowedCalls answers the committed set, whatever its case and order", async () => {
      const chain = await keyedLoop(policyWith(scopedKey));
      const reader = new ScopeReader(live());
      const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
      assert.equal(r.verdict, "verified", r.reason);
      assert.equal(r.scopes?.status, "ok", r.scopes?.detail);
      assert.equal(r.scopes?.address, KEY);
      assert.deepEqual(reader.asked, [[TREASURY, KEY]], "read on the chain's payer, once");
      const lines = formatChannels(r);
      assert.equal(lines[5], "  (d) scopes       ok: getAllowedCalls answers the 3 committed scopes");
      assert.equal(channelsExitCode(r), 0);
    });

    for (const [name, answer, words] of [
      [
        "a missing selector",
        live({ scopes: live().scopes.slice(0, 2) }),
        `lacks the committed ${ESCROW.toLowerCase()} ${OPEN}`,
      ],
      [
        "an extra target",
        live({ scopes: [...live().scopes, { address: STRANGER }] }),
        `allows ${STRANGER} (any selector), which the policy does not commit`,
      ],
      [
        "a different recipient",
        live({
          scopes: [
            { address: USDC_E, selector: TRANSFER_WITH_MEMO, recipients: [STRANGER] },
            ...live().scopes.slice(1),
          ],
        }),
        `to ${STRANGER}, which the policy does not commit`,
      ],
      ["isScoped false", live({ isScoped: false, scopes: [] }), "is unscoped: the key may call any contract"],
    ] as [string, AllowedCallsLog, string][]) {
      it(`fails (d) and the chain for ${name}`, async () => {
        const chain = await keyedLoop(policyWith(scopedKey));
        const r = await verifyChannels(chain, AGENT, { store: chain.store, reader: new ScopeReader(answer) });
        assert.equal(r.scopes?.status, "failed");
        assert.include(r.scopes?.detail ?? "", words);
        assert.equal(r.key?.status, "ok", "(a) is about the authorize, which is fine");
        assert.equal(r.verdict, "failed", "the key Tempo enforces is not the committed one");
        assert.include(r.reason ?? "", "the loop's Tempo key scopes:");
        assert.equal(r.channels[0].verdict, "verified", "the channel itself still balances");
        assert.include(formatChannels(r)[5], "  (d) scopes       failed:");
        assert.equal(channelsExitCode(r), 2);
      });
    }

    it("is unchecked, never failed, for a reader answering null, one that throws, and one without the read", async () => {
      const chain = await keyedLoop(policyWith(scopedKey));
      const silent = await verifyChannels(chain, AGENT, { store: chain.store, reader: new ScopeReader(null) });
      // (a) and (b) are ok here; (d) alone not read still holds the verdict at pending.
      assert.equal(silent.verdict, "pending");
      assert.include(silent.reason ?? "", "(d) getAllowedCalls");
      assert.equal(silent.scopes?.status, "unchecked");
      assert.include(silent.scopes?.detail ?? "", "could not be read on Tempo");

      const down = await verifyChannels(chain, AGENT, {
        store: chain.store,
        reader: new ScopeReader(new Error("node is down")),
      });
      assert.equal(down.verdict, "pending");
      assert.equal(down.scopes?.status, "unchecked");
      assert.include(down.scopes?.detail ?? "", "node is down");

      const old = await verifyChannels(chain, AGENT, { store: chain.store, reader: new KeyReader() });
      assert.equal(old.verdict, "pending");
      assert.equal(old.scopes?.status, "unchecked");
      assert.include(old.scopes?.detail ?? "", "no Tempo reader that reads it");

      const none = await verifyChannels(chain, AGENT, { store: chain.store });
      assert.equal(none.scopes?.status, "unchecked");
    });

    it("says key revoked for a stopped loop's key, and reads the authorization's scopes instead when it has them", async () => {
      const chain = await keyedLoop(policyWith(scopedKey));
      const revoked = live({ isScoped: false, scopes: [], revoked: true });
      const blind = await verifyChannels(chain, AGENT, { store: chain.store, reader: new ScopeReader(revoked) });
      // Not failed: a revoked key is not a key with no scopes. Not verified either: nothing was read.
      assert.equal(blind.verdict, "pending", "a revoked key is not a key with no scopes");
      assert.equal(blind.scopes?.status, "unchecked");
      assert.include(blind.scopes?.detail ?? "", "key revoked");

      const authorized = await verifyChannels(chain, AGENT, {
        store: chain.store,
        reader: new ScopeReader(revoked, authLog({ scopes: live({ revoked: undefined }) })),
      });
      assert.equal(authorized.scopes?.status, "ok", authorized.scopes?.detail);
      assert.include(
        authorized.scopes?.detail ?? "",
        `authorize ${AUTH_TX} authorized the 3 committed scopes (key revoked`
      );
      assert.equal(authorized.verdict, "verified", authorized.reason);

      const wider = await verifyChannels(chain, AGENT, {
        store: chain.store,
        reader: new ScopeReader(revoked, authLog({ scopes: live({ scopes: [{ address: USDC_E }] }) })),
      });
      assert.equal(wider.scopes?.status, "failed");
      assert.include(wider.scopes?.detail ?? "", `authorize ${AUTH_TX}'s key authorization lacks the committed`);
      assert.equal(wider.verdict, "failed");
    });

    it("fails a policy whose scopes are not a list of scopes, with no read", async () => {
      const chain = await keyedLoop(policyWith({ ...tempoKey, scopes: "everything" }));
      const reader = new ScopeReader(live());
      const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
      assert.equal(r.scopes?.status, "failed");
      assert.equal(r.verdict, "failed");
      assert.deepEqual(reader.asked, []);
    });

    it("leaves a key that commits no scopes as it was: no scopes field, no getAllowedCalls read, no new line", async () => {
      const chain = await keyedLoop(policyWith(tempoKey));
      const reader = new ScopeReader(live({ isScoped: false, scopes: [] }));
      const r = await verifyChannels(chain, AGENT, { store: chain.store, reader });
      assert.equal(r.verdict, "verified");
      assert.notProperty(r, "scopes");
      assert.deepEqual(reader.asked, []);
      const lines = formatChannels(r);
      assert.notInclude(lines.join("\n"), "(d)");
      const before = await verifyChannels(chain, AGENT, { store: chain.store, reader: new KeyReader() });
      assert.deepEqual(r, before);
    });
  });
});

// ─── The model a call asked for, held to the session's policy ────────────────────────────────────

/**
 * `audit` over a `FakeChain`: the three reads it makes, each record with the status its preimage
 * encodes. `withheld` names records whose preimage the audit's store does not serve — the records
 * are still listed, so the walk meets them and finds nothing behind their payload hash.
 */
async function auditOf(chain: FakeChain, withheld: readonly bigint[] = []) {
  const records: (InferenceRecord & { status: number })[] = [];
  for (const r of chain.records) {
    const pre = await chain.store.get(r.payloadHash);
    const fields = recordFieldsOf(r.kind, pre!.slice(1));
    records.push({ ...r, reference: fields.reference ?? r.reference, status: fields.status ?? 0 });
  }
  const authority = new PublicKey("11111111111111111111111111111112");
  const client = {
    programId: authority,
    getAgentState: async () => ({ account: {}, state: { authority } }),
    verifyChain: async () => ({
      ok: true,
      headReached: true,
      records: records.length,
      seq: BigInt(records.length),
      head: new Uint8Array(32),
      firstBadSeq: undefined,
      missingSeqs: [],
      unexplainedGaps: [],
      recoveredSeqs: [],
      resyncedSeqs: [],
      epochs: [],
    }),
    listEvents: async () => records,
  } as unknown as LathClient;
  const gone = new Set(
    records.filter((r) => withheld.includes(r.seq)).map((r) => Buffer.from(r.payloadHash).toString("hex"))
  );
  const store: TraceStore = {
    put: (bytes) => chain.store.put(bytes),
    get: async (h) => (gone.has(Buffer.from(h).toString("hex")) ? null : chain.store.get(h)),
  };
  return audit(client, AGENT, { store });
}

describe("the model a call asked for, held to the session's policy", () => {
  const MODEL = "deepseek/deepseek-v4.1-flash";
  const FALLBACK = "openai/gpt-5-mini";

  it("verifies a chain whose policy commits no fallback exactly as before", async () => {
    const chain = new FakeChain();
    // The policy document as every Genesis before fallbacks committed it: no `fallbackModel`.
    await chain.genesis(1, { maxCost: 5_000, model: MODEL, temperature: 0.2, toolAllowList: [] });
    await chain.chatCall(2, { asked: MODEL, payment: voucher("0", "750") });
    await chain.chatCall(3, { asked: MODEL, payment: voucher("750", "1500") });
    await chain.resolution(4, { txHash: TX, spent: "1500" });
    const r = await verifyInference(chain, AGENT, 3, { store: chain.store, reader: settledReader() });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.model, MODEL);
    assert.equal(r.servedBy, MODEL, "an answer names the build that served it, here the slug itself");
    const a = await auditOf(chain);
    assert.equal(a.ok, true, formatReport(a).join("\n"));
    assert.isUndefined(a.traces?.modelsUncommitted);
  });

  it("verifies a call the committed fallback served after two attempts that got no answer", async () => {
    const chain = new FakeChain();
    await chain.genesis(1, { model: MODEL, fallbackModel: FALLBACK, maxCost: 5_000 });
    await chain.chatCall(2, { asked: MODEL, failed: true, payment: voucher("0", "750") });
    await chain.chatCall(3, { asked: MODEL, failed: true, payment: voucher("750", "1500") });
    await chain.chatCall(4, { asked: FALLBACK, payment: voucher("1500", "2250") });
    await chain.resolution(5, { txHash: TX, spent: "2250" });
    const reader = settledReader({}, closedLog({ finalAmount: BigInt(2250) }));

    const served = await verifyInference(chain, AGENT, 4, { store: chain.store, reader });
    assert.equal(served.verdict, "verified", served.reason);
    assert.equal(served.model, FALLBACK);
    assert.include(formatInference(served).join("\n"), `model      ${FALLBACK}`);
    // The attempts that got no answer are paid calls too, each verified against the same close.
    const lost = await verifyInference(chain, AGENT, 2, { store: chain.store, reader });
    assert.equal(lost.verdict, "verified", lost.reason);
    assert.equal(lost.model, MODEL);
    // And the channel balances: every attempt's voucher is on the chain, so nothing was paid that
    // no record names.
    const channels = await verifyChannels(chain, AGENT, { store: chain.store, reader });
    assert.equal(channels.verdict, "verified", channels.channels[0]?.reason);
    assert.deepEqual(channels.channels[0].seqs, ["2", "3", "4"]);
    const a = await auditOf(chain);
    assert.equal(a.ok, true, formatReport(a).join("\n"));
  });

  it("reports the dated build that served a call without holding it to the policy", async () => {
    const chain = new FakeChain();
    await chain.genesis(1, { model: MODEL });
    await chain.chatCall(2, { asked: MODEL, served: `${MODEL}-20261001`, payment: voucher("0", "750") });
    await chain.resolution(3, { txHash: TX, spent: "750" });
    const r = await verifyInference(chain, AGENT, 2, {
      store: chain.store,
      reader: settledReader({}, closedLog({ finalAmount: BigInt(750) })),
    });
    assert.equal(r.verdict, "verified", r.reason);
    assert.equal(r.servedBy, `${MODEL}-20261001`);
    assert.include(formatInference(r).join("\n"), `(served by ${MODEL}-20261001)`);
  });

  it("fails a call served by a model the policy does not commit, in verify-inference and in the audit", async () => {
    const chain = new FakeChain();
    // No fallback committed: a call on any other model — the operator's fallback included — is one
    // the Genesis never allowed.
    await chain.genesis(1, { model: MODEL });
    await chain.chatCall(2, { asked: MODEL, failed: true, payment: voucher("0", "750") });
    await chain.chatCall(3, { asked: FALLBACK, payment: voucher("750", "1500") });
    await chain.resolution(4, { txHash: TX, spent: "1500" });
    const reader = new FakeTempoReader(null);
    const r = await verifyInference(chain, AGENT, 3, { store: chain.store, reader });
    assert.equal(r.verdict, "failed");
    assert.equal(
      r.reason,
      `seq 3 asked for ${FALLBACK}, a model the session's policy does not commit (it allows ${MODEL})`
    );
    assert.equal(reader.calls, 0, "refuted from the chain and the store alone, before any Tempo read");
    const a = await auditOf(chain);
    assert.equal(a.ok, false);
    assert.deepEqual(
      a.traces?.modelsUncommitted?.map((m) => `${m.seq}:${m.model}`),
      [`3:${FALLBACK}`]
    );
    assert.include(formatReport(a).join("\n"), `model not in the policy: seq 3 asked for ${FALLBACK}`);
  });

  it("holds each session's calls to that session's own policy", async () => {
    const chain = new FakeChain();
    await chain.genesis(1, { model: MODEL, fallbackModel: FALLBACK });
    await chain.chatCall(2, { asked: FALLBACK, payment: voucher("0", "750") });
    await chain.resolution(3, { txHash: TX, spent: "750" });
    // The next session commits no fallback; the same model there is a call it did not allow.
    await chain.genesis(4, { model: MODEL });
    await chain.chatCall(5, { asked: FALLBACK, payment: voucher("750", "1500") });
    const a = await auditOf(chain);
    assert.deepEqual(
      a.traces?.modelsUncommitted?.map((m) => m.seq),
      ["5"]
    );
  });

  it("leaves a session's calls unchecked when its Genesis preimage is missing, not held to the session before", async () => {
    const OTHER = "anthropic/claude-sonnet-5";
    const chain = new FakeChain();
    await chain.genesis(1, { model: MODEL });
    await chain.chatCall(2, { asked: MODEL, payment: voucher("0", "750") });
    // Session 2 commits another model, and its Genesis preimage is not in the store: its policy
    // is unread, so its call is unchecked. With the reset after the early returns, the walk would
    // keep session 1's models and fail seq 4 for a model session 2 does commit.
    await chain.genesis(3, { model: OTHER });
    await chain.chatCall(4, { asked: OTHER, payment: voucher("750", "1500") });
    const a = await auditOf(chain, [BigInt(3)]);
    assert.isUndefined(a.traces?.modelsUncommitted, formatReport(a).join("\n"));
    assert.equal(a.ok, true, formatReport(a).join("\n"));
    // The control: with the Genesis served, the same chain verifies, so the call is held to it.
    const served = await auditOf(chain);
    assert.isUndefined(served.traces?.modelsUncommitted);
  });
});

// ─── A call that got no answer is Lath's, and the owner is owed no debit for it ──────────────────

describe("a call that got no answer, paid by Lath", () => {
  const MODEL = "deepseek/deepseek-v4.1-flash";

  /** One lost attempt and the retry that answered, both per-event records, settled by the loop. */
  async function retriedLoop(o: { absorbed: boolean }) {
    const chain = new FakeChain();
    await chain.genesis(1, { model: MODEL });
    await chain.chatCall(2, { asked: MODEL, failed: true, absorbed: o.absorbed, payment: voucher("0", "750") });
    await chain.chatCall(3, { asked: MODEL, payment: voucher("750", "1500") });
    await chain.loopSettlement(4, { payer: PAYER, channelId: CHANNEL, closed: true, txHash: TX, spent: "1500" });
    return chain;
  }
  const reader = () => settledReader({}, closedLog({ finalAmount: BigInt(1500) }));

  it("verifies a lost attempt that debited the owner nothing, its voucher still counted in the channel", async () => {
    const chain = await retriedLoop({ absorbed: true });
    const r = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: reader(),
      debitOf: async (_a, seq) => (seq === 2n ? 0n : 825n),
    });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.equal(r.channels[0].delta, "1500", "the lost attempt's voucher is part of what the channel paid");
    assert.deepEqual(r.channels[0].debits, [
      { seq: "2", deltaBase: "750", expectedMicroUsdc: "0", debitMicroUsdc: "0", paidByLath: true, status: "absorbed" },
      { seq: "3", deltaBase: "750", expectedMicroUsdc: "825", debitMicroUsdc: "825", status: "ok" },
    ]);
    assert.include(formatChannels(r).join("\n"), "1 paid by Lath (no answer), debited nothing");
    const one = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: reader() });
    assert.equal(one.verdict, "verified", one.reason);
    assert.equal(one.paidBy, "lath");
    assert.include(formatInference(one).join("\n"), "paid by    Lath");
  });

  it("fails a lost attempt the record calls Lath's whose transaction debited the owner anyway", async () => {
    const chain = await retriedLoop({ absorbed: true });
    const r = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: reader(),
      debitOf: async () => 825n,
    });
    assert.equal(r.verdict, "failed");
    assert.include(r.channels[0].reason ?? "", "seq 2 records a call that got no answer as paid by Lath");
  });

  it("verifies an old chain whose failed calls were charged at the margin, unchanged", async () => {
    // An older chain: no marker, and the owner debited the margin rule for a paid failure exactly
    // as for an answer.
    const chain = await retriedLoop({ absorbed: false });
    const r = await verifyChannels(chain, AGENT, {
      store: chain.store,
      reader: reader(),
      debitOf: async () => 825n,
    });
    assert.equal(r.verdict, "verified", r.channels[0]?.reason);
    assert.deepEqual(
      r.channels[0].debits?.map((d) => d.status),
      ["ok", "ok"]
    );
    assert.isUndefined(r.channels[0].debits?.[0].paidByLath);
    const one = await verifyInference(chain, AGENT, 2, { store: chain.store, reader: reader() });
    assert.isUndefined(one.paidBy);
  });
});
