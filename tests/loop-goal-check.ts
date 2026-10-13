/**
 * Jev's goal check (docs/ARCHITECTURE.md §6): after each step of a goal loop, Jev answers `continue` or
 * `achieved` with a confidence, and its answer, not the agent's `GOAL REACHED`, ends the loop.
 *
 * Four contracts are pinned here:
 *
 * - **the rule.** `applyGoalCheck` is the enforcer half: `achieved` at the bar stops the loop, claim
 *   or no claim; `continue`, and `achieved` under the bar, do not; no answer leaves the claim to
 *   decide, as a loop with the check off does.
 * - **the bytes that do not move.** The thirteen-key manifest, and every policy-hash vector the
 *   other suites pin, hash as they did; `goalCheckHash` is the fourteenth key and the policy's
 *   `goalCheck` is a new key whose own vector is pinned here.
 * - **the runner.** A real `LoopRunner` over the in-memory chain of `fixtures/fake-chain.ts` and a
 *   stubbed Jev: achieved stops, continue overrides the claim, achieved without a claim stops, an
 *   outage falls back to the claim, and beside the verify seat the question rides the seat's call.
 * - **the audit.** `verify-step` re-derives the answer from the committed blob, prints it as
 *   `goal: achieved 0.80`, and fails a 201 the answer does not back.
 *
 * And the console's half: the start body and a template version resolve the check the same way,
 * absent when off or goal-less, and a step row carries only the fixed vocabulary.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money.
 */
// First, for its side effect: the console's modules read `LATH_TRACE_DIR` when they load.
import "./fixtures/trace-dir";
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  applyGoalCheck,
  audit,
  decodeLoopManifest,
  EventKind,
  formatStepVerify,
  GOAL_CHECK_QUESTIONS,
  goalHash,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  MemoryTraceStore,
  payloadPreimage,
  sameQuestions,
  sha256,
  toBytes32,
  utf8,
  VERIFY_GOAL_QUESTIONS,
  VERIFY_QUESTIONS,
  verifyStepDecision,
  type EpochStore,
  type InferenceRecord,
  type LathClient,
  type LoopStepManifest,
  type TraceStore,
} from "../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  ChatRequest,
  ChatResult,
  ChatTransport,
  LoopRunner,
  MemoryAnchorJournal,
  type StepResult,
} from "../runtime/src";
import { policyDocument, policyVersionHash, toRuntimePolicy, type RuntimePolicy } from "../runtime/src/policy";
import type { DecideRequest, DecideResult } from "../runtime/src/openrouter";
import { FakeChain, RecordingBilling } from "./fixtures/fake-chain";
import { checkGoalCheck, checkLoopRequest, stepGoalCheckView } from "../frontend/src/app/api/_lib/loops";
import { scriptedGoalAnswer } from "../frontend/src/app/api/_lib/tools";
import { checkLoopConfig } from "../frontend/src/app/api/templates/validate";

