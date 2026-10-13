import type { SasGrantItem, SquadsGrantItem } from "../sdk/src/plugins";
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  ChainSignals,
  EpochStore,
  EventKind,
  hex,
  idFromString,
  InsufficientPayerBalance,
  MemoryTraceStore,
  paymentFromBlob,
  RollupBatcher,
  type Grants,
} from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  BillingBackend,
  CHAT_FIRST_DATA_MS,
  chatAttemptModels,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatStreamOptions,
  ChatTransport,
  DelegateDefinition,
  MemoryAnchorJournal,
  MppOpenRouterTransport,
  NoAnswerOptions,
  NoopBilling,
  PaidCallFailed,
  RuntimeEvent,
  policyDocument,
  policyVersionHash,
  toMicroUsdc,
  toMicroUsdcFromBase,
  toRuntimePolicy,
  type MppCloseReceipt,
  type MppSession,
  type RuntimePolicy,
  type TempoKeyScope,
} from "../runtime/src";
import { FakeChain } from "./fixtures/fake-chain";

/**
 * The client-side `maxCost` ceiling, against the in-memory chain in `fixtures/fake-chain.ts`.
 * No validator and no network: what is under test is which counter the ceiling reads, which is
 * the runtime's own arithmetic.
 *
 * The case that matters: in rollup mode a step is charged on its own transaction, through the
 * *optional* `BillingBackend.charge`. A backend that does not implement it leaves every step
 * `unbilled` and `spent` at zero — so a ceiling that only looked at `spent` would never fire, and
 * a session with a 2 000 µUSDC budget would run all sixteen steps.
 *
 * The later cases are the same meter's other doors: a payer too poor for an epoch refused before
 * the model is paid, a paid call whose body never arrived recorded and metered, and a delegate's
 * spend counted against the parent.
 */

const AGENT = idFromString("runtime-budget-agent");
const USER = new PublicKey("11111111111111111111111111111112");

/** An assistant that never stops on its own: every turn asks for the same tool, at a fixed cost. */
class Costing implements ChatTransport {
  calls = 0;
  readonly costUsd: number;

  constructor(costUsd: number) {
    this.costUsd = costUsd;
  }

  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: `call-${this.calls}`, type: "function", function: { name: "noop", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: this.costUsd },
      },
    } as ChatResult;
  }
}

/** A blob store with no `anchor`: this session commits epochs, it does not publish locators. */
function memoryEpochStore(): EpochStore {
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

/** `chargeAndLog` only — the optional `charge` a rollup step needs is deliberately absent. */
const noChargeBilling: BillingBackend = {
  async chargeAndLog() {
    return null;
  },
};

function runtimeOn(chain: FakeChain, maxCost: number, costUsd: number, billing: BillingBackend) {
  const transport = new Costing(costUsd);
  // Anchored, because `FakeChain` stands in for the write side only and the epoch committer a
  // synchronous rollup session would ask the real client for is not part of it. It changes
  // nothing about the metering: the charge still goes through the same backend, one entry
  // ahead of the step it pays for.
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: AGENT,
    transport,
    policy: { model: "test/model", temperature: 0, toolAllowList: ["noop"], maxCost },
    billing,
    structures: false,
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    rollup: { store: memoryEpochStore(), batchSize: 64 },
    anchor: { queue, drain: true },
    tools: [
      {
        name: "noop",
        description: "Does nothing.",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { ok: true };
        },
      },
    ],
  });
  return { runtime, transport };
}

describe("the maxCost ceiling in rollup mode", () => {
  // 0.001 USD × the default 0.10 margin = 1 100 µUSDC a step, so a 2 000 µUSDC budget is
  // breached by the second one and the session must not reach a third.
  const COST_USD = 0.001;
  const PER_STEP = toMicroUsdc(COST_USD, 0.1);
  const MAX_COST = 2_000;

  it("stops a session whose steps are metered but unbilled, instead of running to maxSteps", async () => {
    const chain = new FakeChain();
    const { runtime, transport } = runtimeOn(chain, MAX_COST, COST_USD, noChargeBilling);

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "s1" });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /µUSDC budget/, "the loop reads a budget stop off this wording");
    assert.equal(transport.calls, 2, "two steps metered, and the third was never asked for");
    assert.equal(result.batchedSteps, 3, "both LLM steps and the one tool call between them went into the epoch");

    // Honest about what actually moved: nothing was charged, and the ceiling fired anyway.
    assert.equal(result.costMicroUsdc, 0n, "a backend with no `charge` debited nothing");
    assert.equal(result.unbilledMicroUsdc, PER_STEP * 2n, "and everything it metered is reported as unbilled");
    assert.include(result.reason ?? "", "0 charged", "the reason says so rather than claiming spend");
  });

  it("counts a charged session the same way, and does not double it", async () => {
    const chain = new FakeChain();
    const charges: string[] = [];
    const billing: BillingBackend = {
      async charge(_user, amountMicroUsdc) {
        charges.push(amountMicroUsdc.toString());
        return "sig";
      },
      async chargeAndLog() {
        return null;
      },
    };
    const { runtime, transport } = runtimeOn(chain, MAX_COST, COST_USD, billing);

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "s2" });

    assert.equal(result.status, "aborted");
    assert.equal(transport.calls, 2, "the same two steps: `spent + unbilled` is the metered total, not a sum of both");
    assert.deepEqual(charges, [PER_STEP.toString(), PER_STEP.toString()]);
    assert.equal(result.costMicroUsdc, PER_STEP * 2n);
    assert.equal(result.unbilledMicroUsdc, 0n);
  });

  it("leaves a session under the ceiling alone", async () => {
    const chain = new FakeChain();
    const { runtime, transport } = runtimeOn(chain, 100_000, COST_USD, noChargeBilling);

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "s3" });

    assert.equal(result.status, "aborted", "it ends on the step ceiling, which is the other stop");
    assert.match(result.reason ?? "", /step ceiling/);
    assert.equal(transport.calls, 16, "the default maxSteps, with the budget never in the way");
  });
});

// ─── A payer that cannot fund an epoch is refused before anything is bought ──────────────────

/** Every blob the session stored, in order, so a test can find the one a record hashed. */
class RecordingStore extends MemoryTraceStore {
  readonly puts: Uint8Array[] = [];

  async put(bytes: Uint8Array): Promise<Uint8Array> {
    this.puts.push(bytes);
    return super.put(bytes);
  }
}

/** A charging backend that records what it moved. */
function chargingBilling(): BillingBackend & { charges: string[] } {
  const charges: string[] = [];
  return {
    charges,
    async charge(_user: PublicKey, amountMicroUsdc: bigint) {
      charges.push(amountMicroUsdc.toString());
      return `charge-${charges.length}`;
    },
    async chargeAndLog() {
      return null;
    },
  };
}

/**
 * A session on the fake chain with the seams the cases below need: its own transport, a store,
 * balance signals, delegates. Rollup sessions are anchored for the reason `runtimeOn` gives;
 * `rollup: false` is a plain synchronous session, which is what a delegate's chain is here.
 */
function sessionOn(
  chain: FakeChain,
  o: {
    transport: ChatTransport;
    billing: BillingBackend;
    maxCost?: number;
    store?: MemoryTraceStore;
    signals?: ChainSignals;
    rollup?: boolean;
    delegates?: DelegateDefinition[];
    agentId?: Uint8Array;
    onEvent?: (e: RuntimeEvent) => void;
  }
) {
  // `FakeChain` stands in for the write side only; the signals a test passes are the whole of it.
  (chain as unknown as { chainSignals: () => ChainSignals }).chainSignals = () => ({});
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing: o.billing,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const rollup = o.rollup !== false;
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: o.agentId ?? AGENT,
    transport: o.transport,
    policy: {
      model: "test/model",
      temperature: 0,
      toolAllowList: o.delegates?.length ? ["delegate"] : [],
      maxCost: o.maxCost ?? 1_000_000,
    },
    billing: o.billing,
    structures: false,
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    store: o.store,
    delegates: o.delegates,
    onEvent: o.onEvent,
    ...(rollup ? { rollup: { store: memoryEpochStore(), batchSize: 64, signals: o.signals } } : {}),
    ...(rollup ? { anchor: { queue, drain: true } } : {}),
  });
  return { runtime, queue };
}

