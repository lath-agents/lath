import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  Bytes32,
  EventPayload,
  EventRecord,
  LathClient,
  LocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  LogResult,
  MemoryTraceStore,
  TraceStore,
  computeHead,
  hex,
  idFromString,
  loopStartBodyHash,
  parseLoopStartDoc,
  sha256,
  toBytes32,
  toEventInput,
  utf8,
  ZERO32,
} from "../sdk/src";
import {
  LIFECYCLE_WAITING_DETAIL,
  LoopRecord,
  cancel,
  lifecycleBeforeStep,
  lifecyclePayersSettled,
  oweAgentDeploy,
  payOwedAgentLifecycle,
  payOwedLifecycle,
  pauseLoop,
  publicLoop,
  readLoop,
  readLoops,
  rebuildFromChain,
  recordLoop,
  resumeLoop,
  resumeRefusal,
  retryRefusal,
  setLifecycleWriterForTests,
  startLoop,
  stopLoop,
  updateLoop,
} from "../frontend/src/app/api/_lib/loops";
import {
  LifecycleWriterDeps,
  OwedLifecycle,
  REBUILT_REFUSAL,
  agentDeployEntry,
  loopStartEntry,
  loopTransitionEntry,
  transitionOwed,
  withOwed,
  writeLifecycle,
} from "../frontend/src/app/api/_lib/lifecycle";
import {
  DeployedAgent,
  acquireRunSlot,
  deployedRoles,
  lookupAgent,
  recordAgent,
  readRegistry,
} from "../frontend/src/app/api/_lib/runner";

/**
 * The console's lifecycle records (`frontend/src/app/api/_lib/lifecycle.ts`, the owing and paying in
 * `_lib/loop-registry.ts`): what a decision owes the agent's chain, when it is written, and what a console
 * whose `loops.json` and `agents.json` are gone rebuilds from it.
 *
 * Pinned here:
 *
 * - **the start.** A started loop owes `loop.start` (with the signature and the body hash the route
 *   verified) and its first step pays it before anything else; a write that fails keeps the step
 *   from running, says why on the row, and is paid by the next tick.
 * - **the order.** Pause, resume and stop are written in the order decided, never while another
 *   writer (a step) holds the run slot, and never ahead of a step's owed checkpoint.
 * - **the kill switch.** `LATH_LIFECYCLE=off` owes and writes nothing.
 * - **one half.** The documents are plain bytes in the plain store, and there is no private half:
 *   encryption is on the roadmap, so a start commits to its prompt by hash alone.
 * - **the rebuild.** A fresh registry rebuilt from a fake chain holds read-only rows, and only this
 *   console's agents.
 *
 * Node-only: no validator, no RPC, nothing that can spend money. The writer is the suite's own.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const NAME = "lifecycle-agent";
const AGENT = hex(idFromString(NAME));
const AUTH = { message: "localhost wants you to sign in…\nLath loop: start x", signature: "c2ln" };

function clearStore(): void {
  for (const f of ["loops.json", "templates.json", "agents.json"]) fs.rmSync(path.join(traceDir, f), { force: true });
}

function deploy(extra: Partial<DeployedAgent> = {}): void {
  recordAgent(AGENT, {
    name: NAME,
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: 1_791_000_000_000,
    policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
    ...extra,
  });
}

function row(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  return {
    id,
    agentId: AGENT,
    agentName: NAME,
    owner: OWNER,
    prompt: "keep a one-page note current",
    promptHash: hex(sha256(utf8("keep a one-page note current"))),
    intervalMs: 15_000,
    maxSteps: 5,
    budgetMicroUsdc: "1000000",
    budgetMicroUsdcPerStep: "200000",
    model: "deepseek/deepseek-v4.1-flash",
    goal: "a one-page note",
    goalHash: hex(sha256(utf8("a one-page note"))),
    createdAt: 1_791_000_000_000,
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
}

/** Starts `id` the way the route does, without arming its clock: the suite steps it by hand. */
function started(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const body = { agentId: AGENT, prompt: "keep a one-page note current", maxSteps: 5 };
  startLoop(row(id, over), undefined, { auth: AUTH, startBody: body });
  cancel(id);
  return readLoop(id)!;
}

