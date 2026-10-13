import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  AgentLogger,
  decodeDecisionBlob,
  EpochStore,
  EventKind,
  hex,
  idFromString,
  loopMemoryBytes,
  MemoryTraceStore,
  sha256,
  utf8,
  ZERO32,
} from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  DecideRequest,
  DecideResult,
  PaidCallFailed,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopEvent,
  LoopRunner,
  LoopSnapshot,
  MemoryAnchorJournal,
  NoAnswerOptions,
  StepWork,
  TempoChannel,
  writeLoopCheckpoint,
} from "../runtime/src";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

/**
 * A loop over the anchor queue, against the in-memory chain in `fixtures/fake-chain.ts`: what a
 * step and a settlement do when the journal owes the chain a write, and what a step's Resolution
 * names. No validator, no RPC and no Tempo channel — the channel is a stub that counts its closes.
 *
 * The rule under test: nothing that folds into the head may be
 * written straight to the chain while records are journaled. A loop writes two such things
 * itself — the step's `loop.step` checkpoint and the `loop.settlement` record — and both have to
 * wait for the Retry rather than take a seq a journaled record is holding.
 */

const AGENT = idFromString("loop-anchor-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;
/** 0.001 USD a call, × the default 0.10 margin: one step's one charge. */
const PER_CALL = "1100";

/** Answers every call at once, at a fixed cost: `answer 1`, `answer 2`, … */
class Answering implements ChatTransport {
  calls = 0;

  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content: `answer ${this.calls}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
    };
  }
}

/** A blob store with no `anchor`: the epoch is committed and owes no locator cell. */
function epochStore(): EpochStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(root: Uint8Array, blob: Uint8Array) {
      blobs.set(hex(root), blob);
    },
    async get(root: Uint8Array) {
      return blobs.get(hex(root)) ?? null;
    },
  } as EpochStore;
}

function queueOn(chain: FakeChain, billing: RecordingBilling): AnchorQueue {
  return new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    // One attempt, so a single `failNext` is a failed entry and a halted chain.
    maxAttempts: 1,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
}

function loopOn(
  chain: FakeChain,
  o: {
    queue: AnchorQueue;
    billing: RecordingBilling;
    store?: MemoryTraceStore;
    transport?: ChatTransport;
    tempo?: TempoChannel;
    resume?: LoopSnapshot;
    work?: (ctx: StepWork) => Promise<unknown>;
    onEvent?: (e: LoopEvent) => void;
    verify?: { model: string; minConfidence: number };
    noAnswer?: NoAnswerOptions;
  }
) {
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: AGENT,
    transport: o.transport ?? new Answering(),
    policy: {
      model: "test/model",
      temperature: 0,
      toolAllowList: [],
      maxCost: 1_000_000,
      ...(o.verify ? { verify: o.verify } : {}),
    },
    billing: o.billing,
    structures: false,
    publishPolicy: false,
    now: () => T,
    store: o.store,
    rollup: { store: epochStore(), batchSize: 16 },
    anchor: { queue: o.queue, drain: true },
    ...(o.noAnswer ? { noAnswer: o.noAnswer } : {}),
  });
  const runner = new LoopRunner({
    runtime,
    loopId: "loop-anchor",
    prompt: "Watch the cluster.",
    intervalMs: 0,
    maxSteps: 5,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
    tempo: o.tempo,
    resume: o.resume,
    work: o.work,
    onEvent: o.onEvent,
    verify: o.verify,
  });
  return { runtime, runner };
}

/** A channel that has paid for calls and closes with a fixed receipt, counting its closes. */
function channel(): TempoChannel & { closes: number } {
  const c = {
    payer: "0x18fB0000000000000000000000000000000000B0",
    channelId: "0x7f3c",
    opened: true,
    closes: 0,
    async close() {
      c.closes += 1;
      return { txHash: "0xsettled", spent: "1650" };
    },
  };
  return c;
}

describe("a loop's settlement over a journal that owes the chain", () => {
  it("settles the channel, defers the record, and lets the Retry write it after the step's checkpoint", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const first = loopOn(chain, { queue, billing });

    chain.failNext(1); // the step's genesis spends its one attempt
    const stepped = await first.runner.step();
    assert.exists(stepped.deferredCheckpoint, "the step ran and its checkpoint is owed");
    assert.equal(first.runner.snapshot().stopReason, "anchor-failed");

    // The console settles a stopped loop from a runner it builds for the purpose.
    const tempo = channel();
    const settler = loopOn(chain, { queue, billing, tempo, resume: first.runner.snapshot() });
    const settlement = await settler.runner.settle();

    assert.equal(tempo.closes, 1, "the money is settled whatever the chain does");
    assert.isTrue(settlement!.recordOwed, "and the record is owed rather than written");
    assert.equal(settlement!.txHash, "0xsettled");
    assert.lengthOf(chain.applied, 0, "nothing went straight to a chain whose journal owes it a genesis");

    // The Retry: the journal first, with no divergence, because nothing took a journaled seq…
    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.lengthOf(queue.failed(AGENT), 0);
    // …then the step's deferred checkpoint, as `payDeferredCheckpoints` writes it…
    const logger = new AgentLogger(chain.asClient(), AGENT, {
      store: first.runtime.store,
      compact: false,
      now: () => T,
    });
    const written = await writeLoopCheckpoint({
      client: chain.asClient(),
      agentId: AGENT,
      logger,
      plan: stepped.deferredCheckpoint!,
    });
    assert.isTrue(written.leafOk);

    // …then the owed record, from a runner handed the stored receipt: no second close is sent.
    const seen: LoopEvent[] = [];
    const replayed = { ...channel(), close: async () => ({ txHash: "0xsettled", spent: "1650" }) };
    const replay = loopOn(chain, {
      queue,
      billing,
      tempo: replayed,
      resume: settler.runner.snapshot(),
      onEvent: (e) => seen.push(e),
    });
    const recorded = await replay.runner.settle();

    assert.isUndefined(recorded!.recordOwed, "writing the record clears the debt");
    const record = seen.find((e) => e.type === "settlement");
    assert.exists(record, "the loop.settlement record was written");
    assert.equal(record!.seq, (written.record.seq + 1n).toString(), "right after the step's checkpoint");
    assert.equal(record!.head, hex(chain.state(AGENT)!.head), "at a head the chain confirms");
  });

  it("writes the record at once over a healthy journal, exactly as before", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const tempo = channel();
    const seen: LoopEvent[] = [];
    const { runner } = loopOn(chain, { queue, billing, tempo, onEvent: (e) => seen.push(e) });

    const stepped = await runner.step();
    assert.isTrue(stepped.leafOk);
    const settlement = await runner.settle();

    assert.equal(tempo.closes, 1);
    assert.isUndefined(settlement!.recordOwed);
    const record = seen.find((e) => e.type === "settlement");
    assert.exists(record);
    assert.equal(record!.seq, (chain.state(AGENT)!.seq - 1n).toString(), "the last record on the chain");
  });

  it("keeps the record owed when its own write fails over a healthy journal, so the Retry writes it", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const tempo = channel();
    const { runner } = loopOn(chain, { queue, billing, tempo });

    const stepped = await runner.step();
    assert.isTrue(stepped.leafOk);
    const before = chain.applied.length;
    chain.failNext(1); // the settlement record's direct write (the fake client does not retry)
    const settlement = await runner.settle();

    assert.equal(tempo.closes, 1, "the channel is settled whatever the record does");
    assert.equal(chain.applied.length, before, "the record did not land");
    assert.isTrue(settlement!.recordOwed, "and it is owed, not only reported");
    assert.equal(settlement!.txHash, "0xsettled");

    // The Retry's replay over the stored receipt writes it, with no second close.
    const seen: LoopEvent[] = [];
    const replay = loopOn(chain, {
      queue,
      billing,
      tempo: { ...channel(), close: async () => ({ txHash: "0xsettled", spent: "1650" }) },
      resume: runner.snapshot(),
      onEvent: (e) => seen.push(e),
    });
    const recorded = await replay.runner.settle();
    assert.isUndefined(recorded!.recordOwed);
    assert.exists(seen.find((e) => e.type === "settlement"));
    assert.equal(tempo.closes, 1);
  });
});

describe("a loop step that cannot be closed after its session resolved", () => {
  it("defers the checkpoint when the step's own work leaves the journal owing a record", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const { runner } = loopOn(chain, {
      queue,
      billing,
      // A caller's work that journals a record the chain refuses, and swallows the failure the
      // way a careless hook would. The checkpoint must not be written over it.
      work: async () => {
        chain.failNext(1);
        await queue.logEvent(
          AGENT,
          {
            kind: EventKind.Action,
            toolId: "work.extra",
            argsHash: ZERO32,
            resultHash: ZERO32,
            statusCode: 200,
          },
          { timestamp: T }
        );
        await queue.drain(AGENT).catch(() => undefined);
      },
    });

    const stepped = await runner.step();

    assert.exists(stepped.deferredCheckpoint);
    assert.isUndefined(stepped.record, "no loop.step record");
    assert.equal(runner.snapshot().stopReason, "anchor-failed");
    assert.equal(runner.snapshot().steps, 1, "the step is counted, so it is never run again");
    // genesis, the epoch [1, 2), the Resolution — and nothing after them.
    assert.equal(chain.state(AGENT)!.seq, 3n);
  });

  it("carries the memory forward when the store refuses it, and still checkpoints the step", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const refused = hex(loopMemoryBytes("answer 1"));
    class Refusing extends MemoryTraceStore {
      async put(bytes: Uint8Array): Promise<Uint8Array> {
        if (hex(bytes) === refused) throw new Error("store refused the memory");
        return super.put(bytes);
      }
    }
    const { runner } = loopOn(chain, { queue, billing, store: new Refusing() });

    const first = await runner.step();

    assert.exists(first.record, "the step closed with its checkpoint");
    assert.isTrue(first.leafOk);
    assert.isUndefined(first.manifest!.memoryHash, "naming the memory before it — none, on step 1");
    assert.equal(runner.snapshot().steps, 1);
    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      [PER_CALL],
      "one session's charge"
    );

    const second = await runner.step();
    assert.equal(second.step, 2, "the next step is the next index, not the same one again");
  });

  it("stops the loop with the checkpoint deferred when the checkpoint write itself fails", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const store = new MemoryTraceStore();
    // The checkpoint is a direct client write, so failing the next chain write fails it.
    const { runner } = loopOn(chain, { queue, billing, store, work: async () => chain.failNext(1) });

    const stepped = await runner.step();

    assert.exists(stepped.deferredCheckpoint);
    assert.match(stepped.reason ?? "", /could not be closed/);
    const snapshot = runner.snapshot();
    assert.equal(snapshot.stopReason, "anchor-failed");
    assert.equal(snapshot.steps, 1);
    assert.equal(snapshot.totalCostMicroUsdc, PER_CALL, "the step's cost is counted");
    assert.isUndefined(snapshot.lastMemoryHash, "the pointer waits for the checkpoint that names it");
    assert.isTrue(stepped.deferredCheckpoint!.memoryIsOwn);
    assert.equal(stepped.deferredCheckpoint!.memoryHash, hex(sha256(loopMemoryBytes("answer 1"))));

    // The Retry's checkpoint lands where the step's leaf says it does.
    const logger = new AgentLogger(chain.asClient(), AGENT, { store, compact: false, now: () => T });
    const written = await writeLoopCheckpoint({
      client: chain.asClient(),
      agentId: AGENT,
      logger,
      plan: stepped.deferredCheckpoint!,
    });
    assert.isTrue(written.leafOk);
  });
});

describe("a step whose memory the trace store cannot answer for", () => {
  /** Answers `get` for `target` by throwing (`fail`) or by holding nothing (`forget`); every other hash as stored. */
  class Flaky extends MemoryTraceStore {
    target?: string;
    mode?: "fail" | "forget";
    async get(hash: Uint8Array): Promise<Uint8Array | null> {
      if (hex(hash) === this.target && this.mode === "fail") throw new Error("ETIMEDOUT reading the trace store");
      if (hex(hash) === this.target && this.mode === "forget") return null;
      return super.get(hash);
    }
  }

  async function afterOneStep() {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const store = new Flaky();
    const { runner } = loopOn(chain, { queue: queueOn(chain, billing), billing, store });
    await runner.step();
    const memory = runner.snapshot().lastMemoryHash;
    assert.exists(memory, "step 1 committed a memory for step 2 to resume from");
    store.target = memory;
    return { chain, billing, store, runner, memory: memory! };
  }

  it("takes no step on a read that failed, and steps 2 from the memory once the store answers", async () => {
    const { chain, billing, store, runner, memory } = await afterOneStep();
    const seq = chain.state(AGENT)!.seq;
    store.mode = "fail";

    let thrown: unknown;
    await runner.step().catch((e) => (thrown = e));
    assert.match(String((thrown as Error)?.message), /could not be read, so the step was not taken: ETIMEDOUT/);
    const held = runner.snapshot();
    assert.equal(held.steps, 1, "the step's index is not spent");
    assert.equal(held.consecutiveFailures, 0, "a read that failed is not a failed step");
    assert.notEqual(held.status, "stopped");
    assert.equal(held.lastMemoryHash, memory, "the memory pointer is where step 1 left it");
    assert.equal(chain.state(AGENT)!.seq, seq, "nothing was written");
    assert.lengthOf(billing.charges, 1, "nothing was charged past step 1");

    store.mode = undefined;
    const second = await runner.step();
    assert.equal(second.step, 2);
    assert.equal(second.resumedMemoryHash, memory, "step 2 resumed from step 1's memory, not from nothing");
    assert.notEqual(second.status, "no-memory");
  });

  it("still fails the step no-memory when the store holds nothing under the hash", async () => {
    const { store, runner, memory } = await afterOneStep();
    store.mode = "forget";

    const second = await runner.step();
    assert.equal(second.status, "no-memory");
    assert.match(second.reason ?? "", new RegExp(`the trace store has nothing under ${memory}`));
    assert.equal(runner.snapshot().steps, 2);
    assert.equal(runner.snapshot().consecutiveFailures, 1);
  });
});

describe("a step's Resolution", () => {
  it("names the step's own session, never a request: no step is request-woken in this build", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const store = new MemoryTraceStore();
    const references: string[] = [];
    const { runner } = loopOn(chain, {
      queue,
      billing,
      store,
      work: async ({ session }) => {
        const resolution = session.events.find((e) => e.input.kind === EventKind.Resolution);
        references.push(hex(resolution!.input.reference));
      },
    });

    await runner.step();

    assert.deepEqual(references, [hex(idFromString("loop-anchor:step-1"))]);
  });
});

/**
 * A decision the channel paid for and never answered — a deadline after the headers, a
 * body cut short — raises `PaidCallFailed` out of `decide`, and the runner stores the voucher it
 * carried instead of dropping it. The verdict is still `unavailable` and nothing reads the blob as
 * one, so the step stands where verify-off would have left it.
 */
describe("a decision paid for and never answered", () => {
  const VOUCHER = {
    rail: "tempo" as const,
    chainId: 4217,
    payer: "0x18fB0000000000000000000000000000000000B0",
    channelId: "0x7f3c",
    cumulativeBefore: "1650",
    cumulativeAfter: "1692",
  };

  /** Answers chat like `Answering`, and every decision with a paid failure. */
  class PaidButUnanswered extends Answering {
    decisions = 0;

    async decide(_req: DecideRequest): Promise<DecideResult> {
      this.decisions += 1;
      throw new PaidCallFailed("the decision did not come back in 20000 ms", VOUCHER);
    }
  }

  it("stores the voucher of a step's verdict that never came back, and keeps the verdict unavailable", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const store = new MemoryTraceStore();
    const transport = new PaidButUnanswered();
    const { runner } = loopOn(chain, {
      queue: queueOn(chain, billing),
      billing,
      store,
      transport,
      verify: { model: "typesafe/jev-1.13", minConfidence: 0.6 },
    });

    const stepped = await runner.step();
    assert.equal(transport.decisions, 1, "one attempt, never a retry");
    const verify = stepped.verify as { unavailable: string; paidHash?: string; costBase?: string };
    assert.include(verify.unavailable, "did not come back");
    assert.equal(verify.costBase, "42");
    assert.isString(verify.paidHash, "the paid decision is recorded, not dropped");
    assert.notProperty(stepped.verify!, "verifyHash", "and nothing is committed as a verdict");

    const bytes = await store.get(Buffer.from(verify.paidHash!, "hex"));
    assert.exists(bytes);
    const blob = JSON.parse(new TextDecoder().decode(bytes!));
    assert.deepEqual(blob.payment, VOUCHER);
    assert.isTrue(blob.unanswered);
    assert.isNull(decodeDecisionBlob(bytes!), "no reader can take it for a verdict");
    assert.isTrue(stepped.leafOk, "the step checkpointed as it would with verify off");
  });
});

// ─── A step the model did not answer ────────────────────────────────────────────────────────────

/** Every call of the first `lost` calls times out after its voucher; every call after answers. */
class StallsFirst implements ChatTransport {
  calls = 0;
  private cumulative = 0n;
  private readonly lost: number;

  constructor(lost: number) {
    this.lost = lost;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    const before = this.cumulative;
    this.cumulative += 750n;
    const payment = {
      rail: "tempo" as const,
      chainId: 4217,
      payer: "0x18fB0000000000000000000000000000000000B0",
      channelId: "0x7f3c",
      cumulativeBefore: before.toString(),
      cumulativeAfter: this.cumulative.toString(),
    };
    if (this.calls <= this.lost) {
      throw new PaidCallFailed("the gateway sent no part of the model's answer in 45 s", payment, undefined, true);
    }
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: `answer ${this.calls}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
      payment,
    };
  }
}