describe("the payer balance check in rollup mode", () => {
  it("refuses a turn before the model is called and before anything is charged or journaled", async () => {
    const chain = new FakeChain();
    const billing = chargingBilling();
    const transport = new Costing(0.001);
    const { runtime, queue } = sessionOn(chain, {
      transport,
      billing,
      signals: { payerBalance: async () => 0 },
    });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "poor" });

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /payer holds 0 lamports/);
    assert.equal(transport.calls, 0, "refused before the paid call, not after it");
    assert.deepEqual(billing.charges, [], "nothing was debited");
    assert.equal(result.costMicroUsdc, 0n);
    assert.isFalse(
      (await queue.carried(AGENT)).some((e) => e.kind === "charge"),
      "and no charge entry waits in the journal for a step no epoch carries"
    );
  });

  it("admit() refuses an empty batch under a poor payer and lets an open epoch through", async () => {
    let probes = 0;
    const batcher = new RollupBatcher(
      {
        batchSize: 8,
        maxFlushDelayMs: 0,
        signals: {
          payerBalance: async () => {
            probes += 1;
            return 0;
          },
          // Sampled every time, so the probe count below is a count of the questions asked.
          sampleIntervalMs: 0,
        },
      },
      async () => {
        throw new Error("nothing in this case commits");
      }
    );
    let refused: unknown;
    await batcher.admit().catch((e) => (refused = e));
    assert.instanceOf(refused, InsufficientPayerBalance);
    assert.equal(probes, 1);

    // A step the caller already admitted and paid for is queued without asking again: a sample
    // taken after the charge must not drop it.
    const step = { kind: EventKind.Action as const, toolId: "t", argsHash: AGENT, resultHash: AGENT, statusCode: 200 };
    await batcher.push(step, 1, { admitted: true });
    assert.equal(probes, 1, "an admitted push does not sample the balance");
    assert.equal(batcher.pendingCount, 1);

    // An epoch is open now, and an open epoch still flushes whatever the balance.
    await batcher.admit();
    assert.equal(probes, 1, "no question to ask while an epoch is open");
    batcher.dispose();
  });
});

// ─── A call the gateway was paid for is recorded even when its body never arrived ────────────

/** One call, paid for and cut: the transport raises `PaidCallFailed` with a 750-unit voucher. */
class CutStream implements ChatTransport {
  calls = 0;

  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    throw new PaidCallFailed("OpenRouter request failed (200): the stream was cut", {
      rail: "tempo",
      chainId: 4217,
      payer: "0x18fB0000000000000000000000000000000000B0",
      channelId: "0x7f3c",
      cumulativeBefore: "0",
      cumulativeAfter: "750",
    });
  }
}

describe("a paid call whose body never arrived", () => {
  it("records the failed call with its voucher and charges the user for it", async () => {
    const chain = new FakeChain();
    const billing = chargingBilling();
    const store = new RecordingStore();
    const events: RuntimeEvent[] = [];
    const { runtime } = sessionOn(chain, {
      transport: new CutStream(),
      billing,
      store,
      onEvent: (e) => events.push(e),
    });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "cut" });

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /the stream was cut/);
    const actions = events.filter((e) => e.type === "action" && e.toolId?.startsWith("llm."));
    assert.lengthOf(actions, 1, "exactly one llm.* Action for the one paid call");
    assert.equal(actions[0].statusCode, 502, "a failure after 2xx headers is recorded as a bad gateway");
    const expected = toMicroUsdcFromBase(750n, runtime.margin);
    assert.deepEqual(billing.charges, [expected.toString()], "the provider failed, so the user pays");
    assert.equal(result.costMicroUsdc, expected);
    assert.equal(result.batchedSteps, 1, "and the step went into the session's epoch");

    // The blob the record hashes carries the voucher where `verifyChannels` looks for it.
    const withPayment = store.puts.map((b) => paymentFromBlob(b)).filter((p) => p !== null);
    assert.lengthOf(withPayment, 1);
    assert.equal(withPayment[0]!.cumulativeAfter, "750");
  });

  it("charges a call our own deadline cut for the voucher delta it spent, once", async () => {
    // The gateway redeems the voucher whether or not anyone read the stream, so a cut call left
    // unbilled would be the operator paying for a stream the user's prompt ran past the deadline.
    const chain = new FakeChain();
    const billing = chargingBilling();
    const { runtime } = sessionOn(chain, { transport: new CutStream(), billing });
    const deadline = new AbortController();
    deadline.abort();

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "deadline", signal: deadline.signal });

    assert.equal(result.status, "failed");
    const expected = toMicroUsdcFromBase(750n, runtime.margin);
    assert.deepEqual(billing.charges, [expected.toString()], "one debit, for exactly the delta the voucher moved");
    assert.equal(result.costMicroUsdc, expected);
    assert.equal(result.unbilledMicroUsdc, 0n, "nothing of the spent delta is left to the operator");
    assert.equal(result.batchedSteps, 1, "recorded all the same, so the channel stays contiguous");
  });
});

// ─── A loop key's records, as the runtime stores them ────────────────────────────────────────

const ROOT = "0x18fB0000000000000000000000000000000000B0";
const LOOP_KEY = "0x6B1aE0a6f2C9e4D3b5A7c8E9f0a1B2c3D4e5F607";

/** mppx's session manager as far as the transport reads it: one buffered answer, 750 base units. */
class OneAnswerSession implements MppSession {
  opened = false;
  channelId: string | undefined;
  private total = BigInt(0);

  get cumulative(): bigint {
    return this.total;
  }

  async fetch(): Promise<Response> {
    this.opened = true;
    this.channelId = "0x" + "7f".repeat(32);
    this.total += BigInt(750);
    const body = {
      id: "gen-1",
      model: "test/model",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.00001 },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }

  async close(): Promise<MppCloseReceipt> {
    return { txHash: "0x00", spent: this.total };
  }
}

describe("a loop key's payment record in the stored blob", () => {
  async function storedPayments(account: { address: string; accessKeyAddress?: string }) {
    const chain = new FakeChain();
    const store = new RecordingStore();
    const transport = new MppOpenRouterTransport({
      account,
      maxCostBase: BigInt(10_000),
      maxSteps: 4,
      sessionFactory: async () => new OneAnswerSession(),
    });
    const { runtime } = sessionOn(chain, { transport, billing: chargingBilling(), store });
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "keyed" });
    assert.equal(result.status, "success");
    const texts = store.puts.map((b) => new TextDecoder().decode(b));
    const blobs = store.puts.filter((b) => paymentFromBlob(b) !== null);
    assert.lengthOf(blobs, 1, "one paid call, one blob carrying its voucher");
    return { texts, payment: JSON.parse(new TextDecoder().decode(blobs[0])).payment };
  }

  it("carries the key as signer and the root as payer into the blob result_hash commits", async () => {
    const { payment } = await storedPayments({ address: ROOT, accessKeyAddress: LOOP_KEY });
    assert.equal(payment.payer, ROOT, "payer stays the treasury: one payer per chain");
    assert.equal(payment.signer, LOOP_KEY);
    assert.equal(payment.cumulativeAfter, "750");
  });

  it("stores a treasury session's blobs with no signer anywhere", async () => {
    const { payment, texts } = await storedPayments({ address: ROOT });
    assert.equal(payment.payer, ROOT);
    assert.notProperty(payment, "signer");
    for (const t of texts) assert.notInclude(t, '"signer"');
  });
});

