/**
 * The verify step's pure half, plus `verify-step` over a fake chain.
 *
 * Three contracts are pinned here, and each of them is something a later change could break
 * silently:
 *
 * - **the manifest's bytes.** `verifyHash` is the ninth key, emitted only when set, so every
 *   step already on devnet — six, seven or eight keys — hashes to what it always did. The
 *   six- to eight-key vectors are copied here rather than shared, and `tests/loop-goal.ts` asserts
 *   them too: two suites
 *   asserting the same bytes is the point, because someone editing one path would not run the other.
 * - **the decision blob.** Canonical JSON, so a reader who only has the values back re-hashes to
 *   what the runtime committed, whatever order it assembled them in; and a blob with no verdict
 *   is not a decision blob, because the verdict is the whole reason it is committed.
 * - **the verdict rule.** `applyVerdict` is the enforcer half of the proposer/enforcer split
 *   : the model's `choice` and confidence in, one of three outcomes out,
 *   the same for the runner and for anyone auditing what the runner did.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money.
 */
import { assert } from "chai";
import {
  applyVerdict,
  decisionBlobBytes,
  decisionBlobHash,
  decodeDecisionBlob,
  decodeLoopManifest,
  EventKind,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  loopStepLeaf,
  MemoryTraceStore,
  payloadPreimage,
  sha256,
  utf8,
  verifyState,
  verifyStepDecision,
  VERIFY_QUESTIONS,
  type DecisionBlob,
  type InferenceRecord,
  type LoopStepManifest,
  type TraceStore,
  type VerifyAnswers,
} from "../sdk/src";

const AGENT = sha256(utf8("loop-verify-agent"));
const CHANNEL = `0x${"aa".repeat(32)}`;
const OTHER_CHANNEL = `0x${"bb".repeat(32)}`;
const PAYER = "0x18fB000000000000000000000000000000000e0B";

const base: LoopStepManifest = {
  loopId: "loop-oracle",
  step: 2,
  intervalMs: 300_000,
  maxSteps: 12,
  promptHash: hex(sha256(utf8("standing instruction"))),
  startedAt: 1_757_000_000_000,
};
const VERIFY = "c".repeat(64);
const json = (m: LoopStepManifest) => new TextDecoder().decode(loopManifestBytes(m));

describe("the verify step's manifest key", () => {
  it("leaves a manifest without `verifyHash` byte-for-byte as it was", () => {
    // The six/seven-key vectors every older devnet step hashes to.
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
  });

  it("emits `verifyHash` ninth and last, after `requestAddress`", () => {
    const address = "8sHTvpu8d6rvGBvS38ZkfBT1VqPzXKrQZG3F1LHaCPVu";
    const all = { ...base, memoryHash: hex(sha256(utf8("remembered"))), requestAddress: address, verifyHash: VERIFY };
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
    ]);
    // The verdict is part of the commitment: a step that committed another decision is another
    // manifest, which is what makes `args_hash` say anything about the verdict at all.
    assert.notEqual(
      hex(sha256(loopManifestBytes(all))),
      hex(sha256(loopManifestBytes({ ...all, verifyHash: "d".repeat(64) })))
    );
    assert.equal(json({ ...base, verifyHash: VERIFY }).endsWith(`,"verifyHash":"${VERIFY}"}`), true);
  });

  it("round-trips through `decodeLoopManifest`, and rejects a hash of the wrong length", () => {
    for (const m of [base, { ...base, verifyHash: VERIFY }]) {
      assert.deepEqual(decodeLoopManifest(loopManifestBytes(m)), m);
    }
    const short = utf8(JSON.stringify({ ...base, verifyHash: "c".repeat(63) }));
    assert.isNull(decodeLoopManifest(short));
  });
});

