/**
 * The verifier's half of a loop that pays Tempo's own services (docs/ARCHITECTURE.md §7.4): each
 * `storage.put` held to the one Tempo transfer its receipt names, and every snapshot and receipt a
 * leaf (or the stop record) carries paired with its step, as `verify-charge` and `verify-step` say it.
 *
 * The blobs are written with the runtime's own encoders (`storageArgsBytes`, `storageReceiptBytes`,
 * `tempoCarryBytes`, `storageKey`), so the SDK's reading is pinned against the bytes a loop writes
 * rather than against a copy of them.
 *
 * Node-only: an in-memory chain and store and a stubbed `TempoReader`. No RPC, no key, no money.
 */
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  toHex,
} from "viem";
import {
  CHANNEL_OPENED_ABI,
  CHANNEL_OPENED_SIGNATURE,
  chargeTransferProblem,
  EventKind,
  formatCharges,
  formatStepVerify,
  hex,
  idFromString,
  KEY_AUTHORIZED_SIGNATURE,
  KEYCHAIN_EVENTS_ABI,
  KEYCHAIN_VIEWS_ABI,
  MPP_MEMO_TAG,
  mppClientFingerprint,
  LOOP_SETTLEMENT_TOOL,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  MemoryBackend,
  OPEN_BLOCK_SLACK,
  OPEN_BLOCK_WINDOW,
  LOG_SEARCH_CHUNK,
  logSearchRanges,
  OPEN_SEARCH_HORIZON,
  pairTempoCarries,
  payloadPreimage,
  PlainTraceStore,
  sha256,
  SPENDING_LIMIT_UPDATED_SIGNATURE,
  stepVerifyExitCode,
  STORAGE_PUT_TOOL as SDK_STORAGE_PUT_TOOL,
  TEMPO_ACCOUNT_KEYCHAIN,
  TEMPO_ESCROW,
  TEMPO_STORAGE_SERVICE,
  TEMPO_USDC_E,
  TempoRpcReader,
  TIP20_TRANSFER_TOPIC,
  TIP20_TRANSFER_WITH_MEMO_TOPIC,
  utf8,
  verifyCharges,
  verifyStepDecision,
  verifyStorageCharge,
  type InferenceRecord,
  type LoopStepManifest,
  type LoopTempoView,
  type TempoLog,
  type TempoReader,
  type TempoTxReceipt,
} from "../sdk/src";
import {
  STORAGE_PUT_TOOL,
  TEMPO_STORAGE_URL,
  TEMPO_USDC_E_TOKEN,
  storageArgsBytes,
  storageKey,
  storageReceiptBytes,
  tempoCarryBytes,
  type StorageReceipt,
  type TempoCarry,
  type TempoServicesStop,
  type TempoSnapshot,
} from "../runtime/src";

const AGENT = idFromString("tempo-verify-charge");
const LOOP = "loop-s5";
const PAYER = "0x18fB00000000000000000000000000000000e0B0";
const RECIPIENT = "0xca4e0000000000000000000000000000000000aa";
const OTHER = "0x0000000000000000000000000000000000000bad";
const TX1 = `0x${"a1".repeat(32)}`;
const TX2 = `0x${"a2".repeat(32)}`;

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** One TIP-20 transfer log on `token`, with or without the memo event's fourth topic. */
function transfer(o: { from?: string; to?: string; amount?: bigint; token?: string; memo?: boolean }): TempoLog {
  const topics = [
    o.memo ? TIP20_TRANSFER_WITH_MEMO_TOPIC : TIP20_TRANSFER_TOPIC,
    topicOf(o.from ?? PAYER),
    topicOf(o.to ?? RECIPIENT),
  ];
  if (o.memo) topics.push(`0x${"77".repeat(32)}`);
  return { address: o.token ?? TEMPO_USDC_E, topics, data: `0x${word(o.amount ?? 200n)}` };
}

/** Tempo, as the one read a charge makes. Channel reads answer nothing: no case here asks one. */
class StubTempo implements TempoReader {
  reads: string[] = [];
  readonly txs: Record<string, TempoTxReceipt | null | Error>;
  constructor(txs: Record<string, TempoTxReceipt | null | Error>) {
    this.txs = txs;
  }
  async channelState() {
    return null;
  }
  async closeReceipt() {
    return null;
  }
  async txReceipt(txHash: string): Promise<TempoTxReceipt | null> {
    this.reads.push(txHash);
    const found = this.txs[txHash.toLowerCase()];
    if (found instanceof Error) throw found;
    return found ?? null;
  }
}

const paid = (logs: TempoLog[], status = 1): TempoTxReceipt => ({ status, blockNumber: "1234567", logs });

const payment = (reference: string, over: Record<string, unknown> = {}) => ({
  intent: "charge" as const,
  chainId: 4217,
  payer: PAYER,
  recipient: RECIPIENT,
  amount: "200",
  currency: TEMPO_USDC_E_TOKEN,
  reference,
  ...over,
});

const manifest = (step: number, extra: Partial<LoopStepManifest> = {}): LoopStepManifest => ({
  loopId: LOOP,
  step,
  intervalMs: 10_000,
  maxSteps: 5,
  promptHash: hex(sha256(utf8("publish a report each step"))),
  startedAt: 1_790_000_000_000,
  ...extra,
});

/** An agent's chain as `verifyCharges` and `verifyStepDecision` read it, written the way a loop writes it. */
class LoopChain {
  readonly backend = new MemoryBackend();
  readonly store = new PlainTraceStore(this.backend);
  readonly records: InferenceRecord[] = [];

  get chain() {
    return { listEvents: async () => this.records };
  }

  private async action(toolId: string, argsHash: Uint8Array, resultHash: Uint8Array, statusCode = 200) {
    const pre = payloadPreimage({ kind: EventKind.Action, toolId, argsHash, resultHash, statusCode });
    await this.store.put(pre);
    const rec: InferenceRecord = {
      seq: BigInt(this.records.length),
      kind: EventKind.Action,
      reference: idFromString(toolId),
      payloadHash: sha256(pre),
    };
    this.records.push(rec);
    return rec;
  }

  async step(m: LoopStepManifest, carry?: TempoCarry) {
    if (carry) m.tempoHash = hex(await this.store.put(tempoCarryBytes(carry)));
    const bytes = loopManifestBytes(m);
    return this.action(LOOP_STEP_TOOL, await this.store.put(bytes), sha256(utf8(`leaf ${m.step}`)));
  }

  /** One paid model call on the loop's channel: the voucher a charge's payer is held to when `--payer` is absent. */
  async call(payer = PAYER, before = "0", after = "750") {
    const argsHash = await this.store.put(utf8(JSON.stringify({ model: "openai/gpt-4o-mini" })));
    const payment = {
      rail: "tempo",
      chainId: 4217,
      payer,
      channelId: `0x${"7f".repeat(32)}`,
      cumulativeBefore: before,
      cumulativeAfter: after,
    };
    const resultHash = await this.store.put(utf8(JSON.stringify({ id: "gen", choices: [], payment })));
    return this.action("llm.openai/gpt-4o-mini", argsHash, resultHash);
  }

  /** Any other tool's Action, its result the bytes the tool handed back. */
  async tool(toolId: string, result: string) {
    const argsHash = await this.store.put(utf8(JSON.stringify({ path: "notes.md" })));
    return this.action(toolId, argsHash, await this.store.put(utf8(result)));
  }

  /** One PUT as `writeStoragePuts` records it; returns what the next carry names. */
  async put(ofStep: number, report: string, receiptOver: Partial<StorageReceipt> = {}, statusCode = 200) {
    const bytes = utf8(report);
    const key = storageKey(LOOP, hex(sha256(bytes)));
    const argsHash = await this.store.put(storageArgsBytes(TEMPO_STORAGE_URL, key));
    const resultHash = await this.store.put(bytes);
    const receipt: StorageReceipt = {
      key,
      bytes: bytes.length,
      path: "report/r.md",
      status: statusCode,
      ...receiptOver,
    };
    const receiptHash = hex(await this.store.put(storageReceiptBytes(receipt)));
    const rec = await this.action(STORAGE_PUT_TOOL, argsHash, resultHash, statusCode);
    return { rec, carried: { ofStep, seq: rec.seq.toString(), key, statusCode, receiptHash }, resultHash };
  }