// ─── A delegation always closes, and its child spends out of the parent's budget ─────────────

/** Turn 1 hands a task to `child`, turn 2 answers. */
class Delegating implements ChatTransport {
  calls = 0;

  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    const message: ChatMessage =
      this.calls === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "delegate", arguments: JSON.stringify({ agent: "child", task: "look" }) },
              },
            ],
          }
        : { role: "assistant", content: "done" };
    return {
      status: 200,
      body: { id: `gen-${this.calls}`, model: "test/model", choices: [{ index: 0, message }], usage: { cost: 0 } },
    };
  }
}

/** A child that answers at once, at a fixed cost, and remembers the signal it was handed. */
class Answering implements ChatTransport {
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly costUsd: number;

  constructor(costUsd: number) {
    this.costUsd = costUsd;
  }

  async chat(_req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    this.signals.push(opts?.signal);
    return {
      status: 200,
      body: {
        id: "gen-child",
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content: "found it" } }],
        usage: { cost: this.costUsd },
      },
    };
  }
}

describe("a delegation from a session", () => {
  const CHILD = idFromString("runtime-budget-child");

  function childOn(chain: FakeChain, transport: ChatTransport): DelegateDefinition {
    return {
      name: "child",
      create: () => sessionOn(chain, { transport, billing: new NoopBilling(), rollup: false, agentId: CHILD }).runtime,
    };
  }

  function parentOn(chain: FakeChain, transport: ChatTransport, delegate: DelegateDefinition, maxCost?: number) {
    return sessionOn(chain, { transport, billing: new NoopBilling(), rollup: false, maxCost, delegates: [delegate] })
      .runtime;
  }

  it("closes the Delegation with a 500 when the child's session throws, and the parent carries on", async () => {
    const chain = new FakeChain();
    const parent = new Delegating();
    const delegate: DelegateDefinition = {
      name: "child",
      create: () => {
        const child = childOn(chain, new Answering(0)).create() as AgentRuntime;
        child.start = async () => {
          throw new Error("the child's chain would not open");
        };
        return child;
      },
    };

    const result = await parentOn(chain, parent, delegate).start({ user: USER, prompt: "go", sessionId: "crash" });

    assert.equal(result.status, "success", "one child crashing is information, not a failed session");
    assert.equal(parent.calls, 2, "the parent got its second turn");
    const at = result.events.findIndex((e) => e.input.kind === EventKind.Delegation);
    assert.isAtLeast(at, 0);
    const closing = result.events[at + 1];
    assert.equal(closing.input.kind, EventKind.Action);
    assert.equal(hex(closing.input.reference), hex(idFromString("delegate.child")));
    assert.equal(closing.input.status, 500);
  });

  it("closes a Delegation whose open fails after the record, and the parent carries on", async () => {
    const chain = new FakeChain();
    const parent = new Delegating();
    const runtime = parentOn(chain, parent, childOn(chain, new Answering(0)));
    // The graph edge is the write after the Delegation record; refuse it.
    (runtime as unknown as { graph: unknown }).graph = {
      ensureCreated: async () => false,
      addEdge: async () => {
        throw new Error("the edge cell was refused");
      },
    };

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "edge" });

    assert.equal(result.status, "success", "a delegation that could not open is information, as a crash is");
    assert.equal(parent.calls, 2);
    const at = result.events.findIndex((e) => e.input.kind === EventKind.Delegation);
    assert.isAtLeast(at, 0);
    const closing = result.events[at + 1];
    assert.exists(closing, "the Delegation is not left open");
    assert.equal(closing.input.kind, EventKind.Action);
    assert.equal(hex(closing.input.reference), hex(idFromString("delegate.child")));
    assert.equal(closing.input.status, 500);
  });

  it("counts a grandchild's spend in the parent's delegated total, through the child's own", async () => {
    const chain = new FakeChain();
    const GRANDCHILD = idFromString("runtime-budget-grandchild");
    // The middle agent delegates in turn, and only the grandchild pays for a call.
    const middle: DelegateDefinition = {
      name: "child",
      create: () =>
        sessionOn(chain, {
          transport: new Delegating(),
          billing: new NoopBilling(),
          rollup: false,
          agentId: CHILD,
          delegates: [
            {
              name: "child",
              create: () =>
                sessionOn(chain, {
                  transport: new Answering(0.002),
                  billing: new NoopBilling(),
                  rollup: false,
                  agentId: GRANDCHILD,
                }).runtime,
            },
          ],
        }).runtime,
    };
    const runtime = parentOn(chain, new Delegating(), middle);
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "nested" });

    assert.equal(result.status, "success", result.reason);
    assert.equal(result.costMicroUsdc, 0n);
    assert.equal(
      result.delegatedMicroUsdc,
      toMicroUsdc(0.002, runtime.margin),
      "the grandchild's spend is not dropped"
    );
  });

  it("hands the parent's signal to the child's session", async () => {
    const chain = new FakeChain();
    const child = new Answering(0);
    const deadline = new AbortController();

    await parentOn(chain, new Delegating(), childOn(chain, child)).start({
      user: USER,
      prompt: "go",
      sessionId: "signal",
      signal: deadline.signal,
    });

    assert.lengthOf(child.signals, 1);
    assert.strictEqual(child.signals[0], deadline.signal);
  });

  it("stops the parent when what its child spent takes the session over its budget", async () => {
    const chain = new FakeChain();
    const parent = new Delegating();
    // 0.002 USD × 1.10 = 2 200 µUSDC: over the parent's 2 000 on the child's spend alone.
    const runtime = parentOn(chain, parent, childOn(chain, new Answering(0.002)), 2_000);

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "budget" });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /µUSDC budget/, "the loop reads a budget stop off this wording");
    assert.include(result.reason ?? "", "by delegates");
    assert.equal(parent.calls, 1, "no second turn was bought over the budget");
    assert.equal(result.costMicroUsdc, 0n, "the parent's own debits are still only its own");
    assert.equal(result.delegatedMicroUsdc, toMicroUsdc(0.002, runtime.margin));
  });
});

// ─── A charge that never left the process is retried once, and only that one ────────────────

describe("the charge retry", () => {
  /**
   * A batched runtime with no anchor queue: the one path that debits through `charge` on its own,
   * ahead of the record, and so the one whose blockhash failure provably sent nothing.
   */
  const run = (failures: string[]) => {
    const chain = new FakeChain();
    let attempts = 0;
    const billing: BillingBackend = {
      async chargeAndLog() {
        return null;
      },
      async charge() {
        const f = failures[attempts++];
        if (f) throw new Error(f);
        return "charged";
      },
    };
    // The synchronous committer `LathClient` would hand a rollup session, played on the fake chain:
    // the epoch's own bytes do not matter here, only that the session can close.
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
      transport: new Costing(0.001),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing,
      structures: false,
      publishPolicy: false,
      now: () => 1_700_000_000_000,
      rollup: { store: memoryEpochStore(), batchSize: 64 },
      chargeRetryDelayMs: 0,
    });
    return { runtime, attempts: () => attempts };
  };

  it("retries once after a blockhash failure and the step goes through", async () => {
    const { runtime, attempts } = run(["failed to get recent blockhash: Error: 429 Too Many Requests"]);
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "r1", maxSteps: 1 } as any);
    assert.notMatch(result.reason ?? "", /billing charge failed/);
    assert.isAtLeast(attempts(), 2, "the second attempt is the retry");
  });

  it("fails the session after a second blockhash failure", async () => {
    const e = "failed to get recent blockhash: Error: 429";
    const { runtime, attempts } = run([e, e, e, e]);
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "r2" });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /^billing charge failed/);
    assert.equal(attempts(), 2, "one retry, not more");
  });

  it("never retries a failure that may have landed", async () => {
    const { runtime, attempts } = run(["429 Too Many Requests while confirming"]);
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "r3" });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /^billing charge failed/);
    assert.equal(attempts(), 1, "a possibly-landed charge is not resent");
  });

  it("never runs chargeAndLog twice: its blockhash error may follow an attempt that was sent", async () => {
    // `LathClient.logEvent` retries a blockhash failure itself, with an in-doubt ledger; the error that
    // reaches the runtime can be the last attempt's after an earlier one went out, and a second call
    // would start a fresh ledger — a second Action and a second debit.
    const chain = new FakeChain();
    let attempts = 0;
    const billing: BillingBackend = {
      async chargeAndLog() {
        attempts++;
        throw new Error("failed to get recent blockhash: Error: 429 Too Many Requests");
      },
    };
    const { runtime } = sessionOn(chain, { transport: new Costing(0.001), billing, rollup: false });
    (runtime as unknown as { chargeRetryDelayMs: number }).chargeRetryDelayMs = 0;
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "r4" });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /^billing charge failed/);
    assert.equal(attempts, 1);
  });
});