describe("a step the model did not answer", () => {
  it("says so on the step's result, checkpoints it, charges nothing for it, and the loop goes on", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const transport = new StallsFirst(2);
    const { runner } = loopOn(chain, { queue, billing, transport, noAnswer: {} });

    const one = await runner.step();
    assert.equal(one.status, "failed");
    assert.equal(one.cause, "no-answer");
    assert.equal(one.absorbedBase, "1500", "both lost attempts, paid by Lath");
    assert.equal(one.costMicroUsdc, "0", "the owner was charged nothing for the step");
    assert.isString(one.record?.seq, "the step is checkpointed like any failed step");
    assert.notEqual(runner.snapshot().status, "stopped", "a step the model did not answer does not stop the loop");

    const two = await runner.step();
    assert.equal(two.status, "success", two.reason);
    assert.isUndefined(two.cause);
    assert.isUndefined(two.absorbedBase);
    assert.equal(transport.calls, 3);
  });
});

// ─── A step whose charge fails ──────────────────────────────────────────────────────────────
//
// A step whose USDC charge failed must not keep its output, leave no memory so the next step reads
// *fresh*, run on, and never be paid for. The rule: retry the charge once, then stop the loop
// `charge-failed`, keep no unpaid output as memory, and count the total. The retry is
// `chargeWithRetry`'s (pinned in tests/runtime-budget.ts); what is pinned here is the loop's half,
// on the in-memory chain rather than a validator.