const AGENT = idFromString("loop-goal-check-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;
const GOAL = "a cited answer for who can upgrade the demo program";
const JEV = "typesafe/jev-1.13";
const CHANNEL = `0x${"aa".repeat(32)}`;

// ---------------------------------------------------------------------------------------------
// The rule

describe("applyGoalCheck: Jev's word, the bar and the claim", () => {
  const goal = (choice: string, confidence: number) => ({ goal: { choice, confidence } });

  it("stops on `achieved` at or above the bar, whether or not the step claimed it", () => {
    const claimed = applyGoalCheck(goal("achieved", 0.8), 0.5, true);
    assert.include(claimed, { outcome: "achieved", reached: true, claimed: true, choice: "achieved" });
    assert.notProperty(claimed, "disagreement");
    const unclaimed = applyGoalCheck(goal("achieved", 0.8), 0.5, false);
    assert.include(unclaimed, { outcome: "achieved", reached: true, disagreement: "unclaimed" });
    // Exactly at the bar is achieved: the bar is a floor, as it is for the verdict.
    assert.equal(applyGoalCheck(goal("achieved", 0.5), 0.5, false).outcome, "achieved");
  });

  it("goes on on `continue`, and on `achieved` under the bar, whatever the step claimed", () => {
    const overruled = applyGoalCheck(goal("continue", 0.7), 0.5, true);
    assert.include(overruled, { outcome: "continue", reached: false, disagreement: "overruled" });
    const under = applyGoalCheck(goal("achieved", 0.4), 0.5, true);
    assert.include(under, { outcome: "continue", reached: false, choice: "achieved", disagreement: "overruled" });
    assert.include(under.reason, "below the 0.5");
    const agreed = applyGoalCheck(goal("continue", 0.9), 0.5, false);
    assert.include(agreed, { outcome: "continue", reached: false });
    assert.notProperty(agreed, "disagreement");
  });

  it("leaves the claim to decide when Jev gave no goal answer, or a word outside the two", () => {
    for (const answers of [undefined, {}, goal("done", 0.99), { goal: {} }]) {
      assert.include(applyGoalCheck(answers as any, 0.5, true), { outcome: "unavailable", reached: true });
      assert.include(applyGoalCheck(answers as any, 0.5, false), { outcome: "unavailable", reached: false });
    }
    // The reason is a fixed sentence and never quotes what the model wrote.
    assert.notInclude(applyGoalCheck(goal("done", 0.99), 0.5, true).reason, "done");
  });

  it("asks the goal question alone, or beside the verify seat's two, and leaves the two unchanged", () => {
    assert.deepEqual(Object.keys(GOAL_CHECK_QUESTIONS), ["goal"]);
    assert.deepEqual(Object.keys(VERIFY_GOAL_QUESTIONS), ["followed_plan", "verdict", "goal"]);
    assert.deepEqual(Object.keys(VERIFY_QUESTIONS), ["followed_plan", "verdict"]);
    assert.isTrue(Object.isFrozen(GOAL_CHECK_QUESTIONS.goal.criteria));
    assert.isTrue(Object.isFrozen(VERIFY_GOAL_QUESTIONS.goal));
  });
});

// ---------------------------------------------------------------------------------------------
// The bytes that do not move

describe("the manifest's fourteenth key", () => {
  const base: LoopStepManifest = {
    loopId: "loop-oracle",
    step: 2,
    intervalMs: 300_000,
    maxSteps: 12,
    promptHash: hex(sha256(utf8("standing instruction"))),
    startedAt: 1_757_000_000_000,
  };
  const h = (s: string) => hex(sha256(utf8(s)));
  const thirteen: LoopStepManifest = {
    ...base,
    memoryHash: h("memory"),
    requestAddress: "8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu",
    verifyHash: h("verify"),
    goalHash: goalHash(GOAL),
    members: [{ agentId: h("member"), taskId: "t", outcome: "done", seq: "3", head: h("head") }],
    gateHash: h("gate"),
    replayHash: h("replay"),
  };

  it("leaves a manifest without `goalCheckHash` byte-for-byte what it was", () => {
    // Written out by hand, key by key, in the order `loopManifestBytes` has always emitted them.
    const expected =
      `{"loopId":"loop-oracle","step":2,"intervalMs":300000,"maxSteps":12,"promptHash":"${base.promptHash}",` +
      `"startedAt":1757000000000,"memoryHash":"${h("memory")}",` +
      `"requestAddress":"8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu","verifyHash":"${h("verify")}",` +
      `"goalHash":"${goalHash(GOAL)}","members":[{"agentId":"${h("member")}","taskId":"t","outcome":"done",` +
      `"seq":"3","head":"${h("head")}"}],"gateHash":"${h("gate")}","replayHash":"${h("replay")}"}`;
    assert.equal(new TextDecoder().decode(loopManifestBytes(thirteen)), expected);
    assert.equal(
      new TextDecoder().decode(loopManifestBytes({ ...thirteen, goalCheckHash: undefined })),
      expected,
      "an explicit undefined is absent"
    );
  });

  it("emits `goalCheckHash` fourteenth and last, round-trips it, and refuses a malformed one", () => {
    const m = { ...base, goalHash: goalHash(GOAL), goalCheckHash: h("goal-check") };
    const keys = Object.keys(JSON.parse(new TextDecoder().decode(loopManifestBytes(m))));
    assert.equal(keys[keys.length - 1], "goalCheckHash");
    assert.equal(keys.length, 8);
    assert.deepEqual(
      Object.keys(JSON.parse(new TextDecoder().decode(loopManifestBytes({ ...thirteen, goalCheckHash: h("x") }))))
        .length,
      14
    );
    assert.deepEqual(decodeLoopManifest(loopManifestBytes(m)), m);
    assert.isNull(decodeLoopManifest(utf8(JSON.stringify({ ...m, goalCheckHash: "a".repeat(63) }))));
    assert.isNull(decodeLoopManifest(utf8(JSON.stringify({ ...m, goalCheckHash: "A".repeat(64) }))));
  });
});

describe("the policy hash with and without the goal check", () => {
  const BASE = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };
  const VERIFY = { model: JEV, minConfidence: 0.5 };

  it("leaves every existing policy-hash vector where it was when the check is off", () => {
    // The digests `tests/zeroclaw-posture.ts`, `tests/runtime.ts` and `tests/tempo-inference.ts` pin.
    assert.equal(hex(policyVersionHash(BASE)), "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0");
    assert.equal(
      hex(
        policyVersionHash({ ...BASE, promptHash: "6182417bbd101bec13338e572f204411f74df1b363590ffb0bd25be3541b4858" })
      ),
      "9c2bb44f03366b7bb2194e860a7275f99177bdc35ed029d3db9de88c1c548c06"
    );
    const off: RuntimePolicy = { ...BASE, goalCheck: undefined };
    assert.equal(policyDocument(off), policyDocument(BASE));
    assert.notProperty(toRuntimePolicy(BASE), "goalCheck", "a policy without the check gains no key");
    assert.equal(
      policyDocument({ ...BASE, verify: VERIFY, goalCheck: undefined }),
      policyDocument({ ...BASE, verify: VERIFY })
    );
  });

  it("commits the check as a key of its own, with its own pinned vector", () => {
    const on: RuntimePolicy = { ...BASE, goalCheck: { model: JEV, minConfidence: 0.5 } };
    assert.include(policyDocument(on), '"goalCheck":{"minConfidence":0.5,"model":"typesafe/jev-1.13"}');
    assert.equal(hex(policyVersionHash(on)), GOAL_CHECK_POLICY_VECTOR);
    // Extras dropped, key order irrelevant: the two named keys are the whole of it.
    assert.equal(
      policyDocument({ ...BASE, goalCheck: { minConfidence: 0.5, model: JEV, extra: 1 } as any }),
      policyDocument(on)
    );
    assert.notEqual(
      hex(policyVersionHash({ ...BASE, goalCheck: { model: JEV, minConfidence: 0.6 } })),
      GOAL_CHECK_POLICY_VECTOR
    );
  });
});

