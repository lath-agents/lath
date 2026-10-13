/**
 * One budget per loop, the runtime's side.
 *
 * What is pinned here, each against the in-memory chain of `fixtures/fake-chain.ts`:
 *
 * - **The unhashed guard.** `spendCeilingMicroUsdc` (a runtime option, or per session on
 *   `start()`) resolves a session `aborted` with a `LoopBudgetExhausted` once what it metered
 *   crosses what is left, after the call that crossed it — and refuses a call outright when
 *   nothing is left. The policy's `maxCost` check is untouched.
 * - **The policy's number.** A loop with `budgetMicroUsdc` commits that budget as `maxCost`, and
 *   the runner refuses a runtime whose `maxCost` names anything else.
 * - **The stop.** A loop that runs out mid-step stops `budget` after the call in flight, with the
 *   step still checkpointed; one whose step spends exactly the last of it stops `budget` too, and
 *   takes no further step. The classification is by type, and an oracle request answered by such
 *   a step is rejected `Budget`.
 * - **The owner total.** `spentMicroUsdc` counts the step's session as it finishes. A team's
 *   members would count too, each held to what its finished siblings left; this build runs no team.
 * - **Live metering.** A `delegate` child is bounded by what its parent has left.
 * - **The old path.** A loop without `budgetMicroUsdc` gives no session a ceiling and stops where it
 *   always did; an older snapshot with no owner total resumes with `spentMicroUsdc` read as its total.
 * - **The channel.** `mppChannelSizing` takes the caller's deposit and top-up, and keeps the
 *   `maxCostBase × (maxSteps + 1)` path byte for byte for callers that pass neither.
 *
 * Node-only: no validator, no RPC, no key, nothing that spends money.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import { idFromString, MemoryTraceStore, type EpochStore } from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  BudgetExceeded,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopBudgetExhausted,
  LoopRunner,
  MemoryAnchorJournal,
  mppChannelSizing,
  stopReasonFor,
  toMicroUsdc,
  type LoopSnapshot,
  type SessionResult,
  type StartOptions,
} from "../runtime/src";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

const AGENT = idFromString("loop-budget-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;
const COST_USD = 0.001;

/** Answers every call at a fixed price; `tools: true` makes it ask for a tool every turn, so a session never ends itself. */
class Priced implements ChatTransport {
  calls = 0;
  private readonly tools: boolean;
  constructor(tools = false) {
    this.tools = tools;
  }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    const message = this.tools
      ? {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            { id: `call-${this.calls}`, type: "function" as const, function: { name: "noop", arguments: "{}" } },
          ],
        }
      : { role: "assistant" as const, content: `answer ${this.calls}` };
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [{ index: 0, message, finish_reason: this.tools ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: COST_USD },
      },
    } as ChatResult;
  }
}

function epochStore(): EpochStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(root: Uint8Array, blob: Uint8Array) {
      blobs.set(Buffer.from(root).toString("hex"), blob);
    },
    async get(root: Uint8Array) {
      return blobs.get(Buffer.from(root).toString("hex")) ?? null;
    },
  } as EpochStore;
}

/** Records every `start()`'s options, so a case can see what ceiling a session was handed. */
class Watched extends AgentRuntime {
  readonly starts: StartOptions[] = [];
  async start(opts: StartOptions): Promise<SessionResult> {
    this.starts.push(opts);
    return super.start(opts);
  }
}

function runtimeOn(
  maxCost: number,
  o: { tools?: boolean; spendCeilingMicroUsdc?: () => bigint | undefined } = {}
): { runtime: Watched; transport: Priced; billing: RecordingBilling } {
  const chain = new FakeChain();
  const billing = new RecordingBilling();
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    maxAttempts: 1,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const transport = new Priced(o.tools);
  const runtime = new Watched({
    client: chain.asClient(),
    agentId: AGENT,
    transport,
    policy: { model: "test/model", temperature: 0, toolAllowList: o.tools ? ["noop"] : [], maxCost },
    billing,
    structures: false,
    publishPolicy: false,
    now: () => T,
    store: new MemoryTraceStore(),
    rollup: { store: epochStore(), batchSize: 64 },
    anchor: { queue, drain: true },
    spendCeilingMicroUsdc: o.spendCeilingMicroUsdc,
    tools: o.tools
      ? [
          {
            name: "noop",
            description: "Does nothing.",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { ok: true };
            },
          },
        ]
      : [],
  });
  return { runtime, transport, billing };
}