describe("a step whose charge fails", () => {
  /**
   * The direct-write shape a member runs in: no anchor queue, so a charge is sent before its step is
   * batched and one that fails is a `ChargeFailed`. The epoch committer `LathClient` would hand it is
   * played on the fake chain, as tests/runtime-budget.ts does.
   */
  function directLoop(chain: FakeChain, billing: RecordingBilling, store = new MemoryTraceStore()) {
    (chain as unknown as { createEpochCommitter: unknown }).createEpochCommitter = () => async (inputs: unknown[]) => {
      const startSeq = chain.state(AGENT)!.seq;
      const endSeq = startSeq + BigInt(inputs.length);
      const epochRoot = new Uint8Array(32).fill(7);
      const { signature, head } = await chain.commitEpoch(AGENT, epochRoot, startSeq, endSeq);
      return { signature, epochRoot, startSeq, endSeq, head, blob: new Uint8Array(), inputs };
    };
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport: new Answering(),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing,
      structures: false,
      publishPolicy: false,
      now: () => T,
      store,
      rollup: { store: epochStore(), batchSize: 16 },
    });
    const runner = new LoopRunner({
      runtime,
      loopId: "loop-charge-failed",
      prompt: "Watch the cluster.",
      intervalMs: 0,
      maxSteps: 5,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });
    return { runtime, runner };
  }

  it("stops the loop charge-failed, carries the last paid memory forward, and counts only what moved", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const { runner } = directLoop(chain, billing);

    const one = await runner.step();
    assert.equal(one.status, "success", one.reason);
    const remembered = hex(sha256(loopMemoryBytes("answer 1")));
    assert.equal(one.manifest!.memoryHash, remembered);

    billing.failNext(1); // step 2's one call: a send that may have landed, so it is not retried
    const two = await runner.step();

    assert.equal(two.status, "failed");
    assert.match(two.reason ?? "", /^billing charge failed/);
    assert.isTrue(two.leafOk, "the step that ran still owes the chain its leaf, and has it");
    assert.equal(two.manifest!.memoryHash, remembered, "step 1's memory, carried forward: not fresh");
    assert.equal(two.costMicroUsdc, "0", "nothing was debited for the step");
    const snap = runner.snapshot();
    assert.equal(snap.status, "stopped");
    assert.equal(snap.stopReason, "charge-failed", "the loop does not run on unpaid work");
    assert.equal(snap.lastMemoryHash, remembered, "the unpaid answer is not the next step's memory");
    assert.equal(snap.lastMemoryStep, 1);
    assert.equal(snap.totalCostMicroUsdc, PER_CALL, "a total, and only the charge that moved");
    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      [PER_CALL],
      "one debit, for the one call that was recorded"
    );
  });

  it("over the anchor queue, defers the step to the Retry, which debits it once and only then moves the memory", async () => {
    const chain = new FakeChain();
    const billing = new RecordingBilling();
    const queue = queueOn(chain, billing);
    const store = new MemoryTraceStore();
    const { runtime, runner } = loopOn(chain, { queue, billing, store });

    const one = await runner.step();
    assert.equal(one.status, "success", one.reason);
    const first = hex(sha256(loopMemoryBytes("answer 1")));

    billing.failNext(1); // step 2's journaled charge spends its one attempt and halts the chain
    const two = await runner.step();

    assert.exists(two.deferredCheckpoint, "no leaf over records that did not land");
    assert.isUndefined(two.record);
    const snap = runner.snapshot();
    assert.equal(snap.stopReason, "anchor-failed", "stopped, for the Retry to pay");
    assert.equal(snap.lastMemoryHash, first, "the pointer stays on the memory the chain names");
    assert.equal(snap.totalCostMicroUsdc, (2n * BigInt(PER_CALL)).toString(), "the owed charge is counted");
    assert.lengthOf(billing.charges, 1, "step 2 has not been debited yet");
    assert.lengthOf(queue.failed(AGENT), 1, "and its charge is owed, not dropped");
    const second = hex(sha256(loopMemoryBytes("answer 2")));
    assert.equal(two.deferredCheckpoint!.memoryHash, second);

    // The Retry: the journal, then the deferred checkpoint, as `payDeferredCheckpoints` writes it.
    await queue.retry(AGENT);
    await queue.drain(AGENT);
    assert.deepEqual(
      billing.charges.map((c) => c.amountMicroUsdc),
      [PER_CALL, PER_CALL],
      "step 2 is debited exactly once"
    );
    const logger = new AgentLogger(chain.asClient(), AGENT, { store: runtime.store, compact: false, now: () => T });
    const written = await writeLoopCheckpoint({
      client: chain.asClient(),
      agentId: AGENT,
      logger,
      plan: two.deferredCheckpoint!,
    });
    assert.isTrue(written.leafOk);
  });

  it("goes on when every charge of the step moved", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const { runner } = directLoop(chain, billing);
    await runner.step();
    await runner.step();
    assert.notEqual(runner.snapshot().status, "stopped");
    assert.lengthOf(billing.charges, 2);
  });
});