/** `sha256(policyDocument({ ...BASE, goalCheck: { model: JEV, minConfidence: 0.5 } }))`, pinned. */
const GOAL_CHECK_POLICY_VECTOR = "0411e29f1f13031c04c1d532a29ce79f08e1d6039d696981b7404dcef647a982";

// ---------------------------------------------------------------------------------------------
// The runner, over the fake chain and a stubbed Jev

const PLAN = "DONE: read the program account\nNEXT: read the multisig\nOPEN: none";
const CLAIM = `${PLAN}\nGOAL REACHED`;

/** Answers each chat turn with the next scripted output, and each decision with the next answer. */
class StubJev implements ChatTransport {
  outputs: string[] = [];
  answers: (Record<string, unknown> | Error)[] = [];
  sent: DecideRequest[] = [];
  private turns = 0;
  private cumulative = 0;

  async chat(_req: ChatRequest): Promise<ChatResult> {
    const content = this.outputs[this.turns] ?? PLAN;
    this.turns += 1;
    return {
      status: 200,
      body: {
        id: `gen-${this.turns}`,
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
    };
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    this.sent.push(req);
    const next = this.answers.shift() ?? {};
    if (next instanceof Error) throw next;
    const before = this.cumulative;
    this.cumulative += 42;
    return {
      answers: next as DecideResult["answers"],
      model: "typesafe/jev-1.13-20260917",
      id: `dec-${this.sent.length}`,
      payment: {
        rail: "tempo",
        chainId: 4217,
        payer: "0x18fB000000000000000000000000000000000e0B",
        channelId: CHANNEL,
        cumulativeBefore: String(before),
        cumulativeAfter: String(this.cumulative),
      },
    };
  }
}

/** A trace store that also remembers every blob put, so the test can find the checkpoint preimages. */
class KeptStore extends MemoryTraceStore {
  readonly blobs: Uint8Array[] = [];
  async put(bytes: Uint8Array) {
    this.blobs.push(bytes);
    return super.put(bytes);
  }
}

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

function loop(o: {
  outputs: string[];
  answers: (Record<string, unknown> | Error)[];
  goalCheck?: boolean;
  verify?: boolean;
  maxSteps?: number;
  /** Fail the step's checkpoint, a direct write after the session (`tests/loop-anchor.ts`), as a flaky RPC would. */
  failCheckpoint?: boolean;
}) {
  const chain = new FakeChain();
  const billing = new RecordingBilling();
  const store = new KeptStore();
  const jev = new StubJev();
  jev.outputs = o.outputs;
  jev.answers = o.answers;
  const verify = o.verify ? { model: JEV, minConfidence: 0.5 } : undefined;
  const goalCheck = o.goalCheck === false ? undefined : { model: JEV, minConfidence: 0.5 };
  const queue = new AnchorQueue({
    client: chain.asClient(),
    journal: new MemoryAnchorJournal(),
    billing,
    maxAttempts: 1,
    indexerWaitMs: 200,
    retryDelayMs: 5,
  });
  const policy: RuntimePolicy = {
    model: "test/model",
    temperature: 0,
    toolAllowList: [],
    maxCost: 1_000_000,
    ...(verify ? { verify } : {}),
    ...(goalCheck ? { goalCheck } : {}),
  };
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: AGENT,
    transport: jev,
    policy,
    billing,
    structures: false,
    publishPolicy: false,
    storePayloads: true,
    now: () => T,
    store,
    rollup: { store: epochStore(), batchSize: 16 },
    anchor: { queue, drain: true },
  });
  const runner = new LoopRunner({
    runtime,
    loopId: "loop-goal-check",
    prompt: "Work toward the goal.",
    goal: GOAL,
    ...(verify ? { verify } : {}),
    ...(goalCheck ? { goalCheck } : {}),
    intervalMs: 0,
    maxSteps: o.maxSteps ?? 3,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
    ...(o.failCheckpoint ? { work: async () => chain.failNext(1) } : {}),
  });
  return { runner, runtime, jev, store, policy, billing };
}

/** The `loop.step` payload preimage a step's checkpoint stored, and the status it encodes. */
function checkpointOf(store: KeptStore, result: StepResult): { preimage: Uint8Array; status: number } {
  const argsHash = sha256(loopManifestBytes(result.manifest!));
  const tool = idFromString(LOOP_STEP_TOOL);
  const preimage = store.blobs.find(
    (b) =>
      b.length === 99 &&
      b[0] === EventKind.Action &&
      hex(b.slice(1, 33)) === hex(tool) &&
      hex(b.slice(33, 65)) === hex(argsHash)
  );
  assert.exists(preimage, `step ${result.step}'s checkpoint preimage is in the store`);
  return { preimage: preimage!, status: preimage![97] | (preimage![98] << 8) };
}

/**
 * As much of the chain as `verifyStepDecision` reads: the steps' `loop.step` records, and — given the
 * loop's `policy` — a Genesis just before each naming it, which is what a decision is held to.
 */