  /**
   * Step `step`'s Genesis, its session `<loopId>:step-<k>` and its policy stored under the hash it
   * commits — what (e) reads to learn whether the loop is keyed.
   */
  async genesis(step: number, policy: Record<string, unknown>) {
    const policyVersionHash = await this.store.put(utf8(JSON.stringify(policy)));
    const inputPayloadHash = await this.store.put(utf8(JSON.stringify({ input: `step ${step}` })));
    const pre = payloadPreimage({
      kind: EventKind.Genesis,
      sessionId: idFromString(`${LOOP}:step-${step}`),
      callerPubkey: new Uint8Array(32),
      policyVersionHash,
      inputPayloadHash,
    });
    await this.store.put(pre);
    const rec: InferenceRecord = {
      seq: BigInt(this.records.length),
      kind: EventKind.Genesis,
      reference: new Uint8Array(32),
      payloadHash: sha256(pre),
    };
    this.records.push(rec);
    return rec;
  }

  async settle(services?: TempoServicesStop) {
    const argsHash = await this.store.put(utf8(JSON.stringify({ loopId: LOOP })));
    const blob = {
      payer: PAYER,
      channelId: `0x${"7f".repeat(32)}`,
      txHash: TX2,
      closed: true,
      ...(services ? { services } : {}),
    };
    return this.action(LOOP_SETTLEMENT_TOOL, argsHash, await this.store.put(utf8(JSON.stringify(blob))));
  }
}

const snapshot = (ofStep: number, block: string): TempoSnapshot => ({
  ofStep,
  takenAt: 1_790_000_000_000 + ofStep,
  block,
  channel: { id: `0x${"7f".repeat(32)}`, deposit: "1000000", settled: "0", cumulative: "4500" },
  treasury: { usdcE: "5000000" },
  rpc: { channelId: "0xrpcchannel", cumulative: String(ofStep * 3000) },
});

/**
 * The good loop: step 1, its report's PUT, step 2 carrying that receipt and step 1's snapshot, step
 * 2's PUT, and the stop record carrying the rest with the last snapshot and the close's block.
 */
async function goodLoop(o: { receipt1?: Partial<StorageReceipt> } = {}) {
  const c = new LoopChain();
  const step1 = await c.step(manifest(1));
  const put1 = await c.put(1, "# step 1\nfound nothing new\n", { payment: payment(TX1), ...o.receipt1 });
  const snap1 = snapshot(1, "100");
  const step2 = await c.step(manifest(2), { v: 1, storage: [put1.carried], snapshots: [snap1] });
  const put2 = await c.put(2, "# step 2\nthe goal is reached\n", { payment: payment(TX2) });
  const snap2 = snapshot(2, "110");
  const stop = await c.settle({
    v: 1,
    storage: [put2.carried],
    snapshots: [snap2],
    lastSnapshot: snap2,
    closeBlock: "115",
    rpc: { channelId: "0xrpcchannel", closed: true, txHash: "0xrpcclose", spent: "6000" },
  });
  return { c, step1, step2, put1, put2, stop };
}

const tempoOk = () =>
  new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid([transfer({ memo: true }), transfer({})]) });

describe("verify-charge — the constants the verifier pins", () => {
  it("decodes TIP-20's two transfer events by the topics viem derives", () => {
    assert.equal(TIP20_TRANSFER_TOPIC, toEventSelector("Transfer(address,address,uint256)"));
    assert.equal(TIP20_TRANSFER_WITH_MEMO_TOPIC, toEventSelector("TransferWithMemo(address,address,uint256,bytes32)"));
  });

  it("names the tool, the service and the token the runtime writes", () => {
    assert.equal(SDK_STORAGE_PUT_TOOL, STORAGE_PUT_TOOL);
    assert.equal(TEMPO_STORAGE_SERVICE, TEMPO_STORAGE_URL);
    assert.equal(TEMPO_USDC_E, TEMPO_USDC_E_TOKEN);
  });
});

describe("verify-charge — a charge against its Tempo transaction", () => {
  it("verifies a transfer of the amount from the payer to the recipient, with or without the memo event", async () => {
    const { c, put1, put2 } = await goodLoop();
    const tempo = tempoOk();
    const one = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempo });
    assert.equal(one.verdict, "verified", one.reason);
    assert.include(one, { amount: "200", txHash: TX1, block: "1234567", ofStep: 1, reportRehashed: true });
    const two = await verifyStorageCharge(put2.rec, put2.carried, { store: c.store, reader: tempo });
    assert.equal(two.verdict, "verified", two.reason);
    assert.deepEqual(tempo.reads, [TX1, TX2]);
  });

  it("fails a wrong amount, a wrong recipient, a reverted transaction and one with no transfer", () => {
    const p = payment(TX1);
    assert.match(
      chargeTransferProblem([transfer({ amount: 150n })], p)!,
      /moved 150 base units to the recipient, not the 200/
    );
    assert.match(
      chargeTransferProblem([transfer({ to: OTHER })], p)!,
      /paid 0x0000000000000000000000000000000000000bad, not the recipient/
    );
    assert.match(chargeTransferProblem([], p)!, /carries no transfer/);
    assert.match(chargeTransferProblem([transfer({ from: OTHER })], p)!, /none of it from the payer/);
    // Anyone may emit the same topic: only the currency's own contract counts.
    assert.match(chargeTransferProblem([transfer({ token: OTHER })], p)!, /carries no transfer/);
    assert.isNull(chargeTransferProblem([transfer({ to: RECIPIENT.toUpperCase().replace("0X", "0x") })], p));
  });

  for (const [name, receipt, pattern] of [
    ["wrong amount", paid([transfer({ amount: 199n })]), /moved 199 base units/],
    ["wrong recipient", paid([transfer({ to: OTHER })]), /not the recipient/],
    ["reverted transaction", paid([transfer({})], 0), /reverted \(status 0\)/],
    ["missing log", paid([]), /carries no transfer/],
  ] as const) {
    it(`fails the step's charge on a ${name}`, async () => {
      const { c, put1 } = await goodLoop();
      const tempo = new StubTempo({ [TX1]: receipt });
      const r = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempo });
      assert.equal(r.verdict, "failed");
      assert.match(r.reason!, pattern);
    });
  }

  it("leaves a charge unchecked, not failed, with no reader, an unreachable one, or a node without the tx", async () => {
    const { c, put1 } = await goodLoop();
    const none = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store });
    assert.equal(none.verdict, "pending");
    assert.match(none.reason!, /pass a Tempo RPC/);
    const down = await verifyStorageCharge(put1.rec, put1.carried, {
      store: c.store,
      reader: new StubTempo({ [TX1]: new Error("ECONNREFUSED") }),
    });
    assert.equal(down.verdict, "pending");
    const unseen = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: new StubTempo({}) });
    assert.equal(unseen.verdict, "pending");
    assert.match(unseen.reason!, /does not have/);
  });

  it("says a refused charge moved nothing, and asks Tempo nothing about it", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const put = await c.put(1, "# step 1\n", { status: undefined, error: "the challenge asks 20000 base units" }, 402);
    const tempo = tempoOk();
    const r = await verifyStorageCharge(put.rec, put.carried, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "unpaid");
    assert.match(r.reason!, /no payment was made: the challenge asks/);
    assert.deepEqual(tempo.reads, []);
  });

  it("fails an edited report, an edited receipt, a receipt for another key, and args for another service", async () => {
    const edited = await goodLoop();
    await edited.c.backend.set(hex(edited.put1.resultHash), utf8("# step 1\nsomething else\n"));
    const r1 = await verifyStorageCharge(edited.put1.rec, edited.put1.carried, {
      store: edited.c.store,
      reader: tempoOk(),
    });
    assert.equal(r1.verdict, "failed");
    assert.match(r1.reason!, /it was edited/);

    const forged = await goodLoop();
    await forged.c.backend.set(forged.put1.carried.receiptHash, utf8(JSON.stringify({ key: "x", bytes: 1 })));
    const r2 = await verifyStorageCharge(forged.put1.rec, forged.put1.carried, {
      store: forged.c.store,
      reader: tempoOk(),
    });
    assert.match(r2.reason!, /the receipt was edited/);

    const other = await goodLoop({ receipt1: { key: storageKey(LOOP, "00".repeat(32)) } });
    const r3 = await verifyStorageCharge(other.put1.rec, other.put1.carried, {
      store: other.c.store,
      reader: tempoOk(),
    });
    assert.equal(r3.verdict, "failed");
    assert.match(r3.reason!, /the receipt names key/);

    const c = new LoopChain();
    await c.step(manifest(1));
    const put = await c.put(1, "# r\n", { payment: payment(TX1) });
    const bytes = utf8("# r\n");
    const argsHash = await c.store.put(
      storageArgsBytes("https://elsewhere.example", storageKey(LOOP, hex(sha256(bytes))))
    );
    const pre = payloadPreimage({
      kind: EventKind.Action,
      toolId: STORAGE_PUT_TOOL,
      argsHash,
      resultHash: sha256(bytes),
      statusCode: 200,
    });
    await c.store.put(pre);
    const r4 = await verifyStorageCharge({ ...put.rec, payloadHash: sha256(pre) }, put.carried, {
      store: c.store,
      reader: tempoOk(),
    });
    assert.match(r4.reason!, /not to Tempo storage/);
  });
});

