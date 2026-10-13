import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  LoopRecord,
  isStepping,
  publicLoop,
  readLoop,
  recordLoop,
  retryLoopAnchor,
  schedule,
  stopLoop,
} from "../frontend/src/app/api/_lib/loops";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";
import { removedFeatureStop } from "../frontend/src/app/api/_lib/roadmap";
import type { GateConfig } from "../sdk/src";
import type { LoopStepSummary, LoopStepWakeView } from "../frontend/src/types/loop";
import { earlierBuildSentence } from "../frontend/src/types/loop";

/**
 * What the console does with a gated run, or a run on an oracle trigger, whose write side is not in
 * this build (both are on the roadmap). A start that asks for one is refused
 * (`tests/console-removed-features.ts`); this suite covers stored rows that carry one:
 *
 * - a running one is stopped at its next tick, before anything is funded, asked or spent;
 * - a stopped one still lists and opens, its page naming the gate in one line, and each step's row
 *   still carries its wake, whose `gateHash` the browser's leaf check reads;
 * - a Retry of the checkpoint plan it owed, which commits the gate's log, is refused before anything
 *   is drained, and the plan stays on the row.
 *
 * Node-only: nothing here reaches a cluster, a channel or a treasury. `./fixtures/trace-dir` is
 * imported first because `runner.ts` captures `TRACE_DIR` at module evaluation.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "ab".repeat(32);
const PROMPT = "watch the task key and do what it says";

/** The terms a gated run committed, as its row stores them. */
const gate: GateConfig = {
  model: "typesafe/jev-1.13",
  barBps: 5_700,
  watch: [{ kind: "store", keys: ["task.next", "note"] }],
  failMode: "closed",
  heartbeatMs: 24 * 60 * 60_000,
};

function clearStore(): void {
  for (const f of ["loops.json", "templates.json", "agents.json", "market.json"]) {
    fs.rmSync(path.join(traceDir, f), { force: true });
  }
}

function deploy(): void {
  recordAgent(AGENT, {
    name: "watcher",
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: Date.now(),
    policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
  });
}

/** A stored gated loop row, with `over` laid on it: running and gated unless `over` says. */
function row(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const loop: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "watcher",
    owner: OWNER,
    prompt: PROMPT,
    promptHash: "00".repeat(32),
    intervalMs: 60_000,
    maxSteps: 5,
    budgetMicroUsdcPerStep: "50000",
    model: "deepseek/deepseek-v4.1-flash",
    createdAt: 0,
    trigger: { kind: "gate", pollMs: 60_000 },
    gate,
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
  recordLoop(loop);
  return readLoop(id)!;
}

