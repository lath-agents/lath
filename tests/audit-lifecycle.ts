/**
 * The lifecycle audit (`sdk/src/audit/lifecycle.ts`): an agent's deploy and its loops' starts and
 * transitions, held to the owner's word the documents carry, and wired into `lath-audit`'s report.
 *
 * Pinned here:
 *
 * - **old chains print as they did.** A chain with no lifecycle records audits to the same lines and
 *   the same JSON with the lifecycle check on as with it off.
 * - **the owner's signature.** A real Ed25519 key signs the console's own messages (`authMessage`):
 *   a valid start and owner transitions verify; a forged signature, a `Request ID` that is not the
 *   start body's hash, a transition signed by another wallet, and a small-order "owner" fail.
 * - **order.** A `loop.step` after a stop with no resume fails; with a resume it is fine.
 * - **the deploy transaction.** Without a reader it is unchecked; with one, it must be signed by the
 *   owner and carry `register_agent` for this agent id under the chain's authority.
 * - **private halves.** Unchecked without the key, verified with it, failed when the prompt does
 *   not re-hash.
 *
 * Node-only: no validator, no RPC, nothing that spends.
 */
import { assert } from "chai";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  AgentLogger,
  AGENT_DEPLOY_TOOL,
  authMessage,
  audit,
  Bytes32,
  computeHead,
  EncryptedTraceStore,
  EventPayload,
  EventRecord,
  exitCode,
  formatReport,
  hex,
  idFromString,
  LathClient,
  lifecycleAction,
  lifecycleBytes,
  lifecycleResult,
  LogResult,
  LOOP_PAUSE_TOOL,
  LOOP_RESUME_TOOL,
  LOOP_START_TOOL,
  LOOP_STEP_TOOL,
  LOOP_STOP_TOOL,
  loopAuthBinding,
  MemoryTraceStore,
  registerAgentIdOf,
  sha256,
  SolanaTxReader,
  SolanaTxView,
  toEventInput,
  utf8,
  ZERO32,
} from "../sdk/src";
import { SealingTraceStore, traceKey } from "./fixtures/sealed-traces";

const PROGRAM = "AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz";
const AUTHORITY = Keypair.generate().publicKey.toBase58();
const NAME = "audit-lifecycle-agent";
const AGENT = idFromString(NAME);
const AGENT_HEX = hex(AGENT);
const DEPLOY_SIG = "5deploy";

/** An in-memory chain with the calls `audit` and `AgentLogger` make, folding the real head. */
class MiniChain {
  readonly records: EventRecord[] = [];
  private head: Bytes32 = ZERO32;
  readonly programId = { toBase58: () => PROGRAM };

