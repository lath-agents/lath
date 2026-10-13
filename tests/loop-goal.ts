/**
 * The goal's pure half: the manifest's tenth key, the plan parser, and
 * the two audit answers the goal path depends on.
 *
 * Four contracts are pinned here, each one something a later change could break without any
 * test noticing:
 *
 * - **the manifest's bytes.** `goalHash` is the tenth key, emitted only when set, so every step
 *   already on devnet — six, seven, eight or nine keys — hashes to what it always did. The
 *   shorter vectors are **copied** (the six- to nine-key ones, as in
 *   `tests/loop-verify.ts`) rather than shared, for the reason `loop-verify.ts` gives about its own
 *   copies: two suites asserting the same bytes is the point, because someone editing the goal
 *   path would not run the verify step's suite.
 * - **the terminal line.** It stops a loop and spends nothing after it, so it is matched exactly
 *   and only as the last non-empty line. Lower-cased is not reached; mid-text is not reached.
 * - **the plan parse.** The last block wins, labels are read the way models actually write them,
 *   and text with no block is `null` rather than an empty plan — the loop keeps running on it.
 * - **the audit's two answers**: an accepted step that repeats
 *   its memory is remembered-unchanged and not FAILED, and a predecessor whose manifest cannot
 *   be read is unanswered rather than VERIFIED.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money.
 */
import { assert } from "chai";
import {
  decisionBlobBytes,
  decisionBlobHash,
  decodeLoopManifest,
  EventKind,
  formatReport,
  GOAL_REACHED_LINE,
  goalHash,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  LoopStepStatus,
  loopStepLeaf,
  MemoryTraceStore,
  parseGoalPlan,
  payloadPreimage,
  sha256,
  stepVerifyExitCode,
  utf8,
  verifyState,
  verifyStepDecision,
  VERIFY_QUESTIONS,
  type DecisionBlob,
  type GoalReachedStep,
  type InferenceRecord,
  type LoopStepManifest,
  type VerifyAnswers,
} from "../sdk/src";

const AGENT = sha256(utf8("loop-goal-agent"));
const CHANNEL = `0x${"aa".repeat(32)}`;
const PAYER = "0x18fB000000000000000000000000000000000e0B";
const GOAL = "a one-page comparison of two devnet RPCs, with a recommendation";

const base: LoopStepManifest = {
  loopId: "loop-oracle",
  step: 2,
  intervalMs: 300_000,
  maxSteps: 12,
  promptHash: hex(sha256(utf8("standing instruction"))),
  startedAt: 1_757_000_000_000,
};
const REQUEST = "8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu";
const VERIFY = "c".repeat(64);
const json = (m: LoopStepManifest) => new TextDecoder().decode(loopManifestBytes(m));

describe("the goal's manifest key", () => {
  it("leaves every manifest without `goalHash` byte-for-byte as it was", () => {
    // Six and seven keys: the vectors every older devnet step hashes to.
    assert.equal(
      json(base),
      '{"loopId":"loop-oracle","step":2,"intervalMs":300000,"maxSteps":12,' +
        `"promptHash":"${base.promptHash}","startedAt":1757000000000}`
    );
    const withMemory = { ...base, memoryHash: hex(sha256(utf8("remembered"))) };
    assert.equal(
      json(withMemory),
      '{"loopId":"loop-oracle","step":2,"intervalMs":300000,"maxSteps":12,' +
        `"promptHash":"${base.promptHash}","startedAt":1757000000000,"memoryHash":"${withMemory.memoryHash}"}`
    );
    // Eight keys, a step that names its request; nine, from tests/loop-verify.ts.
    assert.deepEqual(Object.keys(JSON.parse(json({ ...withMemory, requestAddress: REQUEST }))), [
      "loopId",
      "step",
      "intervalMs",
      "maxSteps",
      "promptHash",
      "startedAt",
      "memoryHash",
      "requestAddress",
    ]);
    assert.deepEqual(Object.keys(JSON.parse(json({ ...withMemory, requestAddress: REQUEST, verifyHash: VERIFY }))), [
      "loopId",
      "step",
      "intervalMs",
      "maxSteps",
      "promptHash",
      "startedAt",
      "memoryHash",
      "requestAddress",
      "verifyHash",
    ]);
  });

  it("emits `goalHash` tenth and last, after `verifyHash`", () => {
    const hash = goalHash(GOAL);
    const all = {
      ...base,
      memoryHash: hex(sha256(utf8("remembered"))),
      requestAddress: REQUEST,
      verifyHash: VERIFY,
      goalHash: hash,
    };
    assert.deepEqual(Object.keys(JSON.parse(json(all))), [
      "loopId",
      "step",
      "intervalMs",
      "maxSteps",
      "promptHash",
      "startedAt",
      "memoryHash",
      "requestAddress",
      "verifyHash",
      "goalHash",
    ]);
    // The goal is part of the commitment: a console that misreported it rebuilds another
    // manifest, which is the whole reason `args_hash` says anything about the goal at all.
    assert.notEqual(hex(sha256(loopManifestBytes(all))), hex(sha256(loopManifestBytes({ ...all, goalHash: VERIFY }))));
    // And it is last even when the keys before it are absent — a goal loop with no oracle
    // trigger and no verifier writes seven keys, not ten.
    assert.isTrue(json({ ...base, goalHash: hash }).endsWith(`,"goalHash":"${hash}"}`));
  });

  it("round-trips through `decodeLoopManifest`, and rejects a hash of the wrong length", () => {
    for (const m of [base, { ...base, goalHash: goalHash(GOAL) }, { ...base, verifyHash: VERIFY, goalHash: VERIFY }]) {
      assert.deepEqual(decodeLoopManifest(loopManifestBytes(m)), m);
    }
    assert.isNull(decodeLoopManifest(utf8(JSON.stringify({ ...base, goalHash: "a".repeat(63) }))));
    assert.isNull(decodeLoopManifest(utf8(JSON.stringify({ ...base, goalHash: "A".repeat(64) }))));
    assert.isNull(decodeLoopManifest(utf8(JSON.stringify({ ...base, goalHash: 7 }))));
  });

  it("hashes the goal trimmed, so a textarea's trailing newline is the same goal", () => {
    assert.equal(goalHash(GOAL), goalHash(`\n  ${GOAL}\t\n`));
    assert.equal(goalHash(GOAL), hex(sha256(utf8(GOAL))));
    assert.notEqual(goalHash(GOAL), goalHash(`${GOAL}.`));
  });

  it("gives the terminal step its own status code, distinct from a plain success", () => {
    assert.equal(LoopStepStatus.GoalReached, 201);
    assert.equal(LoopStepStatus.Success, 200);
  });
});

