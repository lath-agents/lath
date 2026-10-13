/**
 * The console's half of the trace audit, node-only. The audit is on the roadmap and not in this
 * build (nor are the console's terms, the scripted reader and the row's writer): a start, a
 * template version, a resume or a Retry that asks for it is refused
 * with the build's sentence, a running row that carries it is stopped at its next tick
 * before anything is spent, and an old row renders read-only. And what stays read: the browser's
 * manifest rebuild with the fifteenth and sixteenth keys, a policy's bytes with the audit off and on,
 * and what an audited step cost Lath.
 */
import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { hex, loopManifestBytes, sha256, toBytes32, type LoopStepManifest } from "../sdk/src";
import { policyDocument, policyVersionHash, toRuntimePolicy, type RuntimePolicy } from "../runtime/src/policy";
import {
  TRACE_AUDIT_START_REFUSAL,
  TRACE_AUDIT_STOP_DETAIL,
  checkLoopRequest,
  publicLoop,
  readLoop,
  recordLoop,
  resumeLoop,
  resumeRefusal,
  retryLoopAnchor,
  schedule,
  traceAuditResumeRefusal,
  traceAuditRetryRefusal,
  type LoopRecord,
} from "../frontend/src/app/api/_lib/loops";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";
import { checkLoopConfig } from "../frontend/src/app/api/templates/validate";
import { manifestFor, manifestKeysOf, mayLackTempoHash, recoverTempoHash } from "../frontend/src/lib/loop-manifest";
import { EventKind, LOOP_STEP_TOOL, hashPayload, loopStepLeaf, verifyStep, type LoopStep } from "../sdk/src";
import { TEMPO_CARRY_VERSION, tempoCarryBytes, type TempoCarry } from "../runtime/src/loop-tempo";
import { jevCostBase, traceCostBase } from "../frontend/src/lib/loop-money";
import { tempoServiceLines } from "../frontend/src/lib/tempo-services";
import type { LoopStepSummary, LoopView } from "../frontend/src/types/loop";

const H = (c: string) => c.repeat(64);

/** The loop terms `manifestFor` reads, as a `LoopView` would carry them. */
const LOOP = {
  id: "loop-1",
  intervalMs: 15_000,
  maxSteps: 6,
  promptHash: H("a"),
  createdAt: 1_790_000_000_000,
  goalHash: H("b"),
} as Pick<LoopView, "id" | "intervalMs" | "maxSteps" | "promptHash" | "createdAt" | "goalHash">;

/** The manifest the runner would have written for the same step: every key, in `writeLoopCheckpoint`'s order. */
function runnerManifest(extra: Partial<LoopStepManifest>): LoopStepManifest {
  return {
    loopId: LOOP.id,
    step: 3,
    intervalMs: LOOP.intervalMs,
    maxSteps: LOOP.maxSteps,
    promptHash: LOOP.promptHash,
    startedAt: LOOP.createdAt,
    memoryHash: H("c"),
    goalHash: LOOP.goalHash,
    ...extra,
  };
}

const leafOf = (m: LoopStepManifest) => hex(sha256(loopManifestBytes(m)));

describe("console trace audit: the browser's manifest rebuild", () => {
  it("rebuilds a step carrying tempoHash byte for byte, never a leaf mismatch", () => {
    const written = runnerManifest({ replayHash: H("d"), tempoHash: H("e") });
    const row = { zeroclaw: { replayHash: H("d") }, tempoHash: H("e") } as unknown as LoopStepSummary;
    const rebuilt = manifestFor(LOOP, 3, H("c"), undefined, undefined, undefined, manifestKeysOf(row));
    assert.equal(leafOf(rebuilt), leafOf(written));
    // Without the key the bytes are the fourteen-key manifest's, and the leaf differs.
    const old = manifestFor(LOOP, 3, H("c"), undefined, undefined, undefined, { replayHash: H("d") });
    assert.notEqual(leafOf(old), leafOf(written));
  });

  it("rebuilds all sixteen keys: goalCheckHash, tempoHash and traceAuditHash in order", () => {
    const written = runnerManifest({
      replayHash: H("d"),
      goalCheckHash: H("f"),
      tempoHash: H("e"),
      traceAuditHash: H("9"),
    });
    const row = {
      zeroclaw: { replayHash: H("d") },
      goalCheck: { outcome: "continue", claimed: false, goalCheckHash: H("f") },
      tempoHash: H("e"),
      traceAudit: { outcome: "clean", hits: [], stopped: false, line: "", behaviours: 4, traceAuditHash: H("9") },
    } as unknown as LoopStepSummary;
    const rebuilt = manifestFor(LOOP, 3, H("c"), undefined, undefined, undefined, manifestKeysOf(row));
    assert.deepEqual(Object.keys(rebuilt).slice(-3), ["goalCheckHash", "tempoHash", "traceAuditHash"]);
    assert.equal(leafOf(rebuilt), leafOf(written));
  });

  it("reads a late step's two keys off its plan when the row's views do not carry them", () => {
    const row = {
      deferredCheckpoint: { tempoHash: H("e"), traceAuditHash: H("9") },
    } as unknown as LoopStepSummary;
    assert.deepEqual(manifestKeysOf(row), { tempoHash: H("e"), traceAuditHash: H("9") });
  });

  it("keeps a step with neither key the manifest it always was", () => {
    const written = runnerManifest({ replayHash: H("d") });
    const rebuilt = manifestFor(
      LOOP,
      3,
      H("c"),
      undefined,
      undefined,
      undefined,
      manifestKeysOf({
        zeroclaw: { replayHash: H("d") },
      } as unknown as LoopStepSummary)
    );
    assert.equal(leafOf(rebuilt), leafOf(written));
    assert.notProperty(rebuilt, "tempoHash");
    assert.notProperty(rebuilt, "traceAuditHash");
  });
});

