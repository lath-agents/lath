/**
 * Lifecycle records (`sdk/src/lifecycle.ts`): an agent's deploy and a loop's start, pause, resume
 * and stop as standalone `Action`s on the agent's chain, read back and folded into the status a
 * console shows.
 *
 * Pinned here:
 *
 * - **the documents.** Canonical bytes, so two writers commit the same hash; a parser that reads
 *   this version and refuses anything else rather than misreading it.
 * - **the fold.** Start → running, pause → paused, resume → running, stop → stopped with its
 *   reason; steps counted in the seq window, or `null` when another loop's window meets it; a goal
 *   reached from a 201 step or the stop's reason; a transition before its start counted as out of
 *   order.
 * - **the reader.** Records written through a real `AgentLogger` come back from `listByTool` with
 *   their documents; a store that lacks them gives `null`s, never a throw, and an old chain with
 *   none gives nothing.
 *
 * Node-only: no validator, no RPC, no key, and nothing that can spend money.
 */
import { assert } from "chai";
import {
  AgentLogger,
  AGENT_DEPLOY_TOOL,
  AGENT_ARCHIVE_TOOL,
  Bytes32,
  EventPayload,
  EventRecord,
  LathClient,
  LifecycleEntry,
  LogResult,
  LOOP_PAUSE_TOOL,
  LOOP_RESUME_TOOL,
  LOOP_START_TOOL,
  LOOP_STEP_TOOL,
  LOOP_STOP_TOOL,
  LoopStartDoc,
  LoopTransitionDoc,
  MemoryTraceStore,
  computeHead,
  foldAgent,
  foldLoops,
  hex,
  idFromString,
  lifecycleAction,
  lifecycleBytes,
  lifecycleResult,
  parseLoopStartDoc,
  parseLoopTransitionDoc,
  parseSignedMessage,
  readAgentLifecycle,
  sha256,
  toEventInput,
  unkeyedStarts,
  utf8,
  ZERO32,
} from "../sdk/src";

const AGENT = sha256(utf8("lifecycle-test-agent"));
const AGENT_HEX = hex(AGENT);

/** The two client calls the reader and the logger use, over an in-memory chain that folds the real head. */
class MiniChain {
  readonly records: EventRecord[] = [];
  private head: Bytes32 = ZERO32;

  async logEvent(agentId: Bytes32, payload: EventPayload, opts: { timestamp?: number } = {}): Promise<LogResult> {
    const input = toEventInput(payload, BigInt(opts.timestamp ?? Date.now()));
    const seq = BigInt(this.records.length);
    this.head = computeHead(this.head, agentId, seq, input);
    this.records.push({
      agentId,
      seq,
      timestamp: input.timestamp,
      kind: input.kind,
      status: input.status,
      reference: input.reference,
      payloadHash: input.payloadHash,
      head: this.head,
    } as EventRecord);
    return { signature: `sig-${seq}`, seq, head: this.head, input } as LogResult;
  }

  async listByTool(agentId: Bytes32, toolId: string): Promise<EventRecord[]> {
    const ref = hex(idFromString(toolId));
    return this.records.filter((r) => hex(r.agentId) === hex(agentId) && r.kind === 1 && hex(r.reference) === ref);
  }
}

function startDoc(loopId: string, extra: Partial<LoopStartDoc> = {}): LoopStartDoc {
  return {
    v: 1,
    loopId,
    agentId: AGENT_HEX,
    owner: "7HtXMnJ554D4AiN4GKmCoKCE3PQEczQ5m4gsxGdQBbHD",
    createdAt: 1_791_000_000_000,
    intervalMs: 10_000,
    maxSteps: 6,
    budgetMicroUsdc: "1000000",
    promptHash: hex(sha256(utf8("prompt"))),
    goal: "a one-page note",
    goalHash: hex(sha256(utf8("a one-page note"))),
    terms: { model: "openai/gpt-5-mini" },
    ...extra,
  };
}

function transition(loopId: string, extra: Partial<LoopTransitionDoc> = {}): LoopTransitionDoc {
  return { v: 1, loopId, at: 1_791_000_100_000, by: "console", ...extra };
}

/** An entry as `readLifecycle` returns it, without a chain: what the fold reads. */
function entry(tool: string, seq: number, args: object | null): LifecycleEntry {
  return {
    tool,
    record: {} as EventRecord,
    seq: BigInt(seq),
    timestamp: BigInt(seq),
    statusCode: 200,
    argsHash: null,
    resultHash: null,
    argsBytes: args ? lifecycleBytes(args) : null,
    result: null,
  };
}