/** Every record the suite's writer put on "the chain", in order, as `tool:loopId`. */
let written: string[] = [];
let failNext = 0;
function recordingWriter() {
  written = [];
  failNext = 0;
  let seq = 0;
  setLifecycleWriterForTests(async (_target, entry) => {
    if (failNext > 0) {
      failNext--;
      throw new Error("fake chain: send failed");
    }
    written.push(`${entry.tool}:${(entry.args as { loopId?: string }).loopId ?? entry.args.agentId}`);
    return { tool: entry.tool, seq: String(seq++), signature: `sig-${seq}`, at: Date.now() };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── A chain, a registry and a backend, in memory ───────────────────────────

/** `logEvent`, the header and the two list reads, over an in-memory chain that folds the real head. */
class MiniChain {
  readonly records: EventRecord[] = [];
  private readonly heads = new Map<string, Bytes32>();
  readonly authorities: Map<string, PublicKey>;
  constructor(authorities: Map<string, PublicKey>) {
    this.authorities = authorities;
  }

  async getAgentState(agentId: Bytes32) {
    const authority = this.authorities.get(hex(agentId));
    if (!authority) return null;
    return { account: {}, state: { authority, agentId, seq: BigInt(this.seqOf(agentId)), head: ZERO32 } };
  }

  private seqOf(agentId: Bytes32): number {
    return this.records.filter((r) => hex(r.agentId) === hex(agentId)).length;
  }

  async logEvent(agentId: Bytes32, payload: EventPayload, opts: { timestamp?: number } = {}): Promise<LogResult> {
    const input = toEventInput(payload, BigInt(opts.timestamp ?? Date.now()));
    const seq = BigInt(this.seqOf(agentId));
    const head = computeHead(this.heads.get(hex(agentId)) ?? ZERO32, agentId, seq, input);
    this.heads.set(hex(agentId), head);
    this.records.push({
      agentId,
      seq,
      timestamp: input.timestamp,
      kind: input.kind,
      status: input.status,
      reference: input.reference,
      payloadHash: input.payloadHash,
      head,
    } as EventRecord);
    return { signature: `sig-${this.records.length}`, seq, head, input } as LogResult;
  }

  async listByTool(agentId: Bytes32, toolId: string): Promise<EventRecord[]> {
    const ref = hex(idFromString(toolId));
    return this.records.filter((r) => hex(r.agentId) === hex(agentId) && r.kind === 1 && hex(r.reference) === ref);
  }

  async listByReference(reference: Bytes32, kind?: number): Promise<EventRecord[]> {
    return this.records.filter((r) => hex(r.reference) === hex(reference) && (kind === undefined || r.kind === kind));
  }
}

/** The locator cells as a map, and a backend that keeps what it is sent: enough for `publishBlobs`. */
function memoryAnchor() {
  const cells = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const backend: LocatorBackend = {
    scheme: LocatorScheme.Raw,
    async upload(bytes: Uint8Array) {
      const id = sha256(utf8(`blob-${n++}`));
      blobs.set(hex(id), bytes);
      return id;
    },
    async download(id: Uint8Array) {
      return blobs.get(hex(id)) ?? null;
    },
  } as LocatorBackend;
  const registry = {
    async ensureCreated() {},
    async has(hash: Uint8Array) {
      return cells.has(hex(hash));
    },
    async publish(hash: Uint8Array, locator: { id: Uint8Array }) {
      cells.set(hex(hash), locator.id);
    },
    async resolve(hash: Uint8Array) {
      const id = cells.get(hex(hash));
      return id ? { locator: { scheme: LocatorScheme.Raw, id } } : null;
    },
  } as unknown as LocatorRegistry;
  return { cells, blobs, backend, registry };
}

function writerDeps(chain: MiniChain, plain: TraceStore, over: Partial<LifecycleWriterDeps> = {}) {
  const anchor = memoryAnchor();
  const deps: LifecycleWriterDeps = {
    client: chain as unknown as LathClient,
    queue: { carried: async () => [], drain: async () => {} },
    plain,
    anchor,
    ...over,
  };
  return { deps, anchor };
}

describe("lifecycle records on the console", () => {
  const before = process.env.LATH_LIFECYCLE;
  beforeEach(() => {
    clearStore();
    delete process.env.LATH_LIFECYCLE;
    recordingWriter();
    deploy();
  });
  afterEach(async () => {
    await sleep(5);
    await lifecyclePayersSettled();
    setLifecycleWriterForTests(null);
  });
  after(() => {
    if (before === undefined) delete process.env.LATH_LIFECYCLE;
    else process.env.LATH_LIFECYCLE = before;
  });

  describe("start", () => {
    it("owes loop.start with the verified signature and the body's hash, and the first step pays it first", async () => {
      const loop = started("loop-start-1");
      const [owed] = loop.lifecycle!.owed;
      assert.equal(owed.tool, "loop.start");
      const args = owed.args as Record<string, any>;
      assert.deepEqual(args.auth, AUTH);
      assert.equal(
        args.startBodyHash,
        loopStartBodyHash({ agentId: AGENT, prompt: "keep a one-page note current", maxSteps: 5 })
      );
      // The record is public and the prompt the owner's: it is committed by `promptHash` alone.
      assert.notProperty(args, "prompt");
      assert.notInclude(JSON.stringify(args), "keep a one-page note current");
      assert.equal(args.promptHash, hex(sha256(utf8("keep a one-page note current"))));
      assert.notProperty(owed, "private", "no private half is owed");
      // Before the step: the step's own records come after what the row owed.
      assert.isFalse(await lifecycleBeforeStep("loop-start-1"));
      written.push("loop.step:loop-start-1");
      assert.deepEqual(written, ["loop.start:loop-start-1", "loop.step:loop-start-1"]);
      const after = readLoop("loop-start-1")!;
      assert.lengthOf(after.lifecycle!.owed, 0);
      assert.deepEqual(
        after.lifecycle!.records.map((r) => r.tool),
        ["loop.start"]
      );
      assert.deepEqual(publicLoop(after).chain, { records: after.lifecycle!.records, owed: [] });
    });

    it("a failed write keeps the step from running, says why, and is paid by the next tick", async () => {
      started("loop-start-2");
      failNext = 1;
      assert.isTrue(await lifecycleBeforeStep("loop-start-2"), "the step waits");
      const waiting = readLoop("loop-start-2")!;
      assert.equal(waiting.status, "running", "a failed write is not a stop");
      assert.match(waiting.stopDetail ?? "", new RegExp(`^${LIFECYCLE_WAITING_DETAIL}loop.start`));
      assert.match(waiting.lifecycle!.error ?? "", /send failed/);
      assert.deepEqual(publicLoop(waiting).chain?.owed, ["loop.start"]);
      assert.deepEqual(written, []);
      // The next tick.
      assert.isFalse(await lifecycleBeforeStep("loop-start-2"));
      const paid = readLoop("loop-start-2")!;
      assert.isUndefined(paid.stopDetail, "the waiting detail goes once the record is on chain");
      assert.isUndefined(paid.lifecycle!.error);
      assert.deepEqual(written, ["loop.start:loop-start-2"]);
    });

    it("a loop started with its deploy names the deploy transaction, not a message", () => {
      startLoop(row("loop-start-3"), undefined, { deployTx: "deploy-sig" });
      cancel("loop-start-3");
      const args = readLoop("loop-start-3")!.lifecycle!.owed[0].args as Record<string, unknown>;
      assert.equal(args.deployTx, "deploy-sig");
      assert.notProperty(args, "auth");
      assert.notProperty(args, "startBodyHash");
    });
  });

  describe("transitions", () => {
    it("pause, resume and stop are written in order, and never while a step holds the slot", async () => {
      started("loop-order");
      await lifecycleBeforeStep("loop-order");
      // A step in flight holds the run slot; the owner pauses meanwhile.
      const step = acquireRunSlot("loop loop-order", 60_000)!;
      pauseLoop("loop-order", { by: "owner", auth: AUTH });
      await sleep(600);
      assert.deepEqual(written, ["loop.start:loop-order"], "nothing lands beside the step");
      written.push("loop.step:loop-order");
      step.release();
      await lifecyclePayersSettled();
      assert.deepEqual(written, ["loop.start:loop-order", "loop.step:loop-order", "loop.pause:loop-order"]);
      const paused = readLoop("loop-order")!;
      assert.equal(paused.lifecycle!.records.at(-1)!.tool, "loop.pause");

      resumeLoop("loop-order", { by: "owner", auth: AUTH });
      cancel("loop-order");
      // A running loop's resume is its next step's to pay.
      assert.deepEqual(
        readLoop("loop-order")!.lifecycle!.owed.map((o) => o.tool),
        ["loop.resume"]
      );
      assert.isFalse(await lifecycleBeforeStep("loop-order"));

      stopLoop("loop-order", "stopped", {}, undefined, { by: "owner", auth: AUTH });
      stopLoop("loop-order", "budget"); // a second stop is a no-op, and owes nothing
      await sleep(50);
      await lifecyclePayersSettled();
      assert.deepEqual(written.slice(3), ["loop.resume:loop-order", "loop.stop:loop-order"]);
      const stopped = readLoop("loop-order")!;
      assert.lengthOf(stopped.lifecycle!.owed, 0);
      assert.deepEqual(
        stopped.lifecycle!.records.map((r) => r.tool),
        ["loop.start", "loop.pause", "loop.resume", "loop.stop"]
      );
    });

    it("a stop the console makes is the console's, with the reason, steps and last step seq", () => {
      started("loop-console-stop");
      updateLoop("loop-console-stop", (l) => ({
        ...l,
        status: "stopped",
        stopReason: "goal-reached",
        stopDetail: "goal reached after 2 of 5 steps",
        snapshot: { ...l.snapshot, steps: 2, lastSeq: "17" },
      }));
      const stop = readLoop("loop-console-stop")!.lifecycle!.owed.at(-1)!;
      assert.equal(stop.tool, "loop.stop");
      assert.deepInclude(stop.args, {
        by: "console",
        reason: "goal-reached",
        detail: "goal reached after 2 of 5 steps",
        steps: 2,
        lastStepSeq: "17",
      });
      assert.notProperty(stop.args, "auth");
      assert.deepEqual(stop.result, { v: 1, id: "loop-console-stop", status: "stopped", reason: "goal-reached" });
    });

    it("waits while a step's checkpoint is owed, so nothing lands between its Resolution and its loop.step", async () => {
      started("loop-deferred");
      await lifecycleBeforeStep("loop-deferred");
      updateLoop("loop-deferred", (l) => ({
        ...l,
        status: "stopped",
        stopReason: "anchor-failed",
        history: [{ step: 1, status: "ok", deferredCheckpoint: { step: 1 } } as any],
      }));
      assert.equal((await payOwedLifecycle("loop-deferred", 0)).status, "held");
      await lifecyclePayersSettled();
      assert.deepEqual(written, ["loop.start:loop-deferred"]);
      // The Retry lands the checkpoint (and finishes the run as max-steps): the stop replaces the
      // one still owed, and is written after the checkpoint.
      updateLoop("loop-deferred", (l) => ({
        ...l,
        stopReason: "max-steps",
        history: l.history.map((h) => ({ ...h, deferredCheckpoint: undefined })),
      }));
      written.push("loop.step:loop-deferred");
      assert.deepEqual(
        readLoop("loop-deferred")!.lifecycle!.owed.map((o) => [o.tool, (o.args as any).reason]),
        [["loop.stop", "max-steps"]]
      );
      assert.equal((await payOwedLifecycle("loop-deferred", 0)).status, "paid");
      assert.deepEqual(written, ["loop.start:loop-deferred", "loop.step:loop-deferred", "loop.stop:loop-deferred"]);
    });

    it("a Retry's resume names its reason, and a stop still owed is replaced by the next", () => {
      const current = { status: "stopped" as const, stopReason: "anchor-failed" };
      const next = { id: "l", status: "running" as const, snapshot: { steps: 1 } as any };
      const resume = transitionOwed(current, next, { by: "owner", auth: AUTH, resumeReason: "retry" })!;
      assert.equal(resume.tool, "loop.resume");
      assert.deepInclude(resume.args, { by: "owner", reason: "retry", auth: AUTH });
      assert.isNull(
        transitionOwed({ status: "stopped", stopReason: "x" }, { ...next, status: "stopped", stopReason: "x" }, null)
      );
      const a = loopTransitionEntry("loop.stop", "l", { reason: "anchor-failed" });
      const b = loopTransitionEntry("loop.stop", "l", { reason: "max-steps" });
      const state = withOwed(withOwed({ records: [], owed: [] }, a), b);
      assert.deepEqual(
        state.owed.map((o) => (o.args as any).reason),
        ["max-steps"]
      );
    });
  });

  describe("the kill switch", () => {
    it("LATH_LIFECYCLE=off owes and writes nothing", async () => {
      process.env.LATH_LIFECYCLE = "off";
      started("loop-off");
      assert.isUndefined(readLoop("loop-off")!.lifecycle);
      pauseLoop("loop-off");
      stopLoop("loop-off");
      oweAgentDeploy(AGENT, "sig");
      assert.isFalse(await lifecycleBeforeStep("loop-off"));
      await sleep(20);
      await lifecyclePayersSettled();
      assert.deepEqual(written, []);
      assert.isUndefined(lookupAgent(AGENT)!.lifecycle);
      assert.notProperty(publicLoop(readLoop("loop-off")!), "chain");
    });

    it("a row from before the records owes nothing for its transitions", async () => {
      recordLoop(row("loop-old"));
      pauseLoop("loop-old");
      await sleep(20);
      assert.isUndefined(readLoop("loop-old")!.lifecycle);
      assert.deepEqual(written, []);
    });
  });

  describe("agents", () => {
    it("a deploy owes agent.deploy with the transaction, and it is paid under the slot", async () => {
      oweAgentDeploy(AGENT, "deploy-sig");
      const owed = lookupAgent(AGENT)!.lifecycle!.owed[0];
      assert.equal(owed.tool, "agent.deploy");
      assert.deepInclude(owed.args, { deployTx: "deploy-sig", name: NAME, owner: OWNER, agentId: AGENT });
      // Kicked a turn later, under the slot; nothing is left owed for an explicit pass to pay.
      await sleep(20);
      await lifecyclePayersSettled();
      assert.equal((await payOwedAgentLifecycle(AGENT, 0)).status, "none");
      assert.deepEqual(written, [`agent.deploy:${AGENT}`]);
      assert.deepEqual(
        lookupAgent(AGENT)!.lifecycle!.records.map((r) => r.tool),
        ["agent.deploy"]
      );
      // A second confirm (a retried one) owes nothing new.
      oweAgentDeploy(AGENT, "deploy-sig");
      assert.lengthOf(lookupAgent(AGENT)!.lifecycle!.owed, 0);
    });
  });

  describe("the writer", () => {
    it("writes the start document in the clear, anchored, with no private half beside it", async () => {
      const server = Keypair.generate();
      const authority = deployedRoles(server, NAME).agent.key.publicKey;
      const chain = new MiniChain(new Map([[AGENT, authority]]));
      const plain = new MemoryTraceStore();
      const { deps, anchor } = writerDeps(chain, plain, { authority });
      const entry = loopStartEntry(row("loop-w"), {
        auth: AUTH,
        startBody: { agentId: AGENT, prompt: "keep a one-page note current" },
      });
      const ref = await writeLifecycle({ agentId: AGENT, name: NAME }, entry, deps);
      assert.equal(ref.tool, "loop.start");
      assert.equal(ref.seq, "0");
      assert.lengthOf(chain.records, 1);

      // The public document, read back from the plain store by the hash the chain's preimage names.
      const docs = await Promise.all(
        [...anchor.cells.keys()].map(async (h) => ({ h, bytes: await plain.get(toBytes32(h)) }))
      );
      const startDoc = docs.map((d) => parseLoopStartDoc(d.bytes)).find((d) => d);
      assert.ok(startDoc, "the start document is plain and anchored");
      assert.equal(startDoc!.loopId, "loop-w");
      // `privateHash` is written only when set, so a start without a private half hashes the way
      // the document did before the field existed, and an older reader parses it unchanged.
      assert.notProperty(startDoc!, "privateHash");
      // Every anchored blob is one the plain store holds: nothing was sealed on the side.
      for (const d of docs) {
        assert.ok(d.bytes, `anchored ${d.h} is in the plain store`);
        assert.notInclude(new TextDecoder().decode(d.bytes!), "keep a one-page note current");
      }
    });

    it("refuses a journal that holds a failed write or a charge, and drains one that only carries records", async () => {
      const authority = Keypair.generate().publicKey;
      const chain = new MiniChain(new Map([[AGENT, authority]]));
      const entry = loopTransitionEntry("loop.pause", "loop-j", { by: "owner" });
      const failed = writerDeps(chain, new MemoryTraceStore(), {
        queue: { carried: async () => [{ state: "failed" }], drain: async () => assert.fail("no drain") },
      });
      let error = "";
      await writeLifecycle({ agentId: AGENT, name: NAME }, entry, failed.deps).catch((e) => (error = e.message));
      assert.match(error, /failed/);
      const charged = writerDeps(chain, new MemoryTraceStore(), {
        queue: { carried: async () => [{ state: "pending" }], drain: async () => assert.fail("no drain") },
        carriedPayers: async () => [OWNER],
      });
      await writeLifecycle({ agentId: AGENT, name: NAME }, entry, charged.deps).catch((e) => (error = e.message));
      assert.match(error, /charges owed/);
      assert.lengthOf(chain.records, 0, "nothing written over an owed journal");
      let drained = 0;
      let bound = 0;
      const records = writerDeps(chain, new MemoryTraceStore(), {
        queue: { carried: async () => [{ state: "pending" }], drain: async () => void drained++ },
        carriedPayers: async () => [],
        bind: () => void bound++,
      });
      await writeLifecycle({ agentId: AGENT, name: NAME }, entry, records.deps);
      assert.deepEqual([bound, drained, chain.records.length], [1, 1, 1]);
    });

    it("refuses a chain another key operates", async () => {
      const chain = new MiniChain(new Map([[AGENT, Keypair.generate().publicKey]]));
      const { deps } = writerDeps(chain, new MemoryTraceStore(), { authority: Keypair.generate().publicKey });
      let error = "";
      await writeLifecycle({ agentId: AGENT, name: NAME }, loopTransitionEntry("loop.stop", "x", {}), deps).catch(
        (e) => (error = e.message)
      );
      assert.match(error, /not operated by this runtime/);
    });
  });

  describe("the rebuild", () => {
    it("rebuilds this console's agents and loops from the chain as read-only rows, and nobody else's", async () => {
      const server = Keypair.generate();
      const mine = deployedRoles(server, NAME).agent.key.publicKey;
      const stranger = "someone-elses-agent";
      const strangerId = hex(idFromString(stranger));
      const chain = new MiniChain(
        new Map([
          [AGENT, mine],
          [strangerId, Keypair.generate().publicKey],
        ])
      );
      const plain = new MemoryTraceStore();
      const { deps } = writerDeps(chain, plain, { authority: mine });
      const target = { agentId: AGENT, name: NAME };
      const agent: DeployedAgent = {
        name: NAME,
        authority: mine.toBase58(),
        owner: OWNER,
        createdAt: 1_791_000_000_000,
        policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
      };
      const entries: OwedLifecycle[] = [
        agentDeployEntry(AGENT, agent, "deploy-sig"),
        loopStartEntry(row("loop-rebuilt"), { auth: AUTH, startBody: { agentId: AGENT } }),
        loopTransitionEntry("loop.stop", "loop-rebuilt", { reason: "goal-reached", steps: 2, lastStepSeq: "5" }),
        loopStartEntry(row("loop-live", { createdAt: 1_791_000_100_000 }), { auth: AUTH }),
        // A goal loop: its prompt is its goal, so the hashes match and the public goal is the prompt.
        loopStartEntry(
          row("loop-goal", {
            prompt: "a one-page note",
            promptHash: hex(sha256(utf8("a one-page note"))),
            status: "stopped",
            createdAt: 1_791_000_200_000,
          }),
          { auth: AUTH }
        ),
        loopTransitionEntry("loop.stop", "loop-goal", { reason: "goal-reached", steps: 1, lastStepSeq: "8" }),
      ];
      for (const e of entries) await writeLifecycle(target, e, deps);
      // A stranger's chain claiming this console's authority: its header says otherwise, so it is skipped.
      const fake = agentDeployEntry(strangerId, { ...agent, name: stranger, authority: mine.toBase58() });
      await writeLifecycle({ agentId: strangerId, name: stranger }, fake, { ...deps, authority: undefined });

      clearStore();
      assert.deepEqual(readLoops(), {});
      const added = await rebuildFromChain({
        server,
        client: chain as unknown as LathClient,
        reader: () => plain,
      });
      assert.deepEqual(added, { agents: 1, loops: 3 });
      assert.deepEqual(Object.keys(readRegistry()), [AGENT]);
      const a = lookupAgent(AGENT)!;
      assert.equal(a.owner, OWNER);
      assert.isTrue(a.lifecycle!.rebuilt);

      const done = readLoop("loop-rebuilt")!;
      assert.equal(done.status, "stopped");
      assert.equal(done.stopReason, "goal-reached");
      assert.equal(done.snapshot.steps, 2);
      // The chain holds the prompt's hash and not its text, so a rebuilt row whose prompt is not its
      // goal has no prompt to show: empty, and the hash still says what it was.
      assert.equal(done.prompt, "");
      assert.equal(done.promptHash, hex(sha256(utf8("keep a one-page note current"))));
      assert.equal(done.goal, "a one-page note");
      // A goal loop's prompt is its goal, which the start document carries in the clear.
      const goal = readLoop("loop-goal")!;
      assert.equal(goal.prompt, "a one-page note");
      assert.equal(goal.status, "stopped");
      assert.deepEqual(publicLoop(done).chain?.rebuilt, true);
      assert.deepEqual(
        done.lifecycle!.records.map((r) => r.tool),
        ["loop.start", "loop.stop"]
      );

      // Read-only: nothing here moves it.
      const live = readLoop("loop-live")!;
      assert.equal(live.status, "running");
      assert.equal(pauseLoop("loop-live")!.status, "running");
      assert.equal(stopLoop("loop-live")!.status, "running");
      assert.equal(resumeRefusal(live), REBUILT_REFUSAL);
      assert.equal(retryRefusal(done), REBUILT_REFUSAL);
      assert.isFalse(await lifecycleBeforeStep("loop-live"));
      await sleep(20);
      assert.deepEqual(written, [], "a rebuilt row owes nothing");

      // A second pass adds nothing it already has.
      assert.deepEqual(
        await rebuildFromChain({
          server,
          client: chain as unknown as LathClient,
          reader: () => plain,
        }),
        { agents: 0, loops: 0 }
      );
    });
  });
});