  async logEvent(agentId: Bytes32, payload: EventPayload, opts: { timestamp?: number } = {}): Promise<LogResult> {
    const input = toEventInput(payload, BigInt(opts.timestamp ?? 1_791_000_000_000 + this.records.length));
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
  async getAgentState() {
    return { state: { authority: { toBase58: () => AUTHORITY } } };
  }
  async verifyChain() {
    return {
      ok: true,
      headReached: true,
      records: this.records.length,
      seq: BigInt(this.records.length),
      head: this.head,
      missingSeqs: [],
      recoveredSeqs: [],
      resyncedSeqs: [],
      epochs: [],
    };
  }
  async listEvents() {
    return this.records;
  }
  async listByTool(agentId: Bytes32, toolId: string): Promise<EventRecord[]> {
    const ref = hex(idFromString(toolId));
    return this.records.filter((r) => hex(r.agentId) === hex(agentId) && r.kind === 1 && hex(r.reference) === ref);
  }
}

/** A wallet that signs the console's messages the way a browser wallet does: Ed25519 over the UTF-8 text. */
function wallet() {
  const kp = Keypair.generate();
  return {
    address: kp.publicKey.toBase58(),
    sign(purpose: "Lath loop" | "Lath agent", action: string, target: string, body?: string, as?: string) {
      const message = authMessage(purpose, {
        action,
        target,
        ...(body ? { body } : {}),
        domain: "localhost:3000",
        uri: "http://localhost:3000",
        cluster: "devnet",
        wallet: as ?? kp.publicKey.toBase58(),
        issued: "2026-10-10T20:00:00.000Z",
        nonce: "0123456789abcdef",
      });
      const signature = Buffer.from(nacl.sign.detached(utf8(message), kp.secretKey)).toString("base64");
      return { message, signature };
    },
  };
}

/** `register_agent`'s data as the program reads it: discriminator, `None` proof, tree info, index, id, created_at. */
function registerData(agentId: Uint8Array): string {
  const data = new Uint8Array(8 + 1 + 4 + 1 + 32 + 8);
  data.set([135, 157, 66, 195, 2, 113, 175, 30], 0);
  data.set(agentId, 14);
  return Buffer.from(data).toString("base64");
}

function txReader(view: Partial<SolanaTxView> | null, owner: string): SolanaTxReader {
  return {
    async getTransaction(signature: string) {
      if (signature !== DEPLOY_SIG || view === null) return null;
      return {
        slot: 1,
        err: null,
        signers: [AUTHORITY, owner],
        instructions: [{ programId: PROGRAM, accounts: [AUTHORITY], data: registerData(AGENT) }],
        tokenDeltas: [],
        ...view,
      };
    },
  };
}

type Wallet = ReturnType<typeof wallet>;
type Auth = { message: string; signature: string };

/** The start body every scenario signs, and the binding its signature names. */
const START_BODY = { agentId: AGENT_HEX, prompt: "write a one-page note", goal: "a one-page note", maxSteps: 6 };
const BINDING = loopAuthBinding(START_BODY);
const LOOP_ID = "loop-ab12cd34ef56";

interface Scenario {
  /** The owner's wallet; a fresh one when absent. */
  owner?: Wallet;
  /** Overrides on the start: its `auth`, `owner`. */
  start?: Record<string, unknown>;
  /** The owner's pause's `auth`, from the owner; the owner's own pause text when absent. */
  pauseAuth?: (owner: Wallet) => Auth;
  /** Leave out the resume, so the step after the stop has none before it. */
  stepAfterStop?: boolean;
  /** The stop's fields, from the owner; a console stop at goal-reached when absent. */
  stop?: (owner: Wallet) => Record<string, unknown>;
  /** The prompt the private half carries; the start's own when absent. */
  privatePrompt?: string;
}

/**
 * One agent's chain, written through a real `AgentLogger`: deploy, a start, a step, an owner's
 * pause and resume, a 201 step, a console stop at goal-reached. Public documents go to a plain
 * store; each private half is encrypted under `key` into the same backend, as a chain written
 * encrypted holds it (this build writes none; `tests/fixtures/sealed-traces.ts`).
 */
async function writeChain(s: Scenario = {}) {
  const chain = new MiniChain();
  const store = new MemoryTraceStore();
  const key = traceKey();
  const sealed = new SealingTraceStore(store.backend, key);
  const logger = new AgentLogger(chain as unknown as LathClient, AGENT, { store, storePayloads: true });
  const owner = s.owner ?? wallet();
  const prompt = START_BODY.prompt;
  const startBody = START_BODY;
  const binding = BINDING;
  const loopId = LOOP_ID;

  const agentPrivate = lifecycleBytes({ v: 1, agentId: AGENT_HEX, prompt });
  await sealed.put(agentPrivate);
  await logger.action(
    lifecycleAction({
      tool: AGENT_DEPLOY_TOOL,
      args: {
        v: 1,
        agentId: AGENT_HEX,
        name: NAME,
        owner: owner.address,
        authority: AUTHORITY,
        createdAt: 1_791_000_000_000,
        deployTx: DEPLOY_SIG,
        policy: { model: "openai/gpt-5-mini" },
        privateHash: hex(sha256(agentPrivate)),
      },
      result: lifecycleResult(AGENT_HEX, "deployed"),
    })
  );

  const loopPrivate = lifecycleBytes({ v: 1, loopId, prompt: s.privatePrompt ?? prompt, startBody });
  await sealed.put(loopPrivate);
  await logger.action(
    lifecycleAction({
      tool: LOOP_START_TOOL,
      args: {
        v: 1,
        loopId,
        agentId: AGENT_HEX,
        owner: owner.address,
        createdAt: 1_791_000_000_000,
        intervalMs: 10_000,
        maxSteps: 6,
        budgetMicroUsdc: "1000000",
        promptHash: hex(sha256(utf8(prompt))),
        goal: "a one-page note",
        startBodyHash: binding.body,
        auth: owner.sign("Lath loop", "start", binding.target, binding.body),
        privateHash: hex(sha256(loopPrivate)),
        terms: { model: "openai/gpt-5-mini" },
        ...s.start,
      },
      result: lifecycleResult(loopId, "running"),
    })
  );
  const step = (status: number) =>
    logger.action({ toolId: LOOP_STEP_TOOL, args: utf8(`{"s":${status}}`), result: utf8("leaf"), statusCode: status });
  const transition = (tool: string, extra: Record<string, unknown>, status: "paused" | "running" | "stopped") =>
    logger.action(
      lifecycleAction({
        tool: tool as typeof LOOP_STOP_TOOL,
        args: { v: 1, loopId, at: 1_791_000_100_000, ...extra },
        result: lifecycleResult(loopId, status, extra.reason as string | undefined),
      })
    );
  await step(200);
  await transition(
    LOOP_PAUSE_TOOL,
    { by: "owner", auth: s.pauseAuth ? s.pauseAuth(owner) : owner.sign("Lath loop", "pause", loopId) },
    "paused"
  );
  await transition(LOOP_RESUME_TOOL, { by: "owner", auth: owner.sign("Lath loop", "resume", loopId) }, "running");
  await step(201);
  await transition(
    LOOP_STOP_TOOL,
    s.stop ? s.stop(owner) : { by: "console", reason: "goal-reached", steps: 2 },
    "stopped"
  );
  if (s.stepAfterStop) await step(200);
  return { chain, store, key, sealed, owner, loopId };
}

describe("lifecycle audit", () => {
  it("prints an old chain with no lifecycle records exactly as before, lines and JSON", async () => {
    const chain = new MiniChain();
    const store = new MemoryTraceStore();
    const logger = new AgentLogger(chain as unknown as LathClient, AGENT, { store, storePayloads: true });
    await logger.action({ toolId: "http.get", args: utf8('{"u":"x"}'), result: utf8("{}"), statusCode: 200 });
    await logger.action({ toolId: LOOP_STEP_TOOL, args: utf8("{}"), result: utf8("leaf"), statusCode: 200 });
    const client = chain as unknown as LathClient;
    const before = await audit(client, AGENT, { store });
    const after = await audit(client, AGENT, { store, lifecycle: { tx: txReader(null, "") } });
    assert.isUndefined(after.lifecycle);
    assert.deepEqual(formatReport(after), formatReport(before));
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    assert.equal(exitCode(after), 0);
  });

  it("verifies a deploy, a signed start, owner transitions and a console stop", async () => {
    const w = await writeChain();
    const report = await audit(w.chain as unknown as LathClient, AGENT, {
      store: w.store,
      lifecycle: { tx: txReader({}, w.owner.address) },
    });
    const lines = formatReport(report);
    assert.equal(report.lifecycle?.verdict, "verified", lines.join("\n"));
    assert.isTrue(report.ok);
    assert.equal(exitCode(report), 0);
    const owner = w.owner.address;
    assert.include(lines, `deploy     owner ${owner.slice(0, 4)}…${owner.slice(-4)} · deploy tx verified`);
    assert.include(lines, "loops      1 recorded: loop-ab12cd3… stopped (goal-reached, 2 steps)");
    assert.include(
      lines,
      "  not checked here: deploy.private (the private half is encrypted: pass --trace-key <hex|path> to open it); " +
        "loop loop-ab12cd34ef56 private (the prompt is encrypted: pass --trace-key <hex|path> to open it)"
    );
    assert.equal(lines[lines.length - 1], "VERIFIED");
    const names = report.lifecycle!.checks.filter((c) => c.status === "ok").map((c) => c.name);
    assert.includeMembers(names, ["deploy.tx", "loop loop-ab12cd34ef56 start", "loop loop-ab12cd34ef56 pause"]);
    // The JSON carries the summary, and it serialises.
    assert.doesNotThrow(() => JSON.stringify(report));
  });

  it("fails a forged start signature, and says which part failed", async () => {
    const owner = wallet();
    const real = owner.sign("Lath loop", "start", BINDING.target, BINDING.body);
    const sig = Buffer.from(real.signature, "base64");
    sig[0] ^= 1;
    const c = await writeChain({
      owner,
      start: { auth: { message: real.message, signature: sig.toString("base64") } },
    });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    assert.equal(report.lifecycle?.verdict, "failed");
    assert.isFalse(report.ok);
    assert.equal(exitCode(report), 2);
    const start = report.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} start`)!;
    assert.equal(start.status, "failed");
    assert.equal(start.detail, `the signature does not verify for ${owner.address}`);
    const lines = formatReport(report);
    assert.include(lines, `  loop ${LOOP_ID} start (seq 1): the signature does not verify for ${owner.address}`);
    assert.equal(lines[lines.length - 1], "FAILED");
  });

  it("fails a start whose Request ID is not its startBodyHash", async () => {
    const owner = wallet();
    const c = await writeChain({
      owner,
      start: { auth: owner.sign("Lath loop", "start", AGENT_HEX, "cd".repeat(32)) },
    });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    const start = report.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} start`)!;
    assert.equal(start.status, "failed");
    assert.include(start.detail, "is not the start body hash");
    assert.equal(exitCode(report), 2);
  });