describe("lifecycle records", () => {
  describe("documents", () => {
    it("commit canonical bytes: key order does not change the hash", () => {
      const a = lifecycleBytes({ b: 1, a: { d: 2, c: 3 } });
      const b = lifecycleBytes({ a: { c: 3, d: 2 }, b: 1 });
      assert.equal(hex(sha256(a)), hex(sha256(b)));
    });

    it("parse this version and refuse other shapes", () => {
      const doc = startDoc("loop-1");
      assert.deepEqual(parseLoopStartDoc(lifecycleBytes(doc)), doc);
      assert.isNull(parseLoopStartDoc(lifecycleBytes({ ...doc, v: 2 })));
      assert.isNull(parseLoopStartDoc(lifecycleBytes({ ...doc, maxSteps: "6" })));
      assert.isNull(parseLoopStartDoc(utf8("not json")));
      assert.isNull(parseLoopStartDoc(null));
      assert.isNull(parseLoopTransitionDoc(lifecycleBytes({ ...transition("loop-1"), by: "someone" })));
      assert.isNull(parseLoopStartDoc(lifecycleBytes({ ...doc, auth: { message: "m" } })));
    });

    it("write as a 200 Action whose args and result are the canonical documents", () => {
      const a = lifecycleAction({
        tool: LOOP_STOP_TOOL,
        args: transition("loop-1", { reason: "goal-reached" }),
        result: lifecycleResult("loop-1", "stopped", "goal-reached"),
      });
      assert.equal(a.toolId, "loop.stop");
      assert.equal(a.statusCode, 200);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(a.result)), {
        id: "loop-1",
        reason: "goal-reached",
        status: "stopped",
        v: 1,
      });
    });

    it("read a console's signed message", () => {
      const message =
        "localhost:3000 wants you to sign in with your Solana account:\n" +
        "7HtXMnJ554D4AiN4GKmCoKCE3PQEczQ5m4gsxGdQBbHD\n\n" +
        `Lath loop: start ${AGENT_HEX}\n\n` +
        "URI: http://localhost:3000\nVersion: 1\nChain ID: devnet\nNonce: 0123456789abcdef\n" +
        "Issued At: 2026-10-10T20:00:00.000Z\nRequest ID: " +
        "ab".repeat(32);
      const parsed = parseSignedMessage(message)!;
      assert.equal(parsed.wallet, "7HtXMnJ554D4AiN4GKmCoKCE3PQEczQ5m4gsxGdQBbHD");
      assert.equal(parsed.purpose, "Lath loop");
      assert.equal(parsed.action, "start");
      assert.equal(parsed.target, AGENT_HEX);
      assert.equal(parsed.field("Request ID"), "ab".repeat(32));
      assert.isNull(parseSignedMessage("Lath loop: start x"));
    });
  });

  describe("fold", () => {
    it("start, pause, resume, stop: the status the last transition leaves", () => {
      const entries = [
        entry(LOOP_START_TOOL, 3, startDoc("loop-1")),
        entry(LOOP_PAUSE_TOOL, 10, transition("loop-1", { by: "owner" })),
      ];
      assert.equal(foldLoops(AGENT_HEX, entries)[0].status, "paused");
      entries.push(entry(LOOP_RESUME_TOOL, 11, transition("loop-1", { by: "owner" })));
      assert.equal(foldLoops(AGENT_HEX, entries)[0].status, "running");
      entries.push(entry(LOOP_STOP_TOOL, 20, transition("loop-1", { reason: "max-steps", steps: 6 })));
      const [loop] = foldLoops(AGENT_HEX, entries);
      assert.equal(loop.status, "stopped");
      assert.equal(loop.stopReason, "max-steps");
      assert.equal(loop.steps, 6);
      assert.equal(loop.transitions.length, 3);
      assert.equal(loop.outOfOrder, 0);
    });

    it("counts steps in the seq window while running, and a 201 inside it is a goal reached", () => {
      const steps = [
        { seq: 2n, statusCode: 200 }, // before the start: an earlier run's
        { seq: 7n, statusCode: 200 },
        { seq: 12n, statusCode: 201 },
      ];
      const [loop] = foldLoops(AGENT_HEX, [entry(LOOP_START_TOOL, 3, startDoc("loop-1"))], steps);
      assert.equal(loop.steps, 2);
      assert.isTrue(loop.goalReached);
    });

    it("leaves steps unattributed when another loop's window meets this one", () => {
      const entries = [entry(LOOP_START_TOOL, 3, startDoc("loop-1")), entry(LOOP_START_TOOL, 5, startDoc("loop-2"))];
      const loops = foldLoops(AGENT_HEX, entries, [{ seq: 8n, statusCode: 200 }]);
      assert.deepEqual(
        loops.map((l) => l.steps),
        [null, null]
      );
      // A loop that stopped before the next one started has a window of its own.
      const apart = foldLoops(
        AGENT_HEX,
        [
          entry(LOOP_START_TOOL, 3, startDoc("loop-1")),
          entry(LOOP_STOP_TOOL, 9, transition("loop-1", { reason: "stopped" })),
          entry(LOOP_START_TOOL, 12, startDoc("loop-2")),
        ],
        [
          { seq: 6n, statusCode: 200 },
          { seq: 15n, statusCode: 200 },
        ]
      );
      assert.deepEqual(
        apart.map((l) => l.steps),
        [1, 1]
      );
    });

    it("counts a transition before its start as out of order, and ignores a transition for a loop it cannot key", () => {
      const [loop] = foldLoops(AGENT_HEX, [
        entry(LOOP_PAUSE_TOOL, 1, transition("loop-1")),
        entry(LOOP_START_TOOL, 3, startDoc("loop-1")),
        entry(LOOP_STOP_TOOL, 4, transition("loop-9", { reason: "stopped" })),
      ]);
      assert.equal(loop.status, "running");
      assert.equal(loop.outOfOrder, 1);
    });

    it("an unreadable start is counted, not keyed", () => {
      const entries = [entry(LOOP_START_TOOL, 3, null), entry(LOOP_START_TOOL, 4, startDoc("loop-1"))];
      assert.lengthOf(foldLoops(AGENT_HEX, entries), 1);
      assert.lengthOf(unkeyedStarts(entries), 1);
    });

    it("an agent's deploy, and its archive mark", () => {
      const deploy = {
        v: 1,
        agentId: AGENT_HEX,
        name: "lifecycle-test-agent",
        owner: "7HtXMnJ554D4AiN4GKmCoKCE3PQEczQ5m4gsxGdQBbHD",
        authority: "11111111111111111111111111111112",
        createdAt: 1,
        policy: { model: "m" },
      };
      const agent = foldAgent(AGENT_HEX, [
        entry(AGENT_DEPLOY_TOOL, 0, deploy),
        entry(AGENT_ARCHIVE_TOOL, 5, { v: 1, agentId: AGENT_HEX, at: 5, by: "owner" }),
      ]);
      assert.equal(agent.deploy?.doc.name, "lifecycle-test-agent");
      assert.isTrue(agent.archived);
    });
  });

  describe("reader", () => {
    async function write(chain: MiniChain, store: MemoryTraceStore) {
      const logger = new AgentLogger(chain as unknown as LathClient, AGENT, { store, storePayloads: true });
      await logger.action(
        lifecycleAction({
          tool: LOOP_START_TOOL,
          args: startDoc("loop-1"),
          result: lifecycleResult("loop-1", "running"),
        })
      );
      await logger.action({ toolId: LOOP_STEP_TOOL, args: utf8("{}"), result: utf8("leaf"), statusCode: 201 });
      await logger.action(
        lifecycleAction({
          tool: LOOP_STOP_TOOL,
          args: transition("loop-1", { reason: "goal-reached", steps: 1, lastStepSeq: "1" }),
          result: lifecycleResult("loop-1", "stopped", "goal-reached"),
        })
      );
    }

    it("reads records written through a real logger back with their documents", async () => {
      const chain = new MiniChain();
      const store = new MemoryTraceStore();
      await write(chain, store);
      const read = await readAgentLifecycle(chain as unknown as LathClient, store, AGENT);
      assert.lengthOf(read.entries, 2);
      assert.equal(read.unkeyed, 0);
      const [loop] = read.loops;
      assert.equal(loop.loopId, "loop-1");
      assert.equal(loop.status, "stopped");
      assert.equal(loop.stopReason, "goal-reached");
      assert.isTrue(loop.goalReached);
      assert.equal(loop.steps, 1);
      assert.equal(read.entries[1].result?.status, "stopped");
      assert.isNull(read.agent.deploy);
    });

    it("a store without the documents gives nulls, not a throw", async () => {
      const chain = new MiniChain();
      await write(chain, new MemoryTraceStore());
      const read = await readAgentLifecycle(chain as unknown as LathClient, new MemoryTraceStore(), AGENT);
      assert.lengthOf(read.entries, 2);
      assert.isNull(read.entries[0].argsBytes);
      assert.lengthOf(read.loops, 0);
      assert.equal(read.unkeyed, 1);
      const none = await readAgentLifecycle(chain as unknown as LathClient, null, AGENT);
      assert.lengthOf(none.entries, 2);
    });

    it("an old chain with no lifecycle records reads as nothing recorded", async () => {
      const chain = new MiniChain();
      const store = new MemoryTraceStore();
      const logger = new AgentLogger(chain as unknown as LathClient, AGENT, { store, storePayloads: true });
      await logger.action({ toolId: LOOP_STEP_TOOL, args: utf8("{}"), result: utf8("leaf"), statusCode: 200 });
      const read = await readAgentLifecycle(chain as unknown as LathClient, store, AGENT);
      assert.lengthOf(read.entries, 0);
      assert.lengthOf(read.loops, 0);
      assert.isNull(read.agent.deploy);
      assert.isFalse(read.agent.archived);
    });
  });
});