describe("verify-charge over a whole loop", () => {
  it("verifies every storage.put and pairs every carry", async () => {
    const { c } = await goodLoop();
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempoOk() });
    assert.equal(r.verdict, "verified", r.problems.join("; "));
    assert.deepEqual(
      r.charges.map((x) => [x.seq, x.ofStep, x.verdict, x.carriedBy]),
      [
        ["1", 1, "verified", "seq 2"],
        ["3", 2, "verified", "the stop record (seq 4)"],
      ]
    );
    assert.include(formatCharges(r).join("\n"), "$0.0002 USDC.e");
  });

  it("calls a chain with no storage.put and no carry what it is, and not a failure", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    await c.step(manifest(2));
    await c.settle();
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempoOk() });
    assert.equal(r.verdict, "no-preimage");
    assert.deepEqual(r.charges, []);
  });
});

describe("verify-charge — a receipt is held to one transfer and to the chain's payer", () => {
  const STRANGER = "0x5555555555555555555555555555555555555555";

  it("fails the second charge that names a transaction an earlier charge already named, and reads Tempo once", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const real = await c.put(1, "# step 1\nreal report\n", { payment: payment(TX1) });
    const phantom = await c.put(1, "# step 1\nphantom report\n", { payment: payment(TX1) });
    await c.step(manifest(2), { v: 1, storage: [real.carried, phantom.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX1]: paid([transfer({})]) });
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.deepEqual(
      r.charges.map((x) => [x.seq, x.verdict]),
      [
        ["1", "verified"],
        ["2", "failed"],
      ]
    );
    assert.include(r.charges[1].reason ?? "", "the charge at seq 1 already named");
    assert.deepEqual(tempo.reads, [TX1], "the phantom fails on the chain's own terms, before Tempo is asked");
  });

  it("checks one charge on its own as before: no run, no map, no second charge to collide with", async () => {
    const { c, put1 } = await goodLoop();
    const alone = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempoOk() });
    assert.equal(alone.verdict, "verified", alone.reason);
    const again = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempoOk() });
    assert.equal(again.verdict, "verified", "the same charge checked twice is not a duplicate");
  });

  it("fails a receipt naming a stranger's transfer under --payer, before Tempo is read", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const put = await c.put(1, "# step 1\n", { payment: payment(TX2, { payer: STRANGER }) });
    await c.step(manifest(2), { v: 1, storage: [put.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX2]: paid([transfer({ from: STRANGER })]) });
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo, expectedPayer: PAYER });
    assert.equal(r.verdict, "failed");
    assert.include(r.charges[0].reason ?? "", `names payer ${STRANGER}, not ${PAYER}`);
    assert.deepEqual(tempo.reads, []);
    // The flag is one address in either case.
    const upper = await verifyCharges(c.chain, AGENT, {
      store: c.store,
      reader: tempo,
      expectedPayer: STRANGER.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(upper.verdict, "verified", upper.charges[0].reason);
  });

  it("pins the payer to the chain's own vouchers when --payer is absent: the nearest one before the charge", async () => {
    const c = new LoopChain();
    await c.call(PAYER);
    await c.step(manifest(1));
    const put1 = await c.put(1, "# step 1\n", { payment: payment(TX1) });
    await c.call(PAYER, "750", "1500");
    const put2 = await c.put(2, "# step 2\n", { payment: payment(TX2, { payer: STRANGER }) });
    await c.step(manifest(2), { v: 1, storage: [put1.carried, put2.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid([transfer({ from: STRANGER })]) });
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.deepEqual(
      r.charges.map((x) => [x.seq, x.verdict]),
      [
        ["2", "verified"],
        ["4", "failed"],
      ]
    );
    assert.include(r.charges[1].reason ?? "", `not ${PAYER}, who pays this chain's charges`);
    assert.deepEqual(
      tempo.reads,
      [TX1],
      "the stranger's transfer is not read: the receipt already disagrees with the chain"
    );
  });

  it("falls back to the first receipt's payer on a chain with no readable voucher, and --payer overrides both", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const put1 = await c.put(1, "# step 1\nreal report\n", { payment: payment(TX1) });
    const put2 = await c.put(1, "# step 1\nanother\n", { payment: payment(TX2, { payer: STRANGER }) });
    await c.step(manifest(2), { v: 1, storage: [put1.carried, put2.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid([transfer({ from: STRANGER })]) });
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.equal(r.charges[0].verdict, "verified");
    assert.equal(r.charges[1].verdict, "failed");
    assert.include(r.charges[1].reason ?? "", PAYER);

    const pinned = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo, expectedPayer: STRANGER });
    assert.equal(pinned.charges[0].verdict, "failed", "the first receipt is held to the flag, not the flag to it");
    assert.equal(pinned.charges[1].verdict, "verified", pinned.charges[1].reason);
  });

  it("pins the payer to an LLM call's voucher, never to a payment a tool's output spells", async () => {
    const c = new LoopChain();
    await c.call(PAYER);
    await c.step(manifest(1));
    // A sandbox file tool handed the model text that is a voucher naming a stranger, nearest the charge.
    const fake = { rail: "tempo", chainId: 4217, payer: STRANGER, channelId: `0x${"7f".repeat(32)}` };
    await c.tool("zc.file_read", JSON.stringify({ payment: { ...fake, cumulativeBefore: "0", cumulativeAfter: "1" } }));
    const put = await c.put(1, "# step 1\n", { payment: payment(TX1) });
    await c.step(manifest(2), { v: 1, storage: [put.carried], snapshots: [] });
    const r = await verifyCharges(c.chain, AGENT, {
      store: c.store,
      reader: new StubTempo({ [TX1]: paid([transfer({})]) }),
    });
    assert.equal(r.verdict, "verified", r.charges.map((x) => x.reason).join("; "));
  });

  it("verifies the good loop exactly as before, with the payer learned from its receipts", async () => {
    const { c } = await goodLoop();
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempoOk() });
    assert.equal(r.verdict, "verified", r.charges.map((x) => x.reason).join("; "));
    assert.deepEqual(
      r.charges.map((x) => x.verdict),
      ["verified", "verified"]
    );
  });
});