/**
 * `loop-0292a02b6f3d2780` (agent `upgrade-watch-demo`, on devnet): its step 2 committed a carry of
 * step 1's `storage.put` and snapshot, but its row kept no `tempoHash`, so a page that rebuilt the
 * leaf from the row alone would read *leaf mismatch* on a chain `lath-audit` verifies. The rows
 * below are that loop's, as the console's registry holds them; the receipt hash and the head before
 * the record are not on any row, so they are stand-ins, which the commitment does not care about.
 */
describe("console trace audit: a step whose row lost its tempoHash", () => {
  const LOOP_0292 = {
    id: "loop-0292a02b6f3d2780",
    intervalMs: 10_000,
    maxSteps: 6,
    promptHash: "368f05ca0ce5b20a3aa52914105566c1aeb08164744e13d3b89fc702e17f1e78",
    createdAt: 1790714033708,
    goalHash: "6b6244447fd87392f7068dccc9d591be0640984e61b71e497e51e8a35d5230aa",
  } as Pick<LoopView, "id" | "intervalMs" | "maxSteps" | "promptHash" | "createdAt" | "goalHash">;
  const AGENT = toBytes32("5f3ef07bdd6c52b37ca8344e98ffc08b9d4dd65047d033d9e35af2ae1d1cc6b2");

  const STEP_1 = {
    step: 1,
    seq: "23",
    tempoStorage: {
      key: "loop-0292a02b6f3d2780-e5a9b01e3ba3b15deb3956c28c14a289c9a97deb2437388be58c3f1ad7a21673",
      path: "report/authority.md",
      bytes: 4636,
      statusCode: 200,
      amount: "200",
      reference: "0x2c0532e353f2b5a9a36d36d229edb3ea67507bd679a881dc5c50b82b58db6ff0",
      seq: "25",
    },
    tempoSnapshot: {
      ofStep: 1,
      takenAt: 1790714191959,
      rpc: { channelId: "0x65b8800ce73ba8815be38d808cd7fc953bd16a94c7bea5d0ef6e1e748b0a1eaa", cumulative: "4000" },
      block: "41850706",
      channel: {
        id: "0x3c40fbb47a7f2a2cf6892345e25bb84ab6c86f39fc07514a7aab492067006448",
        deposit: "169618",
        settled: "0",
        cumulative: "24622",
      },
      treasury: { usdcE: "2350410" },
    },
  } as unknown as LoopStepSummary;

  // No `tempoHash`: that is the whole fault.
  const STEP_2 = {
    step: 2,
    seq: "40",
    memoryHash: "465939bff8b414e7cd5b7c597f08b11d1825e1cfe92988a9a0ae70c5ef555b7f",
    genesisPayloadHash: "556f265014e09f21338340fca4477c039ef2f128f1b526feacda3551cc6fd432",
    goalCheck: {
      outcome: "achieved",
      claimed: true,
      goalCheckHash: "d6e4aa5e32398529b9987e3ee72ded441f3d2b7db63cff04e27aaf6aa12ebe8b",
    },
    zeroclaw: { replayHash: "a7b80f9c4c7d7b257a248c9609cdfa85d07ee07ddc8bc7c290aa72a7cf9a32db" },
    tempoStorage: {
      key: "loop-0292a02b6f3d2780-83736dadbe17397a848abbe4743317d2f502704bc5787d63baf78db6b2dc1b81",
      path: "report/authority.md",
      bytes: 2829,
      statusCode: 200,
      amount: "200",
      reference: "0xb99ae7ec741adae9a44bcfdb57510d14cb001bf469ac19551a9d7c9f6989e0ba",
      seq: "42",
    },
  } as unknown as LoopStepSummary;

  /** What step 2's leaf carried, as `LoopTempoServices.carry()` built it: step 1's PUT and snapshot. */
  function carryOf(snapshot = STEP_1.tempoSnapshot!): TempoCarry {
    const put = STEP_1.tempoStorage!;
    return {
      v: TEMPO_CARRY_VERSION,
      storage: [{ ofStep: 1, seq: put.seq!, key: put.key, statusCode: put.statusCode, receiptHash: H("7") }],
      snapshots: [snapshot as any],
    };
  }
  const CARRY_HASH = hex(sha256(tempoCarryBytes(carryOf())));

  /** The rebuild the page makes from the row, which lacks the fifteenth key. */
  const base = () =>
    manifestFor(LOOP_0292, 2, STEP_2.memoryHash, undefined, undefined, undefined, manifestKeysOf(STEP_2));

  /** The `loop.step` record as the chain holds it, over the manifest the runner actually hashed. */
  function chainStep(committed: LoopStepManifest): LoopStep {
    const seq = BigInt(STEP_2.seq);
    const priorHead = toBytes32(H("5"));
    const payloadHash = hashPayload({
      kind: EventKind.Action,
      toolId: LOOP_STEP_TOOL,
      argsHash: sha256(loopManifestBytes(committed)),
      resultHash: loopStepLeaf(AGENT, seq, priorHead),
      statusCode: 200,
    });
    return {
      record: { agentId: AGENT, seq, kind: EventKind.Action, status: 200, payloadHash } as any,
      seq,
      head: toBytes32(H("6")),
      priorHead,
      timestamp: BigInt(0),
      statusCode: 200,
    };
  }
  const CHAIN = chainStep({ ...base(), tempoHash: CARRY_HASH });
  const onChain = async (m: LoopStepManifest) => (await verifyStep(AGENT, CHAIN, { manifest: m })).verdict === "ok";

  /** The step's bundle as `indexBundle` keys it: other blobs it wrote, and the carry. */
  const bundleHashes = (carry: string) => [H("1"), STEP_2.memoryHash!, carry, H("2")];

  it("reads leaf mismatch without the key, which is the fault on the loop page", async () => {
    assert.isFalse(await onChain(base()));
    assert.isTrue(mayLackTempoHash(STEP_2, [STEP_1, STEP_2]));
  });

  it("finds the committed carry among the step's own blobs and the rebuilt leaf verifies", async () => {
    const found = await recoverTempoHash(base(), bundleHashes(CARRY_HASH), onChain);
    assert.equal(found, CARRY_HASH);
    assert.isTrue(await onChain({ ...base(), tempoHash: found }));
  });

  it("finds nothing when the bundle's carry was edited: the step stays a mismatch", async () => {
    // One figure of the snapshot moved — the treasury the carry says Lath held after step 1.
    const edited = { ...STEP_1.tempoSnapshot!, treasury: { usdcE: "9350410" } };
    const tampered = hex(sha256(tempoCarryBytes(carryOf(edited))));
    assert.notEqual(tampered, CARRY_HASH);
    assert.isUndefined(await recoverTempoHash(base(), bundleHashes(tampered), onChain));
  });

  it("never swaps a tempoHash the row named, even for the one that would verify", async () => {
    const named = { ...base(), tempoHash: H("e") };
    assert.isUndefined(await recoverTempoHash(named, bundleHashes(CARRY_HASH), onChain));
  });

  it("is not tried on a row that carries the key or on a loop with nothing earlier to carry", () => {
    assert.isFalse(mayLackTempoHash({ ...STEP_2, tempoHash: CARRY_HASH } as LoopStepSummary, [STEP_1]));
    assert.isFalse(mayLackTempoHash(STEP_2, [STEP_2]));
    assert.isFalse(mayLackTempoHash(STEP_1, [STEP_1, STEP_2]));
  });
});