async function chainOf(store: KeptStore, results: StepResult[], channelId = CHANNEL, policy?: RuntimePolicy) {
  const records: InferenceRecord[] = results.map((r) => ({
    seq: BigInt(r.seq!),
    kind: EventKind.Action,
    reference: idFromString(LOOP_STEP_TOOL),
    payloadHash: sha256(checkpointOf(store, r).preimage),
  }));
  if (policy) {
    const policyVersionHash = await store.put(utf8(policyDocument(policy)));
    const inputPayloadHash = await store.put(utf8("{}"));
    for (const r of results) {
      const genesis = payloadPreimage({
        kind: EventKind.Genesis,
        sessionId: `loop-goal-check:step-${r.step}`,
        callerPubkey: new Uint8Array(32),
        policyVersionHash,
        inputPayloadHash,
      } as any);
      await store.put(genesis);
      records.push({
        seq: BigInt(r.seq!) - 1n,
        kind: EventKind.Genesis,
        reference: new Uint8Array(32),
        payloadHash: sha256(genesis),
      });
    }
    records.sort((a, b) => (a.seq < b.seq ? -1 : 1));
  }
  // One paid model call on the loop's channel before the first checkpoint, as the step's own calls
  // are on a real chain: the channel a decision's voucher is held to (verify-step says no-preimage
  // when no voucher of the loop's own calls is readable).
  const toolId = "llm.test/model";
  const argsHash = await store.put(utf8(JSON.stringify({ model: "test/model" })));
  const payment = { rail: "tempo", chainId: 4217, payer: "0x18fB000000000000000000000000000000000e0B" };
  const body = {
    model: "test/model",
    payment: { ...payment, channelId, cumulativeBefore: "0", cumulativeAfter: "0" },
  };
  const resultHash = await store.put(utf8(JSON.stringify(body)));
  const preimage = payloadPreimage({ kind: EventKind.Action, toolId, argsHash, resultHash, statusCode: 200 } as any);
  await store.put(preimage);
  records.unshift({ seq: 0n, kind: EventKind.Action, reference: idFromString(toolId), payloadHash: sha256(preimage) });
  return { listEvents: async () => records, records };
}