describe("verify-charge — a charge is paid in USDC.e, to a gateway, and to one recipient", () => {
  /** A contract anyone can deploy, emitting TIP-20's `Transfer` topic from the treasury for nothing. */
  const FOREIGN = "0x00000000000000000000000000000000000f4ce0";
  const PAYEE2 = "0x000000000000000000000000000000000000beef";

  async function oneCharge(over: Record<string, unknown>, logs: TempoLog[]) {
    const c = new LoopChain();
    await c.step(manifest(1));
    const put = await c.put(1, "# step 1\n", { payment: payment(TX1, over) });
    await c.step(manifest(2), { v: 1, storage: [put.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX1]: paid(logs) });
    return { c, put, tempo };
  }

  it("fails a charge in a currency that is not USDC.e, though that contract logged the transfer, before Tempo is read", async () => {
    const { c, put, tempo } = await oneCharge({ currency: FOREIGN }, [transfer({ token: FOREIGN })]);
    const one = await verifyStorageCharge(put.rec, put.carried, {
      store: c.store,
      reader: tempo,
      expectedPayer: PAYER,
    });
    assert.equal(one.verdict, "failed");
    assert.include(one.reason ?? "", `names currency ${FOREIGN}`);
    const all = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(all.verdict, "failed");
    assert.deepEqual(tempo.reads, []);
  });

  it("fails a treasury transfer to itself, and the escrow deposit of a model channel, cited as a storage payment", async () => {
    const self = await oneCharge({ recipient: PAYER }, [transfer({ to: PAYER })]);
    const r1 = await verifyCharges(self.c.chain, AGENT, { store: self.c.store, reader: self.tempo });
    assert.equal(r1.verdict, "failed");
    assert.include(r1.charges[0].reason ?? "", "as its own recipient");
    const escrow = await oneCharge({ recipient: TEMPO_ESCROW }, [transfer({ to: TEMPO_ESCROW })]);
    const r2 = await verifyCharges(escrow.c.chain, AGENT, { store: escrow.c.store, reader: escrow.tempo });
    assert.equal(r2.verdict, "failed");
    assert.include(r2.charges[0].reason ?? "", "a channel deposit");
    assert.deepEqual([...self.tempo.reads, ...escrow.tempo.reads], []);
  });

  it("holds every charge to the first paid one's recipient, or to --recipient, and prints whom each paid", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const put1 = await c.put(1, "# step 1\nreal\n", { payment: payment(TX1) });
    const put2 = await c.put(1, "# step 1\nelsewhere\n", { payment: payment(TX2, { recipient: PAYEE2 }) });
    await c.step(manifest(2), { v: 1, storage: [put1.carried, put2.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid([transfer({ to: PAYEE2 })]) });
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.deepEqual(
      r.charges.map((x) => x.verdict),
      ["verified", "failed"]
    );
    assert.include(r.charges[1].reason ?? "", `names recipient ${PAYEE2}, not ${RECIPIENT}`);
    assert.include(formatCharges(r).join("\n"), `$0.0002 USDC.e to ${RECIPIENT}`);
    const pinned = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo, expectedRecipient: PAYEE2 });
    assert.deepEqual(
      pinned.charges.map((x) => x.verdict),
      ["failed", "verified"]
    );
    // The good loop pays one gateway throughout, and verifies as it did.
    const good = await goodLoop();
    assert.equal(
      (await verifyCharges(good.c.chain, AGENT, { store: good.c.store, reader: tempoOk() })).verdict,
      "verified"
    );
  });

  it("holds a scoped loop key's charges to the payees its policy's scopes commit", async () => {
    const scopes = (payee: string) => [
      { address: TEMPO_ESCROW, selector: "0x1b2f3d84" },
      { address: TEMPO_USDC_E, selector: "0x95777d59", recipients: [payee] },
    ];
    const tempoKey = { address: "0x5eed00000000000000000000000000000000c0de", token: TEMPO_USDC_E };
    for (const [payee, verdict] of [
      [RECIPIENT, "verified"],
      [PAYEE2, "failed"],
    ] as const) {
      const c = new LoopChain();
      await c.genesis(1, { model: "m", tempoKey: { ...tempoKey, scopes: scopes(payee) } });
      await c.step(manifest(1));
      const put = await c.put(1, "# step 1\n", { payment: payment(TX1) });
      await c.step(manifest(2), { v: 1, storage: [put.carried], snapshots: [] });
      // The memo names the loop, so (e) passes and only the recipient is in question.
      const m = `0x${MPP_MEMO_TAG}01${"00".repeat(10)}${mppClientFingerprint(LOOP)}${"00".repeat(7)}`;
      const t = transfer({ memo: true });
      const tempo = new StubTempo({ [TX1]: paid([{ ...t, topics: [...t.topics.slice(0, 3), m] }, transfer({})]) });
      const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
      assert.equal(r.charges[0].verdict, verdict, r.charges[0].reason);
      if (verdict === "failed") assert.include(r.charges[0].reason ?? "", `may pay only ${PAYEE2}`);
    }
  });
});

describe("verify-step — pairing a carry with its step", () => {
  const recs = (n: number, storageAt: number[] = []): InferenceRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      seq: BigInt(i),
      kind: EventKind.Action,
      reference: idFromString(storageAt.includes(i) ? STORAGE_PUT_TOOL : LOOP_STEP_TOOL),
      payloadHash: new Uint8Array(32),
    }));
  const view = (carriers: LoopTempoView["carriers"]): LoopTempoView => ({
    loopId: LOOP,
    steps: new Map([
      [1, "0"],
      [2, "2"],
      [3, "4"],
    ]),
    carriers,
    problems: [],
    unchecked: [],
    unreadCheckpoints: 0,
  });
  const entry = (ofStep: number, seq: string) => ({
    ofStep,
    seq,
    key: "k",
    statusCode: 200,
    receiptHash: "00".repeat(32),
  });

  it("pairs a late snapshot with its own step however far it rode", () => {
    const v = view([
      {
        seq: "4",
        step: 3,
        carry: { v: 1, snapshots: [snapshot(1, "100"), snapshot(2, "101")], storage: [entry(1, "1")] },
      },
    ]);
    assert.deepEqual(pairTempoCarries(v, recs(5, [1])).problems, []);
  });

  it("fails a snapshot of the carrying step or later, of a step that does not exist, and one carried twice", () => {
    const texts = (carriers: LoopTempoView["carriers"]) =>
      pairTempoCarries(view(carriers), recs(5, [1])).problems.map((p) => p.text);
    assert.match(
      texts([{ seq: "2", step: 2, carry: { v: 1, snapshots: [snapshot(2, "1")] } }])[0],
      /not earlier than it/
    );
    assert.match(
      texts([{ seq: "4", step: 3, carry: { v: 1, snapshots: [snapshot(7, "1")] } }])[0],
      /no checkpoint of loop/
    );
    assert.match(
      texts([
        { seq: "2", step: 2, carry: { v: 1, snapshots: [snapshot(1, "1")] } },
        { seq: "4", step: 3, carry: { v: 1, snapshots: [snapshot(1, "1")] } },
      ])[0],
      /step 1's snapshot is carried twice/
    );
  });

  it("fails a storage entry whose seq is not a storage.put, is carried twice, or comes after its carrier", () => {
    const texts = (carriers: LoopTempoView["carriers"]) =>
      pairTempoCarries(view(carriers), recs(5, [1])).problems.map((p) => p.text);
    assert.match(texts([{ seq: "4", step: 3, carry: { v: 1, storage: [entry(1, "3")] } }])[0], /it is not one/);
    assert.match(texts([{ seq: "4", step: 3, carry: { v: 1, storage: [entry(1, "9")] } }])[0], /no record there/);
    assert.match(
      texts([
        { seq: "2", step: 2, carry: { v: 1, storage: [entry(1, "1")] } },
        { seq: "4", step: 3, carry: { v: 1, storage: [entry(1, "1")] } },
      ])[0],
      /carried twice/
    );
    const late = pairTempoCarries(
      view([{ seq: "0", step: 2, carry: { v: 1, storage: [entry(1, "1")] } }]),
      recs(5, [1])
    );
    assert.match(late.problems[0].text, /comes after it/);
  });

  it("holds the stop record's last snapshot to the one a leaf carried", () => {
    const stop = (last: TempoSnapshot) => ({
      seq: "5",
      carry: { v: 1 as const },
      services: { v: 1 as const, lastSnapshot: last },
    });
    const leaf = { seq: "4", step: 3, carry: { v: 1 as const, snapshots: [snapshot(2, "110")] } };
    assert.deepEqual(pairTempoCarries(view([leaf, stop(snapshot(2, "110"))]), recs(6)).problems, []);
    const off = pairTempoCarries(view([leaf, stop(snapshot(2, "999"))]), recs(6)).problems;
    assert.match(off[0].text, /last snapshot of step 2 is not the one step 3/);
  });

  it("says a step no readable checkpoint names is unchecked, not wrong, when a checkpoint was unreadable", () => {
    const v = {
      ...view([{ seq: "4", step: 3, carry: { v: 1 as const, snapshots: [snapshot(7, "1")] } }]),
      unreadCheckpoints: 1,
    };
    const r = pairTempoCarries(v, recs(5));
    assert.deepEqual(r.problems, []);
    assert.match(r.unchecked[0].text, /no readable checkpoint/);
  });
});