describe("parseGoalPlan", () => {
  const plan = ["DONE: read both docs", "NEXT: measure Helius", "NEXT: measure Triton", "OPEN: none"].join("\n");

  it("stops the plan at a TASKS or RESULTS label, so a team loop's tasks are not read as open questions", () => {
    // A team loop's answer carries the plan first and the tasks last; the memory the next step
    // reads carries RESULTS after that. Neither block is part of
    // the plan, whatever section the plan ended on.
    const withTasks = [plan, "TASKS:", "scout: read the upgrade authority", "reader: idle"].join("\n");
    const parsed = parseGoalPlan(withTasks);
    assert.deepEqual(parsed?.open, []);
    assert.deepEqual(parsed?.next, ["measure Helius", "measure Triton"]);
    const withResults = [plan.replace("OPEN: none", "OPEN: which RPC to trust"), "", "RESULTS:", "scout: done"].join(
      "\n"
    );
    assert.deepEqual(parseGoalPlan(withResults)?.open, ["which RPC to trust"]);
  });

  it("returns null for text that carries no block, so the loop runs on prose", () => {
    assert.isNull(parseGoalPlan("I looked at the docs and nothing else happened."));
    assert.isNull(parseGoalPlan(""));
    // A sentence that merely starts with the word is not a label: the colon is what makes one.
    assert.isNull(parseGoalPlan("Next steps are unclear."));
    // OPEN alone is not a plan either — there is no DONE and no NEXT to stand on.
    assert.isNull(parseGoalPlan("OPEN: what is the budget?"));
  });

  it("reads the three labels into three arrays", () => {
    const parsed = parseGoalPlan(plan);
    assert.deepEqual(parsed?.done, ["read both docs"]);
    assert.deepEqual(parsed?.next, ["measure Helius", "measure Triton"]);
    // `OPEN: none` is the instruction's own word for "nothing open", not a question reading none.
    assert.deepEqual(parsed?.open, []);
    assert.isFalse(parsed?.reached);
  });

  it("takes the last block when a step restates the previous plan first", () => {
    const two = ["DONE: read both docs", "NEXT: measure Helius", "OPEN: none", "", plan.replace("Helius", "Triton")];
    const parsed = parseGoalPlan(two.join("\n"));
    assert.deepEqual(parsed?.next, ["measure Triton", "measure Triton"]);
  });

  it("reads items listed under a label as well as beside it", () => {
    const parsed = parseGoalPlan(
      ["DONE:", "- read the Helius doc", "* read the Triton doc", "NEXT:", "1. measure"].join("\n")
    );
    assert.deepEqual(parsed?.done, ["read the Helius doc", "read the Triton doc"]);
    assert.deepEqual(parsed?.next, ["measure"]);
    assert.deepEqual(parsed?.open, []);
  });

  it("tolerates case, a trailing period and markdown emphasis on the labels", () => {
    const parsed = parseGoalPlan(["**Done.:** read both docs", "next : measure Helius", "  OPEN:  none  "].join("\n"));
    assert.deepEqual(parsed?.done, ["read both docs"]);
    assert.deepEqual(parsed?.next, ["measure Helius"]);
    assert.deepEqual(parsed?.open, []);
  });

  it("is reached only when the terminal line is the last non-empty line, exactly", () => {
    assert.isTrue(parseGoalPlan(`${plan}\n${GOAL_REACHED_LINE}`)?.reached);
    // Trailing blank lines are whitespace, not content.
    assert.isTrue(parseGoalPlan(`${plan}\n${GOAL_REACHED_LINE}\n\n   \n`)?.reached);
    // Lower-cased is not the line: a loop that stopped on it would stop on any prose mentioning it.
    assert.isFalse(parseGoalPlan(`${plan}\ngoal reached`)?.reached);
    // Mid-text is not the line either: the model was told to make it the last one.
    assert.isFalse(parseGoalPlan([GOAL_REACHED_LINE, plan].join("\n"))?.reached);
    assert.isFalse(parseGoalPlan(`${plan}\n${GOAL_REACHED_LINE} — finally`)?.reached);
    assert.isFalse(parseGoalPlan(plan)?.reached);
  });

  it("keeps the terminal line out of the plan's items", () => {
    const parsed = parseGoalPlan(`${plan}\n${GOAL_REACHED_LINE}`);
    assert.notInclude(parsed?.open ?? [], GOAL_REACHED_LINE);
    assert.deepEqual(parsed?.open, []);
  });
});

