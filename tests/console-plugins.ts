import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, type Connection } from "@solana/web3.js";
import { loopReceiptAddress, sasCredentialAddress, sasSchemaAddress } from "@lath/sdk";
import {
  LoopRecord,
  LoopRefused,
  afterStepFailure,
  attestDemo,
  checkLoopRequest,
  checkLoopStart,
  grantsRefusal,
  loopReceiptValues,
  loopReceiptView,
  publishOwedReceipts,
  loopStepPolicy,
  planPreparedStart,
  prepareLoopStart,
  publicLoop,
  readLoop,
  readLoops,
  recordLoop,
  resumeRefusal,
  setSolanaKeySeamsForTests,
  type SolanaKeySeams,
} from "../frontend/src/app/api/_lib/loops";
import { protocolPluginsEnabled } from "../frontend/src/app/api/_lib/receipt";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";

/**
 * The console's half of SAS · receipt (docs/ARCHITECTURE.md §8): the demo issuer's
 * receipt schema in `attestDemo`, the start's `receipt` pointer refused or committed, the receipt built
 * from the row after the settle, and its publish once, on Jev's `achieved` only.
 *
 * File I/O against a throwaway `LATH_TRACE_DIR` and nothing else. The one devnet write, the publish, goes
 * through `setSolanaKeySeamsForTests`; nothing here sends a transaction. The receipt is the one plugin the
 * form offers.
 *
 * `squads.pay` and `sas.attest` are on the roadmap, and so are protocol-plugin grants: grants in a start
 * body, the loop's Solana key made at prepare and swept at stop, the plugins card. What this suite holds
 * of grants is that they are not in this build: a start carrying them is refused whatever the switches
 * say, and a stored row started with them is read — its policy, its card — never resumed or stepped.
 *
 * Runs in its own mocha process, as every `console-*` suite does.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "ab".repeat(32);
const feePayer = Keypair.generate();
/** A program the demo issuer attests about; any address here. */
const TARGET = Keypair.generate().publicKey.toBase58();