describe("verify-step's storage and snapshot lines", () => {
  it("prints step 1's storage line and its snapshot, paired, carried by step 2", async () => {
    const { c, step1 } = await goodLoop();
    const r = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store, reader: tempoOk() });
    const lines = formatStepVerify(r);
    const key = storageKey(LOOP, hex(sha256(utf8("# step 1\nfound nothing new\n"))));
    assert.include(
      lines,
      `storage    seq 1 ${key.slice(
        0,
        44
      )}… (200), $0.0002 USDC.e to ${RECIPIENT}, tx 0xa1a1a1a1…a1a1 at block 1234567, verified`
    );
    assert.include(lines, "snapshot   after step 1, block 100, carried by step 2 (seq 2), paired");
    // The step was not verified by a second model, which is what its verdict says; the charge adds nothing to it.
    assert.equal(r.verdict, "no-preimage");
    assert.equal(r.tempo!.storage[0].verdict, "verified");
  });

  it("prints the last step's snapshot carried by the stop record, and the close's block", async () => {
    const { c, step2 } = await goodLoop();
    const r = await verifyStepDecision(c.chain, AGENT, step2.seq, { store: c.store, reader: tempoOk() });
    const lines = formatStepVerify(r);
    assert.include(lines, "snapshot   after step 2, block 110, carried by the stop record (seq 4), paired");
    assert.include(lines, "stop       the model channel's close settled at block 115");
    assert.isTrue(lines.some((l) => l.startsWith("storage    seq 3 ") && l.endsWith(", verified")));
  });

  it("fails the step whose charge Tempo contradicts", async () => {
    const { c, step1 } = await goodLoop();
    const tempo = new StubTempo({ [TX1]: paid([transfer({ to: OTHER })]), [TX2]: paid([transfer({})]) });
    const r = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "mismatch");
    assert.match(r.reason!, /^Tempo: the storage.put at seq 1: .*not the recipient/);
    assert.equal(stepVerifyExitCode(r), 1);
    assert.isTrue(formatStepVerify(r).some((l) => l.startsWith("storage    seq 1 ") && l.includes("FAILED")));
  });

  it("fails a step whose leaf carries a snapshot that does not pair", async () => {
    const c = new LoopChain();
    await c.step(manifest(1));
    const step2 = await c.step(manifest(2), { v: 1, snapshots: [snapshot(2, "100")] });
    const r = await verifyStepDecision(c.chain, AGENT, step2.seq, { store: c.store });
    assert.equal(r.verdict, "mismatch");
    assert.include(
      formatStepVerify(r),
      "tempo      FAIL: step 2 (seq 1) carries a snapshot of step 2, which is not earlier than it"
    );
  });

  it("holds the step's charges to verify-charge's pins: the chain's payer, --payer, and one transfer per charge", async () => {
    const STRANGER = "0x5772000000000000000000000000000000000001";
    // A receipt citing a stranger's transfer to the storage payee, the stranger named as payer: the
    // chain's own voucher names the treasury, and verify-step now says what verify-charge says.
    const c = new LoopChain();
    await c.call(PAYER);
    const step1 = await c.step(manifest(1));
    const put = await c.put(1, "# step 1\n", { payment: payment(TX2, { payer: STRANGER }) });
    await c.step(manifest(2), { v: 1, storage: [put.carried], snapshots: [] });
    const tempo = new StubTempo({ [TX2]: paid([transfer({ from: STRANGER })]) });
    const r = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store, reader: tempo });
    assert.equal(r.tempo!.storage[0].verdict, "failed");
    assert.include(r.tempo!.storage[0].reason ?? "", `names payer ${STRANGER}, not ${PAYER}`);
    assert.equal(r.verdict, "mismatch");
    assert.equal(
      (await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo })).charges[0].verdict,
      "failed",
      "the two commands agree"
    );
    // --payer overrides the vouchers, as it does on verify-charge.
    const pinned = await verifyStepDecision(c.chain, AGENT, step1.seq, {
      store: c.store,
      reader: tempo,
      expectedPayer: STRANGER,
    });
    assert.equal(pinned.tempo!.storage[0].verdict, "verified", pinned.tempo!.storage[0].reason);

    // Step 2's receipt cites the transaction step 1's charge already named: a phantom charge.
    const d = new LoopChain();
    await d.step(manifest(1));
    const p1 = await d.put(1, "# step 1\n", { payment: payment(TX1) });
    const s2 = await d.step(manifest(2), { v: 1, storage: [p1.carried], snapshots: [] });
    const p2 = await d.put(2, "# step 2\n", { payment: payment(TX1) });
    await d.step(manifest(3), { v: 1, storage: [p2.carried], snapshots: [] });
    const once = new StubTempo({ [TX1]: paid([transfer({})]) });
    const step2 = await verifyStepDecision(d.chain, AGENT, s2.seq, { store: d.store, reader: once });
    assert.equal(step2.tempo!.storage.length, 1);
    assert.equal(step2.tempo!.storage[0].verdict, "failed");
    assert.include(step2.tempo!.storage[0].reason ?? "", "which the charge at seq 1 already named");
    assert.deepEqual(once.reads, [], "the earlier charge is read from its blobs; Tempo is asked about neither");
    // The first citation is the genuine one, and step 1 still verifies.
    const step1d = await verifyStepDecision(d.chain, AGENT, 0n, { store: d.store, reader: once });
    assert.equal(step1d.tempo!.storage[0].verdict, "verified", step1d.tempo!.storage[0].reason);

    // A second recipient on one chain, after the first paid charge, fails under verify-step too.
    const e = new LoopChain();
    await e.step(manifest(1));
    const q1 = await e.put(1, "# step 1\n", { payment: payment(TX1) });
    const e2 = await e.step(manifest(2), { v: 1, storage: [q1.carried], snapshots: [] });
    const q2 = await e.put(2, "# step 2\n", { payment: payment(TX2, { recipient: OTHER }) });
    await e.step(manifest(3), { v: 1, storage: [q2.carried], snapshots: [] });
    const both = new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid([transfer({ to: OTHER })]) });
    const r2 = await verifyStepDecision(e.chain, AGENT, e2.seq, { store: e.store, reader: both });
    assert.equal(r2.tempo!.storage[0].verdict, "failed");
    assert.include(r2.tempo!.storage[0].reason ?? "", `names recipient ${OTHER}, not ${RECIPIENT}`);
  });

  it("leaves an old chain's step exactly as it was: no tempo key, no new line, no Tempo read", async () => {
    const c = new LoopChain();
    const step1 = await c.step(manifest(1));
    await c.step(manifest(2));
    await c.settle();
    const tempo = tempoOk();
    const r = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store, reader: tempo });
    const before = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store });
    assert.notProperty(r, "tempo");
    assert.deepEqual(r, before);
    assert.deepEqual(formatStepVerify(r), [
      `agent      ${hex(AGENT)}`,
      "seq        0",
      "  seq 0 carries no `verifyHash`: this step was not verified",
      "",
      "NOT VERIFIED (no preimage)",
    ]);
    assert.deepEqual(tempo.reads, []);
  });
});

/**
 * Audit (e): a loop whose policy commits a
 * `tempoKey` writes its storage charges with `clientId = loopId`, so the transfer's MPP attribution
 * memo carries `keccak256(loopId)[0..9]` in bytes 15..24. The memos are built here with viem's
 * keccak, so the SDK's own (noble's) is pinned against an independent one.
 */
