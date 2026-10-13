import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  computeEpochHead,
  computeEpochLeaf,
  createEpochMerkleTree,
  decodeEpochBlob,
  DEFAULT_MIN_PAYER_LAMPORTS,
  encodeEpochBlob,
  EpochCommit,
  epochLeaves,
  epochRootOf,
  EventInput,
  EventKind,
  EventPayload,
  generateEpochProof,
  InsufficientPayerBalance,
  hex,
  idFromString,
  MemoryEpochStore,
  ResolutionStatus,
  RollupBatcher,
  sha256,
  toEventInput,
  verifyEpochBlob,
  verifyEpochProof,
  ZERO32,
} from "../sdk/src";
import { DynamicStorageEngine, EventTier } from "../scripts/dynamic-storage-engine";

/** No validator: everything here is pure. */

const dummyPk = new PublicKey("11111111111111111111111111111111");

function action(i: number): EventPayload {
  return {
    kind: EventKind.Action,
    toolId: `tool-${i % 7}`,
    argsHash: sha256(new Uint8Array([i, 1])),
    resultHash: sha256(new Uint8Array([i, 2])),
    statusCode: 200 + (i % 3),
  };
}

function inputs(n: number, t0 = 1_700_000_000_000): EventInput[] {
  return Array.from({ length: n }, (_, i) => toEventInput(action(i), t0 + i * 1000));
}

/**
 * A committer that behaves like `LathClient.createEpochCommitter` without a chain: it keeps
 * the owner's seq and head, stores the blob, and folds the head with the real formula.
 */
function fakeCommitter(agentId: Uint8Array, store: MemoryEpochStore) {
  const state = { seq: 0n, head: ZERO32 as Uint8Array, commits: 0 };
  const committer = async (steps: EventInput[]): Promise<EpochCommit> => {
    const startSeq = state.seq;
    const endSeq = startSeq + BigInt(steps.length);
    const tree = createEpochMerkleTree(epochLeaves(startSeq, steps));
    const blob = encodeEpochBlob(startSeq, steps);
    await store.put(tree.root, blob);
    state.head = computeEpochHead(state.head, agentId, tree.root, startSeq, endSeq);
    state.seq = endSeq;
    state.commits++;
    return {
      signature: `sig-${state.commits}`,
      epochRoot: tree.root,
      startSeq,
      endSeq,
      head: state.head,
      tree,
      blob,
      inputs: steps,
    };
  };
  return { state, committer };
}

describe("epoch chain vector", () => {
  it("matches the Rust epoch-head vector byte-for-byte", () => {
    const head = computeEpochHead(
      new Uint8Array(32),
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      0n,
      1000n
    );
    assert.equal(hex(head), "3ac60f0c6856784e6168ab9725fabf285d37f3323629b99622e79052ca5acf53");
  });
});

/**
 * The leaf tag `lattice.epoch.leaf` is one of the frozen `lattice` literals (docs/ARCHITECTURE.md
 * §13): it is hashed into every epoch leaf, so every
 * epoch root already on devnet was built with it. The cases above compare TS with TS, which a
 * rename sweep would rewrite on both sides and leave green; a spelled-out literal in this file
 * would be rewritten with them. A hex digest would not. Each was derived outside the SDK from
 * the literal bytes — paste, never
 * recompute from the SDK at test time.
 */
describe("the epoch leaf tag is frozen", () => {
  const fixed: EventInput = {
    timestamp: 1_700_000_000_000n,
    kind: EventKind.Action,
    status: 200,
    reference: new Uint8Array(32).fill(3),
    payloadHash: new Uint8Array(32).fill(4),
  };

  it("computeEpochLeaf reproduces the pinned vector", () => {
    assert.equal(hex(computeEpochLeaf(5n, fixed)), "013e3cd201639af1634013f0f6c130450d2cb08b9f174ce928f963abe9e311e6");
  });

  it("epochRootOf over three fixed inputs reproduces the pinned vector", () => {
    const three = [fixed, { ...fixed, status: 201 }, { ...fixed, kind: EventKind.Resolution, status: 1 }];
    assert.equal(hex(epochRootOf(0n, three)), "aa0aa749217b8d715a4f6aec00725e00339eca6167e930154c4f627420866c67");
  });
});