// ---------------------------------------------------------------------------------------------
// The audit's two answers

const answers = (choice: string, confidence: number): VerifyAnswers => ({
  followed_plan: { noul: 0.87, confidence: 0.9 },
  verdict: { choice, confidence, probabilities: { accept: confidence } },
});

const blobOf = (choice: string, confidence: number): DecisionBlob => ({
  request: {
    model: "typesafe/jev-1.13",
    state: verifyState("standing instruction", "m", "o"),
    questions: VERIFY_QUESTIONS,
  },
  answers: answers(choice, confidence),
  payment: {
    rail: "tempo",
    chainId: 4217,
    payer: PAYER,
    channelId: CHANNEL,
    cumulativeBefore: "0",
    cumulativeAfter: "42",
  } as any,
  model: "typesafe/jev-1.13-20260917",
  id: "gen-decision-1",
  usage: { cost: 0.000025242 },
});

/** The policy each fake step's Genesis commits: the verifier the blobs here were asked of. */
const POLICY = { model: "x", verify: { model: "typesafe/jev-1.13", minConfidence: 0.6 } };

/**
 * As much of a loop's chain as `verifyStepDecision` reads: one voucher-carrying LLM Action per
 * step, then the `loop.step` checkpoint whose manifest carries `verifyHash`. A copy of the
 * harness in `tests/loop-verify.ts` rather than a shared one, so the two suites stay
 * independent — a change that breaks one is meant to be visible in it.
 */
class StepChain {
  readonly records: InferenceRecord[] = [];
  readonly store = new MemoryTraceStore();
  /** Manifest hashes this chain wrote, so a case can make one of them unreadable by hand. */
  readonly manifestHashes: string[] = [];
  private seq = 0;

  async listEvents(): Promise<readonly InferenceRecord[]> {
    return this.records;
  }

  /** The Genesis that opens a step's session, naming the verifier its decisions are held to. */
  async genesis(policy: Record<string, unknown> = POLICY): Promise<bigint> {
    const policyVersionHash = await this.store.put(utf8(JSON.stringify(policy)));
    const inputPayloadHash = await this.store.put(utf8("{}"));
    return this.append(
      {
        kind: EventKind.Genesis,
        sessionId: `step-session-${this.seq}`,
        callerPubkey: new Uint8Array(32),
        policyVersionHash,
        inputPayloadHash,
      },
      "genesis"
    );
  }

  async call(): Promise<void> {
    const argsHash = await this.store.put(utf8(JSON.stringify({ model: "x" })));
    const resultHash = await this.store.put(
      utf8(
        JSON.stringify({
          id: "gen-1",
          payment: {
            rail: "tempo",
            chainId: 4217,
            payer: PAYER,
            channelId: CHANNEL,
            cumulativeBefore: "0",
            cumulativeAfter: "750",
          },
        })
      )
    );
    await this.append({ kind: EventKind.Action, toolId: "llm.x", argsHash, resultHash, statusCode: 200 }, "llm.x");
  }