describe("LoopRunner with Jev's goal check", () => {
  it("stops the loop on `achieved`, 201 on the step, and commits the answer under the fourteenth key", async () => {
    const { runner, jev, store } = loop({
      outputs: [PLAN, CLAIM],
      answers: [{ goal: { choice: "continue", confidence: 0.9 } }, { goal: { choice: "achieved", confidence: 0.8 } }],
    });
    const one = await runner.step();
    assert.include(one.goalCheck, { outcome: "continue", claimed: false, choice: "continue" });
    assert.equal(checkpointOf(store, one).status, 200);
    assert.notEqual(runner.snapshot().status, "stopped");

    const two = await runner.step();
    assert.include(two.goalCheck, { outcome: "achieved", claimed: true, confidence: 0.8 });
    assert.equal(checkpointOf(store, two).status, 201);
    const snap = runner.snapshot();
    assert.equal(snap.stopReason, "goal-reached");
    assert.equal(snap.stopDetail, "Jev judged the goal achieved at step 2 (confidence 0.80)");

    // One goal-only call per step, the frozen question, the loop's goal in the state.
    assert.lengthOf(jev.sent, 2);
    for (const req of jev.sent) {
      assert.isTrue(sameQuestions(req.questions, GOAL_CHECK_QUESTIONS));
      assert.include(req.state, `GOAL: ${GOAL}`);
    }
    // No verify seat, so the answer's blob is the fourteenth key and the ninth is absent.
    assert.match(two.manifest!.goalCheckHash!, /^[0-9a-f]{64}$/);
    assert.isUndefined(two.manifest!.verifyHash);
    assert.equal(two.goalCheck!.goalCheckHash, two.manifest!.goalCheckHash);
    assert.equal(two.goalCheck!.costBase, "42");
  });

  it("goes on when Jev says `continue` over the agent's claim, and records the disagreement", async () => {
    const { runner, store } = loop({
      outputs: [CLAIM, PLAN],
      answers: [{ goal: { choice: "continue", confidence: 0.7 } }, { goal: { choice: "continue", confidence: 0.9 } }],
      maxSteps: 2,
    });
    const one = await runner.step();
    assert.include(one.goalCheck, { outcome: "continue", claimed: true, disagreement: "overruled" });
    assert.equal(checkpointOf(store, one).status, 200, "the claim alone is not a 201");
    assert.notEqual(runner.snapshot().status, "stopped");
    await runner.step();
    assert.equal(runner.snapshot().stopReason, "max-steps");
  });

  // A step whose writes failed carries a plan at 200 whatever Jev said, so without a note the console
  // could not tell it reached the goal, and its Retry would put the run back on its schedule to pay
  // for more steps. The result says so beside the plan; the plan itself is unchanged.
  it("says beside a deferred plan that Jev judged the goal achieved, and leaves the plan at 200", async () => {
    const { runner } = loop({
      outputs: [PLAN],
      answers: [{ goal: { choice: "achieved", confidence: 0.8 } }],
      failCheckpoint: true,
    });
    const one = await runner.step();
    assert.include(one.goalCheck, { outcome: "achieved" });
    assert.exists(one.deferredCheckpoint, "the checkpoint did not land, so it is owed");
    assert.isTrue(one.deferredGoalReached, "and the step would have ended the loop on its goal");
    assert.equal(one.deferredCheckpoint!.statusCode, 200, "while the plan writes 200, as it always did");
    assert.equal(runner.snapshot().stopReason, "anchor-failed");

    const still = loop({
      outputs: [PLAN],
      answers: [{ goal: { choice: "continue", confidence: 0.8 } }],
      failCheckpoint: true,
    });
    const going = await still.runner.step();
    assert.exists(going.deferredCheckpoint);
    assert.isUndefined(going.deferredGoalReached, "a step Jev sent on says nothing of the kind");
  });

  it("stops on `achieved` when the agent made no claim", async () => {
    const { runner, store } = loop({ outputs: [PLAN], answers: [{ goal: { choice: "achieved", confidence: 0.6 } }] });
    const one = await runner.step();
    assert.include(one.goalCheck, { outcome: "achieved", claimed: false, disagreement: "unclaimed" });
    assert.equal(checkpointOf(store, one).status, 201);
    assert.equal(runner.snapshot().stopReason, "goal-reached");
  });

  it("does not stop on `achieved` under the bar", async () => {
    const { runner } = loop({ outputs: [CLAIM], answers: [{ goal: { choice: "achieved", confidence: 0.3 } }] });
    const one = await runner.step();
    assert.include(one.goalCheck, { outcome: "continue", choice: "achieved", disagreement: "overruled" });
    assert.notEqual(runner.snapshot().status, "stopped");
  });

  it("falls back to the claim when Jev is unreachable, and commits no goal-check hash", async () => {
    const claimed = loop({ outputs: [CLAIM], answers: [new Error("fetch failed")] });
    const one = await claimed.runner.step();
    assert.include(one.goalCheck, { outcome: "unavailable", claimed: true, reason: "fetch failed" });
    assert.isUndefined(one.manifest!.goalCheckHash);
    assert.equal(checkpointOf(claimed.store, one).status, 201);
    assert.equal(claimed.runner.snapshot().stopReason, "goal-reached");
    assert.equal(claimed.runner.snapshot().stopDetail, "step 1 reported the goal reached");

    const quiet = loop({ outputs: [PLAN], answers: [new Error("fetch failed")] });
    const two = await quiet.runner.step();
    assert.equal(two.goalCheck!.outcome, "unavailable");
    assert.notEqual(quiet.runner.snapshot().status, "stopped");
  });

  it("rides the verify seat's call when the seat is on: one decision, one blob, no fourteenth key", async () => {
    const { runner, jev } = loop({
      verify: true,
      outputs: [PLAN, CLAIM],
      answers: [
        { verdict: { choice: "retry", confidence: 0.9 }, goal: { choice: "achieved", confidence: 0.9 } },
        { verdict: { choice: "accept", confidence: 0.9 }, goal: { choice: "achieved", confidence: 0.9 } },
      ],
    });
    // A verdict that refused the step ends no loop, whatever the goal answer said.
    const one = await runner.step();
    assert.equal((one.verify as any).outcome, "retried");
    assert.equal(one.goalCheck!.outcome, "achieved");
    assert.notEqual(runner.snapshot().status, "stopped");
    const two = await runner.step();
    assert.equal(runner.snapshot().stopReason, "goal-reached");
    assert.lengthOf(jev.sent, 2, "one call per step, not two");
    assert.isTrue(sameQuestions(jev.sent[0].questions, VERIFY_GOAL_QUESTIONS));
    assert.match(two.manifest!.verifyHash!, /^[0-9a-f]{64}$/);
    assert.isUndefined(two.manifest!.goalCheckHash);
    assert.isUndefined(two.goalCheck!.goalCheckHash);
  });

  it("charges the owner nothing for Jev's decision: Lath pays it, and its cost stays on the row", async () => {
    // Lath pays Jev's decisions: the goal-only call's 42 base units are paid on the channel and
    // reach neither the checkpoint's transaction nor the Cost.
    const { runner, billing, store } = loop({
      outputs: [PLAN],
      answers: [{ goal: { choice: "continue", confidence: 0.9 } }],
      maxSteps: 1,
    });
    const one = await runner.step();
    assert.equal(one.goalCheck!.costBase, "42", "what Lath paid for the answer is still recorded");
    assert.lengthOf(billing.checkpointCharges, 0, "the checkpoint debited nothing");
    const session = billing.charges.reduce((sum, c) => sum + BigInt(c.amountMicroUsdc), 0n);
    assert.equal(BigInt(one.costMicroUsdc), session, "the step's Cost is its session's own charges alone");
    assert.notProperty(one, "decisionChargeMicroUsdc");
    assert.equal(checkpointOf(store, one).status, 200);
    assert.isTrue(one.leafOk);

    // With the seat, the goal question rides the seat's call: one voucher, and still no debit.
    const seat = loop({
      verify: true,
      outputs: [PLAN],
      answers: [{ verdict: { choice: "accept", confidence: 0.9 }, goal: { choice: "continue", confidence: 0.9 } }],
      maxSteps: 1,
    });
    const two = await seat.runner.step();
    assert.equal((two.verify as { costBase?: string }).costBase, "42");
    assert.lengthOf(seat.billing.checkpointCharges, 0);
    const seatSession = seat.billing.charges.reduce((sum, c) => sum + BigInt(c.amountMicroUsdc), 0n);
    assert.equal(BigInt(two.costMicroUsdc), seatSession);
  });

  it("leaves a goal loop with the check off exactly as it was: no decision, the claim stops it", async () => {
    const { runner, runtime, jev, policy } = loop({ goalCheck: false, outputs: [CLAIM], answers: [] });
    assert.equal(hex(runtime.policyVersionHash), hex(policyVersionHash({ ...policy })));
    assert.notInclude(policyDocument(policy), "goalCheck");
    const one = await runner.step();
    assert.isUndefined(one.goalCheck);
    assert.lengthOf(jev.sent, 0);
    assert.equal(runner.snapshot().stopDetail, "step 1 reported the goal reached");
  });

  it("refuses a check with no goal, one its policy does not name, and one that is not the seat's", () => {
    const { runtime } = loop({ outputs: [], answers: [] });
    const opts = {
      runtime,
      loopId: "l",
      prompt: "Work toward the goal.",
      intervalMs: 0,
      maxSteps: 1,
      user: USER,
      goalCheck: { model: JEV, minConfidence: 0.5 },
    };
    assert.throws(() => new LoopRunner(opts), /needs a goal/);
    assert.throws(
      () => new LoopRunner({ ...opts, goal: GOAL, goalCheck: { model: JEV, minConfidence: 0.7 } }),
      /policy_version_hash/
    );
    const bare = loop({ goalCheck: false, outputs: [], answers: [] });
    assert.throws(() => new LoopRunner({ ...opts, runtime: bare.runtime, goal: GOAL }), /policy_version_hash/);
  });
});