/** Waits for `id`'s row to satisfy `done`, polling the registry, for at most `ms`. */
async function until(id: string, done: (l: LoopRecord) => boolean, ms = 5_000): Promise<LoopRecord> {
  const end = Date.now() + ms;
  for (;;) {
    const l = readLoop(id)!;
    if (done(l) || Date.now() > end) return l;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("gated and oracle rows: the scheduler stops them before they step", () => {
  beforeEach(() => {
    clearStore();
    deploy();
  });

  const running: [string, Partial<LoopRecord>, RegExp][] = [
    ["a gate", {}, /runs with a gate, which is not in this build/],
    [
      "a request trigger",
      { trigger: { kind: "request", pollMs: 15_000 }, gate: undefined },
      /runs with an oracle trigger, which is not in this build/,
    ],
    ["a feed trigger", { trigger: { kind: "feed" }, gate: undefined }, /runs with an oracle trigger/],
    // A gate on a row whose trigger says schedule is a gate all the same.
    ["a gate beside the schedule trigger", { trigger: { kind: "schedule" } }, /runs with a gate/],
  ];

  for (const [what, over, said] of running) {
    it(`stops a running row with ${what} at its next tick, with the reason, and takes no step`, async () => {
      const id = `loop-gate-stop-${what.replace(/\W+/g, "-")}`;
      row(id, over);
      schedule(id, 0);
      const after = await until(id, (l) => l.status === "stopped");
      assert.equal(after.status, "stopped");
      assert.equal(after.stopReason, "error");
      assert.match(after.stopDetail!, said);
      assert.match(after.stopDetail!, /so it takes no more steps; its chain still verifies$/);
      assert.equal(after.snapshot.steps, 0, "no step index was spent");
      assert.deepEqual(after.history, []);
      assert.isUndefined(after.steppingSince, "nothing was funded or opened for a step");
      assert.isFalse(isStepping(id));
      assert.isUndefined(after.nextStepAt);
    });
  }

  it("leaves alone a row on the schedule trigger with no gate, and one with no trigger at all", () => {
    // The rule the tick and the step ask (`removedFeatureStop`), read the way every start reads its
    // keys: an absent or `null` gate and an absent or `schedule` trigger ask for nothing.
    for (const terms of [{}, { trigger: { kind: "schedule" } }, { gate: null }, { gate: undefined, trigger: null }]) {
      assert.isNull(removedFeatureStop(terms), JSON.stringify(terms));
    }
    assert.match(removedFeatureStop({ gate })!, /runs with a gate/);
  });
});

describe("gated rows: what the page reads", () => {
  beforeEach(() => {
    clearStore();
    deploy();
  });

  it("names the gate in one line and draws none of it: no strip, no pending log, no hold", () => {
    // The saved log and the strip's events a gated row carries, as `LoopGate.snapshot()` wrote them:
    // nothing in this build reads either, and the row still loads, lists and opens.
    const loop = row("loop-gate-view", {
      gatePending: { v: 1, sinceStep: 0, quiet: { ticks: 4 }, asks: [{}, {}], costBase: "84" },
      gateEvents: [{ type: "gate", t: 1, outcome: "waited", pActBps: 3_000 }],
    } as Partial<LoopRecord>);
    stopLoop(loop.id);
    const after = readLoop(loop.id)!;
    assert.equal(after.status, "stopped");
    const view = publicLoop(after);
    assert.notProperty(view, "gate", "no strip");
    assert.deepEqual(view.earlierBuild, ["gate"]);
    assert.match(earlierBuildSentence(view.earlierBuild)!, /^Written with a gate, which is not in/);
    assert.notMatch(JSON.stringify(view), /gatePending|gateEvents/, "the saved log is not on the wire");
    // A run with no gate says nothing.
    const plain = row("loop-gate-view-plain", { trigger: { kind: "schedule" }, gate: undefined });
    assert.notProperty(publicLoop(plain), "earlierBuild");
  });

  it("LoopStepSummary.wake reaches the browser on the step's row, for the leaf check's gateHash", () => {
    const wake: LoopStepWakeView = {
      reason: "gate",
      gateHash: "ef".repeat(32),
      pActBps: 8300,
      barBps: 5_700,
      width: "small",
      asks: 1,
      quiet: 3,
      costBase: "42",
    };
    const step: LoopStepSummary = {
      step: 1,
      status: "success",
      steps: 1,
      batchedSteps: 0,
      costMicroUsdc: "0",
      leafOk: true,
      epochs: [],
      wake,
      startedAt: 0,
      endedAt: 1,
    };
    const loop = row("loop-gate-row", { status: "stopped", history: [step] });
    assert.deepEqual(publicLoop(loop).history[0].wake, wake);
  });
});

describe("gated rows: a Retry of the checkpoint plan a gated row owes", () => {
  beforeEach(() => {
    clearStore();
    deploy();
  });

  /** A gated run stopped `anchor-failed` on step 1, whose checkpoint plan commits `gateHash`. */
  function owing(id: string, plan: Record<string, unknown> = {}): LoopRecord {
    return row(id, {
      status: "stopped",
      stopReason: "anchor-failed",
      billing: "charged",
      snapshot: { loopId: id, steps: 1, status: "stopped", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [
        {
          step: 1,
          status: "success",
          steps: 1,
          batchedSteps: 0,
          costMicroUsdc: "0",
          leafOk: false,
          epochs: [],
          startedAt: 0,
          endedAt: 1,
          deferredCheckpoint: {
            loopId: id,
            step: 1,
            sessionId: "s",
            intervalMs: 60_000,
            maxSteps: 5,
            promptHash: "00".repeat(32),
            startedAt: 0,
            statusCode: 200,
            gateHash: "ef".repeat(32),
            ...plan,
          },
        },
      ],
    });
  }

  it("refuses the Retry before anything is drained, and leaves the plan and the stop as they were", async () => {
    const id = "loop-gate-late-checkpoint";
    // What an older plan carries beside the log: the asks' and Jev's charges. Nothing reads them.
    owing(id, { gateChargeMicroUsdc: "93", decisionChargeMicroUsdc: "47" });
    const calls: string[] = [];
    const { loop, error } = await retryLoopAnchor(id, {
      queue: {
        retry: async () => void calls.push("retry"),
        drain: async () => void calls.push("drain"),
      },
      resume: () => void calls.push("resume"),
    });
    assert.deepEqual(calls, [], "no drain: its records would land under no leaf");
    assert.match(
      error!,
      /^this run owes a checkpoint this build does not write \(step 1's checkpoint commits a gate's log\)/
    );
    assert.match(error!, /other than the one its step planned$/);
    assert.equal(loop!.status, "stopped");
    assert.equal(loop!.stopReason, "anchor-failed", "still the stop that names what it owes");
    assert.isDefined(readLoop(id)!.history[0].deferredCheckpoint, "the plan stays owed");
  });
});