// ─── The key's call scopes in the policy ──────────────────────────────────────────────────────

/**
 * The chat-run policy and the key terms `tests/tempo-inference.ts` pins its key vectors with, so the
 * hashes here are the same two: a policy without a key, and one with the unscoped key. Scopes are
 * the only member this build adds, and an unscoped key must still be those five keys byte for byte.
 */
const CHAT_RUN: RuntimePolicy = {
  model: "anthropic/claude-sonnet-5",
  temperature: 0.2,
  toolAllowList: ["a", "b"],
  maxCost: 5_000,
};
const CHAT_RUN_HASH = "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0";
// `LOOP_KEY` is the loop-key block's above: the same key `tests/tempo-inference.ts` pins its vector with.
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const UNSCOPED_KEY = {
  address: LOOP_KEY.toLowerCase(),
  token: USDC_E,
  limitBase: "5750000",
  expiry: 1_767_225_600,
  authorizeTx: "0x" + "ab".repeat(32),
};
const UNSCOPED_KEY_VECTOR = "fe2e7269cf87e84dc9fdca1260f7a1e8f453fe3cf324bf85c8a74fafa4b63bbb";

/** Three scopes as a writer might hand them over: checksummed, out of order, recipients unsorted. */
const ESCROW = "0x4D50500000000000000000000000000000000000";
const PAYEE_A = "0xB0B0000000000000000000000000000000000AbC";
const PAYEE_B = "0x0A0A000000000000000000000000000000000Def";
const SCOPES_AS_GIVEN: TempoKeyScope[] = [
  { address: "0x20C000000000000000000000B9537D11C60E8B50", selector: "0x95777D59", recipients: [PAYEE_A, PAYEE_B] },
  { address: ESCROW, selector: "0xA0B1C2D3" },
  { address: ESCROW, selector: "0x0C1D2E3F" },
];
/** The same scopes as the policy writes them. */
const SCOPES_DOCUMENT =
  `"scopes":[` +
  `{"address":"${USDC_E}","recipients":["${PAYEE_B.toLowerCase()}","${PAYEE_A.toLowerCase()}"],"selector":"0x95777d59"},` +
  `{"address":"${ESCROW.toLowerCase()}","selector":"0x0c1d2e3f"},` +
  `{"address":"${ESCROW.toLowerCase()}","selector":"0xa0b1c2d3"}]`;
/**
 * `sha256(policyDocument({ ...CHAT_RUN, tempoKey: { ...UNSCOPED_KEY, scopes: SCOPES_AS_GIVEN } }))`,
 * pinned: what a scoped loop's Genesis and the audit rebuilding it from `getAllowedCalls`
 * must both reproduce (audit (d)).
 */
const SCOPED_KEY_VECTOR = "5395959f907569f52048c676928434d1560723393456184b9f09aa0997c556cf";

describe("a loop key's call scopes in the policy", () => {
  const scoped = (scopes: unknown): RuntimePolicy => ({
    ...CHAT_RUN,
    tempoKey: { ...UNSCOPED_KEY, scopes: scopes as TempoKeyScope[] },
  });

  it("leaves the unkeyed and the unscoped key's hashes exactly where they are pinned", () => {
    assert.equal(hex(policyVersionHash(CHAT_RUN)), CHAT_RUN_HASH);
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, tempoKey: UNSCOPED_KEY })), UNSCOPED_KEY_VECTOR);
    // `scopes: undefined` is a key nobody scoped: the member stays the five keys, no `scopes` at all.
    const undef = { ...CHAT_RUN, tempoKey: { ...UNSCOPED_KEY, scopes: undefined } };
    assert.equal(hex(policyVersionHash(undef)), UNSCOPED_KEY_VECTOR);
    assert.notInclude(policyDocument(undef), "scopes");
  });

  it("commits a scoped key's scopes normalised: lower-case, sorted, recipients sorted", () => {
    const doc = policyDocument(scoped(SCOPES_AS_GIVEN));
    assert.include(doc, SCOPES_DOCUMENT);
    assert.equal(hex(policyVersionHash(scoped(SCOPES_AS_GIVEN))), SCOPED_KEY_VECTOR);
    // The caller's list is read, never sorted in place: a loop row keeps the order it was written in.
    assert.equal(SCOPES_AS_GIVEN[0].address, "0x20C000000000000000000000B9537D11C60E8B50");
    assert.deepEqual(SCOPES_AS_GIVEN[0].recipients, [PAYEE_A, PAYEE_B]);
  });

  it("hashes two writers of one key's scopes alike: order, case, extras and an empty recipients list", () => {
    const on = hex(policyVersionHash(scoped(SCOPES_AS_GIVEN)));
    const otherWriter = [
      { selector: "0x0c1d2e3f", address: ESCROW.toLowerCase(), note: "open" },
      { address: USDC_E.toUpperCase().replace("0X", "0x"), selector: "0x95777d59", recipients: [PAYEE_B, PAYEE_A] },
      { address: ESCROW, selector: "0xa0b1c2d3", recipients: [] },
    ];
    assert.equal(hex(policyVersionHash(scoped(otherWriter))), on);
    assert.notInclude(policyDocument(scoped(otherWriter)), "note");
  });

  it("sorts a whole-contract scope before that contract's selectors, and keeps an empty list as scoped", () => {
    const doc = policyDocument(scoped([{ address: ESCROW, selector: "0x00000001" }, { address: ESCROW }]));
    const e = ESCROW.toLowerCase();
    assert.include(doc, `"scopes":[{"address":"${e}"},{"address":"${e}","selector":"0x00000001"}]`);
    // ox reads `[]` as a key that may call nothing and an absent list as one that may call anything,
    // so the two are different terms and must not share a hash.
    const none = scoped([]);
    assert.include(policyDocument(none), `"scopes":[]`);
    assert.notEqual(hex(policyVersionHash(none)), UNSCOPED_KEY_VECTOR);
  });

  it("moves the hash for any change of scope: a selector, a recipient, a contract", () => {
    const on = hex(policyVersionHash(scoped(SCOPES_AS_GIVEN)));
    for (const other of [
      [SCOPES_AS_GIVEN[0], SCOPES_AS_GIVEN[1]],
      [{ ...SCOPES_AS_GIVEN[0], recipients: [PAYEE_A] }, SCOPES_AS_GIVEN[1], SCOPES_AS_GIVEN[2]],
      [{ ...SCOPES_AS_GIVEN[0], selector: "0x95777d5a" }, SCOPES_AS_GIVEN[1], SCOPES_AS_GIVEN[2]],
      [SCOPES_AS_GIVEN[0], { ...SCOPES_AS_GIVEN[1], address: "0x" + "99".repeat(20) }, SCOPES_AS_GIVEN[2]],
    ]) {
      assert.notEqual(hex(policyVersionHash(scoped(other))), on);
    }
  });
});

