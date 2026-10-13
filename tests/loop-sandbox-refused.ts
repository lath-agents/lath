/**
 * `LoopRunner` stops a loop whose sandbox was
 * refused for a reason every later step would meet unchanged, instead of counting the step as one failed
 * session and paying for the same refusal until `maxSteps`.
 *
 * The sandbox's side — which failures are `SandboxRefused`, and a stub-binary loop whose workspace goes
 * over its cap — is `tests/zeroclaw-runtime.ts`. This suite is the runner's side, over a session that
 * reports a refusal the way `ZeroClawRuntime.start` does (`sandboxRefused` on its result):
 *
 * - session A's refusal stops the loop `sandbox` after the step, with the refusal as the detail, and
 *   the step is still checkpointed;
 * - it is the reason even when the session also ran out of budget, because the budget is not what
 *   the next step would be refused on;
 * - a failed session without one is the ordinary failure it always was: the loop goes on.
 *
 * A team member's refusal would be carried out of the team too; this build runs no team.
 *
 * Node-only: the in-memory chain of `fixtures/fake-chain.ts`, a transport that answers, no binary.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import { idFromString, MemoryTraceStore, type EpochStore } from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopRunner,
  MemoryAnchorJournal,
  type SessionResult,
  type StartOptions,
} from "../runtime/src";
import type { SandboxSessionResult } from "../runtime/src/zeroclaw/runtime";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";

const AGENT = idFromString("loop-sandbox-refused-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;
const TREE = "the workspace is 2000 bytes, over its 1024-byte cap";

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

/**
 * Stands in for `ZeroClawRuntime`: an ordinary session, resolved as failed and handed back with
 * `sandboxRefused` on the steps `refuse` names — the shape `ZeroClawRuntime.start` returns.
 */
class Refusing extends AgentRuntime {
  refuse = new Set<number>();
  /** Steps whose session fails on its own — a model that timed out upstream — with no refusal. */
  fail = new Set<number>();
  status: SessionResult["status"] = "failed";
  reasonText = TREE;
  private n = 0;
  async start(opts: StartOptions): Promise<SandboxSessionResult> {
    const session = await super.start(opts);
    this.n += 1;
    if (this.fail.has(this.n)) return { ...session, status: "failed", reason: "The model timed out upstream." };
    if (!this.refuse.has(this.n)) return session;
    return { ...session, status: this.status, reason: this.reasonText, sandboxRefused: TREE };
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

function loopOn(refuse: number[], o: { status?: SessionResult["status"]; reason?: string; fail?: number[] } = {}) {
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
  const runtime = new Refusing({
    client: chain.asClient(),
    agentId: AGENT,
    transport: new Answering(),
    policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
    billing,
    structures: false,
    publishPolicy: false,
    now: () => T,
    store: new MemoryTraceStore(),
    rollup: { store: epochStore(), batchSize: 16 },
    anchor: { queue, drain: true },
  });
  runtime.refuse = new Set(refuse);
  runtime.fail = new Set(o.fail ?? []);
  if (o.status) runtime.status = o.status;
  if (o.reason) runtime.reasonText = o.reason;
  const runner = new LoopRunner({
    runtime,
    loopId: "loop-refused",
    prompt: "Watch the cluster.",
    intervalMs: 0,
    maxSteps: 5,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
  });
  return runner;
}

describe("LoopRunner stops on a refused sandbox", () => {
  it("stops `sandbox` after the step, checkpointed, with the refusal as the detail", async () => {
    const runner = loopOn([2]);
    const one = await runner.step();
    assert.equal(one.status, "success");
    assert.equal(runner.snapshot().status, "idle", "a step with no refusal leaves the loop running");

    const two = await runner.step();
    assert.equal(two.status, "failed");
    assert.isTrue(two.leafOk, "the step ran and was paid for, so it owes the chain its leaf");
    const snap = runner.snapshot();
    assert.equal(snap.status, "stopped");
    assert.equal(snap.stopReason, "sandbox");
    assert.equal(snap.stopDetail, `the sandbox refused step 2: ${TREE}`);
    let thrown: unknown;
    try {
      await runner.step();
    } catch (e) {
      thrown = e;
    }
    assert.match(String(thrown), /is stopped \(sandbox\)/, "no further step, so no further Genesis");
  });

  it("names the refusal, not the budget, when the refused session also ran out of budget", async () => {
    const runner = loopOn([1], { status: "aborted", reason: "session exceeded its 1000 µUSDC budget" });
    await runner.step();
    assert.equal(runner.snapshot().stopReason, "sandbox");
    assert.include(runner.snapshot().stopDetail!, TREE);
  });

  it("goes on after a failed session that reports no refusal, as it always did", async () => {
    // A session that failed on its own (a model timing out upstream) may not fail the next step.
    const runner = loopOn([], { fail: [1] });
    const one = await runner.step();
    assert.equal(one.status, "failed");
    assert.notEqual(runner.snapshot().status, "stopped");
    const two = await runner.step();
    assert.equal(two.status, "success");
  });
});