/**
 * A stored loop started with protocol-plugin grants: its policy still names the grants and the
 * loop's Solana key, so its settlement's runner commits the bytes its Genesis did, but grants are on
 * the roadmap and the runner has no hook to run them, so it refuses every step before anything is
 * written, asked or charged.
 */
describe("a runner whose policy names protocol-plugin grants (a roadmap feature)", () => {
  const addr = (name: string) => new PublicKey(sha256(utf8(`loop-anchor:${name}`))).toBase58();
  const KEY = addr("loop-key");

  it("is built, so its channel can still settle, and refuses every step with nothing written or charged", async () => {
    const chain = new FakeChain();
    await chain.registerAgent(AGENT);
    const billing = new RecordingBilling();
    const transport = new Answering();
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport,
      policy: {
        model: "test/model",
        temperature: 0,
        toolAllowList: [],
        maxCost: 1_000_000,
        grants: {
          v: 1,
          cluster: "devnet",
          mandate: "Pay this week's approved invoices.",
          barBps: 6_000,
          maxPerStep: 3,
          expiresAt: Math.floor(T / 1000) + 86_400,
          items: [
            {
              id: "council",
              plugin: "squads",
              action: "pay",
              multisig: addr("multisig"),
              vaultIndex: 1,
              mint: addr("mint"),
              payees: [{ name: "alice", address: addr("alice") }],
              maxPerAction: "200000000",
              maxTotal: "400000000",
              uniqueRef: true,
            },
          ],
        },
        solanaKey: { address: KEY, createdAt: Math.floor(T / 1000) },
      },
      billing,
      structures: false,
      publishPolicy: false,
      now: () => T,
      store: new MemoryTraceStore(),
      rollup: { store: epochStore(), batchSize: 16 },
      anchor: { queue: queueOn(chain, billing), drain: true },
    });
    const runner = new LoopRunner({
      runtime,
      loopId: "loop-granted",
      prompt: "Settle this week's invoices.",
      intervalMs: 0,
      maxSteps: 3,
      user: USER,
      startedAt: T,
      now: () => T,
      sleep: async () => undefined,
    });
    const seq = chain.state(AGENT)!.seq;
    let refused: unknown;
    try {
      await runner.step();
    } catch (e) {
      refused = e;
    }
    assert.match(
      (refused as Error)?.message ?? "",
      /^loop loop-granted has a policy naming protocol-plugin grants, which this build does not run .*settles and never steps$/
    );
    assert.equal(transport.calls, 0, "no session opened");
    assert.lengthOf(billing.charges, 0, "nothing charged");
    assert.equal(chain.state(AGENT)!.seq, seq, "nothing written");
    assert.equal(runner.snapshot().steps, 0);
  });
});