// ─── Protocol plugins (a roadmap feature) · the grants and the loop's Solana key in the policy ───

/** A `squads.pay` grant as a console would commit it at prepare, `spendingLimit` filled. */
const PLUGIN_GRANTS: Grants = {
  v: 1,
  cluster: "devnet",
  mandate: "Pay this week's approved invoices from the council's treasury; say why for the rest.",
  barBps: 6_000,
  maxPerStep: 3,
  expiresAt: 1_767_225_600,
  items: [
    {
      id: "council",
      plugin: "squads",
      action: "pay",
      multisig: "6ZoaWHyBpXNQBMKXWCCHfL2Cp8yeTJ5bS2SDb6vWBYHo",
      vaultIndex: 1,
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      spendingLimit: "8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu",
      payees: [
        { name: "alice", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
        { name: "bob", address: "3h1zGmCwsRJnVk5BuRNMLsPaQu1y2aqXqXDWYCgrp5UG" },
      ],
      maxPerAction: "200000000",
      maxTotal: "400000000",
      uniqueRef: true,
    },
  ],
};
const PLUGIN_KEY = { address: "Ba1u5Qi9ZYKnGpxZ2PXmP5ToYV5XGBqXCHVA8dXnG7hJ", createdAt: 1_760_000_000 };
/** The `grants` member exactly as `policyDocument` writes it: keys sorted, arrays in the owner's order. */
const GRANTS_DOCUMENT =
  `"grants":{"barBps":6000,"cluster":"devnet","expiresAt":1767225600,"items":[{"action":"pay","id":"council",` +
  `"maxPerAction":"200000000","maxTotal":"400000000","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",` +
  `"multisig":"6ZoaWHyBpXNQBMKXWCCHfL2Cp8yeTJ5bS2SDb6vWBYHo","payees":[{"address":"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",` +
  `"name":"alice"},{"address":"3h1zGmCwsRJnVk5BuRNMLsPaQu1y2aqXqXDWYCgrp5UG","name":"bob"}],"plugin":"squads",` +
  `"spendingLimit":"8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu","uniqueRef":true,"vaultIndex":1}],` +
  `"mandate":"Pay this week's approved invoices from the council's treasury; say why for the rest.","maxPerStep":3,"v":1}`;
/** `sha256(policyDocument({ ...CHAT_RUN, grants: PLUGIN_GRANTS, solanaKey: PLUGIN_KEY }))`, pinned. */
const GRANTS_VECTOR = "a128c1c251f09eea54df0c0afcdd5d546a4edba922994fe75d09ebcc687635bf";

describe("a loop's protocol-plugin grants in the policy", () => {
  const granted = (g: unknown, k: unknown = PLUGIN_KEY): RuntimePolicy => ({
    ...CHAT_RUN,
    grants: g as Grants,
    solanaKey: k as RuntimePolicy["solanaKey"],
  });

  it("leaves every policy without grants exactly where it was", () => {
    assert.equal(hex(policyVersionHash(CHAT_RUN)), CHAT_RUN_HASH);
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, grants: undefined, solanaKey: undefined })), CHAT_RUN_HASH);
    assert.equal(
      hex(policyVersionHash({ ...CHAT_RUN, tempoKey: UNSCOPED_KEY, grants: undefined })),
      UNSCOPED_KEY_VECTOR
    );
    assert.equal(
      hex(
        policyVersionHash({ ...CHAT_RUN, tempoKey: { ...UNSCOPED_KEY, scopes: SCOPES_AS_GIVEN }, solanaKey: undefined })
      ),
      SCOPED_KEY_VECTOR
    );
    assert.notInclude(policyDocument(CHAT_RUN), "grants");
    assert.notInclude(policyDocument(CHAT_RUN), "solanaKey");
    // Spread, not set to `undefined`: a policy object without grants has exactly the keys it had.
    assert.notProperty(toRuntimePolicy(CHAT_RUN), "grants");
    assert.notProperty(toRuntimePolicy(CHAT_RUN), "solanaKey");
  });

  it("commits the grants and the key picked key by key, under a pinned vector", () => {
    const doc = policyDocument(granted(PLUGIN_GRANTS));
    assert.include(doc, GRANTS_DOCUMENT);
    assert.include(doc, `"solanaKey":{"address":"${PLUGIN_KEY.address}","createdAt":1760000000}`);
    assert.equal(hex(policyVersionHash(granted(PLUGIN_GRANTS))), GRANTS_VECTOR);
    // The caller's object is read, never changed.
    assert.equal((PLUGIN_GRANTS.items[0] as SquadsGrantItem).payees[0].name, "alice");
  });

  it("hashes two writers of one grant alike: key order, extras, and a `createdAt` as a string", () => {
    const g = PLUGIN_GRANTS;
    const i = g.items[0] as SquadsGrantItem;
    const otherWriter = {
      items: [
        {
          uniqueRef: true,
          payees: i.payees.map((p) => ({ address: p.address, name: p.name, note: "x" })),
          maxTotal: i.maxTotal,
          maxPerAction: i.maxPerAction,
          spendingLimit: i.spendingLimit,
          mint: i.mint,
          vaultIndex: i.vaultIndex,
          multisig: i.multisig,
          action: i.action,
          plugin: i.plugin,
          id: i.id,
          extra: 1,
        },
      ],
      expiresAt: g.expiresAt,
      maxPerStep: g.maxPerStep,
      barBps: g.barBps,
      mandate: g.mandate,
      cluster: g.cluster,
      v: g.v,
      signedBy: "nobody",
    };
    const key = { createdAt: "1760000000", address: PLUGIN_KEY.address, lamports: 1 };
    assert.equal(hex(policyVersionHash(granted(otherWriter, key))), GRANTS_VECTOR);
  });

  it("keeps the items and payees in the owner's order, and writes `spendingLimit` only when filled", () => {
    const i = PLUGIN_GRANTS.items[0] as SquadsGrantItem;
    const swapped = { ...PLUGIN_GRANTS, items: [{ ...i, payees: [...i.payees].reverse() }] };
    assert.notEqual(hex(policyVersionHash(granted(swapped))), GRANTS_VECTOR);
    const unfilled = { ...PLUGIN_GRANTS, items: [{ ...i, spendingLimit: undefined }] };
    assert.notInclude(policyDocument(granted(unfilled)), "spendingLimit");
    assert.notEqual(hex(policyVersionHash(granted(unfilled))), GRANTS_VECTOR);
  });

  it("moves the hash for any change of a rule or of the key", () => {
    const i = PLUGIN_GRANTS.items[0] as SquadsGrantItem;
    for (const other of [
      { ...PLUGIN_GRANTS, barBps: 6_001 },
      { ...PLUGIN_GRANTS, maxPerStep: 2 },
      { ...PLUGIN_GRANTS, expiresAt: PLUGIN_GRANTS.expiresAt + 1 },
      { ...PLUGIN_GRANTS, mandate: `${PLUGIN_GRANTS.mandate} ` },
      { ...PLUGIN_GRANTS, items: [{ ...i, maxTotal: "400000001" }] },
      { ...PLUGIN_GRANTS, items: [{ ...i, maxPerAction: "199999999" }] },
      { ...PLUGIN_GRANTS, items: [{ ...i, vaultIndex: 0 }] },
      { ...PLUGIN_GRANTS, items: [{ ...i, payees: [i.payees[0]] }] },
      { ...PLUGIN_GRANTS, items: [{ ...i, payees: [i.payees[0], { ...i.payees[1], address: PLUGIN_KEY.address }] }] },
    ]) {
      assert.notEqual(hex(policyVersionHash(granted(other))), GRANTS_VECTOR);
    }
    assert.notEqual(
      hex(policyVersionHash(granted(PLUGIN_GRANTS, { ...PLUGIN_KEY, createdAt: PLUGIN_KEY.createdAt + 1 }))),
      GRANTS_VECTOR
    );
  });
});