// ---------------------------------------------------------------------------------------------
// The audit

describe("verify-step reproduces Jev's goal answer", () => {
  it("re-derives a goal-only answer from its blob and prints it", async () => {
    const { runner, store, policy } = loop({
      outputs: [PLAN, CLAIM],
      answers: [{ goal: { choice: "continue", confidence: 0.9 } }, { goal: { choice: "achieved", confidence: 0.8 } }],
    });
    const results = [await runner.step(), await runner.step()];
    const chain = await chainOf(store, results, CHANNEL, policy);
    const one = await verifyStepDecision(chain, AGENT, results[0].seq!, { store });
    assert.equal(one.verdict, "ok", one.reason);
    assert.include(one.goal, { outcome: "continue", choice: "continue", terminal: false });
    assert.include(formatStepVerify(one).join("\n"), "goal: continue 0.90");
    const two = await verifyStepDecision(chain, AGENT, results[1].seq!, { store });
    assert.equal(two.verdict, "ok", two.reason);
    assert.equal(two.goalCheckHash, results[1].manifest!.goalCheckHash);
    assert.include(two.goal, { outcome: "achieved", confidence: 0.8, claimed: true, terminal: true });
    assert.include(formatStepVerify(two).join("\n"), "goal: achieved 0.80");
  });

  it("re-derives the answer from the verify seat's blob, disagreement included", async () => {
    const { runner, store, policy } = loop({
      verify: true,
      outputs: [CLAIM, PLAN],
      answers: [
        { verdict: { choice: "accept", confidence: 0.9 }, goal: { choice: "continue", confidence: 0.6 } },
        { verdict: { choice: "accept", confidence: 0.9 }, goal: { choice: "achieved", confidence: 0.7 } },
      ],
    });
    const results = [await runner.step(), await runner.step()];
    const chain = await chainOf(store, results, CHANNEL, policy);
    const one = await verifyStepDecision(chain, AGENT, results[0].seq!, { store });
    assert.equal(one.verdict, "ok", one.reason);
    assert.include(one.goal, { outcome: "continue", disagreement: "overruled" });
    assert.include(formatStepVerify(one).join("\n"), "goal: continue 0.60 (the agent claimed GOAL REACHED");
    const two = await verifyStepDecision(chain, AGENT, results[1].seq!, { store });
    assert.equal(two.verdict, "ok", two.reason);
    assert.include(two.goal, { outcome: "achieved", disagreement: "unclaimed", terminal: true });
  });

  it("holds the decision's voucher to the loop's channel only as far as the records here show it", async () => {
    const { runner, store } = loop({
      outputs: [PLAN],
      answers: [{ goal: { choice: "continue", confidence: 0.9 } }],
      maxSteps: 1,
    });
    const one = await runner.step();
    assert.isAbove(Number(one.seq), 1);
    // No voucher of the loop's own calls is readable: the decision is held to nothing, which is no pass.
    const chain = await chainOf(store, [one]);
    const bare = { listEvents: async () => chain.records.filter((r) => r.seq !== 0n) };
    const unread = await verifyStepDecision(bare, AGENT, one.seq!, { store });
    assert.equal(unread.verdict, "no-preimage");
    assert.include(unread.reason ?? "", "no voucher of this loop's own calls");
    // The loop's latest call read rode another channel: payer, with every record here...
    const OTHER = `0x${"bb".repeat(32)}`;
    const other = await chainOf(store, [one], OTHER);
    const payer = await verifyStepDecision(other, AGENT, one.seq!, { store });
    assert.equal(payer.verdict, "payer", payer.reason);
    // ...and unknown when an epoch up to the step was not opened: its calls may be on the decision's.
    const epoch = { epochRoot: sha256(utf8("unopened")), startSeq: 1n, endSeq: 2n };
    const blind = { listEvents: other.listEvents, listEpochs: async () => [epoch] };
    const unknown = await verifyStepDecision(blind, AGENT, one.seq!, { store });
    assert.equal(unknown.verdict, "no-preimage", unknown.reason);
    assert.include(unknown.reason ?? "", "is not opened here");
  });

  it("fails a 201 the committed answer does not back, and a goal-check blob that was edited", async () => {
    const { runner, store } = loop({
      outputs: [CLAIM],
      answers: [{ goal: { choice: "continue", confidence: 0.9 } }],
      maxSteps: 1,
    });
    const one = await runner.step();
    // The same checkpoint, written at 201 as a runner that obeyed the claim would have written it.
    const { preimage } = checkpointOf(store, one);
    const forged = payloadPreimage({
      kind: EventKind.Action,
      toolId: LOOP_STEP_TOOL,
      argsHash: preimage.slice(33, 65),
      resultHash: preimage.slice(65, 97),
      statusCode: 201,
    });
    await store.put(forged);
    const records: InferenceRecord[] = [
      {
        seq: BigInt(one.seq!),
        kind: EventKind.Action,
        reference: idFromString(LOOP_STEP_TOOL),
        payloadHash: sha256(forged),
      },
    ];
    const report = await verifyStepDecision({ listEvents: async () => records }, AGENT, one.seq!, { store });
    assert.equal(report.verdict, "mismatch");
    assert.include(report.reason ?? "", "carries 201");

    const hash = one.manifest!.goalCheckHash!;
    const edited: TraceStore = {
      put: (b) => store.put(b),
      get: async (h) => {
        const bytes = await store.get(h);
        if (hex(h) !== hash || !bytes) return bytes;
        return utf8(new TextDecoder().decode(bytes).replace('"continue"', '"achieved"'));
      },
    };
    const chain = await chainOf(store, [one]);
    const tampered = await verifyStepDecision(chain, AGENT, one.seq!, { store: edited });
    assert.equal(tampered.verdict, "mismatch");
    assert.include(tampered.reason ?? "", "was edited");
    assert.equal(toBytes32(hash).length, 32);
  });
});