describe("the state a verifier is given", () => {
  it("is the three labelled sections, in order, with `none` for an absent memory", () => {
    assert.equal(
      verifyState("watch the pool", undefined, "SOL is 142.10"),
      "PROMPT: watch the pool\n\nPREVIOUS MEMORY: none\n\nSTEP OUTPUT: SOL is 142.10"
    );
    assert.equal(
      verifyState("watch the pool", "last week: 131–139", "SOL is 142.10"),
      "PROMPT: watch the pool\n\nPREVIOUS MEMORY: last week: 131–139\n\nSTEP OUTPUT: SOL is 142.10"
    );
  });

  it("is byte-stable for the same three inputs and moves when any one of them does", () => {
    const one = verifyState("p", "m", "o");
    assert.equal(one, verifyState("p", "m", "o"));
    for (const other of [verifyState("P", "m", "o"), verifyState("p", "M", "o"), verifyState("p", "m", "O")]) {
      assert.notEqual(one, other);
    }
  });

  it("fixes exactly two questions, and freezes them", () => {
    assert.deepEqual(Object.keys(VERIFY_QUESTIONS), ["followed_plan", "verdict"]);
    assert.equal(VERIFY_QUESTIONS.followed_plan.type, "noul");
    assert.equal(VERIFY_QUESTIONS.verdict.type, "choice");
    assert.deepEqual(Object.keys(VERIFY_QUESTIONS.verdict.criteria), ["accept", "retry", "escalate"]);
    assert.isTrue(Object.isFrozen(VERIFY_QUESTIONS) && Object.isFrozen(VERIFY_QUESTIONS.verdict.criteria));
  });
});

const answers = (choice: string, confidence: number): VerifyAnswers => ({
  followed_plan: { noul: 0.87, confidence: 0.9 },
  verdict: { choice, confidence, probabilities: { accept: confidence } },
});

const blobOf = (choice: string, confidence: number, channelId = CHANNEL): DecisionBlob => ({
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
    channelId,
    cumulativeBefore: "0",
    cumulativeAfter: "42",
  } as any,
  model: "typesafe/jev-1.13-20260917",
  id: "gen-decision-1",
  usage: { cost: 0.000025242 },
});

describe("the decision blob", () => {
  it("is canonical: the same bytes whatever order its fields were assembled in", () => {
    const one = blobOf("accept", 0.91);
    const reordered = {
      id: one.id,
      model: one.model,
      usage: one.usage,
      answers: { verdict: one.answers.verdict, followed_plan: one.answers.followed_plan },
      payment: one.payment,
      request: { questions: one.request.questions, state: one.request.state, model: one.request.model },
    } as DecisionBlob;
    assert.equal(hex(sha256(decisionBlobBytes(one))), hex(sha256(decisionBlobBytes(reordered))));
    // Keys sorted at the top level is the visible half of the same rule.
    assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(decisionBlobBytes(one)))), [
      "answers",
      "id",
      "model",
      "payment",
      "request",
      "usage",
    ]);
  });

  it("drops an absent payment rather than writing a null, so a scripted step hashes cleanly", () => {
    const { payment, ...scripted } = blobOf("accept", 0.99);
    const bytes = decisionBlobBytes(scripted as DecisionBlob);
    assert.notInclude(new TextDecoder().decode(bytes), "payment");
    assert.equal(decisionBlobHash(scripted as DecisionBlob), hex(sha256(bytes)));
  });

  it("round-trips, and is not a decision blob at all without `answers.verdict`", () => {
    const decoded = decodeDecisionBlob(decisionBlobBytes(blobOf("retry", 0.8)));
    assert.equal(decoded?.answers.verdict.choice, "retry");
    const { verdict, ...rest } = blobOf("accept", 0.9).answers;
    const noVerdict = utf8(JSON.stringify({ ...blobOf("accept", 0.9), answers: rest }));
    assert.isNull(decodeDecisionBlob(noVerdict));
    assert.isNull(decodeDecisionBlob(utf8("not json at all")));
  });
});

