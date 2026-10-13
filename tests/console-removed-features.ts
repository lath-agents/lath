import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  LoopRecord,
  TEAM_REFUSAL,
  TRACE_AUDIT_START_REFUSAL,
  checkGrants,
  checkLoopRequest,
  readLoop,
  recordLoop,
  resumeLoop,
  removedPlanRefusal,
  resumeRefusal,
  retryLoopAnchor,
} from "../frontend/src/app/api/_lib/loops";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";
import { checkLoopConfig } from "../frontend/src/app/api/templates/validate";
import { removedPlanKeys, writeLoopCheckpoint } from "../runtime/src";

/**
 * What this build does with the features on the roadmap: teams (`workers`), gated loops (`gate`,
 * `trigger.kind: "gate"`), the request and feed triggers, the trace audit (`traceAudit`) and
 * protocol-plugin `grants`. Their write side is not in this build, so each is refused at every door —
 * a start, a deploy carrying a loop, *Run again*, a template write, a resume and a Retry that would put
 * a run back on its schedule — with a sentence naming it, and no setting turns one back on. Refused
 * rather than dropped: a start's signature binds its terms. A stored row that carries one still reads;
 * what it cannot do is step.
 *
 * A running row that carries one is stopped at its next tick before anything is spent; the suites of
 * each feature pin that (`console-trace-audit`, `console-loops`, `console-gate`, `console-plugins`).
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "ab".repeat(32);
/** The tail every roadmap feature's start and template refusal shares: not here, and old chains verify. */
const REMOVED = /not in this build.*still verif/;
/** What a grant is told at every door, whatever LATH_PROTOCOL_PLUGINS says. */
const NOT_IN_BUILD =
  /protocol-plugin grants.*not in this build.*squads\.pay and sas\.attest are on the roadmap.*still verif/;

const body = {
  agentId: AGENT,
  prompt: "watch the program and write down what changed",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdc: "150000",
  model: "deepseek/deepseek-v4.1-flash",
};

const loopConfig = {
  prompt: body.prompt,
  intervalMs: body.intervalMs,
  maxSteps: body.maxSteps,
  budgetMicroUsdcPerStep: "50000",
  model: body.model,
  coordinator: { agentId: AGENT },
  members: [],
};

const scratchTeam = {
  scratch: { policy: { prompt: "read one source and report it", tools: [] }, count: 2 },
  model: "deepseek/deepseek-v4.1-flash",
  budgetMicroUsdcPerTask: "20000",
};
const gate = { watch: [{ kind: "store", keys: ["task.next"] }] };
const grants = { cluster: "devnet", expiresAt: 4_000_000_000, items: [] };

function errorOf(r: unknown): string | undefined {
  return (r as { error?: string } | null)?.error;
}

/** Runs `fn` with LATH_PROTOCOL_PLUGINS at `value`, and puts back whatever the process had. */
function withPlugins<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.LATH_PROTOCOL_PLUGINS;
  if (value === undefined) delete process.env.LATH_PROTOCOL_PLUGINS;
  else process.env.LATH_PROTOCOL_PLUGINS = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.LATH_PROTOCOL_PLUGINS;
    else process.env.LATH_PROTOCOL_PLUGINS = saved;
  }
}