describe("epoch leaves, trees and proofs", () => {
  it("a leaf commits to every EventInput field and the seq", () => {
    const [e] = inputs(1);
    const base = computeEpochLeaf(5n, e);
    assert.notEqual(hex(base), hex(computeEpochLeaf(6n, e)));
    assert.notEqual(hex(base), hex(computeEpochLeaf(5n, { ...e, timestamp: e.timestamp + 1n })));
    assert.notEqual(hex(base), hex(computeEpochLeaf(5n, { ...e, status: e.status + 1 })));
    assert.notEqual(hex(base), hex(computeEpochLeaf(5n, { ...e, kind: EventKind.Genesis })));
    assert.notEqual(hex(base), hex(computeEpochLeaf(5n, { ...e, reference: sha256(e.reference) })));
    assert.notEqual(hex(base), hex(computeEpochLeaf(5n, { ...e, payloadHash: sha256(e.payloadHash) })));
  });

  it("handles empty and single-leaf trees", () => {
    assert.deepEqual(createEpochMerkleTree([]).root, ZERO32);
    const [e] = inputs(1);
    const single = createEpochMerkleTree(epochLeaves(0n, [e]));
    assert.equal(single.depth, 0);
    assert.equal(hex(single.root), hex(computeEpochLeaf(0n, e)));
  });

  it("proves inclusion for 1,000 steps and rejects tampering", () => {
    const steps = inputs(1000);
    const tree = createEpochMerkleTree(epochLeaves(17n, steps));
    assert.equal(tree.leafCount, 1000);
    for (const idx of [0, 1, 499, 500, 998, 999]) {
      const p = generateEpochProof(tree, idx);
      assert.isTrue(verifyEpochProof(p.root, p.leaf, p.proof, idx), `index ${idx}`);
      const bad = new Uint8Array(p.leaf);
      bad[0] ^= 0xff;
      assert.isFalse(verifyEpochProof(p.root, bad, p.proof, idx));
      assert.isFalse(verifyEpochProof(p.root, p.leaf, p.proof, (idx + 1) % 1000));
    }
    assert.throws(() => generateEpochProof(tree, 1000), /out of bounds/);
  });
});

describe("epoch blob", () => {
  it("round-trips and rebuilds the root the chain folded", () => {
    const steps = inputs(100);
    const blob = encodeEpochBlob(42n, steps);
    assert.equal(blob.length, 16 + 100 * 75);
    const decoded = decodeEpochBlob(blob);
    assert.equal(decoded.startSeq, 42n);
    assert.equal(decoded.inputs.length, 100);
    decoded.inputs.forEach((d, i) => {
      assert.equal(d.timestamp, steps[i].timestamp);
      assert.equal(d.kind, steps[i].kind);
      assert.equal(d.status, steps[i].status);
      assert.equal(hex(d.reference), hex(steps[i].reference));
      assert.equal(hex(d.payloadHash), hex(steps[i].payloadHash));
    });
    const root = epochRootOf(42n, steps);
    assert.isNotNull(verifyEpochBlob(blob, root, 42n, 142n));
  });

  it("rejects the wrong bounds, a flipped byte and a truncated blob", () => {
    const steps = inputs(10);
    const blob = encodeEpochBlob(0n, steps);
    const root = epochRootOf(0n, steps);
    assert.isNull(verifyEpochBlob(blob, root, 1n, 11n), "wrong start");
    assert.isNull(verifyEpochBlob(blob, root, 0n, 9n), "wrong end");
    const flipped = new Uint8Array(blob);
    flipped[16 + 5 * 75 + 50] ^= 1; // one byte of one payload hash
    assert.isNull(verifyEpochBlob(flipped, root, 0n, 10n), "flipped byte");
    assert.isNull(verifyEpochBlob(blob.subarray(0, blob.length - 1), root, 0n, 10n), "truncated");
    assert.throws(() => decodeEpochBlob(new Uint8Array([1, 2, 3])), /too short/);
    assert.throws(() => decodeEpochBlob(new Uint8Array(20)), /magic/);
  });
});

