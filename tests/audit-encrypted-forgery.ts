/**
 * A blob whose only evidence of being the owner's ciphertext is a cleartext header must not stand
 * in for bytes an audit was asked to read.
 *
 * An LTE2 header is `"LTE2" ‖ hash`, thirty-six bytes anyone can write. A payload preimage is held
 * to the one ciphertext length its kind allows, and an encrypted one leaves the audit NOT
 * VERIFIED under `--require-preimages`. Goal memory and decision blobs sit a level
 * deeper — named by a manifest, not by a payload's fixed offsets — and there an `encrypted`
 * answer taken as "the owner's right and never a failure" would let a plaintext `loop.step` at 201
 * beside a forged header for its memory audit VERIFIED, exit 0, with the memory unread. The same
 * four bytes of magic would let `verify-charge` skip the edited-report check for a Tempo storage PUT.
 *
 * What must not move: a legitimately encrypted agent — every blob ciphertext under the owner's
 * key — reads exactly as before with and without `--require-preimages`, and a plaintext agent with
 * genuine blobs is still VERIFIED.
 *
 * Node-only: a stub `LathClient` answering the three reads `audit` makes, and an in-memory store.
 */
import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  audit,
  EncryptedTraceStore,
  EventKind,
  exitCode,
  formatReport,
  GOAL_REACHED_LINE,
  hex,
  idFromString,
  LOOP_STEP_TOOL,
  loopManifestBytes,
  LoopStepStatus,
  MemoryBackend,
  payloadPreimage,
  PlainTraceStore,
  sha256,
  utf8,
  verifyStorageCharge,
  type InferenceRecord,
  type LathClient,
  type LoopStepManifest,
  type TraceStore,
} from "../sdk/src";
import { SealingTraceStore, sealTrace } from "./fixtures/sealed-traces";
import { storageArgsBytes, storageKey, storageReceiptBytes, TEMPO_STORAGE_URL } from "../runtime/src";

const AGENT = idFromString("audit-encrypted-forgery");
const KEY = new Uint8Array(32).fill(7);

/** The records `audit` walks, and a chain that replays: what is under test is the trace walk. */
function clientFor(records: InferenceRecord[]): LathClient {
  const authority = new PublicKey("11111111111111111111111111111112");
  return {
    programId: authority,
    getAgentState: async () => ({ account: {}, state: { authority } }),
    verifyChain: async () => ({
      ok: true,
      headReached: true,
      records: records.length,
      seq: BigInt(records.length),
      head: new Uint8Array(32),
      firstBadSeq: undefined,
      missingSeqs: [],
      unexplainedGaps: [],
      recoveredSeqs: [],
      resyncedSeqs: [],
      epochs: [],
    }),
    listEvents: async () => records,
  } as unknown as LathClient;
}

/** `"LTE2" ‖ hash ‖ junk`: the header, naming the hash it is filed under, and nothing behind it. */
function forgedLte2(hash: Uint8Array): Uint8Array {
  return new Uint8Array([...utf8("LTE2"), ...hash, ...new Uint8Array(40).fill(0xab)]);
}

/**
 * One loop, one `loop.step` Action, written through `writer` — a plain store for a plaintext
 * agent, a `SealingTraceStore` (how a chain written encrypted holds its blobs) for an owner-encrypted one. `memory`
 * and `decision` are put too and named by the manifest; the returned hashes are what a forger
 * would overwrite.
 */
async function loopStep(
  writer: TraceStore,
  o: { status: number; memory?: string; decision?: string }
): Promise<{ records: InferenceRecord[]; memoryHash?: Uint8Array; decisionHash?: Uint8Array }> {
  const memoryHash = o.memory !== undefined ? await writer.put(utf8(o.memory)) : undefined;
  const decisionHash = o.decision !== undefined ? await writer.put(utf8(o.decision)) : undefined;
  const manifest: LoopStepManifest = {
    loopId: "forgery-loop",
    step: 1,
    intervalMs: 10_000,
    maxSteps: 3,
    promptHash: hex(sha256(utf8("reach the goal"))),
    startedAt: 1_790_000_000_000,
    ...(memoryHash ? { memoryHash: hex(memoryHash) } : {}),
    ...(decisionHash ? { verifyHash: hex(decisionHash) } : {}),
  };
  const argsHash = await writer.put(loopManifestBytes(manifest));
  const resultHash = await writer.put(utf8("leaf 1"));
  const pre = payloadPreimage({
    kind: EventKind.Action,
    toolId: LOOP_STEP_TOOL,
    argsHash,
    resultHash,
    statusCode: o.status,
  });
  const payloadHash = await writer.put(pre);
  const rec = {
    seq: 0n,
    kind: EventKind.Action,
    status: o.status,
    reference: idFromString(LOOP_STEP_TOOL),
    payloadHash,
  };
  return { records: [rec as InferenceRecord], memoryHash, decisionHash };
}

