import { assert } from "chai";
import {
  AgentLogger,
  AppendPolicy,
  type Lath,
  CellOp,
  computeHead,
  computeStructHead,
  EventKind,
  EVENT_OFFSETS,
  EVENT_RECORD_LEN,
  GENESIS_HEAD,
  hex,
  idFromString,
  LathClient,
  LathSigner,
  MAX_EVENTS_PER_TX,
  MAX_TIMESTAMP_SKEW_MS,
  MemoryTraceStore,
  ResolutionStatus,
  sha256,
  type StructHeader,
  StructKind,
  StructMode,
  toLathSigner,
  utf8,
} from "../sdk/src";

/**
 * Node-only slices: the trace stores and the Rust hash-chain vector.
 */
describe("trace stores", () => {
  it("encrypted store opens a sealed trace and verifies against the plaintext hash", async () => {
    const {
      EncryptedTraceStore,
      WebEncryptedTraceStore,
      isEncryptedTraceBlob,
      MemoryBackend,
      verifyTrace,
      sha256,
      utf8,
      hex,
    } = await import("../sdk/src");
    const { SealingTraceStore, traceKey } = await import("./fixtures/sealed-traces");
    const backend = new MemoryBackend();
    const key = traceKey();
    const store = new EncryptedTraceStore(backend, key);
    const plain = utf8("system prompt + transcript");
    // Sealed the way a chain written encrypted holds it: this build's stores only read.
    const h = await new SealingTraceStore(backend, key).put(plain);
    assert.equal(hex(h), hex(sha256(plain)));
    const atRest = (await backend.get(hex(h)))!;
    assert.notEqual(hex(atRest), hex(plain)); // ciphertext at rest
    assert.isTrue(isEncryptedTraceBlob(atRest), "the LTE header identifies ciphertext by bytes, not by length");
    assert.isFalse(isEncryptedTraceBlob(plain));
    assert.equal(hex((await store.get(h))!), hex(plain));
    assert.isTrue(await verifyTrace(store, h));
    // The WebCrypto store reads the same blob as the Node store.
    const web = new WebEncryptedTraceStore(backend, key);
    assert.equal(hex((await web.get(h))!), hex(plain));
    assert.isTrue(await verifyTrace(web, h));
    const wrongKey = new EncryptedTraceStore(backend, traceKey());
    let threw = false;
    try {
      await wrongKey.get(h);
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
  });

  it("file store round-trips, is content-addressed and idempotent", async () => {
    const { FileTraceStore, verifyTrace, sha256, utf8, hex } = await import("../sdk/src");
    const os = await import("os");
    const fsp = await import("fs");
    const p = await import("path");
    const dir = fsp.mkdtempSync(p.join(os.tmpdir(), "lath-file-store-"));
    try {
      const store = new FileTraceStore(dir);
      const bytes = utf8("a verbose trace");
      const h = await store.put(bytes);
      assert.equal(hex(h), hex(sha256(bytes)), "the key is the hash of the plaintext");
      assert.isTrue(fsp.existsSync(p.join(dir, hex(h))), "one file per blob, named by hex hash");
      assert.equal(hex((await store.get(h))!), hex(bytes));
      assert.equal(hex(await store.put(bytes)), hex(h), "re-putting the same bytes is a no-op");
      assert.isTrue(await verifyTrace(store, h));

      assert.isNull(await store.get(sha256(utf8("never stored"))));
      const empty = await store.put(new Uint8Array(0));
      assert.equal(hex((await store.get(empty))!), hex(new Uint8Array(0)));
      const big = new Uint8Array(200_000).fill(7);
      assert.equal((await store.get(await store.put(big)))!.length, big.length);
    } finally {
      fsp.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hash chain vector", () => {
  it("matches the Rust next_head test vector", () => {
    const h = computeHead(new Uint8Array(32), new Uint8Array(32).fill(1), 7n, {
      timestamp: 1_700_000_000_000n,
      kind: EventKind.Action,
      status: 200,
      reference: new Uint8Array(32).fill(2),
      payloadHash: new Uint8Array(32).fill(3),
    });
    assert.equal(hex(h), "d7150e18459267717b9d158e4052f69bbd12097a0d659c713c3d477669243ac5");
  });

  /**
   * Pinned against `set_append_policy_head_vector` in `programs/lath/src/lib.rs` — the same bytes,
   * so `computeStructHead` under `CellOp.SetAppendPolicy` and Rust `next_header_head` agree. The
   * header is a legacy `Anyone` mailbox taken to `OwnerOnly` at the owner's seq 11, five cells in
   * ; `lenOrCount` and `createdOpSeq` are non-zero so the vector also pins that neither is in
   * the preimage.
   */
  it("matches the Rust set_append_policy head vector", () => {
    const header: StructHeader = {
      ownerId: new Uint8Array(32).fill(1),
      structId: new Uint8Array(32).fill(2),
      kind: StructKind.Log,
      mode: StructMode.Public,
      lenOrCount: 5n,
      createdOpSeq: 3n,
      consumable: true,
      appendPolicy: AppendPolicy.OwnerOnly,
      policyRef: new Uint8Array(32),
    };
    const prev = new Uint8Array(32).fill(7);
    const head = computeStructHead(prev, header, 11n, CellOp.SetAppendPolicy);
    assert.equal(hex(head), "44eb1be4eb52eea8a4bee92fdffe7a4d7d9aa9929013a31814692f8f8c6cde15");
    // The op byte is what keeps a rewrite from hashing identically to a creation of the same header.
    assert.notEqual(hex(computeStructHead(prev, header, 11n)), hex(head));
    assert.equal(CellOp.SetAppendPolicy, 5, "cell_op::SET_APPEND_POLICY; 4 is the program's EPOCH byte");
  });
});