function loopOn(
  runtime: AgentRuntime,
  o: {
    budget?: bigint;
    maxSteps?: number;
    resume?: LoopSnapshot;
    perStep?: number;
    onSpend?: (spentMicroUsdc: bigint) => void;
  } = {}
): LoopRunner {
  return new LoopRunner({
    runtime,
    loopId: "loop-budget",
    prompt: "Watch the cluster.",
    intervalMs: 0,
    maxSteps: o.maxSteps ?? 10,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
    ...(o.budget !== undefined ? { budgetMicroUsdc: o.budget } : {}),
    ...(o.perStep !== undefined ? { budgetMicroUsdcPerStep: o.perStep } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.onSpend ? { onSpend: o.onSpend } : {}),
  });
}

describe("the unhashed spend ceiling, on one session", () => {
  it("aborts after the call that crosses what is left, typed, while maxCost stays far away", async () => {
    const { runtime, transport } = runtimeOn(1_000_000, { tools: true });
    const per = toMicroUsdc(COST_USD, runtime.margin);
    // Room for two calls and a bit: the third is the one in flight when the ceiling is crossed.
    const left = per * 2n + 1n;
    const result = await runtime.start({
      user: USER,
      prompt: "go",
      sessionId: "s1",
      spendCeilingMicroUsdc: () => left,
    });
    assert.equal(result.status, "aborted");
    assert.equal(transport.calls, 3, "the crossing call was paid for, and no fourth was bought");
    assert.instanceOf(result.budgetStop, LoopBudgetExhausted);
    assert.instanceOf(result.budgetStop, BudgetExceeded, "so every path that aborts on a budget aborts on this");
    assert.equal((result.budgetStop as LoopBudgetExhausted).ceilingMicroUsdc, left);
    assert.equal(result.costMicroUsdc, per * 3n);
    assert.notMatch(result.reason ?? "", /µUSDC budget/, "the wording is not what classifies it");
    assert.equal(stopReasonFor(result), "budget");
  });

  it("refuses the first call when nothing is left, and buys nothing", async () => {
    const { runtime, transport, billing } = runtimeOn(1_000_000, { tools: true });
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "s0", spendCeilingMicroUsdc: () => 0n });
    assert.equal(result.status, "aborted");
    assert.equal(transport.calls, 0);
    assert.lengthOf(billing.charges, 0);
    assert.instanceOf(result.budgetStop, LoopBudgetExhausted);
  });

  it("takes the runtime's own option for a session its builder starts, and the start option over it", async () => {
    // A member runtime the console built with the closure: its sessions are bounded without the
    // runner handing anything in.
    const own = runtimeOn(1_000_000, { tools: true, spendCeilingMicroUsdc: () => 1n });
    const bounded = await own.runtime.start({ user: USER, prompt: "go", sessionId: "own" });
    assert.instanceOf(bounded.budgetStop, LoopBudgetExhausted);
    assert.equal(own.transport.calls, 1);

    const over = runtimeOn(1_000_000, { spendCeilingMicroUsdc: () => 0n });
    const freed = await over.runtime.start({
      user: USER,
      prompt: "go",
      sessionId: "override",
      spendCeilingMicroUsdc: () => undefined,
    });
    assert.equal(freed.status, "success", "the session's own `undefined` is no ceiling, and it wins");
  });

  it("leaves a session with no ceiling on today's maxCost check, and carries that breach typed too", async () => {
    const { runtime, transport } = runtimeOn(2_000, { tools: true });
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "old" });
    assert.equal(result.status, "aborted");
    assert.equal(transport.calls, 2);
    assert.match(result.reason ?? "", /µUSDC budget/, "the policy breach keeps its sentence");
    assert.instanceOf(result.budgetStop, BudgetExceeded);
    assert.notInstanceOf(result.budgetStop, LoopBudgetExhausted);
  });
});