describe("applyVerdict", () => {
  it("covers the four rows of the verdict table", () => {
    assert.equal(applyVerdict(answers("accept", 0.91), 0.6).outcome, "accepted");
    assert.equal(applyVerdict(answers("retry", 0.8), 0.6).outcome, "retried");
    assert.equal(applyVerdict(answers("accept", 0.5), 0.6).outcome, "retried");
    // Escalation does not care about the bar: the model is saying the step left the prompt's
    // bounds, and a loop that continued on a low-confidence escalation would be the wrong risk.
    assert.equal(applyVerdict(answers("escalate", 0.2), 0.99).outcome, "escalated");
    assert.equal(applyVerdict(answers("escalate", 0.9), 0.6).outcome, "escalated");
  });

  it("accepts at exactly the threshold, and retries an unrecognised choice", () => {
    assert.equal(applyVerdict(answers("accept", 0.6), 0.6).outcome, "accepted");
    const unknown = applyVerdict(answers("abstain", 0.9), 0.6);
    assert.equal(unknown.outcome, "retried");
    assert.include(unknown.reason, "abstain");
    // A missing confidence is zero, not a pass: an accept that says nothing about how sure it is
    // has not cleared any bar.
    assert.equal(applyVerdict({ verdict: { choice: "accept" } }, 0.6).outcome, "retried");
  });

  it("says why, in one sentence naming the number the loop required", () => {
    assert.include(applyVerdict(answers("accept", 0.5), 0.6).reason, "0.6");
  });
});

/**
 * A loop's chain, as much of it as `verifyStepDecision` reads: one voucher-carrying LLM Action
 * per step, then the `loop.step` checkpoint whose manifest carries `verifyHash`. The decision
 * blob goes in the same store the manifest does, because that is where the runtime puts it.
 */
/** The policy every fake step's Genesis commits: the verifier the blobs below were asked of, at 0.6. */
const POLICY = { model: "x", verify: { model: "typesafe/jev-1.13", minConfidence: 0.6 } };

class StepChain {
  readonly records: InferenceRecord[] = [];
  readonly store = new MemoryTraceStore();
  private seq = 0;

  async listEvents(): Promise<readonly InferenceRecord[]> {
    return this.records;
  }

  /**
   * The Genesis that opens a step's session, naming `policy` through its `policy_version_hash`: what
   * the audit holds the step's decision to. The document goes in the store, as the runtime puts it.
   */
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

  /** One paid LLM call on `channelId`: what makes the chain able to name the loop's channel. */
  async call(channelId = CHANNEL): Promise<void> {
    const argsHash = await this.store.put(utf8(JSON.stringify({ model: "x" })));
    const resultHash = await this.store.put(
      utf8(
        JSON.stringify({
          id: "gen-1",
          payment: {
            rail: "tempo",
            chainId: 4217,
            payer: PAYER,
            channelId,
            cumulativeBefore: "0",
            cumulativeAfter: "750",
          },
        })
      )
    );
    await this.append({ kind: EventKind.Action, toolId: "llm.x", argsHash, resultHash, statusCode: 200 }, "llm.x");
  }