// ---------------------------------------------------------------------------------------------
// The console's half

describe("the console resolves Jev's goal check", () => {
  const body = {
    agentId: "ab".repeat(32),
    prompt: "Work toward the goal, one item at a time.",
    intervalMs: 5 * 60_000,
    maxSteps: 3,
  };

  it("resolves the terms from the verify seat when it is on, and to the committed 0.5 when it is not", () => {
    assert.deepEqual(checkGoalCheck(true, GOAL, undefined), { model: JEV, minConfidence: 0.5 });
    assert.deepEqual(checkGoalCheck(true, GOAL, { model: JEV, minConfidence: 0.7 }), {
      model: JEV,
      minConfidence: 0.7,
    });
    // A stored pair is re-derived, never trusted, so it cannot disagree with the seat beside it.
    assert.deepEqual(checkGoalCheck({ model: "x", minConfidence: 0.1 }, GOAL, undefined), {
      model: JEV,
      minConfidence: 0.5,
    });
    assert.isUndefined(checkGoalCheck(true, undefined, undefined), "no goal, nothing to check");
    assert.isUndefined(checkGoalCheck(false, GOAL, undefined));
    assert.isUndefined(checkGoalCheck(undefined, GOAL, undefined));
    assert.property(checkGoalCheck("yes", GOAL, undefined), "error");
  });

  it("puts the key on a start only with a goal and the toggle on", () => {
    const on = checkLoopRequest({ ...body, goal: GOAL, goalCheck: true }) as any;
    assert.deepEqual(on.goalCheck, { model: JEV, minConfidence: 0.5 });
    const seat = checkLoopRequest({ ...body, goal: GOAL, goalCheck: true, verify: { minConfidence: 0.6 } }) as any;
    assert.deepEqual(seat.goalCheck, { model: JEV, minConfidence: 0.6 });
    assert.notProperty(checkLoopRequest({ ...body, goal: GOAL }), "goalCheck");
    assert.notProperty(checkLoopRequest({ ...body, goalCheck: true }), "goalCheck");
  });

  it("stores the check on a template version the way a start resolves it, and nothing when off", () => {
    const version = (over: Record<string, unknown>) =>
      checkLoopConfig({
        prompt: body.prompt,
        intervalMs: 15_000,
        maxSteps: 3,
        budgetMicroUsdcPerStep: "50000",
        model: "deepseek/deepseek-v4.1-flash",
        coordinator: { agentId: "aa".repeat(32) },
        members: [],
        ...over,
      }) as any;
    assert.deepEqual(version({ goal: GOAL, goalCheck: true }).config.goalCheck, { model: JEV, minConfidence: 0.5 });
    assert.notProperty(version({ goal: GOAL }).config, "goalCheck");
    assert.notProperty(version({ goalCheck: true }).config, "goalCheck");
  });

  it("puts only the fixed vocabulary on a step row", () => {
    const view = stepGoalCheckView(
      {
        goalCheck: {
          outcome: "continue",
          claimed: true,
          choice: "achieved",
          confidence: 0.4,
          bar: 0.5,
          disagreement: "overruled",
          reason: "Jev judged the goal achieved at confidence 0.40, below the 0.5 this loop requires",
          goalCheckHash: "cd".repeat(32),
        },
      },
      false
    );
    assert.deepEqual(view, {
      outcome: "continue",
      claimed: true,
      choice: "achieved",
      confidence: 0.4,
      bar: 0.5,
      disagreement: "overruled",
      goalCheckHash: "cd".repeat(32),
    });
    assert.notProperty(stepGoalCheckView({ goalCheck: { outcome: "achieved", choice: "done!" } }, false), "choice");
    assert.isUndefined(stepGoalCheckView({ goalCheck: { outcome: "maybe" } }, false));
    assert.isUndefined(stepGoalCheckView({}, false));
    assert.include(stepGoalCheckView({ goalCheck: { outcome: "achieved" } }, true), { scripted: true });
  });

  it("answers the goal question on a scripted run with the step's own claim", () => {
    const ask = (output: string) =>
      scriptedGoalAnswer({
        model: "scripted",
        state: `PROMPT: p\n\nGOAL: g\n\nPREVIOUS MEMORY: none\n\nSTEP OUTPUT: ${output}`,
        questions: GOAL_CHECK_QUESTIONS as any,
      });
    assert.equal((ask(CLAIM) as any).goal.choice, "achieved");
    assert.equal((ask(PLAN) as any).goal.choice, "continue");
    assert.isUndefined(scriptedGoalAnswer({ model: "scripted", state: "", questions: VERIFY_QUESTIONS as any }));
  });
});