describe("a loop with one overall budget", () => {
  it("refuses a runtime whose maxCost is not the loop budget, and ignores the derived per-step value", () => {
    const { runtime } = runtimeOn(5_000);
    assert.throws(() => loopOn(runtime, { budget: 4_000n }), /loop's budget is the runtime's own `maxCost`/);
    assert.throws(() => loopOn(runtime, { budget: 0n }), /above zero/);
    // The console keeps writing floor(budget ÷ maxSteps) beside the budget; it is not a ceiling.
    const runner = loopOn(runtime, { budget: 5_000n, perStep: 500 });
    assert.equal(runner.budgetMicroUsdc, 5_000n);
    assert.equal(runner.budgetMicroUsdcPerStep, 500);
    assert.equal(runner.remainingMicroUsdc, 5_000n);
  });

  it("stops `budget` after the call in flight when the money runs out mid-step, and the step is checkpointed", async () => {
    const probe = runtimeOn(1);
    const per = toMicroUsdc(COST_USD, probe.runtime.margin);
    // Two whole steps and part of a third: the third step's one call crosses what is left.
    const budget = per * 2n + per / 2n;
    const { runtime, transport } = runtimeOn(Number(budget));
    const runner = loopOn(runtime, { budget });

    const snap = await runner.run();
    assert.equal(snap.stopReason, "budget");
    assert.equal(snap.steps, 3);
    assert.equal(transport.calls, 3, "one call per step, the last of them the one that crossed");
    assert.equal(snap.spentMicroUsdc, (per * 3n).toString(), "the overshoot is that one call and no more");
    assert.equal(snap.totalCostMicroUsdc, snap.spentMicroUsdc, "with no members, the two totals agree");
    assert.equal(runner.remainingMicroUsdc, 0n);
    assert.isDefined(snap.lastLeaf, "the step that ran out still owes, and got, its leaf");
    // Each session was handed the remaining budget, not the whole one.
    assert.lengthOf(runtime.starts, 3);
    for (const s of runtime.starts) assert.isFunction(s.spendCeilingMicroUsdc);
  });

  it("stops `budget` on a step that spends exactly the last of it, and takes no further step", async () => {
    const probe = runtimeOn(1);
    const per = toMicroUsdc(COST_USD, probe.runtime.margin);
    const { runtime, transport } = runtimeOn(Number(per * 2n));
    const runner = loopOn(runtime, { budget: per * 2n });

    const one = await runner.step();
    assert.equal(one.status, "success");
    assert.equal(runner.snapshot().status, "idle");
    const two = await runner.step();
    assert.equal(two.status, "success", "the session was within what was left");
    assert.equal(runner.snapshot().stopReason, "budget");
    let thrown: unknown;
    try {
      await runner.step();
    } catch (e) {
      thrown = e;
    }
    assert.match(String(thrown), /is stopped \(budget\)/);
    assert.equal(transport.calls, 2);
  });

  it("stops a resumed loop whose budget was already spent before it opens a session", async () => {
    const { runtime, transport } = runtimeOn(3_000);
    const runner = loopOn(runtime, {
      budget: 3_000n,
      resume: {
        loopId: "loop-budget",
        steps: 2,
        status: "idle",
        totalCostMicroUsdc: "3000",
        spentMicroUsdc: "3000",
        consecutiveFailures: 0,
      },
    });
    let thrown: unknown;
    try {
      await runner.step();
    } catch (e) {
      thrown = e;
    }
    assert.match(String(thrown), /is stopped \(budget\)/);
    assert.equal(runner.snapshot().stopReason, "budget");
    assert.equal(transport.calls, 0);
    assert.lengthOf(runtime.starts, 0, "no Genesis for a step that could not buy a call");
  });

  it("classifies a session the loop budget stopped as `budget`, an older runtime's sentence too", () => {
    const session = {
      status: "aborted",
      reason: "metered 1100 µUSDC this session, over the 500 µUSDC left of the loop's budget",
      budgetStop: new LoopBudgetExhausted(1100n, 500n, "over"),
    } as unknown as SessionResult;
    assert.equal(stopReasonFor(session), "budget");
    // A hand-made result from an older runtime, with only the policy's sentence, still maps.
    const old = { status: "aborted", reason: "metered 900 µUSDC of a 500 µUSDC budget" } as unknown as SessionResult;
    assert.equal(stopReasonFor(old), "budget");
  });
});