describe("(e) — a keyed loop's storage charges name the loop in their memo", () => {
  const KEY = "0x5eed00000000000000000000000000000000c0de";
  const tempoKey = {
    address: KEY,
    token: TEMPO_USDC_E,
    limitBase: "2500",
    expiry: 1_762_000_000,
    authorizeTx: `0x${"a7".repeat(32)}`,
  };
  const policy = (keyed: boolean) => ({ model: "openai/gpt-4o-mini", rail: "tempo", ...(keyed ? { tempoKey } : {}) });
  const fingerprint = (id: string) => keccak256(toHex(id)).slice(2, 22);
  const TAG = keccak256(toHex("mpp")).slice(2, 10);
  /** mppx's attribution memo (`Attribution.encode`): tag, version 1, server, client or zeros, nonce. */
  const memo = (clientId?: string) =>
    `0x${TAG}01${fingerprint("storage.mpp.tempo.xyz")}${
      clientId === undefined ? "00".repeat(10) : fingerprint(clientId)
    }${keccak256(toHex("challenge-1")).slice(2, 16)}`;
  /** A `TransferWithMemo` log carrying `m`, beside which the plain `Transfer` rides as TIP-20 emits it. */
  const withMemo = (m: string): TempoLog[] => {
    const t = transfer({ memo: true });
    return [{ ...t, topics: [...t.topics.slice(0, 3), m] }, transfer({})];
  };

  async function loop(keyed: boolean, m1: string, m2 = memo(LOOP)) {
    const c = new LoopChain();
    await c.genesis(1, policy(keyed));
    const step1 = await c.step(manifest(1));
    const put1 = await c.put(1, "# step 1\nfound nothing new\n", { payment: payment(TX1) });
    await c.genesis(2, policy(keyed));
    await c.step(manifest(2), { v: 1, storage: [put1.carried] });
    const put2 = await c.put(2, "# step 2\nthe goal is reached\n", { payment: payment(TX2) });
    await c.settle({ v: 1, storage: [put2.carried] });
    const tempo = new StubTempo({ [TX1]: paid(withMemo(m1)), [TX2]: paid(withMemo(m2)) });
    return { c, step1, put1, put2, tempo };
  }

  it("computes mppx's tag and client fingerprint as viem's keccak does", () => {
    assert.equal(MPP_MEMO_TAG, TAG);
    assert.equal(mppClientFingerprint(LOOP), fingerprint(LOOP));
  });

  it("verifies a keyed loop's charges whose memos name the loop, and prints (e) under each", async () => {
    const { c, tempo } = await loop(true, memo(LOOP));
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "verified", r.charges.map((x) => x.reason).join("; "));
    assert.deepEqual(
      r.charges.map((x) => x.attribution?.status),
      ["ok", "ok"]
    );
    assert.include(
      formatCharges(r),
      `  (e) attributed ok: the memo names loop ${LOOP} (client 0x${fingerprint(LOOP)})`
    );
  });

  it("fails a keyed loop's charge whose memo names another loop", async () => {
    const { c, tempo } = await loop(true, memo("loop-other"));
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    const [one, two] = r.charges;
    assert.equal(one.verdict, "failed");
    assert.equal(one.attribution?.status, "failed");
    assert.match(
      one.reason!,
      new RegExp(`^loop attribution: the memo names client 0x${fingerprint("loop-other")}, not loop ${LOOP}`)
    );
    assert.equal(two.verdict, "verified", "the other charge is the loop's");
    assert.isTrue(formatCharges(r).some((l) => l.startsWith("  (e) attributed failed:")));
  });

  it("fails a keyed loop's charge whose attribution memo is anonymous", async () => {
    const { c, tempo } = await loop(true, memo());
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.equal(r.charges[0].attribution?.status, "failed");
    assert.include(r.charges[0].reason!, "the memo is anonymous");
  });

  // A keyed loop's charge refuses a challenge carrying the gateway's own memo before signing, so
  // neither a plain memo nor no memo is one this loop's code made: both fail (e).
  it("fails a keyed loop's charge whose memo is the gateway's own, or that carries no memo", async () => {
    const own = `0x${"77".repeat(32)}`;
    const { c, tempo } = await loop(true, own);
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "failed");
    assert.equal(r.charges[0].attribution?.status, "failed");
    assert.match(r.charges[0].reason!, /^loop attribution: the memo 0x7{64} is not an MPP attribution memo/);
    assert.equal(r.charges[1].verdict, "verified", "the other charge is the loop's");

    const bare = new StubTempo({ [TX1]: paid([transfer({})]), [TX2]: paid(withMemo(memo(LOOP))) });
    const r2 = await verifyCharges(c.chain, AGENT, { store: c.store, reader: bare });
    assert.equal(r2.verdict, "failed");
    assert.equal(r2.charges[0].attribution?.status, "failed");
    assert.match(r2.charges[0].reason!, /^loop attribution: the transfer carries no memo/);
  });

  it("leaves (e) unchecked, not failed, for a charge whose loop is not known or whose transaction was not read", async () => {
    const { c, put1, tempo } = await loop(true, memo(LOOP));

    const unknown = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempo }, { tempoKey });
    assert.equal(unknown.verdict, "verified");
    assert.equal(unknown.attribution?.status, "unchecked");
    assert.include(unknown.attribution?.detail ?? "", "no checkpoint on this chain names the loop");

    const unread = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store }, { loopId: LOOP, tempoKey });
    assert.equal(unread.verdict, "pending");
    assert.equal(unread.attribution?.status, "unchecked");
  });

  it("prints (e) under the step's storage line in verify-step", async () => {
    const { c, step1, tempo } = await loop(true, memo(LOOP));
    const r = await verifyStepDecision(c.chain, AGENT, step1.seq, { store: c.store, reader: tempo });
    assert.equal(r.tempo!.storage[0].attribution?.status, "ok");
    assert.include(
      formatStepVerify(r),
      `  (e) attributed ok: the memo names loop ${LOOP} (client 0x${fingerprint(LOOP)})`
    );
  });

  it("leaves an unkeyed loop's charges untouched: no (e), whatever the memo says", async () => {
    const { c, put1, tempo } = await loop(false, memo(), memo("loop-other"));
    const r = await verifyCharges(c.chain, AGENT, { store: c.store, reader: tempo });
    assert.equal(r.verdict, "verified");
    for (const x of r.charges) assert.notProperty(x, "attribution");
    assert.notInclude(formatCharges(r).join("\n"), "(e)");
    const bare = await verifyStorageCharge(put1.rec, put1.carried, { store: c.store, reader: tempo });
    const asUnkeyed = await verifyStorageCharge(
      put1.rec,
      put1.carried,
      { store: c.store, reader: tempo },
      { loopId: LOOP, tempoKey: null }
    );
    assert.deepEqual(asUnkeyed, bare);
    // And a loop with no readable policy — the good loop above has no Genesis at all.
    const { c: old } = await goodLoop();
    const before = await verifyCharges(old.chain, AGENT, { store: old.store, reader: tempoOk() });
    for (const x of before.charges) assert.notProperty(x, "attribution");
  });
});

/**
 * The two Tempo reads the loop key checks make (docs/ARCHITECTURE.md §7.3),
 * through `TempoRpcReader` over a stubbed JSON-RPC: the escrow's `ChannelOpened` for (b) and the
 * keychain's `KeyAuthorized` for (a). The logs are encoded with viem, so the reader's decoding is
 * pinned against the ABI rather than against a copy of its own output. No network, no key.
 */
