/**
 * The end-to-end flow against a real cluster and a Helius
 * ZK-compression RPC, not the local Light stack.
 *
 * Skipped unless `LATH_DEVNET_RPC` is set, because it spends real SOL and depends on
 * Light Protocol's deployed v2 trees:
 *
 * ```bash
 * LATH_DEVNET_RPC="https://devnet.helius-rpc.com/?api-key=…" npm run test:devnet
 * ```
 *
 * It funds nothing: the wallet at `ANCHOR_WALLET` (default `~/.config/solana/id.json`) pays,
 * and the whole run costs a few thousand lamports of fees plus one state-tree rollover share.
 * Each run uses a fresh agent id, so it is rerunnable against a chain that already has history.
 */
import { createRpc } from "@lightprotocol/stateless.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentLogger,
  AnchoredEpochStore,
  audit,
  BillingClient,
  computeHead,
  EventKind,
  GENESIS_HEAD,
  hex,
  idFromString,
  LathClient,
  LathLog,
  listSteps,
  LocatorRegistry,
  LocatorScheme,
  loopMemoryHash,
  FileEpochStore,
  FileTraceStore,
  formatInference,
  formatReport,
  FsLocatorBackend,
  HttpGatewayBackend,
  inferenceExitCode,
  IRYS_ENCODING,
  IRYS_GATEWAY,
  IrysBackend,
  MemoryEpochStore,
  MemoryTraceStore,
  NameRecord,
  AnchoredTraceStore,
  ResolutionStatus,
  selectOutputTree,
  sha256,
  TempoRpcReader,
  toBytes32,
  USDC_DECIMALS,
  utf8,
  verifyEpochBlob,
  verifyInference,
  verifyStep,
} from "../sdk/src";
import { DynamicStorageEngine } from "../scripts/dynamic-storage-engine";
import { AgentRuntime, ChatRequest, ChatResult, ChatTransport, LoopRunner, NoopBilling } from "../runtime/src";

/**
 * The treasury this deployment bills against (docs/ARCHITECTURE.md §12). Its admin is what the web
 * app is configured with; everything else — the vault, every balance, every allowance — is a
 * PDA under it, so checking the admin resolves is checking the whole billing configuration.
 */
const TREASURY_ADMIN = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";

const RPC = process.env.LATH_DEVNET_RPC;
/**
 * Helius serves RPC, Photon and the prover from one endpoint, which is why these default to
 * `RPC`. They exist so the *logic* of this suite can be smoke-run against a local Light stack
 * (which splits the three across ports) before it is trusted to run unattended on a nightly
 * cron — a test that has only ever run against devnet has never actually been debugged.
 */
const PHOTON = process.env.LATH_DEVNET_PHOTON ?? RPC;
const PROVER = process.env.LATH_DEVNET_PROVER ?? RPC;
const walletPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");

/**
 * Two turns per step, forever: a tool call, then an answer — the transport of `tests/loop.ts`,
 * so a loop against a live cluster still needs no model key. Every step ends with the same
 * sentence, so every step commits to the same memory hash; what the case checks is who resumed
 * from whom, and that the bytes reached the model.
 */
function cycling(costUsd: number, seen: ChatRequest[] = []): ChatTransport {
  let turn = 0;
  return {
    async chat(req: ChatRequest): Promise<ChatResult> {
      seen.push(req);
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: costUsd };
      const even = turn++ % 2 === 0;
      return {
        status: 200,
        body: {
          id: `step-${turn}`,
          model: req.model,
          choices: [
            even
              ? {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant" as const,
                    content: null,
                    tool_calls: [
                      { id: `c${turn}`, type: "function" as const, function: { name: "watch", arguments: "{}" } },
                    ],
                  },
                }
              : {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant" as const, content: "Nothing has changed since the last step." },
                },
          ],
          usage,
        },
      };
    },
  };
}