describe("a loop without a budget (the old path)", () => {
  it("hands no session a ceiling and stops at max-steps as it always did", async () => {
    const { runtime, transport } = runtimeOn(1_000_000);
    const runner = loopOn(runtime, { maxSteps: 3 });
    assert.isUndefined(runner.budgetMicroUsdc);
    assert.isUndefined(runner.remainingMicroUsdc);
    assert.equal(runner.budgetMicroUsdcPerStep, 1_000_000, "the per-step budget is still `maxCost`");
    const snap = await runner.run();
    assert.equal(snap.stopReason, "max-steps");
    assert.equal(transport.calls, 3);
    for (const s of runtime.starts) assert.notProperty(s, "spendCeilingMicroUsdc");
    assert.equal(snap.spentMicroUsdc, snap.totalCostMicroUsdc);
  });

  it("still holds the per-step check a loop with only a per-step budget passes", () => {
    const { runtime } = runtimeOn(1_000);
    assert.throws(() => loopOn(runtime, { perStep: 999 }), /per-step budget is the runtime's own `maxCost`/);
    assert.doesNotThrow(() => loopOn(runtime, { perStep: 1_000 }));
  });

  it("resumes an older snapshot with no owner total, reading it as `totalCostMicroUsdc`", () => {
    const { runtime } = runtimeOn(10_000);
    const old = {
      loopId: "loop-budget",
      steps: 2,
      status: "idle",
      totalCostMicroUsdc: "2200",
      consecutiveFailures: 0,
    } as LoopSnapshot;
    assert.equal(loopOn(runtime).snapshot().spentMicroUsdc, "0");
    assert.equal(loopOn(runtime, { resume: old }).snapshot().spentMicroUsdc, "2200");
    const budgeted = loopOn(runtime, { resume: old, budget: 10_000n });
    assert.equal(budgeted.remainingMicroUsdc, 7_800n);
  });
});

/** Turn 1 hands a task to `child`, turn 2 answers; every turn at the fixed price. */
class DelegatingPriced implements ChatTransport {
  calls = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    const message =
      this.calls === 1
        ? {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function" as const,
                function: { name: "delegate", arguments: JSON.stringify({ agent: "child", task: "look" }) },
              },
            ],
          }
        : { role: "assistant" as const, content: "done" };
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [{ index: 0, message }],
        usage: { cost: COST_USD },
      },
    } as ChatResult;
  }
}