describe("loop keys — the ChannelOpened and KeyAuthorized reads", () => {
  const CHANNEL = `0x${"c1".repeat(32)}`;
  const KEY = "0x5eed00000000000000000000000000000000c0de";
  const AUTH_TX = `0x${"a7".repeat(32)}`;
  const EXPIRY = 1_762_000_000;
  const checksum = (a: string) => getAddress(a);

  function openedLog(o: { escrow?: string; signer?: string; block?: string } = {}) {
    const topics = encodeEventTopics({
      abi: CHANNEL_OPENED_ABI as any,
      eventName: "ChannelOpened",
      args: { channelId: CHANNEL, payer: PAYER.toLowerCase(), payee: RECIPIENT },
    } as any) as string[];
    const data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint96" },
      ],
      [RECIPIENT, TEMPO_USDC_E, o.signer ?? KEY, `0x${"00".repeat(32)}`, `0x${"ee".repeat(32)}`, 2500n] as any
    );
    return { address: o.escrow ?? TEMPO_ESCROW, topics, data, blockNumber: o.block ?? "0x1004" };
  }

  function keyAuthorizedLog(o: { emitter?: string; account?: string; key?: string; expiry?: number } = {}) {
    return {
      address: o.emitter ?? TEMPO_ACCOUNT_KEYCHAIN,
      topics: encodeEventTopics({
        abi: KEYCHAIN_EVENTS_ABI as any,
        eventName: "KeyAuthorized",
        args: { account: (o.account ?? PAYER).toLowerCase(), publicKey: o.key ?? KEY },
      } as any) as string[],
      data: encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }], [0, BigInt(o.expiry ?? EXPIRY)] as any),
    };
  }

  function limitLog(amount: bigint, o: { key?: string; token?: string } = {}) {
    return {
      address: TEMPO_ACCOUNT_KEYCHAIN,
      topics: encodeEventTopics({
        abi: KEYCHAIN_EVENTS_ABI as any,
        eventName: "SpendingLimitUpdated",
        args: { account: PAYER.toLowerCase(), publicKey: o.key ?? KEY, token: o.token ?? TEMPO_USDC_E },
      } as any) as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount] as any),
    };
  }

  /** A JSON-RPC that answers from a table and records every call. */
  function rpc(answers: Record<string, (params: any[]) => unknown>) {
    const calls: { method: string; params: any[] }[] = [];
    const reader = new TempoRpcReader({
      request: async (method: string, params: unknown[]) => {
        calls.push({ method, params: params as any[] });
        const answer = answers[method];
        if (!answer) throw new Error(`unexpected ${method}`);
        return answer(params as any[]);
      },
    });
    return { reader, calls };
  }

  it("pins the three topics against viem, and ChannelOpened against the console's recovery read", () => {
    assert.equal(
      toEventSelector(CHANNEL_OPENED_SIGNATURE),
      // `CHANNEL_OPENED_TOPIC` in frontend/src/app/api/_lib/tempo.ts, which recovers a lost row from it.
      "0xdebaba36f0e9c7978f536fed432d9360b1f9646d7ca88531c34c3eae43f154a7"
    );
    assert.equal(
      toEventSelector(KEY_AUTHORIZED_SIGNATURE),
      toEventSelector(KEYCHAIN_EVENTS_ABI.find((e) => e.name === "KeyAuthorized") as any)
    );
    assert.equal(
      toEventSelector(SPENDING_LIMIT_UPDATED_SIGNATURE),
      toEventSelector(KEYCHAIN_EVENTS_ABI.find((e) => e.name === "SpendingLimitUpdated") as any)
    );
  });

  it("is the keychain address viem's tempo actions authorize keys at", () => {
    // Read from viem's own source rather than imported: `viem/tempo` pulls `ox` through the
    // tsconfig's `.d.ts` mapping on the CommonJS path (the probe script's header says how it failed).
    const source = fs.readFileSync(
      path.join(path.dirname(require.resolve("viem/package.json")), "tempo", "Addresses.ts"),
      "utf8"
    );
    const m = /export const accountKeychain = '(0x[0-9a-fA-F]{40})'/.exec(source);
    assert.equal(m?.[1], TEMPO_ACCOUNT_KEYCHAIN);
  });

  it("reads a channel's ChannelOpened from around its open block, filtered by the channel id", async () => {
    const { reader, calls } = rpc({
      eth_blockNumber: () => "0x30d40", // 200 000
      eth_getLogs: () => [openedLog({ escrow: "0x0000000000000000000000000000000000000bad" }), openedLog()],
    });
    const log = await reader.channelOpened(CHANNEL, "4100");
    assert.deepEqual(log, {
      channelId: CHANNEL,
      payer: checksum(PAYER),
      payee: checksum(RECIPIENT),
      token: checksum(TEMPO_USDC_E),
      authorizedSigner: checksum(KEY),
      deposit: 2500n,
      blockNumber: "4100",
    });
    const filter = calls.find((c) => c.method === "eth_getLogs")!.params[0];
    assert.equal(filter.address, TEMPO_ESCROW);
    assert.deepEqual(filter.topics, [toEventSelector(CHANNEL_OPENED_SIGNATURE), CHANNEL]);
    assert.equal(BigInt(filter.fromBlock), 4100n - OPEN_BLOCK_SLACK);
    assert.equal(BigInt(filter.toBlock), 4100n + OPEN_BLOCK_WINDOW, "a bounded window, under the head");
    // rpc.tempo.xyz refuses a range past 100 000 blocks; the slack and the window together must fit.
    assert.isBelow(Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock)), 100_000);
  });

  it("searches back from the head in ranges the RPC serves when no open block was recorded", async () => {
    const head = 10_000_000n;
    let n = 0;
    const { reader, calls } = rpc({
      eth_blockNumber: () => `0x${head.toString(16)}`,
      // The first range is refused as too wide, the second finds nothing, the third finds it.
      eth_getLogs: () => {
        n++;
        if (n === 1) throw new Error("query exceeds max block range");
        return n === 2 ? [] : [openedLog({ signer: RECIPIENT })];
      },
    });
    const log = await reader.channelOpened(CHANNEL);
    assert.equal(log?.authorizedSigner, checksum(RECIPIENT));
    const asked = calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => [BigInt(c.params[0].fromBlock), BigInt(c.params[0].toBlock)]);
    assert.deepEqual(asked, logSearchRanges(head).slice(0, 3));
  });

  // rpc.tempo.xyz refuses any range over 100 000 blocks, so windows of 500 000 or 5 000 000 blocks
  // from the head would never find an open older than ~7.5 h; the search stays under the cap.
  it("finds an open 200 000 blocks back from a node that refuses any range over 100 000 blocks", async () => {
    const head = 10_000_000n;
    const opened = head - 200_000n;
    const { reader, calls } = rpc({
      eth_blockNumber: () => `0x${head.toString(16)}`,
      eth_getLogs: ([f]) => {
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        if (to - from > 100_000n) throw new Error("query exceeds max block range 100000");
        return from <= opened && opened <= to ? [openedLog({ signer: RECIPIENT })] : [];
      },
    });
    const log = await reader.channelOpened(CHANNEL);
    assert.equal(log?.authorizedSigner, checksum(RECIPIENT));
    assert.equal(calls.filter((c) => c.method === "eth_getLogs").length, 3, "three ranges back, and no further");
  });

  it("ends the search, unchecked, on a log read that failed for any reason but the range", async () => {
    const { reader, calls } = rpc({
      eth_blockNumber: () => "0x989680",
      eth_getLogs: () => {
        throw new Error("429 Too Many Requests");
      },
    });
    assert.isNull(await reader.channelOpened(CHANNEL));
    assert.equal(calls.filter((c) => c.method === "eth_getLogs").length, 1, "not asked fifty more times");
  });

  it("walks consecutive ranges under the RPC's cap down to the horizon, and no further", () => {
    const head = 10_000_000n;
    const ranges = logSearchRanges(head);
    assert.isBelow(Number(LOG_SEARCH_CHUNK), 100_000, "every range is under rpc.tempo.xyz's 100 000-block cap");
    assert.deepEqual(ranges[0], [head - LOG_SEARCH_CHUNK + 1n, head]);
    for (const [lo, hi] of ranges) assert.isAtMost(Number(hi - lo + 1n), Number(LOG_SEARCH_CHUNK));
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][1], ranges[i - 1][0] - 1n, "no gap, no overlap");
    assert.equal(ranges[ranges.length - 1][0], head - OPEN_SEARCH_HORIZON);
    assert.lengthOf(ranges, 51);
    assert.deepEqual(logSearchRanges(1_000n), [[0n, 1_000n]], "a young chain is one range from block 0");
    assert.deepEqual(logSearchRanges(0n), [[0n, 0n]]);
  });

  it("answers null, never throws, when the open is not found or the node is down", async () => {
    const empty = rpc({ eth_blockNumber: () => "0x1000", eth_getLogs: () => [] });
    assert.isNull(await empty.reader.channelOpened(CHANNEL, "100"));
    const down = rpc({});
    assert.isNull(await down.reader.channelOpened(CHANNEL, "100"));
    assert.isNull(await down.reader.keyAuthorized(AUTH_TX));
  });

  it("reads KeyAuthorized from the keychain and the limit from the transaction's signed key authorization", async () => {
    const { reader, calls } = rpc({
      eth_getTransactionReceipt: () => ({
        status: "0x1",
        to: PAYER,
        blockNumber: "0xfa0",
        // A lookalike from another contract comes first and must be ignored.
        logs: [keyAuthorizedLog({ emitter: OTHER, key: OTHER }), keyAuthorizedLog()],
      }),
      eth_getTransactionByHash: () => ({
        hash: AUTH_TX,
        keyAuthorization: {
          keyId: KEY,
          expiry: `0x${EXPIRY.toString(16)}`,
          limits: [{ token: TEMPO_USDC_E, limit: "0x9c4" }],
        },
      }),
    });
    const auth = await reader.keyAuthorized(AUTH_TX);
    assert.deepEqual(auth, {
      status: 1,
      account: checksum(PAYER),
      publicKey: checksum(KEY),
      expiry: EXPIRY,
      limits: [{ token: TEMPO_USDC_E, amount: 2500n }],
      limitsFrom: "authorization",
      blockNumber: "4000",
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["eth_getTransactionReceipt", "eth_getTransactionByHash"]
    );
  });

  it("answers with the asked key's KeyAuthorized when one transaction authorized several", async () => {
    const { reader } = rpc({
      eth_getTransactionReceipt: () => ({
        status: "0x1",
        to: PAYER,
        logs: [keyAuthorizedLog({ key: OTHER, expiry: 1 }), keyAuthorizedLog(), limitLog(2000n)],
      }),
      eth_getTransactionByHash: () => null,
    });
    const asked = await reader.keyAuthorized(AUTH_TX, KEY.toUpperCase().replace("0X", "0x"));
    assert.equal(asked?.publicKey, checksum(KEY));
    assert.equal(asked?.expiry, EXPIRY);
    assert.deepEqual(asked?.limits, [{ token: checksum(TEMPO_USDC_E), amount: 2000n }]);
    // Asked for no key, it answers with the first, whose key (a) then names as not the committed one.
    assert.equal((await reader.keyAuthorized(AUTH_TX))?.publicKey, checksum(OTHER));
  });

  it("takes a SpendingLimitUpdated log for this key over the payload, and says an unlimited key has none", async () => {
    const logged = rpc({
      eth_getTransactionReceipt: () => ({
        status: "0x1",
        to: PAYER,
        logs: [keyAuthorizedLog(), limitLog(2000n), limitLog(9n, { key: OTHER })],
      }),
      eth_getTransactionByHash: () => null,
    });
    const fromLogs = await logged.reader.keyAuthorized(AUTH_TX);
    assert.deepEqual(fromLogs?.limits, [{ token: checksum(TEMPO_USDC_E), amount: 2000n }]);
    assert.equal(fromLogs?.limitsFrom, "logs");

    const unlimited = rpc({
      eth_getTransactionReceipt: () => ({ status: "0x1", to: PAYER, logs: [keyAuthorizedLog()] }),
      eth_getTransactionByHash: () => ({ keyAuthorization: { keyId: KEY, expiry: null } }),
    });
    const none = await unlimited.reader.keyAuthorized(AUTH_TX);
    assert.deepEqual(none?.limits, []);
    assert.equal(none?.limitsFrom, "authorization", "the payload was read and set no limit at all");

    const unread = rpc({
      eth_getTransactionReceipt: () => ({ status: "0x1", to: PAYER, logs: [keyAuthorizedLog()] }),
      eth_getTransactionByHash: () => {
        throw new Error("method not found");
      },
    });
    const blind = await unread.reader.keyAuthorized(AUTH_TX);
    assert.deepEqual(blind?.limits, []);
    assert.notProperty(blind, "limitsFrom", "nothing said what the limit was: the limit half stays unchecked");
  });

  it("returns an empty publicKey for a receipt that authorized nothing, and null for one the node lacks", async () => {
    const reverted = rpc({
      eth_getTransactionReceipt: () => ({ status: "0x0", to: PAYER, logs: [] }),
    });
    assert.deepEqual(await reverted.reader.keyAuthorized(AUTH_TX), {
      status: 0,
      account: "",
      publicKey: "",
      expiry: 0,
      limits: [],
    });
    const missing = rpc({ eth_getTransactionReceipt: () => null });
    assert.isNull(await missing.reader.keyAuthorized(AUTH_TX));
  });

  // Audit (d): the keychain's live scopes, and the authorization's.
  const OPEN = "0x11aa11aa";
  const TRANSFER_WITH_MEMO = "0x95777d59";
  const GET_KEY = toFunctionSelector("getKey(address,address)");
  const GET_ALLOWED_CALLS = toFunctionSelector("getAllowedCalls(address,address)");
  const keyResult = (o: { revoked?: boolean; keyId?: string } = {}) =>
    encodeFunctionResult({
      abi: KEYCHAIN_VIEWS_ABI as any,
      functionName: "getKey",
      result: {
        signatureType: 0,
        keyId: o.keyId ?? KEY,
        expiry: BigInt(EXPIRY),
        enforceLimits: true,
        isRevoked: o.revoked ?? false,
      },
    } as any);
  const scopesResult = encodeFunctionResult({
    abi: KEYCHAIN_VIEWS_ABI as any,
    functionName: "getAllowedCalls",
    result: [
      true,
      [
        { target: TEMPO_ESCROW, selectorRules: [{ selector: OPEN, recipients: [] }] },
        { target: TEMPO_USDC_E, selectorRules: [{ selector: TRANSFER_WITH_MEMO, recipients: [RECIPIENT] }] },
        { target: OTHER, selectorRules: [] },
      ],
    ],
  } as any);
  const keychain = (answers: Record<string, () => string>) =>
    rpc({
      eth_call: (params) => {
        assert.equal(params[0].to, TEMPO_ACCOUNT_KEYCHAIN);
        const answer = answers[String(params[0].data).slice(0, 10)];
        if (!answer) throw new Error("execution reverted");
        return answer();
      },
    });

  it("calls getKey and getAllowedCalls under the selectors viem's tempo ABI names", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(require.resolve("viem/package.json")), "tempo", "Selectors.ts"),
      "utf8"
    );
    assert.include(source, `getAllowedCalls: '${GET_ALLOWED_CALLS}'`);
    assert.equal(GET_ALLOWED_CALLS, "0x0163e7ec");
  });

  it("reads a live key's scopes flattened: a target with no rules is any selector, no recipients is any", async () => {
    const { reader, calls } = keychain({ [GET_KEY]: () => keyResult(), [GET_ALLOWED_CALLS]: () => scopesResult });
    assert.deepEqual(await reader.allowedCalls(PAYER, KEY), {
      isScoped: true,
      scopes: [
        { address: checksum(TEMPO_ESCROW), selector: OPEN },
        { address: checksum(TEMPO_USDC_E), selector: TRANSFER_WITH_MEMO, recipients: [checksum(RECIPIENT)] },
        { address: checksum(OTHER) },
      ],
      revoked: false,
    });
    assert.deepEqual(
      calls.map((c) => String(c.params[0].data).slice(0, 10)),
      [GET_KEY, GET_ALLOWED_CALLS]
    );
  });

  it("says revoked, with no second read, for a revoked key and for no key at all", async () => {
    for (const result of [keyResult({ revoked: true }), keyResult({ keyId: `0x${"00".repeat(20)}` })]) {
      const { reader, calls } = keychain({ [GET_KEY]: () => result, [GET_ALLOWED_CALLS]: () => scopesResult });
      assert.deepEqual(await reader.allowedCalls(PAYER, KEY), { isScoped: false, scopes: [], revoked: true });
      assert.equal(calls.length, 1);
    }
  });

  it("answers null, never throws, when either read fails or answers nothing", async () => {
    assert.isNull(await keychain({}).reader.allowedCalls(PAYER, KEY));
    assert.isNull(await keychain({ [GET_KEY]: () => keyResult() }).reader.allowedCalls(PAYER, KEY));
    assert.isNull(
      await keychain({ [GET_KEY]: () => keyResult(), [GET_ALLOWED_CALLS]: () => "0x" }).reader.allowedCalls(PAYER, KEY)
    );
  });

  it("reads the authorization's allowedCalls as its scopes, and nothing when the payload carries none", async () => {
    const { reader } = rpc({
      eth_getTransactionReceipt: () => ({ status: "0x1", to: PAYER, logs: [keyAuthorizedLog()] }),
      eth_getTransactionByHash: () => ({
        keyAuthorization: {
          keyId: KEY,
          expiry: `0x${EXPIRY.toString(16)}`,
          limits: [{ token: TEMPO_USDC_E, limit: "0x9c4" }],
          allowedCalls: [{ target: TEMPO_ESCROW, selectorRules: [{ selector: OPEN }] }, { target: OTHER }],
        },
      }),
    });
    const auth = await reader.keyAuthorized(AUTH_TX);
    assert.deepEqual(auth?.scopes, {
      isScoped: true,
      scopes: [{ address: TEMPO_ESCROW, selector: OPEN }, { address: OTHER }],
    });
  });
});