  /** One checkpoint, with its manifest and (when there is one) its decision blob stored. */
  async step(manifest: LoopStepManifest, blob?: DecisionBlob): Promise<bigint> {
    if (blob) await this.store.put(decisionBlobBytes(blob));
    const argsHash = await this.store.put(loopManifestBytes(manifest));
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

describe("verify-step over a fake chain", () => {
  const memoryA = hex(sha256(utf8("step one")));
  const memoryB = hex(sha256(utf8("step two")));

  /** Two steps: the first accepted, the second whatever the case wants. */
  async function twoSteps(blob: DecisionBlob, second: Partial<LoopStepManifest> = {}, policy = POLICY) {
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    await chain.genesis(policy);
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis(policy);
    await chain.call();
    const seq = await chain.step(
      { ...base, step: 2, memoryHash: memoryB, ...second, verifyHash: decisionBlobHash(blob) },
      blob
    );
    return { chain, seq };
  }

  it("is `ok` when the blob re-hashes and the memory did what the verdict says", async () => {
    const { chain, seq } = await twoSteps(blobOf("accept", 0.91));
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "ok", report.reason);
    assert.equal(report.model, "typesafe/jev-1.13-20260917");
    assert.equal(report.choice, "accept");
    assert.isTrue(report.memoryAdvanced);
  });

  it("is `mismatch` when the verifier said retry and the memory advanced anyway", async () => {
    const { chain, seq } = await twoSteps(blobOf("retry", 0.8));
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "mismatch");
    assert.include(report.reason ?? "", "advanced");
    // The other direction of the same rule: a retry that carried the memory forward is `ok`.
    const carried = await twoSteps(blobOf("retry", 0.8), { memoryHash: memoryA });
    const second = await verifyStepDecision(carried.chain, AGENT, carried.seq, { store: carried.chain.store });
    assert.equal(second.verdict, "ok", second.reason);
  });

  it("holds an `accept` under the recorded bar to the outcome, not the word", async () => {
    // The runner retried it (0.3 < 0.6), so the memory rightly stood still: `ok`, not a mismatch.
    const under = blobOf("accept", 0.3);
    under.request.minConfidence = 0.6;
    const carried = await twoSteps(under, { memoryHash: memoryA });
    const report = await verifyStepDecision(carried.chain, AGENT, carried.seq, { store: carried.chain.store });
    assert.equal(report.verdict, "ok", report.reason);
    assert.isFalse(report.memoryAdvanced);
    // And had the memory advanced on it, that is the chain contradicting the bar it committed.
    const advanced = await twoSteps(under);
    const bad = await verifyStepDecision(advanced.chain, AGENT, advanced.seq, { store: advanced.chain.store });
    assert.equal(bad.verdict, "mismatch");
  });

  it("is `payer` when the decision was paid on a channel that is not the loop's", async () => {
    const { chain, seq } = await twoSteps(blobOf("accept", 0.91, OTHER_CHANNEL));
    const report = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(report.verdict, "payer");
    assert.equal(report.channelId, OTHER_CHANNEL);
  });

  it("is `no-preimage` for a step nothing verified, and `mismatch` for an edited blob", async () => {
    const chain = new StepChain();
    await chain.call();
    const plain = await chain.step({ ...base, step: 1, memoryHash: memoryA });
    const unverified = await verifyStepDecision(chain, AGENT, plain, { store: chain.store });
    assert.equal(unverified.verdict, "no-preimage");
    assert.include(unverified.reason ?? "", "not verified");

    const { chain: edited, seq } = await twoSteps(blobOf("accept", 0.91));
    const target = decisionBlobHash(blobOf("accept", 0.91));
    // A store that answers the decision's key with other bytes, by hand.
    const tampered: TraceStore = {
      put: (b) => edited.store.put(b),
      get: async (h) => (hex(h) === target ? utf8("a decision nobody gave") : edited.store.get(h)),
    };
    const report = await verifyStepDecision(edited, AGENT, seq, { store: tampered });
    assert.equal(report.verdict, "mismatch");
    assert.include(report.reason ?? "", "edited");
  });
});

/**
 * An epoch whose blob is not here drops its members from the walk, and every search for "the most
 * recent earlier checkpoint" sees only what it walked. With the step before this one inside such an
 * epoch, the search lands on an older checkpoint, or on none and takes the step as a loop's first —
 * so withholding one epoch blob could turn a FAILED step into VERIFIED. A blind spot must never
 * upgrade a verdict: the comparison is not made and the step is `no-preimage`.
 */