describe("a delegate child inside a budgeted session", () => {
  function parentWith(child: (chain: FakeChain) => AgentRuntime): {
    runtime: AgentRuntime;
    transport: DelegatingPriced;
  } {
    const chain = new FakeChain();
    const transport = new DelegatingPriced();
    const runtime = new AgentRuntime({
      client: chain.asClient(),
      agentId: AGENT,
      transport,
      policy: { model: "test/model", temperature: 0, toolAllowList: ["delegate"], maxCost: 1_000_000 },
      billing: new RecordingBilling(),
      structures: false,
      publishPolicy: false,
      now: () => T,
      store: new MemoryTraceStore(),
      delegates: [{ name: "child", create: () => child(chain) }],
    });
    return { runtime, transport };
  }

  function childOn(chain: FakeChain): AgentRuntime {
    return new AgentRuntime({
      client: chain.asClient(),
      agentId: idFromString("loop-budget-child"),
      transport: new Priced(),
      policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
      billing: new RecordingBilling(),
      structures: false,
      publishPolicy: false,
      now: () => T,
      store: new MemoryTraceStore(),
    });
  }

  it("starts the child with what the parent has left: its ceiling less what it metered", async () => {
    const asked: (bigint | undefined)[] = [];
    const { runtime } = parentWith((chain) => {
      const child = childOn(chain);
      const start = child.start.bind(child);
      child.start = async (o: StartOptions) => {
        asked.push(o.spendCeilingMicroUsdc?.());
        return start(o);
      };
      return child;
    });
    const per = toMicroUsdc(COST_USD, runtime.margin);
    const left = per * 10n;
    const metered: bigint[] = [];
    const result = await runtime.start({
      user: USER,
      prompt: "go",
      sessionId: "delegating",
      spendCeilingMicroUsdc: () => left,
      onMeter: (m) => metered.push(m.spent + m.delegated),
    });
    assert.equal(result.status, "success");
    assert.deepEqual(asked, [left - per], "the parent's first call is already spent out of the child's room");
    assert.equal(result.delegatedMicroUsdc, per);
    assert.deepEqual(
      metered,
      [per, per * 2n, per * 2n, per * 3n],
      "the child's call shows live, then lands in delegated"
    );
  });

  it("gives an unbudgeted parent's child no ceiling, and counts a crashed child's metered spend", async () => {
    const asked: StartOptions[] = [];
    const { runtime } = parentWith((chain) => {
      const child = childOn(chain);
      child.start = async (o: StartOptions) => {
        asked.push(o);
        o.onMeter?.({ spent: 300n, unbilled: 0n, delegated: 0n, costUsd: 0 });
        throw new Error("the child's chain went away after it paid");
      };
      return child;
    });
    const result = await runtime.start({ user: USER, prompt: "go", sessionId: "crashing" });
    assert.lengthOf(asked, 1);
    assert.notProperty(asked[0], "spendCeilingMicroUsdc");
    assert.equal(result.delegatedMicroUsdc, 300n, "what the child paid for before it threw is the parent's");
  });
});

describe("the loop channel's sizing (runtime side)", () => {
  it("takes the caller's deposit and top-up as given", () => {
    assert.deepEqual(mppChannelSizing({ maxDepositBase: 5_750_000n, topUpBase: 250_000n }), {
      maxDepositBase: 5_750_000n,
      topUpBase: 250_000n,
    });
    // A top-up floored at one gate ask may exceed a nearly spent loop's deposit; the console decides.
    assert.doesNotThrow(() => mppChannelSizing({ maxDepositBase: 1_000n, topUpBase: 20_000n }));
  });

  it("refuses half a sizing, and a top-up of zero", () => {
    assert.throws(() => mppChannelSizing({ maxDepositBase: 1_000n }), /together/);
    assert.throws(() => mppChannelSizing({ topUpBase: 1_000n, maxCostBase: 10n, maxSteps: 2 }), /together/);
    assert.throws(() => mppChannelSizing({ maxDepositBase: 1_000n, topUpBase: 0n }), /topUpBase > 0/);
  });

  it("keeps the per-call path byte for byte for callers that pass neither", () => {
    assert.deepEqual(mppChannelSizing({ maxCostBase: 10_000n, maxSteps: 4 }), {
      maxDepositBase: 50_000n,
      topUpBase: 10_000n,
    });
    assert.throws(() => mppChannelSizing({ maxCostBase: 10_000n, maxSteps: 0 }), /maxSteps ≥ 1/);
    assert.throws(() => mppChannelSizing({}), /needs maxCostBase and maxSteps/);
  });
});