async function verdict(records: InferenceRecord[], store: TraceStore, requirePreimages: boolean) {
  const report = await audit(clientFor(records), AGENT, { store, requirePreimages });
  return { report, code: exitCode(report), last: formatReport(report).pop() };
}

const GOAL_MEMORY = `worked it out\n${GOAL_REACHED_LINE}\n`;

describe("a forged LTE2 header does not satisfy --require-preimages", () => {
  it("a plaintext agent with genuine blobs is still VERIFIED, with and without the flag", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    const { records } = await loopStep(store, {
      status: LoopStepStatus.GoalReached,
      memory: GOAL_MEMORY,
      decision: '{"verdict":"accept"}',
    });
    for (const flag of [false, true]) {
      const { report, code, last } = await verdict(records, store, flag);
      assert.equal(last, "VERIFIED", formatReport(report).join("\n"));
      assert.equal(code, 0);
      assert.isUndefined(report.traces!.blobsEncrypted);
      assert.equal(report.verifiedSteps?.[0].decision, "ok");
    }
    const { report } = await verdict(records, store, true);
    assert.equal(report.goalReached?.[0].terminal, "ok");
  });

  it("goal memory served as a header-only LTE2 blob reads NOT VERIFIED, and FAILED once the key is given", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    // The memory the step really committed does not say it reached the goal; the store hides that.
    const { records, memoryHash } = await loopStep(store, {
      status: LoopStepStatus.GoalReached,
      memory: "still looking\n",
    });
    await backend.set(hex(memoryHash!), forgedLte2(memoryHash!));

    const strict = await verdict(records, store, true);
    assert.equal(strict.last, "NOT VERIFIED (encrypted blobs not opened)", formatReport(strict.report).join("\n"));
    assert.equal(strict.code, 4);
    assert.isFalse(strict.report.ok);
    assert.equal(strict.report.goalReached?.[0].terminal, "encrypted");
    assert.deepEqual(strict.report.traces!.blobsEncrypted, [hex(memoryHash!)]);

    // Without the flag nothing below the preimage was asked for, and nothing changes.
    const loose = await verdict(records, store, false);
    assert.equal(loose.last, "VERIFIED");

    // The key is what tells a forgery from the owner's ciphertext: this one refuses it.
    const keyed = await verdict(records, new EncryptedTraceStore(backend, KEY), true);
    assert.equal(keyed.last, "FAILED", formatReport(keyed.report).join("\n"));
    assert.equal(keyed.code, 2);
    assert.equal(keyed.report.traces!.unopenable?.[0].hash, hex(memoryHash!));
  });

  it("a decision blob served as a header-only LTE2 blob reads NOT VERIFIED under the flag", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    const { records, decisionHash } = await loopStep(store, {
      status: LoopStepStatus.Success,
      decision: '{"verdict":"reject"}',
    });
    await backend.set(hex(decisionHash!), forgedLte2(decisionHash!));

    const strict = await verdict(records, store, true);
    assert.equal(strict.last, "NOT VERIFIED (encrypted blobs not opened)", formatReport(strict.report).join("\n"));
    assert.equal(strict.code, 4);
    assert.equal(strict.report.verifiedSteps?.[0].decision, "encrypted");
    assert.deepEqual(strict.report.traces!.blobsEncrypted, [hex(decisionHash!)]);

    // Unchanged without the flag: an unread decision is never a failure on its own.
    assert.equal((await verdict(records, store, false)).last, "VERIFIED");
  });

  it("a legitimately owner-encrypted agent reads exactly as it did, with and without the flag and the key", async () => {
    const backend = new MemoryBackend();
    // Sealed as a chain written encrypted holds it; read back through the SDK's own reader below.
    const { records } = await loopStep(new SealingTraceStore(backend, KEY), {
      status: LoopStepStatus.GoalReached,
      memory: GOAL_MEMORY,
      decision: '{"verdict":"accept"}',
    });
    const keyless = new PlainTraceStore(backend);

    const strict = await verdict(records, keyless, true);
    assert.equal(strict.code, 4);
    assert.equal(strict.last, "NOT VERIFIED (encrypted preimages not opened)");
    assert.deepEqual(strict.report.notChecked, ["1 encrypted preimage not opened: pass --trace-key <hex|path>"]);
    assert.isUndefined(strict.report.traces!.blobsEncrypted, "the walk stops at the encrypted preimage");

    const loose = await verdict(records, keyless, false);
    assert.equal(loose.last, "VERIFIED");
    assert.equal(loose.code, 0);

    const keyed = await verdict(records, new EncryptedTraceStore(backend, KEY), true);
    assert.equal(keyed.last, "VERIFIED", formatReport(keyed.report).join("\n"));
    assert.equal(keyed.report.goalReached?.[0].terminal, "ok");
  });
});