describe("devnet end-to-end", function () {
  this.timeout(300_000);

  let client: LathClient;
  let logger: AgentLogger;
  let payer: Keypair;
  // Kept as a string as well as an id, because a published name has to *be* the preimage of the
  // id it is published under (SPEC §14.2) — and it fits the 32-byte inline limit at this length.
  const agentName = `devnet-e2e-${process.pid}-${Date.now()}`;
  const agentId = idFromString(agentName);

  before(function () {
    if (!RPC) this.skip();
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
    // Helius serves the RPC, the Photon indexer and the prover from one endpoint.
    const rpc = createRpc(RPC, PHOTON, PROVER, { commitment: "confirmed" });
    client = LathClient.fromIdl(rpc, payer);
  });

  // Blobs go to a directory whose filenames are ids the backend picked, so the only way back to
  // them is the mapping the chain carries. A fresh directory per backend, removed after the run.
  const tmpDirs: string[] = [];
  const fsBackend = (scheme: number = LocatorScheme.Raw) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-devnet-"));
    tmpDirs.push(dir);
    return new FsLocatorBackend(dir, { scheme });
  };

  after(function () {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("talks to a deployed program and Light's v2 trees", async () => {
    const info = await client.rpc.getAccountInfo(client.programId);
    assert.isNotNull(info, `program ${client.programId.toBase58()} is not deployed on this cluster`);
    assert.isTrue(info!.executable);

    // The v2 address tree is a fixed account; state trees are discovered per cluster.
    const addressTree = await client.rpc.getAccountInfo(client.addressTree);
    assert.isNotNull(addressTree, "Light's batched address tree is missing on this cluster");
    const stateTree = await client.outputStateTree();
    assert.instanceOf(stateTree.tree, PublicKey);
  });

  it("registers an agent and logs the four primitives", async () => {
    logger = new AgentLogger(client, agentId, { store: new MemoryTraceStore() });
    assert.isTrue(await logger.ensureRegistered(), "expected a fresh agent id");

    const state = (await client.getAgentState(agentId))!.state;
    assert.equal(state.seq, 0n);
    assert.isTrue(state.authority.equals(payer.publicKey));
    assert.equal(hex(state.head), hex(GENESIS_HEAD));

    const g = await logger.genesis({
      sessionId: "devnet-session",
      caller: payer.publicKey,
      policyVersionHash: sha256(utf8("policy-v1")),
      input: { prompt: "summarise the quarterly report" },
    });
    assert.equal(g.seq, 0n);
    assert.equal(hex(g.head), hex(computeHead(GENESIS_HEAD, agentId, 0n, g.input)));

    const a = await logger.action({
      toolId: "http.post",
      args: { url: "https://api.example.com/report" },
      result: { id: 42 },
      statusCode: 200,
    });
    assert.equal(a.seq, 1n);

    const d = await client.logEvent(agentId, {
      kind: EventKind.Delegation,
      parentTaskId: "task-1",
      fromAgentPubkey: payer.publicKey,
      toAgentPubkey: Keypair.generate().publicKey,
      scopeHash: sha256(utf8("scope")),
    });
    assert.equal(d.seq, 2n);

    const r = await logger.resolve({
      taskId: "task-1",
      status: ResolutionStatus.Success,
      output: "done",
      totalStepCount: 3,
    });
    assert.equal(r.seq, 3n);
  });

  it("reads the records back through the indexer and replays the chain", async () => {
    const rec = await client.getEvent(agentId, 1n);
    assert.isNotNull(rec, "indexer did not return the action record");
    assert.equal(rec!.kind, EventKind.Action);
    assert.equal(rec!.status, 200);
    assert.equal(hex(rec!.reference), hex(idFromString("http.post")));

    assert.equal((await client.listByKind(agentId, EventKind.Action)).length, 1);
    assert.equal((await client.listByTool(agentId, "http.post")).length, 1);

    const chain = await client.verifyChain(agentId);
    assert.isTrue(chain.ok, `chain diverged at seq ${chain.firstBadSeq}`);
    assert.equal(chain.records, 4);
    assert.equal(chain.seq, 4n);
    assert.deepEqual(chain.missingSeqs, []);
  });

  it("has a treasury the app can bill against", async () => {
    const admin = new PublicKey(TREASURY_ADMIN);
    const billing = BillingClient.fromIdl(client.rpc, payer, { admin });
    const treasury = await billing.getTreasury();
    assert.isNotNull(treasury, `no treasury for admin ${TREASURY_ADMIN} — run scripts/init-treasury.ts`);
    assert.isTrue(treasury!.admin.equals(admin));
    assert.isTrue(treasury!.vault.equals(billing.vaultAddress()));
    // A treasury whose mint is not 6 decimals would silently mis-scale every amount in the UI.
    const mint = await client.rpc.getAccountInfo(treasury!.usdcMint);
    assert.isNotNull(mint, "the treasury's mint does not exist on this cluster");
    assert.equal(mint!.data[44], USDC_DECIMALS, "USDC must have 6 decimals");
    // The sweeper can only ever move metered spend, and only to the recorded destination.
    assert.isTrue(treasury!.totalSwept <= treasury!.totalSpent);
  });

  it("recovers a compact event from transaction history", async () => {
    const compact = await client.logEvent(
      agentId,
      {
        kind: EventKind.Action,
        toolId: "compact.tool",
        argsHash: sha256(utf8("a")),
        resultHash: sha256(utf8("r")),
        statusCode: 200,
      },
      { compact: true }
    );
    assert.equal(compact.seq, 4n);
    assert.isUndefined(compact.eventAddress);
    assert.isNull(await client.getEvent(agentId, 4n));

    // The compact write is the chain's tail, so the fold stops at the gap and never reaches
    // `AgentState.head`. Nothing diverged — nothing was compared — and that is exactly what
    // `headReached: false` says. `--recover` below turns it back into a full replay.
    const withGap = await client.verifyChain(agentId);
    assert.isFalse(withGap.ok, "a chain whose tail is a compact write is unchecked, not verified");
    assert.isFalse(withGap.headReached);
    assert.isUndefined(withGap.firstBadSeq);
    assert.deepEqual(withGap.missingSeqs, [4n]);

    const full = await logger.audit([], { recover: true });
    assert.isTrue(full.ok, `chain diverged at seq ${full.firstBadSeq}`);
    assert.deepEqual(full.missingSeqs, [], "Helius should still hold the recent transaction");
    assert.deepEqual(full.recoveredSeqs, [4n]);
  });

  it("round-trips a v0.2 cell: create a Log, append, read back, verify the chain", async () => {
    // v0.2 on devnet (PROMPT step 1): the deployed program must serve `create_struct` and
    // `create_cell`, and a cell write must fold into the same owner chain as the events above.
    const log = new LathLog(client, agentId, LathLog.id("devnet-log"), {
      store: new MemoryTraceStore(),
    });
    assert.isTrue(await log.ensureCreated(), "expected a fresh structure for a fresh agent id");

    const value = "devnet cell round-trip: longer than 32 bytes, so the slot is a commitment";
    const appended = await log.append(value, {
      tag: 7,
      reference: idFromString("devnet.e2e"),
    });
    assert.equal(appended.index, 0n);

    const entry = (await log.get(0))!;
    assert.isNotNull(entry, "indexer did not return the cell");
    assert.equal(entry.cell.tag, 7);
    assert.isFalse(entry.inline, "a >32-byte value must be committed, not inline");
    assert.isNotNull(entry.value, "the store should resolve the committed value");
    assert.equal(new TextDecoder().decode(entry.value!), value);
    assert.equal(await log.length(), 1n);

    // The header creation and the cell write each consumed one owner seq (5 and 6), and
    // verifyChain replays events, structures and cells as one ordered history.
    const chain = await client.verifyChain(agentId);
    assert.isTrue(chain.ok, `chain diverged at seq ${chain.firstBadSeq}`);
    assert.equal(chain.seq, 7n);
    assert.deepEqual(chain.missingSeqs, [4n], "the compact event is still off-indexer");
  });

  it("anchors a trace through the on-chain locator map and publishes a verified name", async () => {
    // The v0.4 surfaces (SPEC §14) on a real cluster. They add no instruction — both are `Map`s
    // — so what this actually checks is that the deployed program's `create_cell` serves them
    // and that Photon indexes the cells the SDK derives addresses for.
    const registry = new LocatorRegistry(client, agentId);
    assert.isTrue(await registry.ensureCreated(), "expected a fresh registry for a fresh agent id");

    const backend = fsBackend(LocatorScheme.Irys);
    const store = new AnchoredTraceStore(backend, registry);
    const trace = utf8(JSON.stringify({ session: agentName, transcript: "the verbose material" }));
    const hash = await store.put(trace);

    // The round-trip that matters: the bytes come back only because the chain said where they
    // are, and they are re-hashed on the way out.
    const back = await store.get(hash);
    assert.isNotNull(back, "the anchored trace did not resolve through the chain");
    assert.equal(hex(back!), hex(trace));
    assert.isTrue(await registry.has(hash));

    // A name is self-certifying: `sha256(agentName)` is this agent's id, so nothing about the
    // publication has to be trusted.
    const record = new NameRecord(client, agentId);
    assert.isTrue(await record.ensureCreated());
    await record.publish(agentName);
    assert.equal(await record.name(), agentName);

    const chain = await client.verifyChain(agentId);
    assert.isTrue(chain.ok, `chain diverged at seq ${chain.firstBadSeq}`);
    assert.deepEqual(chain.missingSeqs, [4n], "still only the compact event is off-indexer");
  });

  it("commits an epoch on the deployed program and audits it through the locator map", async function () {
    // A fresh owner, so the case reruns; the registry is created by the first anchor.
    const owner = idFromString(`devnet-epoch-${process.pid}-${Date.now()}`);
    const epochLogger = new AgentLogger(client, owner, { store: new MemoryTraceStore() });
    await epochLogger.ensureRegistered();
    await epochLogger.genesis({
      sessionId: "devnet-epoch",
      caller: payer.publicKey,
      policyVersionHash: sha256(utf8("policy-v1")),
      input: "batch three steps",
    });
    const backend = fsBackend();
    const store = new AnchoredEpochStore(backend, new LocatorRegistry(client, owner));
    const engine = new DynamicStorageEngine(
      { mode: "dynamic", standardBatchSize: 3, standardFlushDelayMs: 0, rateSampleWindowMs: 5000 },
      (input) => client.logEventInput(owner, input, false),
      client.createEpochCommitter(owner, store)
    );
    for (let i = 0; i < 3; i++) {
      await engine.push({
        kind: EventKind.Action,
        toolId: `devnet-tool-${i}`,
        argsHash: sha256(new Uint8Array([i])),
        resultHash: sha256(new Uint8Array([i, 1])),
        statusCode: 200,
      });
    }
    await engine.push({
      kind: EventKind.Resolution,
      taskId: "devnet-epoch",
      status: ResolutionStatus.Success,
      finalOutputHash: sha256(utf8("done")),
      totalStepCount: 3,
    });
    const epochs = await client.listEpochs(owner);
    assert.equal(epochs.length, 1, "the deployed program should have emitted EpochCommitted");
    assert.equal(epochs[0].startSeq, 1n);
    assert.equal(epochs[0].endSeq, 4n);
    // Read back by a client holding only the chain: root → locator → bytes → root again.
    const reader = new AnchoredEpochStore(backend, new LocatorRegistry(client, owner));
    const report = await audit(client, owner, { epochs: reader });
    assert.isTrue(report.ok, JSON.stringify(report));
    assert.equal(report.epochs!.checked, 1);
    assert.deepEqual(report.chain.missingSeqs, []);
  });
  // The claim a checkpoint makes is the step manifest on the loop's own chain, and the loop case
  // below covers it.

  it("a loop of three steps on devnet remembers across steps", async function () {
    // Epochs, checkpoints and the two together are covered above; this is a loop, which is what
    // the submission demonstrates. Three steps against the deployed
    // program, each one session with `rollup` on, each committing the previous step's answer as
    // `memoryHash`, and every step verified from the chain alone afterwards.
    //
    // Inference is the cycling transport of `tests/loop.ts`, so nothing here needs a model key;
    // the chain writes are real. Epochs stay in a `MemoryEpochStore` (as the loop suite does):
    // the point of this case is `commit_epoch` and the step records on devnet, and the anchored
    // path gets its own case below.
    const suffix = `${process.pid}-${Date.now()}-${Keypair.generate().publicKey.toBase58().slice(0, 8)}`;
    const loopAgentId = idFromString(`devnet-loop-${suffix}`);
    const loopId = `devnet-loop-${suffix}`;
    const epochs = new MemoryEpochStore();
    const traces = new MemoryTraceStore();
    const requests: ChatRequest[] = [];
    let clock = 1_700_000_000_000;
    const now = () => (clock += 1000);
    const runtime = new AgentRuntime({
      client,
      agentId: loopAgentId,
      transport: cycling(0.0001, requests),
      store: traces,
      billing: new NoopBilling(),
      now,
      storePayloads: true,
      rollup: { store: epochs, batchSize: 100 },
      policy: { model: "test/model", temperature: 0, toolAllowList: ["watch"], maxCost: 1_000_000 },
      tools: [{ name: "watch", execute: async () => ({ ok: true, at: now() }) }],
    });
    const runner = new LoopRunner({
      runtime,
      loopId,
      prompt: "Watch the cluster and report anything new.",
      intervalMs: 0,
      maxSteps: 3,
      user: payer.publicKey,
      startedAt: 1_700_000_000_000,
      now,
      sleep: async () => undefined,
    });

    const steps = [await runner.step(), await runner.step(), await runner.step()];
    for (const w of steps) {
      assert.equal(w.status, "success", w.reason);
      assert.equal(w.epochs.length, 1, "one epoch per step");
      assert.isTrue(w.leafOk);
    }

    // Memory: every step ends with the same sentence, so what matters is who resumed from whom.
    const remembered = loopMemoryHash("Nothing has changed since the last step.");
    assert.isUndefined(steps[0].resumedFromStep, "the first step starts fresh");
    for (const w of steps) assert.equal(w.memoryHash, remembered, `step ${w.step} committed its answer`);
    assert.equal(steps[1].resumedFromStep, 1);
    assert.equal(steps[1].resumedMemoryHash, steps[0].memoryHash);
    assert.equal(steps[2].resumedFromStep, 2);
    assert.equal(steps[2].resumedMemoryHash, steps[1].memoryHash);
    // The model of step 2 was handed step 1's answer, checked against the hash the chain holds.
    const step2System = requests[2].messages.filter((m) => m.role === "system");
    assert.equal(step2System.length, 1);
    assert.include(step2System[0].content, "Nothing has changed since the last step.");
    assert.include(step2System[0].content, `sha256 ${remembered}`);

    // The read side, from the deployed chain: three step records, each leaf and each memory
    // rebuilt and re-hashed by a reader holding only the chain and the trace store.
    const listed = await listSteps(client, loopAgentId);
    assert.equal(listed.length, 3);
    assert.deepEqual(
      listed.map((w) => w.seq.toString()),
      steps.map((w) => w.seq!)
    );
    for (const [i, w] of listed.entries()) {
      const verified = await verifyStep(loopAgentId, w, { store: traces });
      assert.equal(verified.verdict, "ok", JSON.stringify(verified));
      assert.equal(verified.leaf, steps[i].leaf);
      assert.equal(verified.manifest!.step, i + 1);
      assert.equal(verified.manifest!.loopId, loopId);
      assert.equal(verified.manifest!.memoryHash, remembered);
      assert.equal(verified.memory?.verdict, "ok", JSON.stringify(verified.memory));
      assert.equal(verified.memory?.hash, remembered);
    }

    const chain = await client.verifyChain(loopAgentId);
    assert.isTrue(chain.ok, `chain broken at ${chain.firstBadSeq}`);
    assert.deepEqual(chain.missingSeqs, []);
    assert.equal(chain.epochs.length, 3, "one epoch per step, folded by the verifier");

    const report = await audit(client, loopAgentId, { epochs, store: traces, requirePreimages: true });
    assert.isTrue(report.ok, JSON.stringify(report));
    assert.equal(report.epochs!.count, 3);
    assert.deepEqual(report.traces!.missing, []);
    assert.deepEqual(report.traces!.preimagesUnavailable, []);
  });

  it("anchors devnet epochs through one manifest cell per K", async function () {
    // On the deployed program: with
    // `every: K` the locator map gets one manifest cell per K epochs instead of one cell per
    // epoch, and a reader holding nothing but the chain still opens every blob.
    const suffix = `${process.pid}-${Date.now()}-${Keypair.generate().publicKey.toBase58().slice(0, 8)}`;
    const owner = idFromString(`devnet-manifest-${suffix}`);
    const ownerLogger = new AgentLogger(client, owner, { store: new MemoryTraceStore() });
    assert.isTrue(await ownerLogger.ensureRegistered(), "expected a fresh owner id");

    const backend = fsBackend();
    const registry = new LocatorRegistry(client, owner);
    const store = new AnchoredEpochStore(backend, registry, { every: 2 });
    const commitOne = client.createEpochCommitter(owner, store);
    let clock = Date.now();
    const step = (a: string, b: string) => ({
      timestamp: BigInt((clock += 1000)),
      kind: EventKind.Action,
      status: 200,
      reference: sha256(utf8(a)),
      payloadHash: sha256(utf8(b)),
    });

    // Two epochs: the first is queued, the second publishes the one manifest that carries both.
    const e1 = await commitOne([step("a", "b")]);
    assert.isTrue(e1.anchored && e1.anchorPending, "the first epoch waits for a manifest");
    const e2 = await commitOne([step("c", "d"), step("e", "f")]);
    assert.isTrue(e2.anchored);
    assert.isFalse(e2.anchorPending, "the second epoch published the manifest");
    assert.equal(store.pendingAnchors.length, 0);
    assert.equal((await store.manifests.entries()).length, 1, "one manifest cell for two epochs");
    assert.isFalse(await registry.has(e1.epochRoot), "no direct cell for the first epoch");
    assert.isFalse(await registry.has(e2.epochRoot), "no direct cell for the second");

    // A fresh reader: nothing but the chain, the manifest map and the gateway.
    const reader = new AnchoredEpochStore(backend, new LocatorRegistry(client, owner));
    for (const e of [e1, e2]) {
      const blob = await reader.get(e.epochRoot);
      assert.isNotNull(blob, `epoch ${hex(e.epochRoot)} resolves through the manifest`);
      assert.isNotNull(verifyEpochBlob(blob!, e.epochRoot, e.startSeq, e.endSeq));
    }
    const report = await audit(client, owner, { epochs: reader });
    assert.isTrue(report.ok, JSON.stringify(report));
    assert.equal(report.epochs!.checked, 2);
    assert.deepEqual(report.chain.missingSeqs, []);

    // A partial queue flushed on demand — what the console does when a loop stops.
    const e3 = await commitOne([step("g", "h")]);
    assert.isTrue(e3.anchorPending, "a lone third epoch is still queued");
    const flushed = await store.flush();
    assert.equal(flushed!.roots.length, 1);
    assert.isNull(await store.flush(), "nothing left to flush");
    assert.equal((await store.manifests.entries()).length, 2);
    assert.isFalse(await registry.has(e3.epochRoot), "the flush published a manifest, not a cell");
    const after = new AnchoredEpochStore(backend, new LocatorRegistry(client, owner));
    const blob3 = await after.get(e3.epochRoot);
    assert.isNotNull(blob3, "the flushed epoch resolves for a reader holding only the chain");
    assert.isNotNull(verifyEpochBlob(blob3!, e3.epochRoot, e3.startSeq, e3.endSeq));
    const full = await audit(client, owner, { epochs: after });
    assert.isTrue(full.ok, JSON.stringify(full));
    assert.equal(full.epochs!.checked, 3);
  });

  /**
   * The data-availability fallback: an upload that fails mid-session costs
   * the epoch its locator and nothing else — the session still resolves, the blob is kept
   * locally, and an auditor holding that directory still verifies the chain.
   *
   * The uploader is a real `IrysBackend` pointed at `127.0.0.1:9` (the discard port, where
   * nothing listens), so `upload` throws the connection error a node that is down or a key that
   * ran dry would produce. It is constructed here rather than through the console's
   * `irysBackendFor` (`frontend/src/app/api/_lib/runner.ts`), which reads the uploader's balance
   * and refuses at zero: with the node unreachable that read throws before a session ever
   * starts, which is the *refusal* — the other half of the fallback — and not the fallback itself.
   *
   * Off unless `LATH_DA_FALLBACK=1`, even with an RPC set, because it registers an agent and
   * writes a whole session to devnet:
   *
   * ```bash
   * LATH_DA_FALLBACK=1 LATH_DEVNET_RPC="…" \
   *   npx ts-mocha --paths -p ./tsconfig.json -t 300000 tests/devnet.ts -g 'uploader is unreachable'
   * ```
   */
  it("keeps the epoch blob locally when the uploader is unreachable, and still audits", async function () {
    if (process.env.LATH_DA_FALLBACK !== "1") this.skip();
    const suffix = `${process.pid}-${Date.now()}-${Keypair.generate().publicKey.toBase58().slice(0, 8)}`;
    const owner = idFromString(`devnet-da-fallback-${suffix}`);
    // One directory for both kinds of blob, because that is what the console has: the fallback
    // epoch store and the trace store are `LATH_TRACE_DIR`, and `--store`/`--epochs` name it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-da-fallback-"));
    tmpDirs.push(dir);
    const traces = new FileTraceStore(dir);
    const dead = "http://127.0.0.1:9";
    const backend = new IrysBackend({ wallet: payer, network: "devnet", rpc: RPC!, node: dead });
    const registry = new LocatorRegistry(client, owner);
    const epochs = new AnchoredEpochStore(backend, registry, { fallback: new FileEpochStore(dir) });

    let clock = 1_700_000_000_000;
    const runtime = new AgentRuntime({
      client,
      agentId: owner,
      transport: cycling(0.0001),
      store: traces,
      billing: new NoopBilling(),
      now: () => (clock += 1000),
      storePayloads: true,
      rollup: { store: epochs, batchSize: 100 },
      policy: { model: "test/model", temperature: 0, toolAllowList: ["watch"], maxCost: 1_000_000 },
      tools: [{ name: "watch", execute: async () => ({ ok: true }) }],
    });
    const session = await runtime.start({ user: payer.publicKey, prompt: "Report anything new." });

    // The session resolves: the upload failure never reaches the caller.
    assert.equal(session.status, "success", session.reason);
    const resolution = session.events[session.events.length - 1];
    assert.equal(resolution.input.kind, EventKind.Resolution, "the terminal record is the resolution");
    console.log(`fallback genesis     ${session.events[0].signature}`);
    console.log(`fallback resolution  ${resolution.signature}`);

    // The epoch is on chain and says where its bytes went.
    assert.equal(session.epochs.length, 1, "the closing flush committed one epoch");
    const commit = session.epochs[0];
    console.log(`fallback epoch       ${commit.signature} anchored=${commit.anchored}`);
    assert.isFalse(commit.anchored, "a blob that never reached the backend is not anchored");
    assert.match(commit.anchorError ?? "", /ECONNREFUSED|connect/i, "the error names the connection");
    assert.include(commit.anchorError ?? "", "127.0.0.1:9");
    assert.isFalse(await registry.has(commit.epochRoot), "no locator cell points at bytes nobody uploaded");

    // The bytes are in the fallback directory under the root the chain committed to.
    const kept = await new FileEpochStore(dir).get(commit.epochRoot);
    assert.isNotNull(kept, `epoch ${hex(commit.epochRoot)} is in ${dir}`);
    assert.isNotNull(
      verifyEpochBlob(kept!, commit.epochRoot, commit.startSeq, commit.endSeq),
      "the kept blob rebuilds the committed root"
    );

    // What `lath-audit --store <dir> --epochs <dir>` runs, verdict line included.
    const report = await audit(client, owner, {
      store: new FileTraceStore(dir),
      epochs: new FileEpochStore(dir),
      requirePreimages: true,
    });
    const lines = formatReport(report);
    assert.equal(lines[lines.length - 1], "VERIFIED", lines.join("\n"));
    assert.equal(report.epochs!.checked, 1, "the fallback blob was opened, not just counted");
    assert.deepEqual(report.traces!.preimagesUnavailable, []);
  });

  /**
   * Output-tree affinity on an older chain. An output tree drawn at random by
   * `selectStateTreeInfo` scatters an agent's accounts across the five state trees devnet runs, and
   * a two-input cell write then spends its owner header from one tree and its structure header from
   * another — `0x179b` from the Light system program. `selectOutputTree` pins the output to the
   * spent header's tree, and this is the case that says so on a chain whose accounts scattered.
   *
   * `LATH_F_M22_AGENT` is the agent — a name or a 32-byte hex id — and the case is skipped
   * without it, because there is no way to synthesise an old chain. Only the key that signed
   * `register_agent` may append, so `LATH_F_M22_KEYPAIR` is that key's path; the wallet at
   * `ANCHOR_WALLET` will not do unless it happens to be the same key. For an agent the console
   * deployed, `LATH_F_M22_NAME` alone is enough: its authority is `derived(server,
   * "owner:<name>")` from `LATH_RUNTIME_KEYPAIR` (`_lib/runner.ts`), re-derived here the same
   * way so the nightly can run the case with no key file beyond the one it already holds.
   */
  it("writes to an agent whose accounts predate output-tree affinity", async function () {
    const name = process.env.LATH_F_M22_NAME;
    const spec = process.env.LATH_F_M22_AGENT ?? name;
    if (!spec) this.skip();
    const id = /^[0-9a-f]{64}$/i.test(spec!) ? Uint8Array.from(Buffer.from(spec!, "hex")) : idFromString(spec!);

    const found = await client.getAgentState(id);
    assert.isNotNull(found, `${spec} is not registered on this cluster`);
    const ownerTree = found!.account.treeInfo;
    const discovered = await client.outputStateTree();
    const chosen = selectOutputTree([ownerTree], discovered);

    // The three trees the case is about, printed whatever happens next: the tree the spent
    // header lives in, the tree a random draw would give, and the one the client picks.
    console.log(`output tree ${spec} seq ${found!.state.seq}`);
    console.log(`  header tree   ${ownerTree.tree.toBase58()}`);
    console.log(`  discovered    ${discovered.tree.toBase58()}`);
    console.log(`  selected      ${chosen.tree.toBase58()}`);
    assert.equal(chosen.tree.toBase58(), ownerTree.tree.toBase58(), "the output tree is the spent header's");

    const keyPath = process.env.LATH_F_M22_KEYPAIR;
    const serverPath = process.env.LATH_RUNTIME_KEYPAIR ?? "frontend/.runtime-keypair.json";
    const loadKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
    // The console's own agent signs with the runtime key itself; one it deployed signs with the
    // derived owner key. Whichever matches the chain's authority is the one that may append.
    const server = !keyPath && name && fs.existsSync(serverPath) ? loadKey(serverPath) : null;
    const candidates = keyPath
      ? [loadKey(keyPath)]
      : server
      ? [Keypair.fromSeed(sha256(utf8(`lattice-console:owner:${name}:`), server.secretKey.slice(0, 32))), server]
      : [payer];
    const authority = candidates.find((k) => found!.state.authority.equals(k.publicKey)) ?? candidates[0];
    if (!found!.state.authority.equals(authority.publicKey)) {
      console.log(`  skipping the writes: ${found!.state.authority.toBase58()} signs for this agent`);
      this.skip();
    }
    const owned = LathClient.fromIdl(client.rpc, authority);

    // One single-input write, then one two-input write. `recordFailure` keeps the signature the
    // send reported, because a `0x179b` rejected at preflight never reaches the chain and the
    // finding has to say which of the two it is.
    const recordFailure = (what: string, e: unknown) => {
      const sig = (e as { signature?: string }).signature;
      return `${what} failed on a header in ${ownerTree.tree.toBase58()}: ${(e as Error).message}${
        sig ? ` (signature ${sig})` : " (no signature — rejected before it was sent)"
      }`;
    };

    const before = found!.state.seq;
    const probe = new AgentLogger(owned, id, { store: new MemoryTraceStore() });
    try {
      await probe.action({ toolId: "f-m22.probe", args: "", result: "", statusCode: 200 });
    } catch (e) {
      assert.fail(recordFailure("log_event", e));
    }

    const log = new LathLog(owned, id, LathLog.id("f-m22"), { store: new MemoryTraceStore() });
    try {
      await log.ensureCreated();
      await log.append("f-m22 two-input cell write");
    } catch (e) {
      assert.fail(recordFailure("create_cell", e));
    }

    const header = await owned.getHeader(id, LathLog.id("f-m22"));
    assert.isNotNull(header);
    assert.equal(
      header!.account.treeInfo.tree.toBase58(),
      ownerTree.tree.toBase58(),
      "a structure created under the fix lands in its owner's tree, so the cell write spends one tree"
    );
    const chain = await owned.verifyChain(id);
    assert.isTrue(chain.ok, `chain diverged at seq ${chain.firstBadSeq}`);
    assert.isAbove(Number(chain.seq), Number(before), "the writes advanced the chain");
  });

  /**
   * The payment verifier against a channel that really existed.
   *
   * Read-only on both chains: the record and its blobs come off devnet, the channel and the
   * close receipt off Tempo mainnet. It writes nothing anywhere and signs nothing, but it does
   * call a **mainnet** RPC, so it is off unless `LATH_TEMPO_LIVE=1` says otherwise — the
   * shape the DA fallback case above uses:
   *
   * ```bash
   * LATH_TEMPO_LIVE=1 LATH_DEVNET_RPC="…" \
   *   LATH_TEMPO_AGENT=<name|hex id> LATH_TEMPO_SEQ=<seq of an llm.* Action> \
   *   npx ts-mocha --paths -p ./tsconfig.json -t 300000 tests/devnet.ts -g 'a real channel'
   * ```
   *
   * `LATH_TEMPO_STORE` is a local blob directory; without it the blobs are read through the
   * agent's own locator registry and the Irys gateway, which is where a console on the `irys`
   * backend puts them. `PENDING` is a pass for a loop that is still running — the verdict this
   * asserts is only that it is not `failed` and not `no-preimage`.
   */
  it("verifies a payment on a real channel", async function () {
    if (process.env.LATH_TEMPO_LIVE !== "1") this.skip();
    const spec = process.env.LATH_TEMPO_AGENT;
    const seq = process.env.LATH_TEMPO_SEQ;
    if (!spec || !seq) this.skip();

    const id = /^[0-9a-fA-F]{64}$/.test(spec!) ? toBytes32(spec!) : idFromString(spec!);
    const dir = process.env.LATH_TEMPO_STORE;
    const store = dir
      ? new FileTraceStore(path.resolve(dir))
      : new AnchoredTraceStore(
          new HttpGatewayBackend(process.env.LATH_TEMPO_GATEWAY ?? IRYS_GATEWAY, {
            scheme: LocatorScheme.Irys,
            encoding: IRYS_ENCODING,
          }),
          new LocatorRegistry(client, id)
        );

    const report = await verifyInference(client, id, seq!, {
      store,
      reader: new TempoRpcReader({ url: process.env.LATH_TEMPO_RPC }),
      expectedPayer: process.env.LATH_TEMPO_PAYER,
    });
    console.log(formatInference(report).join("\n"));
    assert.oneOf(report.verdict, ["verified", "pending"], report.reason ?? "");
    assert.match(report.payer ?? "", /^0x[0-9a-fA-F]{40}$/, "the record names the address that signed the vouchers");
    assert.isString(report.channelId);
    assert.equal(inferenceExitCode(report), report.verdict === "verified" ? 0 : 4);
  });

  /**
   * The negative cases below are ones nothing else exercises against the deployed programs. Each
   * takes its own fresh id or grant, so they rerun and stand alone.
   */

  /** Anchor puts the program's error name in the logs a failed simulation carries; fall back to the whole text. */
  const errorName = (e: any): string => {
    const text = [e?.message, JSON.stringify(e?.logs ?? []), String(e)].join(" ");
    return text.match(/Error Code: (\w+)/)?.[1] ?? text;
  };

  it("negative: a charge over the allowance cap fails with AllowanceCapExceeded and moves no funds", async function () {
    // The payer is user and agent at once: a grant to oneself is a grant, and it needs no second funded key. The
    // charge needs the user's balance row, which only a deposit creates, and a deposit needs devnet USDC this suite
    // cannot mint — so the case runs when the wallet already holds a balance on the treasury and says so if not.
    const billing = BillingClient.fromIdl(client.rpc, payer, { admin: new PublicKey(TREASURY_ADMIN) });
    const before = await billing.getBalance(payer.publicKey);
    if (!before) return this.skip();
    const treasuryBefore = (await billing.getTreasury())!;

    // The cap (1 micro-USDC) is below the charge (2), so the cap check fires whatever the balance is — it runs
    // before the balance check in `charge`. A stale self-grant from an interrupted run is simply overwritten.
    await billing.approveAgent({
      agentAuthority: payer.publicKey,
      cap: 1n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      policyVersionHash: sha256(utf8(`negative-cap-${process.pid}-${Date.now()}`)),
    });
    try {
      let name: string | undefined;
      try {
        await billing.charge(payer.publicKey, 2n);
      } catch (e) {
        name = errorName(e);
      }
      assert.isDefined(name, "a charge of 2 against a cap of 1 must not land");
      assert.equal(name, "AllowanceCapExceeded");

      const after = await billing.getBalance(payer.publicKey);
      assert.equal(after!.spent, before.spent, "a refused charge debits nothing");
      assert.equal(after!.deposited, before.deposited);
      assert.equal((await billing.getAllowance(payer.publicKey, payer.publicKey))!.spent, 0n);
      assert.equal((await billing.getTreasury())!.totalSpent, treasuryBefore.totalSpent);
    } finally {
      // Give the grant's rent back; the balance row was never touched.
      await billing.revokeAgent({ agentAuthority: payer.publicKey }).catch(() => undefined);
    }
  });

  it("negative: a key that did not register the agent cannot append, and the chain is unchanged", async () => {
    const name = `devnet-neg-signer-${process.pid}-${Date.now()}`;
    const id = idFromString(name);
    const owned = new AgentLogger(client, id, { store: new MemoryTraceStore() });
    assert.isTrue(await owned.ensureRegistered(), "expected a fresh agent id");
    await owned.genesis({
      sessionId: "negative-signer",
      caller: payer.publicKey,
      policyVersionHash: sha256(utf8("policy-v1")),
      input: "owner writes",
    });
    const before = (await client.getAgentState(id))!.state;
    assert.equal(before.seq, 1n);

    // The refusal under test is the SDK's ownership guard, which reads the agent's authority before it builds a
    // transaction: a foreign key cannot get a proof-carrying `log_event` signed for an agent it did not register (the
    // program's own `require_keys_eq!` sits behind that and cannot be reached through the client without forging a
    // signature). So the intruder needs no SOL, nothing is sent, and what the case pins is that the guard holds and
    // that the chain is untouched afterwards.
    const intruder = Keypair.generate();
    const other = LathClient.fromIdl(client.rpc, intruder);
    const input = {
      timestamp: BigInt(Date.now()),
      kind: EventKind.Action,
      status: 0,
      reference: new Uint8Array(32),
      payloadHash: new Uint8Array(32),
    };
    let failed: unknown;
    try {
      await other.logEventInput(id, input, false);
    } catch (e) {
      failed = e;
    }
    assert.isDefined(failed, "an append signed by another key must fail");
    assert.match(errorName(failed), /does not own this agent|Unauthorized/);

    const after = (await client.getAgentState(id))!.state;
    assert.equal(after.seq, before.seq, "seq is unchanged");
    assert.equal(hex(after.head), hex(before.head), "head is unchanged");
    assert.isTrue(after.authority.equals(payer.publicKey));
  });

  it("negative: an epoch blob with one flipped byte fails the audit, and the untouched copy is VERIFIED", async () => {
    const owner = idFromString(`devnet-neg-epoch-${process.pid}-${Date.now()}`);
    const l = new AgentLogger(client, owner, { store: new MemoryTraceStore() });
    await l.ensureRegistered();
    await l.genesis({
      sessionId: "negative-epoch",
      caller: payer.publicKey,
      policyVersionHash: sha256(utf8("policy-v1")),
      input: "one epoch, then tamper with it",
    });
    // A memory store, not the locator map: the case is about what the audit does with the bytes it is handed, and
    // the anchor path has its own case above. The epoch itself is committed on the deployed program.
    const good = new MemoryEpochStore();
    const engine = new DynamicStorageEngine(
      { mode: "dynamic", standardBatchSize: 3, standardFlushDelayMs: 0, rateSampleWindowMs: 5000 },
      (input) => client.logEventInput(owner, input, false),
      client.createEpochCommitter(owner, good)
    );
    for (let i = 0; i < 3; i++) {
      await engine.push({
        kind: EventKind.Action,
        toolId: `neg-tool-${i}`,
        argsHash: sha256(new Uint8Array([i])),
        resultHash: sha256(new Uint8Array([i, 1])),
        statusCode: 200,
      });
    }
    await engine.push({
      kind: EventKind.Resolution,
      taskId: "negative-epoch",
      status: ResolutionStatus.Success,
      finalOutputHash: sha256(utf8("done")),
      totalStepCount: 3,
    });
    const epochs = await client.listEpochs(owner);
    assert.equal(epochs.length, 1, "the deployed program should have emitted EpochCommitted");
    const root = epochs[0].epochRoot;

    const okReport = await audit(client, owner, { epochs: good });
    const okLines = formatReport(okReport);
    assert.equal(okLines[okLines.length - 1], "VERIFIED", okLines.join("\n"));
    assert.equal(okReport.epochs!.checked, 1);

    // Flip the last byte — inside the last input, past the header — so the blob still decodes and it is the root
    // recomputation that refuses it, not a parse error.
    const bytes = await good.get(root);
    assert.isNotNull(bytes);
    const flipped = Uint8Array.from(bytes!);
    flipped[flipped.length - 1] ^= 1;
    const bad = new MemoryEpochStore();
    bad.tamper(root, flipped);

    const badReport = await audit(client, owner, { epochs: bad });
    const badLines = formatReport(badReport);
    assert.isFalse(badReport.ok, badLines.join("\n"));
    assert.notEqual(badLines[badLines.length - 1], "VERIFIED");
    assert.deepEqual(
      badReport.epochs!.missing,
      [hex(root)],
      "the report names the epoch root whose bytes do not match"
    );
    assert.equal(badReport.epochs!.checked, 0);
    assert.include(badLines.join("\n"), `missing epoch: ${hex(root)}`);

    // The untouched copy is still good: the failure was the flipped byte's, not the chain's.
    assert.isTrue((await audit(client, owner, { epochs: good })).ok);
  });
});