  it("fails a start signed by a wallet that is not its owner, or for another agent", async () => {
    const stranger = wallet();
    const c = await writeChain({ start: { auth: stranger.sign("Lath loop", "start", BINDING.target, BINDING.body) } });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    assert.include(report.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} start`)!.detail, "not the owner");
    const owner = wallet();
    const other = "ef".repeat(32);
    const c2 = await writeChain({ owner, start: { auth: owner.sign("Lath loop", "start", other, BINDING.body) } });
    const r2 = await audit(c2.chain as unknown as LathClient, AGENT, { store: c2.store, lifecycle: {} });
    assert.include(r2.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} start`)!.detail, `start ${other}`);
  });

  it("fails an owner's transition signed by another wallet, or for another verb", async () => {
    const stranger = wallet();
    const c = await writeChain({ pauseAuth: () => stranger.sign("Lath loop", "pause", LOOP_ID) });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    const pause = report.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} pause`)!;
    assert.equal(pause.status, "failed");
    assert.include(pause.detail, `signed by ${stranger.address}, not the owner`);
    assert.equal(exitCode(report), 2);
    // The verb is bound too: the owner's own "resume" text is not a pause.
    const c2 = await writeChain({ pauseAuth: (owner) => owner.sign("Lath loop", "resume", LOOP_ID) });
    const r2 = await audit(c2.chain as unknown as LathClient, AGENT, { store: c2.store, lifecycle: {} });
    const p2 = r2.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} pause`)!;
    assert.equal(p2.status, "failed");
    assert.include(p2.detail, `not "Lath loop: pause ${LOOP_ID}"`);
  });

  it("takes the agent's archive message as the owner's word for the stop it drove, and nothing else's", async () => {
    const archived = await writeChain({
      stop: (owner) => ({
        by: "owner",
        reason: "archived",
        steps: 2,
        auth: owner.sign("Lath agent", "archive", AGENT_HEX),
      }),
    });
    const r = await audit(archived.chain as unknown as LathClient, AGENT, { store: archived.store, lifecycle: {} });
    assert.equal(r.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} stop`)!.status, "ok");
    assert.include(formatReport(r), "loops      1 recorded: loop-ab12cd3… stopped (archived, 2 steps)");
    // An owner's stop with no message at all is the console's word dressed as the owner's.
    const bare = await writeChain({ stop: () => ({ by: "owner", reason: "stopped" }) });
    const r2 = await audit(bare.chain as unknown as LathClient, AGENT, { store: bare.store, lifecycle: {} });
    assert.equal(r2.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} stop`)!.status, "failed");
    // An unarchive is not an archive.
    const other = await writeChain({
      stop: (owner) => ({ by: "owner", reason: "archived", auth: owner.sign("Lath agent", "unarchive", AGENT_HEX) }),
    });
    const r3 = await audit(other.chain as unknown as LathClient, AGENT, { store: other.store, lifecycle: {} });
    assert.equal(r3.lifecycle!.checks.find((x) => x.name === `loop ${LOOP_ID} stop`)!.status, "failed");
  });

  it("refuses a small-order owner key, whose all-zero signature OpenSSL accepts for some messages", async () => {
    const zero = "11111111111111111111111111111111";
    const text = (nonce: string) =>
      authMessage("Lath loop", {
        action: "start",
        target: BINDING.target,
        body: BINDING.body,
        domain: "localhost:3000",
        uri: "http://localhost:3000",
        cluster: "devnet",
        wallet: zero,
        issued: "2026-10-10T20:00:00.000Z",
        nonce,
      });
    // A console forging the owner's word grinds the nonce until WebCrypto itself takes the zero
    // signature (about one message in four): the message the audit is then handed is one a bare
    // Ed25519 check would pass.
    const raw = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"]);
    let message = "";
    for (let i = 0; i < 256 && !message; i++) {
      const m = text(`nonce${i.toString(16).padStart(8, "0")}`);
      if (await crypto.subtle.verify({ name: "Ed25519" }, raw, new Uint8Array(64), utf8(m))) message = m;
    }
    assert.isNotEmpty(message, "some nonce makes the zero signature verify under a bare check");
    const auth = { message, signature: Buffer.alloc(64).toString("base64") };
    const c = await writeChain({ start: { owner: zero, auth } });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    const start = report.lifecycle!.checks.find((x) => x.name === "loop loop-ab12cd34ef56 start")!;
    assert.equal(start.status, "failed");
    assert.equal(start.detail, `the signature does not verify for ${zero}`);
  });

  it("fails a loop.step after a stop with no resume, and accepts one after a resume", async () => {
    const c = await writeChain({ stepAfterStop: true });
    const report = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    const order = report.lifecycle!.checks.find((x) => x.name === "loop loop-ab12cd34ef56 order")!;
    assert.equal(order.status, "failed");
    assert.include(order.detail, "loop.step at seq 7 after the loop stopped");

    // A resume after the stop puts the loop back: its next step is in order.
    const ok = await writeChain();
    const l2 = new AgentLogger(ok.chain as unknown as LathClient, AGENT, { store: ok.store, storePayloads: true });
    await l2.action(
      lifecycleAction({
        tool: LOOP_RESUME_TOOL,
        args: { v: 1, loopId: ok.loopId, at: 1, by: "console", reason: "retry" },
        result: lifecycleResult(ok.loopId, "running"),
      })
    );
    await l2.action({ toolId: LOOP_STEP_TOOL, args: utf8("{}"), result: utf8("leaf"), statusCode: 200 });
    const r2 = await audit(ok.chain as unknown as LathClient, AGENT, { store: ok.store, lifecycle: {} });
    assert.equal(r2.lifecycle?.verdict, "verified");
    assert.include(formatReport(r2), "loops      1 recorded: loop-ab12cd3… running");
  });

  it("checks the deploy transaction only with a reader, and holds it to the owner and the agent", async () => {
    const c = await writeChain();
    const unread = await audit(c.chain as unknown as LathClient, AGENT, { store: c.store, lifecycle: {} });
    assert.equal(unread.lifecycle?.verdict, "verified");
    assert.equal(unread.lifecycle!.checks.find((x) => x.name === "deploy.tx")!.status, "unchecked");
    assert.isTrue(
      formatReport(unread).some((l) => l.startsWith("deploy     owner ") && l.endsWith("· deploy tx not checked"))
    );

    const cases: [Partial<SolanaTxView> | null, string][] = [
      [null, "the cluster has no transaction"],
      [{ err: { InstructionError: [0, "Custom"] } }, "failed"],
      [{ signers: [AUTHORITY] }, "is not signed by the owner"],
      [
        { instructions: [{ programId: PROGRAM, accounts: [AUTHORITY], data: registerData(idFromString("other")) }] },
        "registers no agent",
      ],
      [
        { instructions: [{ programId: PROGRAM, accounts: [c.owner.address], data: registerData(AGENT) }] },
        "registers the agent under",
      ],
    ];
    for (const [view, says] of cases) {
      const report = await audit(c.chain as unknown as LathClient, AGENT, {
        store: c.store,
        lifecycle: { tx: txReader(view, c.owner.address) },
      });
      const tx = report.lifecycle!.checks.find((x) => x.name === "deploy.tx")!;
      assert.equal(tx.status, "failed", says);
      assert.include(tx.detail, says);
      assert.isTrue(formatReport(report).some((l) => l.endsWith("· deploy tx FAILED")));
    }
  });

  it("reads register_agent's agent id at its fixed offset, with and without a proof", () => {
    const id = sha256(utf8("x"));
    const none = Buffer.from(registerData(id), "base64");
    assert.equal(hex(registerAgentIdOf(new Uint8Array(none))!), hex(id));
    const some = new Uint8Array(8 + 1 + 128 + 4 + 1 + 32 + 8);
    some.set([135, 157, 66, 195, 2, 113, 175, 30], 0);
    some[8] = 1;
    some.set(id, 8 + 1 + 128 + 5);
    assert.equal(hex(registerAgentIdOf(some)!), hex(id));
    assert.isNull(registerAgentIdOf(new Uint8Array(60)));
  });

  it("opens the private halves with the key, and fails a prompt that does not re-hash", async () => {
    const c = await writeChain();
    const keyed = new EncryptedTraceStore(c.store.backend, c.key);
    const report = await audit(c.chain as unknown as LathClient, AGENT, {
      store: keyed,
      lifecycle: { keyed: true },
    });
    assert.equal(report.lifecycle?.verdict, "verified");
    const priv = report.lifecycle!.checks.filter((x) => x.name.endsWith("private"));
    assert.deepEqual(
      priv.map((x) => x.status),
      ["ok", "ok"]
    );
    assert.isFalse(formatReport(report).some((l) => l.includes("--trace-key")));

    const bad = await writeChain({ privatePrompt: "something else" });
    const r2 = await audit(bad.chain as unknown as LathClient, AGENT, {
      store: new EncryptedTraceStore(bad.store.backend, bad.key),
      lifecycle: { keyed: true },
    });
    assert.equal(r2.lifecycle?.verdict, "failed");
    const p = r2.lifecycle!.checks.find((x) => x.name === "loop loop-ab12cd34ef56 private")!;
    assert.include(p.detail, "promptHash");

    // The wrong key: the blob is there and will not open, which is a failure, not a gap.
    const r3 = await audit(c.chain as unknown as LathClient, AGENT, {
      store: new EncryptedTraceStore(c.store.backend, traceKey()),
      lifecycle: { keyed: true },
    });
    assert.equal(r3.lifecycle!.checks.find((x) => x.name === "loop loop-ab12cd34ef56 private")!.status, "failed");
  });

  it("counts a start it cannot open, and never fails it", async () => {
    const c = await writeChain();
    // A store with none of the documents: every lifecycle record is recorded, none readable.
    const report = await audit(c.chain as unknown as LathClient, AGENT, { lifecycle: {} });
    assert.equal(report.lifecycle?.verdict, "verified");
    assert.equal(report.lifecycle?.unkeyedStarts, 1);
    const lines = formatReport(report);
    assert.include(lines, "deploy     recorded, not readable here");
    assert.include(lines, "loops      1 recorded (1 start not readable here)");
    assert.equal(lines[lines.length - 1], "VERIFIED");
  });
});