// ─── Protocol plugins (a roadmap feature) · an `sas.attest` grant in the policy ───

/** An `sas.attest` grant: _target_ on the demo credential's `upgrade-authority` v1. */
const SAS_GRANTS: Grants = {
  v: 1,
  cluster: "devnet",
  mandate: "Publish who can upgrade each subject only when your answer cites the program's account on chain.",
  barBps: 6_000,
  maxPerStep: 1,
  expiresAt: 1_767_225_600,
  items: [
    {
      id: "upgrades",
      plugin: "sas",
      action: "attest",
      credential: "BewvqsfA1tFejBKDs6ZGza8Pp5CFmpE2pB81jRamaK9C",
      schema: "4hTjaY3F9XVuq1YTNTyJc3h6NKU6A7KqkMUCY7RbHY1a",
      subjects: [{ name: "target", address: "3UViFkVCxgfiGprWkvBkqTodoorLPh2fqw9nZHaasHqd" }],
      maxTotal: 3,
      expiresInDays: 7,
    },
  ],
};
/** The SAS item exactly as `policyDocument` writes it: every field, keys sorted, subjects in order. */
const SAS_GRANTS_DOCUMENT =
  `"grants":{"barBps":6000,"cluster":"devnet","expiresAt":1767225600,"items":[{"action":"attest",` +
  `"credential":"BewvqsfA1tFejBKDs6ZGza8Pp5CFmpE2pB81jRamaK9C","expiresInDays":7,"id":"upgrades","maxTotal":3,` +
  `"plugin":"sas","schema":"4hTjaY3F9XVuq1YTNTyJc3h6NKU6A7KqkMUCY7RbHY1a","subjects":[{"address":` +
  `"3UViFkVCxgfiGprWkvBkqTodoorLPh2fqw9nZHaasHqd","name":"target"}]}],"mandate":"Publish who can upgrade each ` +
  `subject only when your answer cites the program's account on chain.","maxPerStep":1,"v":1}`;
/** `sha256(policyDocument({ ...CHAT_RUN, grants: SAS_GRANTS, solanaKey: PLUGIN_KEY }))`, pinned. */
const SAS_GRANTS_VECTOR = "4a5ff5caddafab913e0e2dff3e6357c53c955d130f06a132c8830290854adfff";

describe("a loop's `sas.attest` grant in the policy", () => {
  const granted = (g: unknown): RuntimePolicy => ({ ...CHAT_RUN, grants: g as Grants, solanaKey: PLUGIN_KEY });
  const item = SAS_GRANTS.items[0] as SasGrantItem;

  it("commits every field of the SAS item, which a Squads-only copy would have dropped, under a pinned vector", () => {
    const doc = policyDocument(granted(SAS_GRANTS));
    assert.include(doc, SAS_GRANTS_DOCUMENT);
    assert.equal(hex(policyVersionHash(granted(SAS_GRANTS))), SAS_GRANTS_VECTOR);
    // No Squads key appears on an SAS item, not even as an undefined one `canonicalJson` would drop.
    const written = toRuntimePolicy(granted(SAS_GRANTS)).grants!.items[0];
    for (const k of ["multisig", "vaultIndex", "mint", "spendingLimit", "payees", "maxPerAction", "uniqueRef"]) {
      assert.notProperty(written, k);
    }
  });

  it("drops a writer's extras and ignores key order, on the item and on each subject", () => {
    const otherWriter = {
      signedBy: "nobody",
      v: 1,
      cluster: "devnet",
      expiresAt: SAS_GRANTS.expiresAt,
      maxPerStep: SAS_GRANTS.maxPerStep,
      barBps: SAS_GRANTS.barBps,
      mandate: SAS_GRANTS.mandate,
      items: [
        {
          expiresInDays: item.expiresInDays,
          maxTotal: item.maxTotal,
          subjects: item.subjects.map((s) => ({ address: s.address, name: s.name, note: "x" })),
          schema: item.schema,
          credential: item.credential,
          action: item.action,
          plugin: item.plugin,
          id: item.id,
          payees: [{ name: "alice", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }],
          extra: 1,
        },
      ],
    };
    assert.equal(hex(policyVersionHash(granted(otherWriter))), SAS_GRANTS_VECTOR);
  });

  it("moves the hash for any change of an SAS field, and keeps the subjects in the owner's order", () => {
    const second = { name: "council", address: "6ZoaWHyBpXNQBMKXWCCHfL2Cp8yeTJ5bS2SDb6vWBYHo" };
    const two = { ...SAS_GRANTS, items: [{ ...item, subjects: [...item.subjects, second] }] };
    const swapped = { ...SAS_GRANTS, items: [{ ...item, subjects: [second, ...item.subjects] }] };
    assert.notEqual(hex(policyVersionHash(granted(two))), hex(policyVersionHash(granted(swapped))));
    for (const other of [
      two,
      { ...SAS_GRANTS, items: [{ ...item, credential: PLUGIN_KEY.address }] },
      { ...SAS_GRANTS, items: [{ ...item, schema: PLUGIN_KEY.address }] },
      { ...SAS_GRANTS, items: [{ ...item, maxTotal: 2 }] },
      { ...SAS_GRANTS, items: [{ ...item, expiresInDays: 8 }] },
      { ...SAS_GRANTS, items: [{ ...item, subjects: [{ ...item.subjects[0], name: "target2" }] }] },
    ]) {
      assert.notEqual(hex(policyVersionHash(granted(other))), SAS_GRANTS_VECTOR);
    }
  });

  it("leaves the Squads grant's vector where it was beside it", () => {
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, grants: PLUGIN_GRANTS, solanaKey: PLUGIN_KEY })), GRANTS_VECTOR);
  });
});

// ─── A chat call that got no answer: retried, then a fallback ───────────────────────────────

const RETRY_PAYER = "0x18fB0000000000000000000000000000000000B0";
const RETRY_CHANNEL = "0x" + "4b".repeat(32);

/** What one scripted attempt does: time out after its voucher, answer, or fail some other way. */
type AttemptPlan = "timeout" | "answer" | "refused" | "cut";

/**
 * A transport that plays one plan per call on one channel, advancing the cumulative 750 base units
 * for every paid attempt — a timeout after 2xx headers is paid, as the gateway does — and
 * keeping what each call asked for and with which options.
 */
class Attempts implements ChatTransport {
  readonly seen: { model: string; opts?: ChatStreamOptions }[] = [];
  private cumulative = 0n;
  private readonly plans: AttemptPlan[];

  constructor(plans: AttemptPlan[]) {
    this.plans = plans;
  }

