import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  LoopRefused,
  afterStepFailure,
  loopSettling,
  publishStepPostures,
  readLoop,
  readLoops,
  recordLoop,
  settleLoopChannel,
  startLoop,
  sweepLoopKeys,
  syncScheduler,
  updateLoop,
  type LoopRecord,
} from "../frontend/src/app/api/_lib/loops";

/**
 * `loops.json` read the `json-store.ts` way: only a missing file is an empty registry, and a lookup
 * by a caller's id is an own-property lookup. Node only, no cluster.
 */
const REGISTRY = path.join(traceDir, "loops.json");

function row(id: string): LoopRecord {
  return {
    id,
    agentId: "ab".repeat(32),
    agentName: "watcher",
    owner: "11111111111111111111111111111111",
    prompt: "watch the chain and say what moved",
    promptHash: "cd".repeat(32),
    intervalMs: 60_000,
    maxSteps: 3,
    budgetMicroUsdcPerStep: "1000",
    model: "deepseek/deepseek-v4.1-flash",
    createdAt: Date.now(),
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
  } as LoopRecord;
}

describe("loop registry: reads that fail are not an empty registry", () => {
  beforeEach(() => fs.rmSync(REGISTRY, { force: true }));

  it("reads a missing file as empty, and records into it", () => {
    assert.deepEqual(readLoops(), {});
    recordLoop(row("loop-0000000000000001"));
    assert.equal(readLoop("loop-0000000000000001")?.id, "loop-0000000000000001");
  });

  it("refuses to record over a file that is not JSON, and leaves it as it was", () => {
    recordLoop(row("loop-0000000000000001"));
    fs.writeFileSync(REGISTRY, '{"loop-0000000000000001": {');
    assert.throws(() => recordLoop(row("loop-0000000000000002")), /is not JSON/);
    assert.equal(fs.readFileSync(REGISTRY, "utf8"), '{"loop-0000000000000001": {');
  });

  it("throws from updateLoop on an unreadable file rather than answering null", () => {
    fs.writeFileSync(REGISTRY, "[]");
    assert.throws(() => updateLoop("loop-0000000000000001", (l) => l), /not a map of loop records/);
  });

  it("answers null for ids that name Object.prototype's own properties", () => {
    recordLoop(row("loop-0000000000000001"));
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.isNull(readLoop(id), id);
      assert.isNull(
        updateLoop(id, (l) => l),
        id
      );
    }
  });

  it("drops a __proto__ row in the file rather than letting it set the registry's prototype", () => {
    // Spelled as text: an object literal's `__proto__` sets a prototype, and `JSON.stringify` drops it.
    const text = `{"__proto__": ${JSON.stringify(row("__proto__"))}, "loop-0000000000000001": ${JSON.stringify(
      row("x")
    )}}`;
    fs.writeFileSync(REGISTRY, text);
    const all = readLoops();
    assert.deepEqual(Object.keys(all), ["loop-0000000000000001"]);
    assert.equal(Object.getPrototypeOf(all), Object.prototype);
  });

  it("keeps a row it cannot read on disk, verbatim, across a record and an update", () => {
    // An older row, with older field names, that still holds a live fee key: dropped from
    // the answer, but the next write must not erase it, or its SOL is stranded for good.
    const old = {
      id: "loop-00000000000000aa",
      agentId: "ab".repeat(32),
      maxWakes: 3,
      budgetMicroUsdcPerWake: "1000",
      solanaKey: { address: "So11111111111111111111111111111111111111112" },
    };
    fs.writeFileSync(
      REGISTRY,
      JSON.stringify({ [old.id]: old, "loop-0000000000000001": row("loop-0000000000000001") })
    );
    assert.deepEqual(Object.keys(readLoops()), ["loop-0000000000000001"]);
    recordLoop(row("loop-0000000000000002"));
    updateLoop("loop-0000000000000001", (l) => ({ ...l, status: "paused" }));
    const disk = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    assert.deepEqual(disk[old.id], old);
    assert.equal(disk["loop-0000000000000001"].status, "paused");
    assert.equal(disk["loop-0000000000000002"].id, "loop-0000000000000002");
    assert.notProperty(readLoops(), old.id);
  });

  it("does not carry a __proto__ row it skipped back onto the disk", () => {
    fs.writeFileSync(REGISTRY, `{"__proto__": {"id": "x"}, "loop-0000000000000001": ${JSON.stringify(row("y"))}}`);
    recordLoop(row("loop-0000000000000002"));
    const disk = fs.readFileSync(REGISTRY, "utf8");
    assert.notInclude(disk, "__proto__");
  });
});

/**
 * What a `loops.json` that cannot be read costs the functions documented never to throw: the
 * operation, logged, and nothing that escapes into a stop, a timer or a `void` call.
 */
describe("loop registry: an unreadable file does not escape the never-throwing paths", () => {
  const ID = "loop-00000000000000aa";
  beforeEach(() => fs.writeFileSync(REGISTRY, "{ not json"));
  after(() => fs.rmSync(REGISTRY, { force: true }));

  it("settles without throwing, synchronously or in its promise", async () => {
    let settled: unknown = "unset";
    assert.doesNotThrow(() => {
      settled = settleLoopChannel(ID, "stopped", { settle: async () => assert.fail("nothing to settle") });
    });
    assert.isUndefined(await (settled as Promise<unknown>));
  });

  it("queues the settle of a refused step whose stop could not be written", async () => {
    assert.doesNotThrow(() => afterStepFailure(ID, new LoopRefused("refused"), {}));
    assert.isTrue(loopSettling(ID), "the settle is queued although the stop write threw");
    for (let i = 0; i < 100 && loopSettling(ID); i++) await new Promise((r) => setTimeout(r, 10));
    assert.isFalse(loopSettling(ID), "and it ends rather than rejecting");
  });

  it("answers a failed step's detail write without throwing", () => {
    assert.doesNotThrow(() => afterStepFailure(ID, new Error("a moment failing"), {}));
  });

  it("runs the key pass, the scheduler and the posture publish to an end", async () => {
    await sweepLoopKeys({ orphans: true });
    assert.doesNotThrow(() => syncScheduler());
    await publishStepPostures(ID, { step: 1 } as Parameters<typeof publishStepPostures>[1]);
  });

  it("refuses a start it cannot record and leaves the file as it was", () => {
    assert.throws(() => startLoop(row(ID)), /is not JSON/);
    assert.equal(fs.readFileSync(REGISTRY, "utf8"), "{ not json");
  });
});