const body = {
  agentId: AGENT,
  prompt: "check the slot and report",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
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

function record(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
  const loop: LoopRecord = {
    id,
    agentId: AGENT,
    agentName: "watcher",
    owner: OWNER,
    prompt: body.prompt,
    promptHash: "cd".repeat(32),
    intervalMs: body.intervalMs,
    maxSteps: body.maxSteps,
    budgetMicroUsdcPerStep: body.budgetMicroUsdcPerStep,
    model: body.model,
    createdAt: Date.now(),
    status: "running",
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
    ...over,
  };
  recordLoop(loop);
  return loop;
}

/** A cluster that would answer a balance read. Sends nothing anywhere. */
function fakeConnection(): Connection {
  return {
    async getBalance() {
      return 19_000_000;
    },
  } as unknown as Connection;
}

/** The seams for a console with protocol plugins on: a fake cluster and this suite's fee payer. */
function onSeams(over: Partial<SolanaKeySeams> = {}): Partial<SolanaKeySeams> {
  return {
    enabled: () => true,
    connection: () => fakeConnection(),
    feePayer: () => feePayer,
    ...over,
  };
}

describe("the loop receipt on SAS: the console", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-demo-receipt-"));
  const file = path.join(dir, "addresses.json");
  const issuer = Keypair.generate().publicKey.toBase58();
  const credential = sasCredentialAddress(issuer, "lath-demo");
  const schema = sasSchemaAddress(credential, "upgrade-authority", 1);
  const receiptSchema = sasSchemaAddress(credential, "loop-receipt", 1);
  const signer = feePayer.publicKey.toBase58();
  const pointer = { credential, schema: receiptSchema, signer };
  const seeded = {
    issuer,
    credential,
    credentialName: "lath-demo",
    schema,
    schemaName: "upgrade-authority",
    schemaVersion: 1,
    subjects: [{ name: "target", address: TARGET }],
    receiptSchema,
  };
  const GOAL = "ef".repeat(32);
  let published: { loopId: string; values: unknown }[];

  beforeEach(() => {
    clearStore();
    deploy();
    published = [];
    fs.writeFileSync(file, JSON.stringify(seeded));
    process.env.LATH_DEMO_ATTEST = file;
    setSolanaKeySeamsForTests(
      onSeams({
        publishReceipt: async (args) => {
          published.push({ loopId: args.loopId, values: args.values });
          return { attestation: "Att3st111111111111111111111111111111111111", signature: "receiptsig", slot: 7 };
        },
      })
    );
  });
  afterEach(() => {
    setSolanaKeySeamsForTests(undefined);
    delete process.env.LATH_DEMO_ATTEST;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A loop that stopped on Jev's achieved, its channel settled, with the receipt's pointer. */
  function achieved(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
    return record(id, {
      status: "stopped",
      stopReason: "goal-reached",
      goalHash: GOAL,
      receipt: pointer,
      snapshot: {
        loopId: id,
        steps: 2,
        status: "stopped",
        totalCostMicroUsdc: "23456",
        spentMicroUsdc: "23456",
        consecutiveFailures: 0,
        lastSeq: "41",
        lastHead: "AB".repeat(32),
        tempo: { payer: "0xTREASURY", closed: true, spent: "31000" },
      } as any,
      history: [{ step: 1 } as any, { step: 2, goalCheck: { outcome: "achieved", claimed: true } } as any],
      ...over,
    });
  }

  it("offers the receipt schema and this console's key in attestDemo, only when the seed made it", () => {
    assert.deepEqual(attestDemo(file, signer)?.receipt, { schema: receiptSchema, signer });
    assert.notProperty(attestDemo(file, null)!, "receipt", "no runtime key, no receipt");
    fs.writeFileSync(file, JSON.stringify({ ...seeded, receiptSchema: schema }));
    assert.notProperty(attestDemo(file, signer)!, "receipt", "a schema that is not loop-receipt v1 is not offered");
    const { receiptSchema: _r, ...without } = seeded;
    fs.writeFileSync(file, JSON.stringify(without));
    assert.notProperty(attestDemo(file, signer)!, "receipt");
  });

  it("refuses a receipt with the switch off, on a deploy or a listing, or not this console's", () => {
    setSolanaKeySeamsForTests({ enabled: () => false, feePayer: () => feePayer });
    const off = checkLoopStart({ ...body, receipt: pointer }, OWNER);
    assert.match((off as { error: string }).error, /^receipt: .*protocol plugins off/);
    setSolanaKeySeamsForTests(onSeams());
    assert.match(String((checkLoopRequest({ ...body, receipt: pointer } as any) as any).error), /deploy or a listing/);
    const other = { ...pointer, signer: Keypair.generate().publicKey.toBase58() };
    assert.match((checkLoopStart({ ...body, receipt: other }, OWNER) as any).error, /not this console's/);
    assert.match(
      (checkLoopStart({ ...body, receipt: { ...pointer, extra: 1 } }, OWNER) as any).error,
      /receipt\.extra/
    );
  });

  it("commits the pointer on the row and in every step's policy, and nothing for a start without one", async () => {
    // Without a goal check no receipt can ever be published, so the start is refused.
    const noCheck = checkLoopStart({ ...body, receipt: pointer }, OWNER);
    assert.match((noCheck as { error: string }).error, /^receipt: .*goal check says achieved/);
    const goal = { goal: "target's upgrade authority is the council's vault", goalCheck: true };
    const prepared = await prepareLoopStart({ ...body, ...goal, receipt: pointer }, OWNER);
    if ("error" in prepared) throw new Error(prepared.error);
    const planned = planPreparedStart(prepared, OWNER);
    if ("error" in planned) throw new Error(planned.error);
    assert.deepEqual(planned.loop.receipt, pointer);
    assert.notProperty(planned.loop, "solanaKey", "a receipt makes no loop key");
    const policy = loopStepPolicy(planned.loop, { toolAllowList: [], paid: true });
    assert.deepEqual(policy.receipt, pointer);
    const plain = loopStepPolicy(record("loop-plain"), { toolAllowList: [], paid: true });
    assert.notProperty(plain, "receipt");
  });

  it("builds the receipt from the row after the settle: the last checkpoint, the goal, both costs, the vouchers' signer", () => {
    const loop = achieved("loop-r1", { tempoKey: { address: "0xKEY" } as any });
    assert.deepEqual(loopReceiptValues(loop), {
      agent: AGENT,
      loop: "loop-r1",
      seq: "41",
      head: "ab".repeat(32),
      steps: 2,
      goal: GOAL,
      usdcCharged: "23456",
      tempoSpent: "31000",
      tempoPayer: "0xkey",
    });
    const noKey = loopReceiptValues(achieved("loop-r2"));
    assert.equal((noKey as any).tempoPayer, "0xtreasury", "the treasury signed on a loop without its own key");
    assert.match(String((loopReceiptValues(achieved("loop-r3", { goalHash: undefined })) as any).error), /goal hash/);
  });

  it("publishes once, on a goal-reached stop only, keeps the outcome, and the view follows it", async () => {
    achieved("loop-yes");
    achieved("loop-by-hand", { stopReason: "stopped" });
    achieved("loop-continue", {
      history: [{ step: 1, goalCheck: { outcome: "continue", claimed: false } } as any],
    });
    record("loop-running", { receipt: pointer });
    achieved("loop-open", { channel: { id: "0xch" } as any });

    assert.equal(loopReceiptView(readLoop("loop-yes")!)!.status, "waiting");
    await publishOwedReceipts();
    assert.deepEqual(
      published.map((p) => p.loopId),
      ["loop-yes"],
      "not by hand, not on continue, not while running, not with the channel still open"
    );
    const row = readLoop("loop-yes")!;
    assert.include(row.receiptResult!, { signature: "receiptsig", slot: 7 });
    const view = loopReceiptView(row)!;
    assert.equal(view.status, "published");
    assert.equal(view.address, loopReceiptAddress(pointer, "loop-yes"));
    assert.equal(view.values?.seq, "41");
    assert.equal(loopReceiptView(readLoop("loop-by-hand")!)!.status, "none");
    assert.equal(loopReceiptView(readLoop("loop-running")!)!.status, "waiting");
    assert.isNull(loopReceiptView(record("loop-none")));

    await publishOwedReceipts();
    assert.lengthOf(published, 1, "a published receipt is not published again");
  });

  it("keeps a failure on the row, the view says failed, and the next pass tries again", async () => {
    achieved("loop-fails");
    setSolanaKeySeamsForTests(
      onSeams({
        publishReceipt: async () => {
          throw new Error("the credential's issuer has not authorized it");
        },
      })
    );
    await publishOwedReceipts();
    const failed = loopReceiptView(readLoop("loop-fails")!)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /not authorized/);
    setSolanaKeySeamsForTests(
      onSeams({
        publishReceipt: async (args) => {
          published.push({ loopId: args.loopId, values: args.values });
          return { attestation: "x", found: true };
        },
      })
    );
    await publishOwedReceipts();
    assert.equal(loopReceiptView(readLoop("loop-fails")!)!.status, "published");
    assert.isTrue(readLoop("loop-fails")!.receiptResult!.found);
  });
});

describe("protocol plugins: the switch", () => {
  const saved = process.env.LATH_PROTOCOL_PLUGINS;
  after(() => {
    if (saved === undefined) delete process.env.LATH_PROTOCOL_PLUGINS;
    else process.env.LATH_PROTOCOL_PLUGINS = saved;
  });

  it("is on for 1, on, true and yes in any case, and off for anything else or unset", () => {
    for (const v of ["1", "on", "true", "yes", "ON", " Yes ", "TRUE"]) {
      process.env.LATH_PROTOCOL_PLUGINS = v;
      assert.isTrue(protocolPluginsEnabled(), JSON.stringify(v));
    }
    for (const v of ["", "0", "off", "false", "no", "enabled", "2"]) {
      process.env.LATH_PROTOCOL_PLUGINS = v;
      assert.isFalse(protocolPluginsEnabled(), JSON.stringify(v));
    }
    delete process.env.LATH_PROTOCOL_PLUGINS;
    assert.isFalse(protocolPluginsEnabled());
  });
});

/**
 * Protocol-plugin grants, not in this build (`grantsRefusal`): refused at every door whatever
 * `LATH_PROTOCOL_PLUGINS` says, rather than dropped, and a stored row started with them read,
 * never stepped.
 */
describe("protocol-plugin grants: not in this build", () => {
  const NOT_IN_BUILD = /protocol-plugin grants.*not in this build.*squads\.pay and sas\.attest are on the roadmap/;
  const MULTISIG = Keypair.generate().publicKey.toBase58();
  const MINT = Keypair.generate().publicKey.toBase58();
  const ALICE = Keypair.generate().publicKey.toBase58();
  const LOOP_KEY = Keypair.generate().publicKey.toBase58();
  const grants = {
    v: 1,
    cluster: "devnet",
    mandate: "Pay this week's approved invoices.",
    barBps: 6_000,
    maxPerStep: 3,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    items: [
      {
        id: "council",
        plugin: "squads",
        action: "pay",
        multisig: MULTISIG,
        vaultIndex: 1,
        mint: MINT,
        payees: [{ name: "alice", address: ALICE }],
        maxPerAction: "200000000",
        maxTotal: "400000000",
        uniqueRef: true,
      },
    ],
  };
  const savedPlugins = process.env.LATH_PROTOCOL_PLUGINS;

  beforeEach(() => {
    clearStore();
    deploy();
    setSolanaKeySeamsForTests(onSeams());
  });
  afterEach(() => setSolanaKeySeamsForTests(undefined));
  after(() => {
    if (savedPlugins === undefined) delete process.env.LATH_PROTOCOL_PLUGINS;
    else process.env.LATH_PROTOCOL_PLUGINS = savedPlugins;
  });

  /** A stored row started with grants: the grants, the loop's key, and what its ledgers say. */
  function granted(id: string, over: Partial<LoopRecord> = {}): LoopRecord {
    return record(id, {
      grants: { ...grants, items: [{ ...grants.items[0], spendingLimit: Keypair.generate().publicKey.toBase58() }] },
      solanaKey: { address: LOOP_KEY, createdAt: 1_760_000_000, fundTx: "fundsig" },
      pluginLedger: [
        { grantId: "council", step: 1, ref: "inv-1", payee: ALICE, amountBase: "120000000", signature: "paysig" },
      ],
      ...over,
    } as Partial<LoopRecord>);
  }

  it("refuses a start, a prepare and a deploy carrying grants whatever LATH_PROTOCOL_PLUGINS says, and makes nothing", async () => {
    for (const plugins of [undefined, "1"]) {
      const label = `LATH_PROTOCOL_PLUGINS=${plugins}`;
      if (plugins === undefined) delete process.env.LATH_PROTOCOL_PLUGINS;
      else process.env.LATH_PROTOCOL_PLUGINS = plugins;
      const start = checkLoopStart({ ...body, grants }, OWNER);
      assert.match((start as { error: string }).error, NOT_IN_BUILD, label);
      assert.deepInclude(start, { status: 400 }, label);
      const prepared = await prepareLoopStart({ ...body, grants }, OWNER);
      assert.match((prepared as { error: string }).error, NOT_IN_BUILD, label);
      assert.notProperty(prepared, "resolvedSolanaKey", label);
      assert.match(String((checkLoopRequest({ ...body, grants } as any) as any).error), NOT_IN_BUILD, label);
    }
    assert.deepEqual(readLoops(), {}, "no row was recorded");
  });

  it("reads a stored row started with grants: its policy commits them, and its page names them in one line", () => {
    const row = granted("loop-granted-read", { status: "stopped", stopReason: "stopped" });
    // Its policy commits the grants and the key its Genesis did, so its settlement hashes as its steps did.
    const policy = loopStepPolicy(row, { toolAllowList: [], paid: true });
    assert.deepEqual(policy.grants, row.grants);
    assert.deepEqual(policy.solanaKey, { address: LOOP_KEY, createdAt: 1_760_000_000 });
    // No plugins card in this build: the view names the grants and carries none of their terms.
    const view = publicLoop(row);
    assert.deepEqual(view.earlierBuild, ["grants"]);
    assert.notProperty(view, "plugins");
    assert.notProperty(publicLoop(record("loop-plain")), "earlierBuild", "nothing on a loop without grants");
  });

  it("neither resumes nor steps such a row: a step's refusal stops it with the reason before anything is spent", async () => {
    const paused = granted("loop-granted-paused", {
      status: "paused",
      snapshot: {
        loopId: "loop-granted-paused",
        steps: 1,
        status: "idle",
        totalCostMicroUsdc: "0",
        consecutiveFailures: 0,
      },
    });
    assert.match(resumeRefusal(paused)!, /^this loop cannot resume: it runs with protocol-plugin grants/);

    // A running one is refused at its step (`runnerBaseFor` throws this before the sandbox, the sources,
    // the funding and the channel), and the refusal stops it with the sentence as its detail.
    const running = granted("loop-granted-running");
    const why = grantsRefusal(running, "step")!;
    assert.match(why, NOT_IN_BUILD);
    assert.match(why, /stopped before its step, with nothing funded or spent/);
    assert.isNull(grantsRefusal(record("loop-plain-running"), "step"));
    const lifecycle = process.env.LATH_LIFECYCLE;
    process.env.LATH_LIFECYCLE = "off";
    try {
      afterStepFailure(running.id, new LoopRefused(why), { settle: async () => assert.fail("no channel to settle") });
      const stopped = readLoop(running.id)!;
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.stopDetail, why);
    } finally {
      if (lifecycle === undefined) delete process.env.LATH_LIFECYCLE;
      else process.env.LATH_LIFECYCLE = lifecycle;
    }
  });
});