describe("RollupBatcher", () => {
  const agentId = idFromString("agent-rollup-batcher");

  it("commits on the count trigger with the seqs the committer assigned", async () => {
    const store = new MemoryEpochStore();
    const { state, committer } = fakeCommitter(agentId, store);
    const batcher = new RollupBatcher({ batchSize: 5, maxFlushDelayMs: 0 }, committer);
    for (let i = 0; i < 4; i++) assert.isNull(await batcher.push(action(i), 1_700_000_000_000 + i));
    assert.equal(batcher.pendingCount, 4);
    const commit = await batcher.push(action(4), 1_700_000_000_004);
    assert.isNotNull(commit);
    assert.equal(commit!.startSeq, 0n);
    assert.equal(commit!.endSeq, 5n);
    assert.equal(state.seq, 5n);
    assert.equal(batcher.pendingCount, 0);

    // The blob in the store is the one the root commits to.
    const blob = await store.get(commit!.epochRoot);
    assert.isNotNull(verifyEpochBlob(blob!, commit!.epochRoot, 0n, 5n));

    // A second epoch starts where the first ended, and proofs find the right one.
    for (let i = 5; i < 10; i++) await batcher.push(action(i), 1_700_000_000_000 + i);
    assert.equal(batcher.epochs.length, 2);
    assert.equal(batcher.epochs[1].startSeq, 5n);
    const p = batcher.proofForSeq(7n);
    assert.equal(p.index, 2);
    assert.isTrue(verifyEpochProof(batcher.epochs[1].epochRoot, p.leaf, p.proof, 2));
    assert.throws(() => batcher.proofForSeq(10n), /not in any committed epoch/);
    batcher.dispose();
  });

  it("commits on the timer", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    const batcher = new RollupBatcher({ batchSize: 100, maxFlushDelayMs: 30 }, committer);
    await batcher.push(action(0));
    assert.equal(batcher.epochs.length, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(batcher.epochs.length, 1);
    assert.equal(batcher.pendingCount, 0);
    batcher.dispose();
  });

  it("never interleaves two flushes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const store = new MemoryEpochStore();
    const { committer } = fakeCommitter(agentId, store);
    const slow = async (steps: EventInput[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      const c = await committer(steps);
      inFlight--;
      return c;
    };
    const batcher = new RollupBatcher({ batchSize: 2, maxFlushDelayMs: 0 }, slow);
    await Promise.all([
      batcher.push(action(0)),
      batcher.push(action(1)),
      batcher.push(action(2)),
      batcher.push(action(3)),
    ]);
    await batcher.flush();
    assert.equal(maxInFlight, 1);
    assert.equal(batcher.epochs.length, 2);
    assert.equal(batcher.epochs[1].startSeq, 2n);
  });

  it("returns from a flush only once no epoch is in flight, when two waited on the same one", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    const gates: (() => void)[] = [];
    let committing = 0;
    const gated = async (steps: EventInput[]) => {
      committing++;
      await new Promise<void>((r) => gates.push(r));
      const c = await committer(steps);
      committing--;
      return c;
    };
    const batcher = new RollupBatcher({ batchSize: 100, maxFlushDelayMs: 0 }, gated);
    await batcher.push(action(0));
    const first = batcher.flush(); // epoch X in flight
    await Promise.resolve();
    await batcher.push(action(1));
    // Two flushes wait on X; the first to wake takes step 1 and starts epoch Y.
    let bReturned = false;
    const a = batcher.flush();
    const b = batcher.flush().then((r) => ((bReturned = true), r));
    gates.shift()!();
    await first;
    while (gates.length === 0) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
    assert.isFalse(bReturned, "b waits for Y rather than finding the buffer empty and returning");
    assert.equal(committing, 1);
    gates.shift()!();
    await Promise.all([a, b]);
    assert.equal(committing, 0, "nothing is committing when either returns");
    assert.equal(batcher.epochs.length, 2);
    batcher.dispose();
  });

  it("commits the steps a failed in-flight epoch put back, for a flush that waited on it", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    let fail = true;
    let release!: () => void;
    const flaky = async (steps: EventInput[]) => {
      if (fail) {
        fail = false;
        await new Promise<void>((r) => (release = r));
        throw new Error("503 Service Unavailable");
      }
      return committer(steps);
    };
    const batcher = new RollupBatcher({ batchSize: 100, maxFlushDelayMs: 0 }, flaky);
    await batcher.push(action(0));
    const first = batcher.flush();
    const second = batcher.flush();
    await Promise.resolve();
    release();
    await first.then(
      () => assert.fail("the failed epoch's own flush reports it"),
      (e) => assert.match(String(e), /503/)
    );
    const commit = await second;
    assert.isNotNull(commit, "the waiter commits the step the failure put back");
    assert.equal(batcher.pendingCount, 0);
    batcher.dispose();
  });
});