describe("console trace audit: not in this build", () => {
  const OWNER = "So11111111111111111111111111111111111111112";
  const AGENT_HEX = "ab".repeat(32);
  const body = {
    agentId: AGENT_HEX,
    prompt: "Read the program account and report who can upgrade it.",
    intervalMs: 5 * 60_000,
    maxSteps: 3,
  };
  /** Terms a start that asked for `true` resolved to: the five offered presets on their defaults. */
  const TERMS = {
    model: "typesafe/jev-1.13",
    behaviours: {
      false_success: { bar: 0.5, onPresent: "flag" },
      injection_followed: { bar: 0.5, onPresent: "stop" },
      secret_exposure: { bar: 0.5, onPresent: "flag" },
      stuck_loop: { bar: 0.5, onPresent: "flag" },
      unsafe_funds: { bar: 0.5, onPresent: "stop" },
    },
  } as const;
  const errorOf = (r: unknown) => (r as { error?: string }).error;

  /** Clears the registry and deploys the one agent every row below runs. */
  function freshAgent() {
    fs.rmSync(path.join(traceDir, "loops.json"), { force: true });
    fs.rmSync(path.join(traceDir, "agents.json"), { force: true });
    recordAgent(AGENT_HEX, {
      name: "watcher",
      authority: "AuThOrItY1111111111111111111111111111111111",
      owner: OWNER,
      createdAt: Date.now(),
      policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
    });
  }

  /** A stored row started with the trace audit, one step in, with `over` laid on it. */
  function auditedRow(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
    recordLoop({
      id,
      agentId: AGENT_HEX,
      agentName: "watcher",
      owner: OWNER,
      prompt: body.prompt,
      promptHash: "cd".repeat(32),
      intervalMs: body.intervalMs,
      maxSteps: body.maxSteps,
      budgetMicroUsdc: "150000",
      budgetMicroUsdcPerStep: "50000",
      model: "deepseek/deepseek-v4.1-flash",
      createdAt: Date.now(),
      status: "paused",
      traceAudit: TERMS as unknown as LoopRecord["traceAudit"],
      snapshot: { loopId: id, steps: 1, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [
        {
          step: 1,
          status: "success",
          traceAudit: {
            outcome: "flagged",
            hits: [{ id: "false_success", p: 0.95, bar: 0.5, onPresent: "flag", action: "flag" }],
            stopped: false,
            line: "trace: ⚑ false_success 0.95",
            behaviours: 5,
            codeChecked: ["secret_exposure", "stuck_loop"],
            traceAuditHash: H("9"),
            costBase: "20",
          },
        } as unknown as LoopStepSummary,
      ],
      ...over,
    } as LoopRecord);
    return readLoop(id)!;
  }

  beforeEach(freshAgent);

  it("starts the loop that exists today, and reads the off values as off", () => {
    for (const extra of [{}, { traceAudit: false }, { traceAudit: null }]) {
      const checked = checkLoopRequest({ ...body, ...extra });
      assert.notProperty(checked, "error", JSON.stringify(extra));
      assert.notProperty(checked, "traceAudit");
    }
  });

  it("refuses a start that asks for it, and names what to leave out", () => {
    // `true` from an old form, its picked terms, a stored version's resolved ones, Span-01's.
    const asks = [true, { behaviours: ["unsafe_funds"] }, TERMS, { ...TERMS, model: "respan/span-01" }, "yes"];
    for (const traceAudit of asks) {
      const said = errorOf(checkLoopRequest({ ...body, traceAudit }));
      assert.equal(said, TRACE_AUDIT_START_REFUSAL, JSON.stringify(traceAudit));
    }
    assert.match(TRACE_AUDIT_START_REFUSAL, /^the trace audit is not in this build: leave out traceAudit; /);
    assert.match(TRACE_AUDIT_START_REFUSAL, /loops that already ran with one still verify$/);
  });

  it("refuses a template version that stores it, and stores one without", () => {
    const version = (over: Record<string, unknown>) =>
      checkLoopConfig({
        prompt: "Read the program account.",
        intervalMs: 15_000,
        maxSteps: 3,
        budgetMicroUsdcPerStep: "50000",
        model: "deepseek/deepseek-v4.1-flash",
        coordinator: { agentId: "aa".repeat(32) },
        members: [],
        ...over,
      }) as { config?: object; error?: string };
    assert.equal(version({ traceAudit: true }).error, TRACE_AUDIT_START_REFUSAL);
    assert.equal(version({ traceAudit: TERMS }).error, TRACE_AUDIT_START_REFUSAL);
    assert.notProperty(version({}).config, "traceAudit");
    assert.notProperty(version({ traceAudit: false }).config, "traceAudit");
  });

  it("does not resume a paused row that runs it, and leaves it paused", () => {
    const row = auditedRow("loop-trace-paused");
    const why = resumeRefusal(row);
    assert.equal(why, traceAuditResumeRefusal(row));
    assert.match(why!, /^this loop cannot resume: it runs with the trace audit, which is not in this build; /);
    assert.match(why!, /its chain still verifies, and stopping it still settles its channel$/);
    assert.equal(resumeLoop(row.id)!.status, "paused");
  });

  it("drains an anchor-failed run that runs it, and leaves it stopped rather than back on its schedule", async () => {
    const id = "loop-trace-retry";
    auditedRow(id, { status: "stopped", stopReason: "anchor-failed" });
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
    const row = readLoop(id)!;
    assert.deepEqual(calls, ["retry", "drain"], "the drain still runs; nothing is scheduled");
    assert.equal(row.status, "stopped");
    assert.equal(row.stopReason, "anchor-failed");
    assert.equal(row.stopDetail, traceAuditRetryRefusal(row));
    assert.match(
      row.stopDetail!,
      /^this run's writes are on chain, but it stays stopped: it runs with the trace audit/
    );
    assert.equal(r.error, row.stopDetail);
  });

  it("stops a running row that runs it at its next tick, before anything is spent, and keeps its history", async () => {
    const row = auditedRow("loop-trace-running", { status: "running", nextStepAt: Date.now() });
    schedule(row.id, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const after = readLoop(row.id)!;
    assert.equal(after.status, "stopped");
    assert.equal(after.stopReason, "error");
    assert.equal(after.stopDetail, TRACE_AUDIT_STOP_DETAIL);
    assert.isUndefined(after.nextStepAt);
    assert.equal(after.snapshot.steps, 1, "no step was taken");
    assert.isUndefined(after.steppingSince);
    assert.deepEqual(after.history, row.history, "the step it took stays as it was");
    assert.deepEqual(after.traceAudit, row.traceAudit, "and so do its terms");
  });

  it("names an old row's audit in one line, and each step's audit still reaches the leaf check and the costs", () => {
    const view = publicLoop(auditedRow("loop-trace-view", { status: "stopped", stopReason: "trace-flagged" }));
    // No terms row on the page in this build: the view names the audit and carries no terms.
    assert.notProperty(view, "traceAudit");
    assert.deepEqual(view.earlierBuild, ["trace-audit"]);
    assert.equal(view.stopReason, "trace-flagged");
    assert.include(view.history[0].traceAudit, { outcome: "flagged", line: "trace: ⚑ false_success 0.95" });
    assert.equal(traceCostBase(view.history[0]), "20");
  });
});

describe("console trace audit: the policy", () => {
  const BASE = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };

  it("hashes a policy with the audit off exactly as before, and an old row's terms as they were committed", () => {
    // The digest `tests/loop-goal-check.ts` and the posture suites pin.
    assert.equal(hex(policyVersionHash(BASE)), "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0");
    const off: RuntimePolicy = { ...BASE, traceAudit: undefined };
    assert.equal(policyDocument(off), policyDocument(BASE));
    assert.notProperty(toRuntimePolicy(BASE), "traceAudit");
    const on = { model: "typesafe/jev-1.13", behaviours: { false_success: { bar: 0.5, onPresent: "flag" as const } } };
    assert.include(policyDocument({ ...BASE, traceAudit: on }), '"traceAudit":{"behaviours":{"false_success"');
  });
});

describe("console trace audit: what the audit cost Lath", () => {
  it("sums the reader's call and a veto's confirm, and nothing for a scripted or unpaid audit", () => {
    const row = (traceAudit: unknown) => ({ traceAudit } as unknown as LoopStepSummary);
    assert.equal(traceCostBase(row({ outcome: "clean", costBase: "20" })), "20");
    assert.equal(traceCostBase(row({ outcome: "stopped", costBase: "20", confirm: { costBase: "60" } })), "80");
    assert.isUndefined(traceCostBase(row({ outcome: "clean", costBase: "20", scripted: true })));
    assert.isUndefined(traceCostBase(row({ outcome: "unavailable" })));
    assert.isUndefined(traceCostBase(row(undefined)));
  });

  it("takes the audit out of the Costs card's model line and gives it its own", () => {
    const loop = {
      history: [
        {
          step: 1,
          tempoSpent: "5080",
          goalCheck: { outcome: "continue", claimed: false, costBase: "42" },
          traceAudit: { outcome: "clean", costBase: "20" },
          tempoSnapshot: { ofStep: 1, takenAt: 0, block: "100", rpc: { cumulative: "10" } },
        },
      ],
      tempo: null,
    } as unknown as LoopView;
    assert.equal(jevCostBase(loop.history[0]), "42");
    const lines = tempoServiceLines(loop)!;
    assert.equal(lines.jev, BigInt(42));
    assert.equal(lines.trace, BigInt(20));
    assert.equal(lines.model, BigInt(5018));
  });
});