/**
 * On the audit's side: a 201 whose memory carries no claim is accepted as `judged`
 * when the decision the step committed says Jev answered `achieved` at its bar. That bar, and the
 * model, are the session policy's, not the ones the blob records — a blob held to a lower bar than
 * the owner's is a stop the owner never agreed to.
 */
describe("audit holds a judged goal stop to the policy's goal check", () => {
  /** A client over `records`, reading each record's status off its stored payload. */
  function clientOf(store: KeptStore, records: InferenceRecord[]): LathClient {
    const rows = records.map((r) => {
      const preimage = store.blobs.find((b) => hex(sha256(b)) === hex(r.payloadHash));
      const status = r.kind === EventKind.Action && preimage ? preimage[97] | (preimage[98] << 8) : 0;
      return { ...r, agentId: AGENT, timestamp: 0n, status, head: sha256(utf8(`head-${r.seq}`)) };
    });
    return {
      programId: new PublicKey("11111111111111111111111111111111"),
      getAgentState: async () => ({
        account: {},
        state: { authority: new PublicKey("11111111111111111111111111111111") },
      }),
      verifyChain: async () => ({
        ok: true,
        headReached: true,
        records: rows.length,
        seq: rows[rows.length - 1].seq + 1n,
        head: rows[rows.length - 1].head,
        missingSeqs: [],
        recoveredSeqs: [],
        resyncedSeqs: [],
        epochs: [],
      }),
      listEvents: async () => rows,
    } as unknown as LathClient;
  }

  /** One step Jev judged achieved at 0.8 under a 0.5 bar, with no claim in its memory: a judged 201. */
  async function judgedStop() {
    const { runner, store, policy } = loop({
      outputs: [PLAN],
      answers: [{ goal: { choice: "achieved", confidence: 0.8 } }],
      maxSteps: 1,
    });
    const one = await runner.step();
    assert.equal(checkpointOf(store, one).status, 201);
    return { one, store, policy };
  }

  it("is judged under the policy the blob was asked of", async () => {
    const { one, store, policy } = await judgedStop();
    const chain = await chainOf(store, [one], CHANNEL, policy);
    const report = await audit(clientOf(store, chain.records), AGENT, { store, requirePreimages: true });
    assert.equal(report.goalReached?.[0].terminal, "judged");
  });

  it("is a mismatch when the session's policy holds the goal check to a higher bar", async () => {
    const { one, store, policy } = await judgedStop();
    const strict: RuntimePolicy = { ...policy, goalCheck: { model: JEV, minConfidence: 0.9 } };
    const chain = await chainOf(store, [one], CHANNEL, strict);
    const report = await audit(clientOf(store, chain.records), AGENT, { store, requirePreimages: true });
    assert.equal(report.goalReached?.[0].terminal, "mismatch");
  });

  // Other bytes served under the step's `args_hash` must not pick the memory the claim is checked
  // against: a manifest naming a memory that says GOAL REACHED once read `ok` here.
  it("reads no goal claim off a manifest whose bytes are not the ones the step committed", async () => {
    const { one, store, policy } = await judgedStop();
    const chain = await chainOf(store, [one], CHANNEL, policy);
    const argsHash = hex(sha256(loopManifestBytes(one.manifest!)));
    const claimed = await store.put(utf8(CLAIM));
    const forged = loopManifestBytes({ ...one.manifest!, memoryHash: hex(claimed) });
    const swapped: TraceStore = {
      put: (b) => store.put(b),
      get: async (h) => (hex(h) === argsHash ? forged : store.get(h)),
    };
    const report = await audit(clientOf(store, chain.records), AGENT, { store: swapped, requirePreimages: true });
    assert.equal(report.goalReached?.[0].terminal, "no-manifest");
    assert.include(report.traces!.missing, argsHash, "the leaf walk names the bytes that do not re-hash");
    assert.isFalse(report.ok);
  });

  it("is missing when the session's policy is not readable", async () => {
    const { one, store, policy } = await judgedStop();
    const chain = await chainOf(store, [one], CHANNEL, policy);
    const doc = hex(sha256(utf8(policyDocument(policy))));
    const noPolicy: TraceStore = {
      put: (b) => store.put(b),
      get: async (h) => (hex(h) === doc ? null : store.get(h)),
    };
    const report = await audit(clientOf(store, chain.records), AGENT, { store: noPolicy, requirePreimages: true });
    assert.equal(report.goalReached?.[0].terminal, "missing");
  });
});