describe("RollupBatcher with chain signals", () => {
  const agentId = idFromString("agent-rollup-signals");

  it("flushes a half-full epoch when the fee market is low, and waits when it is not", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    let fee = 5_000;
    let samples = 0;
    const batcher = new RollupBatcher(
      {
        batchSize: 10,
        maxFlushDelayMs: 0,
        signals: { priorityFee: async () => (samples++, fee), lowFeeMicroLamports: 100, sampleIntervalMs: 0 },
      },
      committer
    );
    // Below half full the fee is not even asked for.
    for (let i = 0; i < 4; i++) assert.isNull(await batcher.push(action(i)));
    assert.equal(samples, 0);
    // Half full, fee high: still waiting.
    assert.isNull(await batcher.push(action(4)));
    assert.equal(samples, 1);
    assert.equal(batcher.pendingCount, 5);
    // Fee drops: the next step commits what is queued.
    fee = 50;
    const commit = await batcher.push(action(5));
    assert.isNotNull(commit);
    assert.equal(commit!.trigger, "fee");
    assert.equal(commit!.inputs.length, 6);
    assert.equal(batcher.signalsSeen.priorityFee, 50);
    // A full batch still commits on count regardless of fees.
    fee = 5_000;
    for (let i = 0; i < 9; i++) await batcher.push(action(i));
    const full = await batcher.push(action(9));
    assert.equal(full!.trigger, "count");
    batcher.dispose();
  });

  it("refuses to open an epoch the payer cannot fund, but still flushes one already open", async () => {
    const { committer, state } = fakeCommitter(agentId, new MemoryEpochStore());
    let balance = 1_000_000;
    const batcher = new RollupBatcher(
      {
        batchSize: 10,
        maxFlushDelayMs: 0,
        signals: { payerBalance: async () => balance, minPayerLamports: 40_000, sampleIntervalMs: 0 },
      },
      committer
    );
    await batcher.push(action(0));
    await batcher.push(action(1));
    // The balance is only consulted when a new epoch opens, so a drop mid-epoch does not lose steps.
    balance = 10_000;
    await batcher.push(action(2));
    const commit = await batcher.flush();
    assert.equal(commit!.inputs.length, 3);
    assert.equal(state.seq, 3n);
    // Now a new epoch would open, and the payer cannot pay for it.
    let refused: unknown;
    try {
      await batcher.push(action(3));
    } catch (e) {
      refused = e;
    }
    assert.instanceOf(refused, InsufficientPayerBalance);
    assert.equal((refused as InsufficientPayerBalance).required, 40_000);
    assert.equal(batcher.pendingCount, 0, "the refused step was not queued");
    balance = 1_000_000;
    assert.isNull(await batcher.push(action(3)));
    assert.equal(batcher.pendingCount, 1);
    batcher.dispose();
  });

  /**
   * What `/api/run` wraps `chainSignals()` with so the console can print a refusal as numbers:
   * the balance read records `{balance, required, payer}` on its way past. The batcher still
   * throws; the wrapper only makes the two numbers it threw on reportable.
   */
  it("reports the balance and the floor a refused epoch was measured against", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    const refusals: { code: string; balance: number; required: number; payer: string }[] = [];
    const required = DEFAULT_MIN_PAYER_LAMPORTS;
    let balance = 10_000;
    const batcher = new RollupBatcher(
      {
        batchSize: 10,
        maxFlushDelayMs: 0,
        signals: {
          minPayerLamports: required,
          sampleIntervalMs: 0,
          payerBalance: async () => {
            if (balance < required) {
              refusals.push({ code: "InsufficientPayerBalance", balance, required, payer: dummyPk.toBase58() });
            }
            return balance;
          },
        },
      },
      committer
    );

    let refused: unknown;
    try {
      await batcher.push(action(0));
    } catch (e) {
      refused = e;
    }
    assert.instanceOf(refused, InsufficientPayerBalance);
    assert.equal((refused as InsufficientPayerBalance).balance, 10_000);
    assert.equal((refused as InsufficientPayerBalance).required, 40_000, "commit_epoch + locator cell + one record");
    assert.deepEqual(refusals, [
      { code: "InsufficientPayerBalance", balance: 10_000, required: 40_000, payer: dummyPk.toBase58() },
    ]);

    // Funded above the floor: the epoch opens and nothing is reported.
    balance = required * 2;
    assert.isNull(await batcher.push(action(0)));
    assert.equal(refusals.length, 1);
    batcher.dispose();
  });

  it("samples signals at the configured interval, not on every push", async () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    let samples = 0;
    const batcher = new RollupBatcher(
      {
        batchSize: 100,
        maxFlushDelayMs: 0,
        signals: { priorityFee: async () => (samples++, 1_000), earlyFlushFraction: 0.01, sampleIntervalMs: 60_000 },
      },
      committer
    );
    for (let i = 0; i < 20; i++) await batcher.push(action(i));
    assert.equal(samples, 1);
    batcher.dispose();
  });
});

