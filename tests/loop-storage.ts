import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { EVENT_RECORD_LEN, LAMPORTS_PER_RECORD } from "@lath/sdk";
import { LoopRecord, publicLoop, recordLoop, stepStorageOf } from "../frontend/src/app/api/_lib/loops";
import {
  RENT_ACCOUNT_OVERHEAD_BYTES,
  RENT_LAMPORTS_PER_BYTE,
  rentExemptLamports,
  storageCardOf,
  type LoopStepSummary,
} from "../frontend/src/types/loop";

/**
 * The storage card: what a step's row records about what
 * its keeping cost, and what the loop page decides to show from it. Node-only: the readings are
 * handed in, the way `runOneStep` hands in its two balance reads, and nothing reaches a cluster.
 */

const SDK = { lamportsPerRecord: LAMPORTS_PER_RECORD, recordBytes: EVENT_RECORD_LEN };
const IRYS_BUNDLE = { scheme: 4, id: "ab".repeat(32), count: 9, bytes: 11_000 };
const FS_BUNDLE = { scheme: 1, id: "cd".repeat(32), count: 9, bytes: 11_000 };

function row(step: number, over: Partial<LoopStepSummary> = {}): LoopStepSummary {
  return {
    step,
    status: "success",
    steps: 3,
    batchedSteps: 5,
    costMicroUsdc: "1650",
    seq: String(10 + step),
    leafOk: true,
    epochs: [],
    genesisPayloadHash: "ef".repeat(32),
    startedAt: 1,
    endedAt: 2,
    ...over,
  };
}