describe("roadmap features: a start is refused, with a sentence a client can act on", () => {
  it("starts the submission's loop, and takes every key's off value", () => {
    assert.notProperty(checkLoopRequest(body), "error");
    for (const extra of [
      { workers: null },
      { workers: false },
      { traceAudit: false },
      { traceAudit: null },
      // `null` is a gate's off value, as it is a team's: no gate, so the clock steps it.
      { gate: null },
      { gate: null, trigger: { kind: "schedule" } },
      { trigger: { kind: "schedule" } },
      { trigger: null },
    ]) {
      assert.notProperty(checkLoopRequest({ ...body, ...extra }), "error", JSON.stringify(extra));
    }
  });

  it("refuses a team, naming workers", () => {
    const error = errorOf(checkLoopRequest({ ...body, workers: scratchTeam }));
    assert.equal(error, TEAM_REFUSAL);
    assert.match(error!, /^teams \(multi-agent loops\) are on the roadmap and not in this build.*leave out workers/);
    assert.match(error!, REMOVED);
  });

  it("refuses the gate trigger, a gate sent without one, and a gate beside another trigger", () => {
    // A gate beside another trigger is a gate all the same: refused, never dropped.
    for (const extra of [
      { trigger: { kind: "gate" }, gate },
      { gate },
      { trigger: { kind: "gate" } },
      { trigger: { kind: "schedule" }, gate },
    ]) {
      const error = errorOf(checkLoopRequest({ ...body, ...extra }));
      assert.match(error!, REMOVED, JSON.stringify(extra));
      assert.match(error!, /^gated loops are not in this build: leave out gate/);
    }
  });

  it("refuses the request and feed triggers", () => {
    for (const trigger of [{ kind: "request" }, { kind: "request", pollMs: 30_000 }, { kind: "feed" }]) {
      const error = errorOf(checkLoopRequest({ ...body, trigger }));
      assert.match(error!, REMOVED, JSON.stringify(trigger));
      assert.match(error!, /oracle request or feed are not in this build.*start the loop on a schedule/);
    }
  });

  it("refuses a trigger kind it does not know with the trigger's own sentence", () => {
    const error = errorOf(checkLoopRequest({ ...body, trigger: { kind: "tide" } }));
    assert.match(error!, /trigger\.kind must be schedule/);
  });

  it("refuses the trace audit, as true or as its terms", () => {
    for (const traceAudit of [true, { behaviours: [] }]) {
      const error = errorOf(checkLoopRequest({ ...body, traceAudit }));
      assert.equal(error, TRACE_AUDIT_START_REFUSAL);
      assert.match(error!, /^the trace audit is not in this build: leave out traceAudit/);
    }
  });

  it("refuses grants whatever LATH_PROTOCOL_PLUGINS says, and points at the receipt", () => {
    for (const plugins of [undefined, "1"]) {
      withPlugins(plugins, () => {
        for (const refused of [checkGrants({ grants }), checkGrants({ grants: null })]) {
          assert.deepInclude(refused, { status: 400 });
          assert.match(errorOf(refused)!, NOT_IN_BUILD, `LATH_PROTOCOL_PLUGINS=${plugins}`);
          assert.match(errorOf(refused)!, /SAS · receipt.*is sent as receipt/);
        }
        // A deploy and *Run again* (`checkLoopRequest`) in the same words.
        assert.match(errorOf(checkLoopRequest({ ...body, grants }))!, NOT_IN_BUILD);
        // No grants is no refusal.
        assert.isNull(checkGrants({}));
      });
    }
  });

  it("refuses a template that stores any of them, and stores one without", () => {
    assert.notProperty(checkLoopConfig(loopConfig), "error");
    assert.equal(errorOf(checkLoopConfig({ ...loopConfig, workers: scratchTeam })), TEAM_REFUSAL);
    assert.equal(errorOf(checkLoopConfig({ ...loopConfig, traceAudit: true })), TRACE_AUDIT_START_REFUSAL);
    assert.match(errorOf(checkLoopConfig({ ...loopConfig, gate }))!, /^gated loops are not in this build/);
    // Grants, which no template ever stored, are refused rather than dropped.
    assert.match(errorOf(checkLoopConfig({ ...loopConfig, grants }))!, NOT_IN_BUILD);
  });
});

/** Clears the loop and agent rows, and deploys the one agent every row below runs. */
function freshAgent() {
  fs.rmSync(path.join(traceDir, "loops.json"), { force: true });
  fs.rmSync(path.join(traceDir, "agents.json"), { force: true });
  recordAgent(AGENT, {
    name: "watcher",
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: Date.now(),
    policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
  });
}