describe("verify-step with an epoch not opened", () => {
  const memoryA = hex(sha256(utf8("step one")));
  const memoryB = hex(sha256(utf8("step two")));

  /** Genesis 0, call 1, step 1 at seq 2; Genesis 3, call 4, step 2 at seq 5 under `blob`. */
  async function twoSteps(blob: DecisionBlob, second: Partial<LoopStepManifest> = {}) {
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    await chain.genesis();
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis();
    await chain.call();
    const seq = await chain.step(
      { ...base, step: 2, memoryHash: memoryB, ...second, verifyHash: decisionBlobHash(blob) },
      blob
    );
    return { chain, seq };
  }

  /** The chain as a reader with no epoch store sees it, when [start, end) was rolled into an epoch. */
  const withEpoch = (chain: StepChain, start: bigint, end: bigint) => ({
    listEvents: async () => chain.records.filter((r) => r.seq < start || r.seq >= end),
    listEpochs: async () => [{ epochRoot: sha256(utf8(`root-${start}`)), startSeq: start, endSeq: end }],
  });

  it("does not verify a retry whose memory advanced when the previous checkpoint's epoch is withheld", async () => {
    const { chain, seq } = await twoSteps(blobOf("retry", 0.8));
    const full = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(full.verdict, "mismatch", "every record here: the memory advanced on a retry");
    // The reviewer's repro: only the step-1 checkpoint is withheld, so the search finds no earlier step.
    const blind = await verifyStepDecision(withEpoch(chain, 2n, 3n), AGENT, seq, { store: chain.store });
    assert.equal(blind.verdict, "no-preimage", blind.reason);
    assert.include(blind.reason ?? "", "epoch 2–3 is not opened");
    assert.isUndefined(blind.memoryAdvanced);
    // And with the epoch reaching over this step's own Genesis too.
    const wider = await verifyStepDecision(withEpoch(chain, 2n, 4n), AGENT, seq, { store: chain.store });
    assert.equal(wider.verdict, "no-preimage", wider.reason);
  });

  it("does not compare an honest step with an older checkpoint than its real predecessor", async () => {
    // Step 1 remembered A, step 2 (hidden) remembered B, step 3 retried and carried B forward. Against
    // step 1, the only one this reader sees, the carried B looks like memory advancing on a retry.
    const chain = new StepChain();
    const accept = blobOf("accept", 0.91);
    await chain.genesis();
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(accept) }, accept);
    await chain.genesis();
    await chain.call();
    const hidden = await chain.step(
      { ...base, step: 2, memoryHash: memoryB, verifyHash: decisionBlobHash(accept) },
      accept
    );
    await chain.genesis();
    await chain.call();
    const retry = blobOf("retry", 0.8);
    const seq = await chain.step({ ...base, step: 3, memoryHash: memoryB, verifyHash: decisionBlobHash(retry) }, retry);
    const full = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(full.verdict, "ok", full.reason);
    const blind = await verifyStepDecision(withEpoch(chain, hidden, hidden + 1n), AGENT, seq, { store: chain.store });
    assert.equal(blind.verdict, "no-preimage", blind.reason);
  });

  it("leaves a step verified when the unopened epoch is older than the checkpoint found", async () => {
    // The epoch holds only the call before step 1: nothing between step 1 and step 2 is missing.
    const { chain, seq } = await twoSteps(blobOf("accept", 0.91));
    const r = await verifyStepDecision(withEpoch(chain, 1n, 2n), AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "ok", r.reason);
    assert.isTrue(r.memoryAdvanced);
    const retried = await twoSteps(blobOf("retry", 0.8));
    const bad = await verifyStepDecision(withEpoch(retried.chain, 1n, 2n), AGENT, retried.seq, {
      store: retried.chain.store,
    });
    assert.equal(bad.verdict, "mismatch", "the predecessor is here, so the contradiction still is");
  });

  it("is `no-preimage` when the chain's epochs cannot be listed", async () => {
    const { chain, seq } = await twoSteps(blobOf("accept", 0.91));
    const unlisted = {
      listEvents: async () => chain.records,
      listEpochs: async (): Promise<never> => {
        throw new Error("history refused");
      },
    };
    const r = await verifyStepDecision(unlisted, AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "no-preimage", r.reason);
    assert.include(r.reason ?? "", "could not be listed");
  });
});

/**
 * A decision blob records the model it asked and the bar it was held to, and both are the writer's
 * word. The runner refuses to start under a seat its policy does not name, so on an honest chain
 * they are the policy's; the audit holds them to it. Otherwise a blob that lowered its own bar — or
 * dropped it, to be read by the word — would pass an `accept` the owner's bar rejects, with the
 * memory advanced on it, as VERIFIED.
 */
