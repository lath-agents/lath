import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { cancel, isStepping, syncScheduler } from "../frontend/src/app/api/_lib/loops";

/**
 * A timer is taken off the scheduler as it fires, and `inFlight` is set only once a step holds the
 * run slot. Anything awaited in between leaves a window in which a `/api/loops` request could run
 * `syncScheduler`, find the loop running with no timer, and arm a second tick beside the first. A
 * tick marks the loop `ticking` from the moment its timer fires until it returns.
 *
 * Its own process and trace store: `syncScheduler` arms a timer for every running row it reads, and
 * this registry holds one row, whose next step is a minute out and is cancelled before the end.
 */
const ID = "loop-tick-guard";
const loopRow = {
  id: ID,
  agentId: "aa".repeat(32),
  agentName: "tick-guard",
  owner: "So11111111111111111111111111111111111111112",
  prompt: "watch the fee market",
  promptHash: "cd".repeat(32),
  intervalMs: 60_000,
  maxSteps: 4,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
  createdAt: Date.now(),
  status: "running",
  nextStepAt: Date.now() + 60_000,
  snapshot: { loopId: ID, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
  history: [],
};

describe("the scheduler arms one tick per loop", () => {
  after(() => cancel(ID));

  it("arms no timer for a loop whose tick is still running, and arms one once it has returned", () => {
    fs.writeFileSync(path.join(traceDir, "loops.json"), JSON.stringify({ [ID]: loopRow }));
    isStepping(ID); // brings the scheduler singleton up, as any route call does
    const s = (globalThis as any)[Symbol.for("lath.loopScheduler")];

    s.ticking.add(ID);
    syncScheduler();
    assert.isFalse(s.timers.has(ID), "a tick awaiting its ask or poll owns the loop's next timer");

    s.ticking.delete(ID);
    syncScheduler();
    assert.isTrue(s.timers.has(ID), "with no tick running, the loop is scheduled as before");
  });
});