/** A loop row at its first step, with `over` laid on it: paused, as `pauseLoop` leaves one, unless `over` says. */
function loopRow(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const loop: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "watcher",
    owner: OWNER,
    prompt: body.prompt,
    promptHash: "cd".repeat(32),
    intervalMs: body.intervalMs,
    maxSteps: body.maxSteps,
    budgetMicroUsdc: body.budgetMicroUsdc,
    budgetMicroUsdcPerStep: "50000",
    model: body.model,
    createdAt: Date.now(),
    status: "paused",
    snapshot: { loopId: id, steps: 1, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
  recordLoop(loop);
  return readLoop(id)!;
}

/** Every kind of row that carries a roadmap feature, what a test calls it, and the words its refusal names it by. */
const rows: [string, Partial<LoopRecord>, RegExp][] = [
  ["a team", { workers: { scratch: { count: 2 } } as any }, /runs with a team, which is on the roadmap/],
  ["the trace audit", { traceAudit: { model: "m", behaviours: {} } as any }, /runs with the trace audit/],
  ["grants", { grants: grants as any }, /runs with protocol-plugin grants/],
  ["a gate", { trigger: { kind: "gate", pollMs: 60_000 }, gate: gate as any }, /runs with a gate/],
  ["a request trigger", { trigger: { kind: "request", pollMs: 15_000 } }, /runs with an oracle trigger/],
  ["a feed trigger", { trigger: { kind: "feed" } }, /runs with an oracle trigger/],
];

describe("roadmap features: a paused loop that runs one does not resume", () => {
  beforeEach(freshAgent);

  for (const [what, over, said] of rows) {
    it(`refuses a row with ${what}, and leaves it paused`, () => {
      const id = `loop-removed-${what.replace(/\W+/g, "-")}`;
      const why = resumeRefusal(loopRow(id, over));
      assert.match(why!, /^this loop cannot resume: /);
      assert.match(why!, said);
      assert.match(why!, /not in this build/);
      assert.match(why!, /stopping it still settles its channel$/);
      assert.equal(resumeLoop(id)!.status, "paused");
    });
  }

  it("resumes a paused row that runs none of them", () => {
    assert.isNull(resumeRefusal(loopRow("loop-removed-plain", { trigger: { kind: "schedule" } })));
  });
});

describe("roadmap features: a Retry lands what a run owed, and does not put one back on its schedule", () => {
  beforeEach(freshAgent);

  /**
   * Retries `id` through a queue with nothing journaled, so the drain lands at once and the run owes
   * nothing after it: whether it goes back on its schedule is then the resume decision alone. Says
   * which queue calls the Retry made and whether it asked to schedule the run.
   */
  async function retry(id: string) {
    const calls: string[] = [];
    const queue = {
      async retry() {
        calls.push("retry");
      },
      async drain() {
        calls.push("drain");
      },
      async discard() {
        return {} as any;
      },
    };
    const r = await retryLoopAnchor(id, { queue: queue as any, resume: () => calls.push("resume") });
    return { ...r, calls, row: readLoop(id)! };
  }

  const anchorFailed: Partial<LoopRecord> = { status: "stopped", stopReason: "anchor-failed" };

  for (const [what, over, said] of rows) {
    it(`drains an anchor-failed run with ${what}, and leaves it stopped on anchor-failed with the reason`, async () => {
      const id = `loop-retry-${what.replace(/\W+/g, "-")}`;
      loopRow(id, { ...anchorFailed, ...over });
      const { error, calls, row } = await retry(id);
      assert.deepEqual(calls, ["retry", "drain"], "the drain still runs; nothing is scheduled");
      assert.equal(row.status, "stopped");
      assert.equal(row.stopReason, "anchor-failed");
      assert.match(row.stopDetail!, /^this run's writes are on chain, but it stays stopped: /);
      assert.match(row.stopDetail!, said);
      assert.match(row.stopDetail!, /not in this build/);
      assert.equal(error, row.stopDetail);
      assert.isUndefined(row.nextStepAt);
    });
  }

  it("does the same for a row paused over a snapshot its step stopped on anchor-failed", async () => {
    const id = "loop-retry-loops7-request";
    loopRow(id, {
      trigger: { kind: "request", pollMs: 15_000 },
      snapshot: {
        loopId: id,
        steps: 1,
        status: "stopped",
        stopReason: "anchor-failed",
        totalCostMicroUsdc: "0",
        consecutiveFailures: 0,
      },
    });
    const { error, calls, row } = await retry(id);
    assert.deepEqual(calls, ["retry", "drain"]);
    // Written down as the stop the step meant, as every Retry of a row paused over its step's stop is, and left there.
    assert.equal(row.status, "stopped");
    assert.equal(row.stopReason, "anchor-failed");
    assert.match(row.stopDetail!, /runs with an oracle trigger, which is not in this build/);
    assert.equal(error, row.stopDetail);
  });

  it("puts a run with none of them back on its schedule", async () => {
    loopRow("loop-retry-plain", { ...anchorFailed, trigger: { kind: "schedule" } });
    const plain = await retry("loop-retry-plain");
    assert.deepEqual(plain.calls, ["retry", "drain", "resume"]);
    assert.equal(plain.row.status, "running");
    assert.isUndefined(plain.error);
  });
});

describe("roadmap features: a Retry of a plan that commits one is refused before anything is drained", () => {
  beforeEach(freshAgent);

  /** An anchor-failed run whose step 1 owes the checkpoint `plan`, which carries a roadmap feature's keys. */
  function owing(id: string, plan: Record<string, unknown>): LoopRecord {
    return loopRow(id, {
      status: "stopped",
      stopReason: "anchor-failed",
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
            sessionId: `${id}:step-1`,
            intervalMs: body.intervalMs,
            maxSteps: body.maxSteps,
            promptHash: "cd".repeat(32),
            startedAt: 0,
            statusCode: 200,
            ...plan,
          },
        },
      ],
    });
  }

  const member = { agentId: "cd".repeat(32), taskId: "t", outcome: "done", seq: "7", head: "ef".repeat(32) };
  const plans: [string, Record<string, unknown>, string][] = [
    ["requestAddress", { requestAddress: "11111111111111111111111111111111" }, "an oracle request"],
    ["members", { members: [member] }, "a team's member commits"],
    ["gateHash", { gateHash: "ef".repeat(32) }, "a gate's log"],
    ["traceAuditHash", { traceAuditHash: "9".repeat(64) }, "the trace audit"],
    ["pluginHash", { pluginHash: "8".repeat(64) }, "protocol-plugin grants"],
  ];

  for (const [key, plan, named] of plans) {
    it(`refuses a plan carrying ${key}, drains nothing and leaves the plan owed`, async () => {
      const id = `loop-plan-${key.toLowerCase()}`;
      owing(id, plan);
      const calls: string[] = [];
      const r = await retryLoopAnchor(id, {
        queue: { retry: async () => void calls.push("retry"), drain: async () => void calls.push("drain") },
        resume: () => void calls.push("resume"),
      });
      assert.deepEqual(calls, [], "no drain: its records would land under no leaf");
      assert.equal(r.error, removedPlanRefusal(readLoop(id)!));
      assert.include(r.error!, `(step 1's checkpoint commits ${named})`);
      assert.match(r.error!, /other than the one its step planned$/);
      const row = readLoop(id)!;
      assert.equal(row.stopReason, "anchor-failed");
      assert.deepInclude(row.history[0].deferredCheckpoint as Record<string, unknown>, plan);
    });
  }

  it("lets a plan with none of them through, an empty roster included, as the bytes never carried one", async () => {
    assert.isNull(removedPlanRefusal(owing("loop-plan-plain", { members: [], goalHash: "ab".repeat(32) })));
  });

  it("and the runtime writes no checkpoint for such a plan, whoever asks", async () => {
    const plan = {
      loopId: "l",
      step: 2,
      sessionId: "l:step-2",
      intervalMs: 1,
      maxSteps: 3,
      promptHash: "cd".repeat(32),
      startedAt: 0,
      statusCode: 200,
      gateHash: "ef".repeat(32),
    };
    assert.deepEqual(removedPlanKeys(plan), ["gateHash"]);
    const unreached = () => {
      throw new Error("the chain was read");
    };
    const e = await writeLoopCheckpoint({
      client: { getAgentState: unreached } as any,
      agentId: new Uint8Array(32) as any,
      logger: { action: unreached } as any,
      plan,
    }).catch((err: Error) => err);
    assert.instanceOf(e, Error);
    assert.equal((e as Error).message, "step 2's checkpoint commits a gate's log, which this build does not write");
  });
});