describe("verify-charge re-hashes a report that only looks encrypted", () => {
  const LOOP = "forgery-loop";

  /** One `storage.put` as a loop writes it, with a receipt that names no payment. */
  async function storagePut(writer: TraceStore, report: string) {
    const bytes = utf8(report);
    const key = storageKey(LOOP, hex(sha256(bytes)));
    const argsHash = await writer.put(storageArgsBytes(TEMPO_STORAGE_URL, key));
    const resultHash = await writer.put(bytes);
    const receiptHash = hex(await writer.put(storageReceiptBytes({ key, bytes: bytes.length, path: "r.md" })));
    const pre = payloadPreimage({
      kind: EventKind.Action,
      toolId: "storage.put",
      argsHash,
      resultHash,
      statusCode: 200,
    });
    const payloadHash = await writer.put(pre);
    const rec = { seq: 3n, kind: EventKind.Action, reference: idFromString("storage.put"), payloadHash };
    return {
      rec: rec as InferenceRecord,
      carried: { ofStep: 1, seq: "3", key, statusCode: 200, receiptHash },
      resultHash,
    };
  }

  it("fails a report replaced by an LTE2 header naming another hash, or by any LTE1 blob, as edited", async () => {
    for (const forge of [
      () => forgedLte2(sha256(utf8("some other report"))),
      () => new Uint8Array([...utf8("LTE1"), ...new Uint8Array(40).fill(0xcd)]),
    ]) {
      const backend = new MemoryBackend();
      const store = new PlainTraceStore(backend);
      const put = await storagePut(store, "# step 1\nfound nothing new\n");
      await backend.set(hex(put.resultHash), forge());
      const r = await verifyStorageCharge(put.rec, put.carried, { store });
      assert.equal(r.verdict, "failed", r.reason);
      assert.match(r.reason!, /it was edited/);
    }
  });

  it("fails an LTE2 header naming the report's hash whose size is not ciphertext of the report", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    const put = await storagePut(store, "# step 1\nfound nothing new\n");
    await backend.set(hex(put.resultHash), forgedLte2(put.resultHash));
    const r = await verifyStorageCharge(put.rec, put.carried, { store });
    assert.equal(r.verdict, "failed", r.reason);
    assert.match(r.reason!, /not ciphertext of that size/);
  });

  it("reads a receipt whose LTE2 header names another hash as edited, not as encrypted", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    const put = await storagePut(store, "# step 1\nfound nothing new\n");
    await backend.set(put.carried.receiptHash, forgedLte2(sha256(utf8("another receipt"))));
    const r = await verifyStorageCharge(put.rec, put.carried, { store });
    assert.equal(r.verdict, "failed", r.reason);
    assert.match(r.reason!, /the receipt was edited/);
  });

  it("still takes the owner's genuine LTE2 ciphertext of the report without re-hashing it", async () => {
    const backend = new MemoryBackend();
    const store = new PlainTraceStore(backend);
    const put = await storagePut(store, "# step 1\nfound nothing new\n");
    // The report as an encrypting store holds it: its own ciphertext under the plaintext hash.
    const { blob: stored } = sealTrace(KEY, utf8("# step 1\nfound nothing new\n"));
    await backend.set(hex(put.resultHash), stored);
    const r = await verifyStorageCharge(put.rec, put.carried, { store });
    assert.equal(r.verdict, "unpaid", r.reason);
    assert.isUndefined(r.reportRehashed);

    // And a plaintext report re-hashes as it always did.
    const plainStore = new PlainTraceStore(new MemoryBackend());
    const plain = await storagePut(plainStore, "# step 2\n");
    const p = await verifyStorageCharge(plain.rec, plain.carried, { store: plainStore });
    assert.equal(p.verdict, "unpaid", p.reason);
    assert.isTrue(p.reportRehashed);
  });
});