describe("verify-step holds a decision to the policy's seat", () => {
  const memoryA = hex(sha256(utf8("step one")));
  const memoryB = hex(sha256(utf8("step two")));

  async function twoSteps(blob: DecisionBlob, policy: Record<string, unknown> = POLICY, second = {}) {
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    await chain.genesis(policy);
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis(policy);
    await chain.call();
    const seq = await chain.step(
      { ...base, step: 2, memoryHash: memoryB, ...second, verifyHash: decisionBlobHash(blob) },
      blob
    );
    return { chain, seq };
  }

  it("fails a blob that lowered its own bar under the policy's", async () => {
    // 0.3 clears the blob's 0.2 and not the policy's 0.6, and the memory advanced on it.
    const lowered = blobOf("accept", 0.3);
    lowered.request.minConfidence = 0.2;
    const { chain, seq } = await twoSteps(lowered);
    const r = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "mismatch", r.reason);
    assert.include(r.reason ?? "", "bar of 0.2");
  });

  it("does not verify a blob that dropped its bar to be read by the word", async () => {
    // By the word an `accept` is kept; by the policy's 0.6, 0.3 is not. Which the runner did cannot be
    // said from the blob, so the memory is not compared on either and the step is not verified.
    const { chain, seq } = await twoSteps(blobOf("accept", 0.3));
    const r = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "no-preimage", r.reason);
    assert.include(r.reason ?? "", "records no bar");
    // A bar-less blob the word and the bar agree on is an older blob, and still verifies.
    const old = await twoSteps(blobOf("accept", 0.91));
    const ok = await verifyStepDecision(old.chain, AGENT, old.seq, { store: old.chain.store });
    assert.equal(ok.verdict, "ok", ok.reason);
  });

  it("fails a blob that asked a model the policy does not name", async () => {
    const swapped = blobOf("accept", 0.91);
    swapped.request.model = "someone/else-1";
    const { chain, seq } = await twoSteps(swapped);
    const r = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "mismatch", r.reason);
    assert.include(r.reason ?? "", "someone/else-1");
  });

  it("does not verify a step whose policy is not readable, or names no verifier", async () => {
    const { chain, seq } = await twoSteps(blobOf("accept", 0.91));
    // A store missing the policy document: the decision is read on its own bar and not called verified.
    const doc = hex(sha256(utf8(JSON.stringify(POLICY))));
    const noPolicy: TraceStore = {
      put: (b) => chain.store.put(b),
      get: async (h) => (hex(h) === doc ? null : chain.store.get(h)),
    };
    const unread = await verifyStepDecision(chain, AGENT, seq, { store: noPolicy });
    assert.equal(unread.verdict, "no-preimage", unread.reason);
    assert.include(unread.reason ?? "", "not readable");
    const seatless = await twoSteps(blobOf("accept", 0.91), { model: "x" });
    const r = await verifyStepDecision(seatless.chain, AGENT, seatless.seq, { store: seatless.chain.store });
    assert.equal(r.verdict, "no-preimage", r.reason);
    assert.include(r.reason ?? "", "commits no verifier");
  });

  it("holds the step to its own session's policy, not an earlier one", async () => {
    // Step 1 under a 0.2 bar, step 2 under the owner's 0.6: step 2's blob at 0.2 is held to 0.6.
    const chain = new StepChain();
    const first = blobOf("accept", 0.91);
    first.request.minConfidence = 0.2;
    await chain.genesis({ ...POLICY, verify: { model: "typesafe/jev-1.13", minConfidence: 0.2 } });
    await chain.call();
    await chain.step({ ...base, step: 1, memoryHash: memoryA, verifyHash: decisionBlobHash(first) }, first);
    await chain.genesis(POLICY);
    await chain.call();
    const lowered = blobOf("accept", 0.3);
    lowered.request.minConfidence = 0.2;
    const seq = await chain.step(
      { ...base, step: 2, memoryHash: memoryB, verifyHash: decisionBlobHash(lowered) },
      lowered
    );
    const r = await verifyStepDecision(chain, AGENT, seq, { store: chain.store });
    assert.equal(r.verdict, "mismatch", r.reason);
  });
});