  private bracket() {
    const before = this.cumulative;
    this.cumulative += 750n;
    return {
      rail: "tempo" as const,
      chainId: 4217,
      payer: RETRY_PAYER,
      channelId: RETRY_CHANNEL,
      cumulativeBefore: before.toString(),
      cumulativeAfter: this.cumulative.toString(),
    };
  }

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    this.seen.push({ model: req.model, opts });
    const plan = this.plans[Math.min(this.seen.length - 1, this.plans.length - 1)];
    if (plan === "timeout") {
      throw new PaidCallFailed(
        "the gateway sent no part of the model's answer in 45 s",
        this.bracket(),
        undefined,
        true
      );
    }
    if (plan === "cut") throw new PaidCallFailed("OpenRouter request failed (200): the stream was cut", this.bracket());
    if (plan === "refused") throw new Error("the voucher was refused: the key's limit is spent");
    const payment = this.bracket();
    return {
      status: 200,
      streamed: true,
      body: {
        id: `gen-${this.seen.length}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 },
      },
      payment,
    };
  }
}

function retryingSession(
  chain: FakeChain,
  o: {
    transport: ChatTransport;
    billing: BillingBackend;
    fallbackModel?: string;
    noAnswer?: NoAnswerOptions | false;
    maxCost?: number;
    store?: MemoryTraceStore;
    onEvent?: (e: RuntimeEvent) => void;
    /** `false`: a synchronous session, each Action its own record with its charge in the same transaction. */
    rollup?: boolean;
  }
) {
  (chain as unknown as { chainSignals: () => ChainSignals }).chainSignals = () => ({});
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing: o.billing,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: AGENT,
    transport: o.transport,
    policy: {
      model: "test/model",
      temperature: 0,
      toolAllowList: [],
      maxCost: o.maxCost ?? 1_000_000,
      ...(o.fallbackModel !== undefined ? { fallbackModel: o.fallbackModel } : {}),
    },
    billing: o.billing,
    structures: false,
    publishPolicy: false,
    now: () => 1_700_000_000_000,
    store: o.store,
    onEvent: o.onEvent,
    ...(o.rollup === false
      ? {}
      : { rollup: { store: memoryEpochStore(), batchSize: 64 }, anchor: { queue, drain: true } }),
    ...(o.noAnswer === false ? {} : { noAnswer: o.noAnswer ?? {} }),
  });
  return runtime;
}

/** The `llm.*` Actions a session emitted, in order. */
function llmActions(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.filter((e) => e.type === "action" && e.toolId?.startsWith("llm."));
}

describe("a chat call that got no answer", () => {
  it("answers from the retry when the first attempt timed out, each attempt its own voucher and record", async () => {
    const chain = new FakeChain();
    const billing = chargingBilling();
    const events: RuntimeEvent[] = [];
    const transport = new Attempts(["timeout", "answer"]);
    const runtime = retryingSession(chain, { transport, billing, onEvent: (e) => events.push(e) });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "retry-1" });

    assert.equal(result.status, "success", result.reason);
    assert.equal(result.output, "done");
    assert.deepEqual(
      transport.seen.map((c) => c.model),
      ["test/model", "test/model"]
    );
    // Attempt 1 has a first-data window and is streamed; the retry is the last attempt and has
    // only the call's deadline, which both share.
    assert.equal(transport.seen[0].opts?.firstDataMs, CHAT_FIRST_DATA_MS[0]);
    assert.isFunction(transport.seen[0].opts?.onToken);
    assert.isUndefined(transport.seen[1].opts?.firstDataMs);
    assert.equal(transport.seen[0].opts?.deadlineAt, transport.seen[1].opts?.deadlineAt);
    assert.equal(transport.seen[0].opts?.attempt, "attempt 1 of 2, test/model");
    const llm = llmActions(events);
    assert.deepEqual(
      llm.map((e) => `${e.toolId}:${e.statusCode}`),
      ["llm.test/model:502", "llm.test/model:200"]
    );
    // One channel, contiguous: the retry opens where the timed-out attempt closed.
    assert.deepEqual(
      llm.map((e) => `${e.payment!.cumulativeBefore}→${e.payment!.cumulativeAfter}`),
      ["0→750", "750→1500"]
    );
    assert.equal(result.steps, 1, "a retry is the same turn, not another one");
  });

  it("answers from the committed fallback when the policy's model timed out twice", async () => {
    const chain = new FakeChain();
    const billing = chargingBilling();
    const events: RuntimeEvent[] = [];
    const transport = new Attempts(["timeout", "cut", "answer"]);
    const runtime = retryingSession(chain, {
      transport,
      billing,
      fallbackModel: "fallback/model",
      onEvent: (e) => events.push(e),
    });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "retry-2" });

    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(
      transport.seen.map((c) => c.model),
      ["test/model", "test/model", "fallback/model"]
    );
    assert.deepEqual(
      transport.seen.map((c) => c.opts?.firstDataMs),
      [CHAT_FIRST_DATA_MS[0], CHAT_FIRST_DATA_MS[1], undefined]
    );
    // The record names the model that served, which is the fallback the policy commits.
    assert.deepEqual(
      llmActions(events).map((e) => `${e.toolId}:${e.statusCode}`),
      ["llm.test/model:502", "llm.test/model:502", "llm.fallback/model:200"]
    );
    assert.include(policyDocument(runtime.policy), `"fallbackModel":"fallback/model"`);
  });

  it("retries once on the same model and no further when no fallback is configured", async () => {
    const chain = new FakeChain();
    const events: RuntimeEvent[] = [];
    const transport = new Attempts(["timeout", "timeout", "answer"]);
    const runtime = retryingSession(chain, { transport, billing: chargingBilling(), onEvent: (e) => events.push(e) });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "retry-3" });

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /^the model gave no answer after 2 attempts: attempt 1 \(test\/model\): /);
    assert.lengthOf(transport.seen, 2);
    assert.lengthOf(llmActions(events), 2, "both paid attempts are on the chain with their vouchers");
    assert.equal(result.cause, "no-answer", "read by type, so a loop can say the model did not answer");
  });

  it("fails the call when every attempt, the fallback's too, got no answer", async () => {
    const chain = new FakeChain();
    const transport = new Attempts(["timeout", "timeout", "timeout"]);
    const runtime = retryingSession(chain, { transport, billing: chargingBilling(), fallbackModel: "fallback/model" });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "retry-4" });

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /no answer after 3 attempts/);
    assert.lengthOf(transport.seen, 3);
  });

  it("does not retry a failure that is not a missing answer, nor a call the caller abandoned", async () => {
    const refused = new Attempts(["refused", "answer"]);
    const r1 = await retryingSession(new FakeChain(), { transport: refused, billing: chargingBilling() }).start({
      user: USER,
      prompt: "go",
      sessionId: "retry-5a",
    });
    assert.equal(r1.status, "failed");
    assert.match(r1.reason ?? "", /voucher was refused/);
    assert.lengthOf(refused.seen, 1);
    assert.isUndefined(r1.cause, "a refusal is a failure, not a missing answer");

    const abandoned = new Attempts(["cut", "answer"]);
    const gone = new AbortController();
    gone.abort();
    const r2 = await retryingSession(new FakeChain(), { transport: abandoned, billing: chargingBilling() }).start({
      user: USER,
      prompt: "go",
      sessionId: "retry-5b",
      signal: gone.signal,
    });
    assert.equal(r2.status, "failed");
    assert.lengthOf(abandoned.seen, 1, "the caller walked away; a retry would buy an answer nobody reads");
  });

  it("starts no retry with less than the least attempt time left of the call", async () => {
    const slow: ChatTransport = {
      async chat(req, opts) {
        await new Promise((r) => setTimeout(r, 40));
        return new Attempts(["timeout"]).chat(req, opts);
      },
    };
    const result = await retryingSession(new FakeChain(), {
      transport: slow,
      billing: chargingBilling(),
      noAnswer: { callBudgetMs: 60, minAttemptMs: 50 },
    }).start({ user: USER, prompt: "go", sessionId: "retry-6" });
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /no answer after 1 attempt: .*no time left for attempt 2/);
  });

  it("sends a call exactly as before when the runtime was not given noAnswer", async () => {
    const transport = new Attempts(["timeout", "answer"]);
    const result = await retryingSession(new FakeChain(), {
      transport,
      billing: chargingBilling(),
      noAnswer: false,
    }).start({ user: USER, prompt: "go", sessionId: "retry-7" });
    assert.equal(result.status, "failed");
    assert.lengthOf(transport.seen, 1);
    assert.deepEqual(Object.keys(transport.seen[0].opts ?? {}).sort(), ["onToken", "signal"]);
    assert.isUndefined(transport.seen[0].opts?.onToken, "a buffered call stays buffered");
  });
});

describe("the fallback model in the policy", () => {
  it("leaves every policy without a fallback, or with its own model as one, at the hash it had", () => {
    assert.equal(hex(policyVersionHash(CHAT_RUN)), CHAT_RUN_HASH);
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, fallbackModel: undefined })), CHAT_RUN_HASH);
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, fallbackModel: "" })), CHAT_RUN_HASH);
    assert.equal(hex(policyVersionHash({ ...CHAT_RUN, fallbackModel: ` ${CHAT_RUN.model} ` })), CHAT_RUN_HASH);
    assert.notInclude(policyDocument({ ...CHAT_RUN, fallbackModel: CHAT_RUN.model }), "fallbackModel");
  });

  it("commits a configured fallback, trimmed, and moves the hash for it", () => {
    const doc = policyDocument({ ...CHAT_RUN, fallbackModel: " openai/gpt-5-mini " });
    assert.include(doc, `"fallbackModel":"openai/gpt-5-mini"`);
    assert.notEqual(hex(policyVersionHash({ ...CHAT_RUN, fallbackModel: "openai/gpt-5-mini" })), CHAT_RUN_HASH);
    assert.deepEqual(chatAttemptModels({ model: "a/b" }), ["a/b", "a/b"]);
    assert.deepEqual(chatAttemptModels({ model: "a/b", fallbackModel: "c/d" }), ["a/b", "a/b", "c/d"]);
  });
});

describe("an attempt that got no answer costs the owner nothing", () => {
  it("debits the owner for the answer only, and records the lost attempt's voucher as Lath's", async () => {
    const chain = new FakeChain();
    const billing = chargingBilling();
    const store = new RecordingStore();
    const events: RuntimeEvent[] = [];
    const absorbed: bigint[] = [];
    const transport = new Attempts(["timeout", "answer"]);
    const runtime = retryingSession(chain, {
      transport,
      billing,
      store,
      onEvent: (e) => events.push(e),
      noAnswer: { onAbsorbed: (b) => absorbed.push(b) },
    });

    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "absorb-1" });

    assert.equal(result.status, "success", result.reason);
    const answer = toMicroUsdcFromBase(750n, runtime.margin);
    assert.deepEqual(billing.charges, [answer.toString()], "one debit, for the attempt that answered");
    assert.equal(result.costMicroUsdc, answer);
    assert.equal(result.unbilledMicroUsdc, 0n, "the lost attempt is not left to the operator unbilled either");
    assert.equal(result.absorbedBase, 750n);
    assert.deepEqual(absorbed, [750n], "the console is told what Lath paid, to count against its share");
    const [lost, served] = llmActions(events);
    assert.equal(lost.absorbed, true);
    assert.equal(lost.costMicroUsdc, "0");
    assert.equal(lost.payment!.cumulativeAfter, "750", "the voucher is still on the record");
    assert.isUndefined(served.absorbed);
    // The blob says whose voucher it was, beside the voucher, inside what `result_hash` commits.
    const blobs = store.puts.map((b) => {
      try {
        return JSON.parse(new TextDecoder().decode(b));
      } catch {
        return null;
      }
    });
    const lostBlob = blobs.find((b) => b?.error && b?.payment?.cumulativeAfter === "750");
    assert.equal(lostBlob?.paidBy, "lath");
    // And the Resolution says so, so the owner's `costMicroUsdc` there reads as what it is.
    const resolution = blobs.find((b) => b && typeof b === "object" && "absorbedBase" in b);
    assert.equal(resolution?.absorbedBase, "750");
    assert.equal(resolution?.costMicroUsdc, answer.toString());
  });

  it("composes no charge into a lost attempt's own transaction on a per-event session", async () => {
    const amounts: string[] = [];
    const billing: BillingBackend = {
      async chargeAndLog(req) {
        amounts.push(req.amountMicroUsdc.toString());
        return null;
      },
    };
    const transport = new Attempts(["timeout", "answer"]);
    const runtime = retryingSession(new FakeChain(), { transport, billing, rollup: false });
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "absorb-2" });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(
      amounts,
      [toMicroUsdcFromBase(750n, runtime.margin).toString()],
      "chargeAndLog only for the answer"
    );
    assert.equal(result.absorbedBase, 750n);
  });

  it("charges every lost attempt to nobody when no attempt answered", async () => {
    const billing = chargingBilling();
    const transport = new Attempts(["timeout", "cut", "timeout"]);
    const result = await retryingSession(new FakeChain(), {
      transport,
      billing,
      fallbackModel: "fallback/model",
    }).start({ user: USER, prompt: "go", sessionId: "absorb-3" });
    assert.equal(result.status, "failed");
    assert.deepEqual(billing.charges, []);
    assert.equal(result.costMicroUsdc, 0n);
    assert.equal(result.absorbedBase, 2250n);
  });

  it("still charges a paid call the caller's own signal cut, and a session without retries", async () => {
    const gone = new AbortController();
    gone.abort();
    const cut = chargingBilling();
    await retryingSession(new FakeChain(), { transport: new Attempts(["cut"]), billing: cut }).start({
      user: USER,
      prompt: "go",
      sessionId: "absorb-4a",
      signal: gone.signal,
    });
    assert.lengthOf(cut.charges, 1, "the caller walked away: the call is theirs");

    const plain = chargingBilling();
    const r = await retryingSession(new FakeChain(), {
      transport: new Attempts(["timeout"]),
      billing: plain,
      noAnswer: false,
    }).start({ user: USER, prompt: "go", sessionId: "absorb-4b" });
    assert.lengthOf(plain.charges, 1, "a runtime without noAnswer bills a timed-out call as it always did");
    assert.isUndefined(r.absorbedBase);
  });

  it("buys no retry Lath's share refuses, and the call fails as one more missing answer", async () => {
    const transport = new Attempts(["timeout", "answer"]);
    const result = await retryingSession(new FakeChain(), {
      transport,
      billing: chargingBilling(),
      noAnswer: { admitRetry: () => "Jev budget spent: Lath's decision spend for this loop is used up" },
    }).start({ user: USER, prompt: "go", sessionId: "absorb-5" });
    assert.equal(result.status, "failed");
    assert.lengthOf(transport.seen, 1);
    assert.match(result.reason ?? "", /no attempt 2: Jev budget spent/);
  });

  it("holds the answering attempt to the budget, and never counts a lost one against it", async () => {
    // The lost attempt moved no owner meter, so the retry passes the same checks the first attempt
    // did; the answer is charged and crosses `maxCost`, which stops the session there — the owner
    // paid one call's worth for one call, the most the budget would have let a fresh call cost.
    const billing = chargingBilling();
    const transport = new Attempts(["timeout", "answer"]);
    const result = await retryingSession(new FakeChain(), { transport, billing, maxCost: 800 }).start({
      user: USER,
      prompt: "go",
      sessionId: "absorb-6",
    });
    assert.lengthOf(transport.seen, 2);
    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /µUSDC budget/);
    assert.lengthOf(billing.charges, 1);
  });

  it("refuses a retry once the loop's remaining budget is spent, before anything is signed", async () => {
    // The spend ceiling says nothing is left by the time the retry would go: it is refused like a
    // fresh call would be, and the session stops on the loop's budget.
    let left = 1_000_000n;
    const inner = new Attempts(["timeout", "answer"]);
    const wrapped: ChatTransport = {
      async chat(req, opts) {
        try {
          return await inner.chat(req, opts);
        } finally {
          // A sibling's spend lands while the first attempt is out: nothing is left after it.
          left = 0n;
        }
      },
    };
    const result = await retryingSession(new FakeChain(), { transport: wrapped, billing: chargingBilling() }).start({
      user: USER,
      prompt: "go",
      sessionId: "absorb-7",
      spendCeilingMicroUsdc: () => left,
    });
    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /loop's budget is spent/);
    assert.lengthOf(inner.seen, 1);
  });
});