describe("loop storage: what a step's row records", () => {
  it("tags the fee payer's balance delta `console`, with the bundle's bytes and the Irys charge", () => {
    const storage = stepStorageOf({
      source: "console",
      before: { payer: 5_000_000, irys: 90_000n },
      after: { payer: 4_930_000, irys: 84_000n },
      bundle: IRYS_BUNDLE,
    });
    assert.deepEqual(storage, { lamports: 70_000, source: "console", bundleBytes: 11_000, irysLamports: 6_000 });
  });

  it("sums the payer's per-transaction deltas and tags them `chain`", () => {
    const storage = stepStorageOf({
      source: "chain",
      payerDeltas: [15_007, 10_000, 15_010, 15_007, 15_007],
      bundle: IRYS_BUNDLE,
    });
    assert.deepEqual(storage, { lamports: 70_031, source: "chain", bundleBytes: 11_000 });
  });

  it("writes no Irys key on a console that does not anchor there", () => {
    const storage = stepStorageOf({
      source: "console",
      before: { payer: 1_000_000 },
      after: { payer: 950_000 },
      bundle: FS_BUNDLE,
    });
    assert.deepEqual(storage, { lamports: 50_000, source: "console", bundleBytes: 11_000 });
    assert.notProperty(storage!, "irysLamports");
  });

  it("records no storage when the payer's balance rose or could not be read: no figure is the step's", () => {
    const bundle = IRYS_BUNDLE;
    assert.isUndefined(
      stepStorageOf({ source: "console", before: { payer: 1_000_000 }, after: { payer: 1_200_000 }, bundle }),
      "a top-up inside the window"
    );
    assert.isUndefined(stepStorageOf({ source: "console", before: { payer: null }, after: { payer: 900 }, bundle }));
    assert.isUndefined(stepStorageOf({ source: "console", before: { payer: 900 }, after: { payer: null }, bundle }));
    assert.isUndefined(stepStorageOf({ source: "chain", payerDeltas: [], bundle }), "no transaction read");
    assert.isUndefined(stepStorageOf({ source: "chain", payerDeltas: [5_000, -1], bundle }));
  });

  it("drops only the Irys figure when the uploader was funded mid-step or its read failed", () => {
    const funded = stepStorageOf({
      source: "console",
      before: { payer: 100_000, irys: 1_000n },
      after: { payer: 30_000, irys: 5_000_000n },
      bundle: IRYS_BUNDLE,
    });
    assert.deepEqual(funded, { lamports: 70_000, source: "console", bundleBytes: 11_000 });
    const unread = stepStorageOf({
      source: "console",
      before: { payer: 100_000, irys: null },
      after: { payer: 30_000, irys: 4_000n },
      bundle: IRYS_BUNDLE,
    });
    assert.notProperty(unread!, "irysLamports");
  });

  it("counts a bundle that did not seal as zero bytes", () => {
    const storage = stepStorageOf({
      source: "console",
      before: { payer: 100_000 },
      after: { payer: 55_000 },
      bundle: { error: "this step logged no genesis, so its bundle has no key" },
    });
    assert.equal(storage!.bundleBytes, 0);
  });

  describe("on the open list", () => {
    beforeEach(() => fs.rmSync(path.join(traceDir, "loops.json"), { force: true }));

    it("keeps `storage` on the row `GET /api/loops` serves, owner or not", () => {
      const storage = stepStorageOf({
        source: "console",
        before: { payer: 5_000_000, irys: 90_000n },
        after: { payer: 4_930_000, irys: 84_000n },
        bundle: IRYS_BUNDLE,
      })!;
      const loop: LoopRecord = {
        id: "loop-storage",
        agentId: "11".repeat(32),
        agentName: "watcher",
        owner: "0wNeR11111111111111111111111111111111111111",
        prompt: "watch",
        promptHash: "cd".repeat(32),
        intervalMs: 60_000,
        maxSteps: 3,
        budgetMicroUsdcPerStep: "10000",
        model: "deepseek/deepseek-v4.1-flash",
        createdAt: Date.now(),
        status: "running",
        snapshot: { loopId: "loop-storage", steps: 1, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
        history: [row(1, { bundle: IRYS_BUNDLE, storage }), row(2)],
      };
      recordLoop(loop);
      const view = publicLoop(loop);
      assert.deepEqual(view.history[0].storage, storage);
      assert.equal(view.history[0].storage!.source, "console");
      assert.notProperty(view.history[1], "storage", "a row without a reading gains none on the way out");
    });
  });
});

describe("loop storage: the card the loop page renders", () => {
  it("renders no card for a row from before the measurement", () => {
    assert.isNull(storageCardOf(row(1), SDK));
    assert.isNull(storageCardOf(row(1, { bundle: IRYS_BUNDLE }), SDK), "a bundle alone is not a measurement");
  });

  it("renders no card for a `storage` that is not the shape this build writes", () => {
    const bad = [
      { lamports: -1, source: "console", bundleBytes: 0 },
      { lamports: 1.5, source: "console", bundleBytes: 0 },
      { lamports: 70_000, source: "guess", bundleBytes: 0 },
      { lamports: 70_000, source: "console" },
      { lamports: 70_000, source: "console", bundleBytes: 0, irysLamports: "6000" },
    ];
    for (const storage of bad) assert.isNull(storageCardOf(row(1, { storage: storage as any }), SDK));
  });

  it("carries the measured figures with their tag and derives the naive comparison", () => {
    const storage = { lamports: 70_000, source: "console" as const, bundleBytes: 11_000, irysLamports: 6_000 };
    const card = storageCardOf(row(1, { bundle: IRYS_BUNDLE, storage }), SDK)!;
    assert.deepEqual(card.measured, { ...storage, bundleOn: "irys" });

    // Five batched calls, one Genesis and one Resolution, and the `loop.step` checkpoint.
    const perRecord = (RENT_ACCOUNT_OVERHEAD_BYTES + EVENT_RECORD_LEN) * RENT_LAMPORTS_PER_BYTE;
    assert.equal(perRecord, 1_914_000, "a 147-byte account at the rent-exempt minimum");
    assert.equal(card.derived.records, 8);
    assert.equal(card.derived.perRecord, perRecord);
    assert.equal(card.derived.compressedPerRecord, LAMPORTS_PER_RECORD);
    assert.equal(card.derived.bundleLamports, rentExemptLamports(11_000));
    assert.equal(card.derived.lamports, 8 * perRecord + (128 + 11_000) * 6_960);
  });

  it("counts a synthesis as a second session, and says where the bundle went", () => {
    const storage = { lamports: 100_000, source: "chain" as const, bundleBytes: 11_000 };
    const synth = storageCardOf(
      row(2, { bundle: FS_BUNDLE, storage, synthesis: { sessionId: "s-b", costMicroUsdc: "0" } }),
      SDK
    )!;
    assert.equal(synth.derived.records, 5 + 4 + 1);
    assert.equal(synth.measured.source, "chain");
    assert.equal(synth.measured.bundleOn, "store");

    const unsealed = storageCardOf(
      row(3, { bundle: { error: "not sealed" }, storage: { ...storage, bundleBytes: 0 } }),
      SDK
    )!;
    assert.equal(unsealed.measured.bundleOn, "none");
    assert.equal(unsealed.derived.bundleLamports, 0);
  });
});