  async step(manifest: LoopStepManifest, blob?: DecisionBlob): Promise<bigint> {
    if (blob) await this.store.put(decisionBlobBytes(blob));
    const argsHash = await this.store.put(loopManifestBytes(manifest));
    this.manifestHashes.push(hex(argsHash));
    const resultHash = loopStepLeaf(AGENT, this.seq, sha256(utf8(`head-${this.seq}`)));
    return this.append(
      { kind: EventKind.Action, toolId: LOOP_STEP_TOOL, argsHash, resultHash, statusCode: 200 },
      LOOP_STEP_TOOL
    );
  }

  private async append(payload: any, toolId: string): Promise<bigint> {
    const preimage = payloadPreimage(payload);
    await this.store.put(preimage);
    const seq = BigInt(this.seq++);
    this.records.push({ seq, kind: payload.kind, reference: idFromString(toolId), payloadHash: sha256(preimage) });
    return seq;
  }
}

describe("verify-step and a memory that did not move", () => {
  const memoryA = hex(sha256(utf8("step one")));

  /** Two accepted steps; the second commits whatever the case gives it. */
  async function twoSteps(second: Partial<LoopStepManifest>) {
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    await chain.genesis();
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis();
    await chain.call();
    const blob = blobOf("accept", 0.91);
    const seq = await chain.step({ ...base, step: 2, ...second, verifyHash: decisionBlobHash(blob) }, blob);
    return { chain, seq };
  }

  it("an accepted step that repeats its memory is remembered, unchanged — not FAILED", async () => {
    // The store is content-addressed, so a step whose answer repeats the last one word for word
    // commits the hash it already had. That is a loop with nothing new to say, not a defect.
    const { chain, seq } = await twoSteps({ memoryHash: memoryA });
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "ok", report.reason);
    assert.isFalse(report.memoryAdvanced);
    assert.isTrue(report.memoryRepeated);
    assert.equal(stepVerifyExitCode(report), 0);
  });

  it("still fails an accepted step that committed no memory while the one before it had one", async () => {
    const { chain, seq } = await twoSteps({});
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "mismatch");
    assert.include(report.reason ?? "", "commits no memory");
  });
});

describe("verify-step and a predecessor it cannot read", () => {
  const memoryA = hex(sha256(utf8("step one")));
  const memoryB = hex(sha256(utf8("step two")));

  it("a previous manifest that is not available answers no-preimage and exits 2", async () => {
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    await chain.genesis();
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis();
    await chain.call();
    const blob = blobOf("accept", 0.91);
    const seq = await chain.step({ ...base, step: 2, memoryHash: memoryB, verifyHash: decisionBlobHash(blob) }, blob);

    // A store that has lost exactly the first step's manifest — what a gateway that pruned one
    // blob looks like from here.
    const gone = chain.manifestHashes[0];
    const partial = {
      put: (b: Uint8Array) => chain.store.put(b),
      get: async (h: Uint8Array) => (hex(h) === gone ? null : chain.store.get(h)),
    };
    const report = await verifyStepDecision(chain, AGENT, seq, { store: partial });
    assert.equal(report.verdict, "no-preimage");
    assert.include(report.reason ?? "", "the step before this one");
    assert.equal(stepVerifyExitCode(report), 2);
    // And with the whole store it is the answer it always was, so the skip did not widen.
    const whole = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(whole.verdict, "ok", whole.reason);
  });

  it("prints `goal reached` on a 201 step, and says why when its memory disagrees", () => {
    const of = (terminal: GoalReachedStep["terminal"]) =>
      formatReport({
        agentId: hex(AGENT),
        programId: "11111111111111111111111111111111",
        authority: "11111111111111111111111111111111",
        seq: "9",
        head: hex(sha256(utf8("head"))),
        chain: { ok: true, headReached: true, records: 9, missingSeqs: [], recoveredSeqs: [] },
        goalReached: [{ seq: "8", goalHash: goalHash(GOAL), memoryHash: memoryB, terminal }],
        ok: terminal !== "mismatch",
      }).join("\n");
    assert.include(of("ok"), "goal reached at seq 8");
    assert.include(of("ok"), `ends with "${GOAL_REACHED_LINE}"`);
    assert.include(of("mismatch"), `does not end with "${GOAL_REACHED_LINE}"`);
    assert.include(of("mismatch"), "FAILED");
    // Bytes the owner withheld are not a disagreement: the report says so and still VERIFIES.
    assert.include(of("encrypted"), "--trace-key");
    assert.include(of("encrypted"), "VERIFIED");
  });

  it("keeps the first-step skip: nothing earlier exists, so there is nothing missing", async () => {
    const chain = new StepChain();
    const blob = blobOf("accept", 0.91);
    await chain.genesis();
    await chain.call();
    const seq = await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(blob) }, blob);
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "ok", report.reason);
    assert.isUndefined(report.memoryAdvanced);
  });
});