describe("DynamicStorageEngine", () => {
  const agentId = idFromString("agent-engine");
  const genesis: EventPayload = {
    kind: EventKind.Genesis,
    callerPubkey: dummyPk,
    sessionId: "s1",
    policyVersionHash: ZERO32,
    inputPayloadHash: ZERO32,
  };
  const delegation: EventPayload = {
    kind: EventKind.Delegation,
    parentTaskId: "t1",
    fromAgentPubkey: dummyPk,
    toAgentPubkey: dummyPk,
    scopeHash: ZERO32,
  };
  const resolution: EventPayload = {
    kind: EventKind.Resolution,
    taskId: "t1",
    status: ResolutionStatus.Success,
    finalOutputHash: ZERO32,
    totalStepCount: 5,
  };

  it("classifies by kind, or by mode", () => {
    const { committer } = fakeCommitter(agentId, new MemoryEpochStore());
    const dynamic = new DynamicStorageEngine(undefined, async () => "crit", committer);
    assert.equal(dynamic.classify(EventKind.Genesis), EventTier.Critical);
    assert.equal(dynamic.classify(EventKind.Delegation), EventTier.Critical);
    assert.equal(dynamic.classify(EventKind.Resolution), EventTier.Critical);
    assert.equal(dynamic.classify(EventKind.Action), EventTier.Standard);
    const batch = new DynamicStorageEngine(
      { mode: "batch", standardBatchSize: 10, standardFlushDelayMs: 0, rateSampleWindowMs: 5000 },
      async () => "crit",
      committer
    );
    assert.equal(batch.classify(EventKind.Genesis), EventTier.Standard);
  });

  it("flushes the epoch before every critical write, so the seqs stay dense and ordered", async () => {
    const store = new MemoryEpochStore();
    const { state, committer } = fakeCommitter(agentId, store);
    const order: string[] = [];
    const engine = new DynamicStorageEngine(
      { mode: "dynamic", standardBatchSize: 10, standardFlushDelayMs: 0, rateSampleWindowMs: 5000 },
      async (input) => {
        order.push(`critical:${input.kind}@${state.seq}`);
        state.seq++; // a real record takes one seq
        return "sig";
      },
      async (steps) => {
        order.push(`epoch:${steps.length}@${state.seq}`);
        return committer(steps);
      }
    );
    await engine.push(genesis);
    for (let i = 0; i < 3; i++) await engine.push(action(i));
    await engine.push(delegation);
    for (let i = 0; i < 2; i++) await engine.push(action(i));
    await engine.push(resolution);
    assert.deepEqual(order, ["critical:0@0", "epoch:3@1", "critical:2@4", "epoch:2@5", "critical:3@7"]);
    const m = engine.getMetrics();
    assert.equal(m.totalPushed, 8);
    assert.equal(m.criticalPushed, 3);
    assert.equal(m.standardPushed, 5);
    assert.equal(m.epochsCommitted, 2);
    assert.equal(m.standardPending, 0);
    engine.dispose();
  });
});
