/**
 * The session bundle (docs/ARCHITECTURE.md §9): the codec, and a reader that answers every hash of a
 * recorded session from one locator cell.
 *
 * No validator and no network. The registry is an in-memory stand-in for the owner's on-chain
 * `sha256 → locator` map — one cell is one entry in a `Map`, which is exactly what the reader
 * asks of it — and the blob store is a real `FsLocatorBackend` in a temp directory, so the bytes
 * make a round trip through a file the way they would through a gateway.
 *
 * What is pinned here is the claim the design rests on:
 * correctness is never the bundle's own hash, it is each entry re-hashing to the hash the chain
 * committed. So a tampered bundle is not a detected forgery with an error message — it is a
 * bundle that answers nothing, and every hash of that session reads `unavailable`.
 */
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { replayBundle, seqRanges } from "../scripts/verify-bundle";
import {
  AppendPolicy,
  Bytes32,
  Cell,
  CellOp,
  computeCellHead,
  computeEpochHead,
  computeHead,
  computeStructHead,
  createEpochMerkleTree,
  epochLeaves,
  epochRootOf,
  EventInput,
  EventKind,
  generateEpochProof,
  StructHeader,
  StructKind,
  StructMode,
  valueSlot,
  ZERO32,
  BundledTraceStore,
  BundleIndex,
  bundleKey,
  decodeBundle,
  encodeBundle,
  EncryptedTraceStore,
  FsLocatorBackend,
  hex,
  indexBundle,
  isEncryptedTraceBlob,
  MemoryBackend,
  Locator,
  LocatorRegistry,
  LocatorScheme,
  MAX_BUNDLE_BYTES,
  MemoryTraceStore,
  RecordingTraceStore,
  ResolvedLocator,
  sha256,
} from "../sdk/src";
import { SealingTraceStore, traceKey } from "./fixtures/sealed-traces";

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The locator registry as a `Map`: `publish` is first-write-wins because creating the cell
 * proves its address did not exist, and `resolve` answers `null` for a hash never mapped. That
 * is the whole of the interface a reader touches, and the chain is what the validator suite
 * checks (`tests/locator.ts`).
 */
function stubRegistry(): { registry: LocatorRegistry; cells: Map<string, Locator> } {
  const cells = new Map<string, Locator>();
  const registry = Object.create(LocatorRegistry.prototype) as LocatorRegistry;
  Object.assign(registry as unknown as Record<string, unknown>, {
    ensureCreated: async () => true,
    has: async (hash: Uint8Array) => cells.has(hex(hash)),
    publish: async (hash: Uint8Array, locator: Locator) => {
      if (cells.has(hex(hash))) throw new Error("already published");
      cells.set(hex(hash), locator);
      return { signature: "stub" };
    },
    resolve: async (hash: Uint8Array): Promise<ResolvedLocator | null> => {
      const locator = cells.get(hex(hash));
      return locator ? ({ hash, locator, version: 0n, publishedAt: 0n, cell: {} } as unknown as ResolvedLocator) : null;
    },
  });
  return { registry, cells };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lath-bundle-"));
}

describe("session bundles", () => {
  describe("the LPB1 codec", () => {
    it("round-trips entries in put order, including an empty one", () => {
      const entries = [utf8("the prompt"), new Uint8Array(0), utf8("a tool result"), new Uint8Array([0, 255, 7])];
      const decoded = decodeBundle(encodeBundle(entries));
      assert.equal(decoded.length, entries.length);
      decoded.forEach((got, i) => assert.equal(hex(got), hex(entries[i])));
    });

    it("indexes by what each entry re-hashes to, never by the bundle's own hash", () => {
      const entries = [utf8("one"), utf8("two")];
      const index = indexBundle(encodeBundle(entries));
      for (const entry of entries) assert.equal(hex(index.get(hex(sha256(entry)))!), hex(entry));
      assert.isUndefined(index.get(hex(sha256(encodeBundle(entries)))));
    });

    it("keys an encrypted entry by the hash in its header, which is the one the chain committed", async () => {
      // A ciphertext re-hashes to a number no record names, so keying it by `sha256(entry)` would
      // file every encrypted session under hashes nobody asks for and every lookup would miss.
      const key = traceKey();
      const backend = new MemoryBackend();
      const plaintext = utf8('{"prompt":"private"}');
      // Sealed as a chain written encrypted holds it (`tests/fixtures/sealed-traces.ts`).
      const hash = await new SealingTraceStore(backend, key).put(plaintext);
      const ciphertext = (await backend.get(hex(hash)))!;

      const index = indexBundle(encodeBundle([ciphertext, utf8("a plaintext entry beside it")]));
      assert.equal(hex(index.get(hex(hash))!), hex(ciphertext), "the committed hash answers, with ciphertext");
      // Every entry is filed under its own re-hash too: nobody asks for a ciphertext's,
      // and what it answers with is the bytes that re-hash to it, so it can mislead no one.
      assert.equal(hex(index.get(hex(sha256(ciphertext)))!), hex(ciphertext), "its own re-hash is only itself");
      assert.isDefined(index.get(hex(sha256(utf8("a plaintext entry beside it")))), "plaintext is unchanged");
    });

    it("never lets a header that only claims a hash displace a plaintext that re-hashes to it", async () => {
      // A genuine LTE2 blob of other bytes, its header rewritten to name the plaintext's hash. A
      // header is cleartext and anyone can write one; the plaintext proves itself by re-hashing.
      const plaintext = utf8("a plaintext entry the chain committed");
      const hash = sha256(plaintext);
      const backend = new MemoryBackend();
      const otherHash = await new SealingTraceStore(backend, traceKey()).put(utf8("other"));
      const forged = new Uint8Array((await backend.get(hex(otherHash)))!);
      forged.set(hash, 4);
      assert.isTrue(isEncryptedTraceBlob(forged));

      // Later in the same bundle: the plaintext keeps the slot.
      const index = indexBundle(encodeBundle([plaintext, forged]));
      assert.equal(hex(index.get(hex(hash))!), hex(plaintext));
      // The other order was always fine, and still is: bytes that prove themselves win the slot.
      assert.equal(hex(indexBundle(encodeBundle([forged, plaintext])).get(hex(hash))!), hex(plaintext));

      // And across bundles: a later session's forged entry does not displace an earlier one's.
      const bundles = new BundleIndex();
      const download = (bytes: Uint8Array) => async () => ({ bytes, found: {} as ResolvedLocator });
      await bundles.open(sha256(utf8("genesis one")), download(encodeBundle([plaintext])));
      await bundles.open(sha256(utf8("genesis two")), download(encodeBundle([forged])));
      assert.equal(hex(bundles.get(hash)!), hex(plaintext));
      assert.equal(
        hex(bundles.sourceOf(hash)!.key),
        hex(bundleKey(sha256(utf8("genesis one")))),
        "and it is still named against the bundle it came out of"
      );
    });

    it("derives the key from the genesis payload hash and nothing else", () => {
      const genesis = sha256(utf8("a genesis payload"));
      assert.equal(hex(bundleKey(genesis)), hex(sha256(utf8("lattice.preimages"), genesis)));
      assert.notEqual(hex(bundleKey(genesis)), hex(bundleKey(sha256(utf8("another genesis")))));
    });

    it("refuses a truncated bundle and says where it stopped", () => {
      const whole = encodeBundle([utf8("a blob that is long enough to cut"), utf8("and a second")]);
      assert.throws(() => decodeBundle(whole.slice(0, whole.length - 5)), /truncated at offset \d+/);
      // A length prefix cut in half is a different offset, and the message has to name it.
      assert.throws(() => decodeBundle(whole.slice(0, 10)), /truncated at offset 8/);
      assert.throws(() => decodeBundle(whole.slice(0, 6)), /short of the 8-byte header/);
      assert.throws(() => decodeBundle(utf8("NOPE____")), /expected "LPB1" at offset 0/);
    });

    it("refuses a bundle over 16 MiB, encoding and decoding", () => {
      // Declared rather than allocated twice: the encoder is asked for one byte too many, and
      // the decoder is handed a blob one byte too long.
      const oversize = new Uint8Array(MAX_BUNDLE_BYTES + 1);
      oversize.set(utf8("LPB1"), 0);
      assert.throws(() => decodeBundle(oversize), /at most 16777216 bytes/);
      assert.throws(() => encodeBundle([new Uint8Array(MAX_BUNDLE_BYTES)]), /at most 16777216 bytes/);
    });
  });

  describe("a recorded session, read back through one cell", () => {
    /** Everything a small session writes: the preimages, and the blobs inside them. */
    const blobs = [
      utf8("the system prompt"),
      utf8('{"kind":0,"input":"what is the slot?"}'),
      utf8('{"tool":"solana.slot","args":{}}'),
      utf8('{"slot":123456789}'),
      utf8("the final answer, in two sentences"),
    ];
    const genesis = sha256(utf8("genesis payload for this session"));

    async function seal(dir: string) {
      const { registry, cells } = stubRegistry();
      const backend = new FsLocatorBackend(dir);
      const inner = new MemoryTraceStore();
      const recording = new RecordingTraceStore(inner, { backend, registry });
      for (const blob of blobs) await recording.put(blob);
      // A session puts the same bytes twice — a loop step carries its memory forward — and the
      // bundle carries them once.
      await recording.put(blobs[0]);
      const sealed = await recording.seal(genesis);
      return { registry, cells, backend, sealed };
    }

    it("answers every hash of the session from the one bundle cell", async () => {
      const dir = tempDir();
      const { registry, cells, backend, sealed } = await seal(dir);
      assert.isUndefined(sealed.error);
      assert.equal(sealed.count, blobs.length, "the duplicate put is not a second entry");
      assert.equal(cells.size, 1, "one cell for the whole session");
      assert.isTrue(cells.has(hex(bundleKey(genesis))), "and it is keyed by the derived bundle key");

      // The reader: the same registry and a gateway for the scheme, and nothing else. No cell
      // exists for any individual blob — only the bundle's.
      const reader = new BundledTraceStore(registry, [backend]);
      assert.isNull(await reader.get(sha256(blobs[0])), "no bundle opened yet, and no cell for the hash");
      assert.equal(await reader.openSession(genesis), blobs.length);
      for (const blob of blobs) {
        const got = await reader.get(sha256(blob));
        assert.isNotNull(got, `${hex(sha256(blob))} should come out of the bundle`);
        assert.equal(hex(sha256(got!)), hex(sha256(blob)), "and re-hash to the hash the chain committed");
      }
      // A hash the session never wrote is still nothing, bundle open or not.
      assert.isNull(await reader.get(sha256(utf8("never written"))));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("never asks the Irys gateway by hash", async () => {
      const dir = tempDir();
      const { registry } = await seal(dir);
      // An Irys-only reader on a chain whose blobs are raw: the bundle cell names scheme 0,
      // which this reader has no gateway for, so nothing opens and nothing is asked for by hash.
      const asked: string[] = [];
      const irysOnly = {
        scheme: LocatorScheme.Irys,
        upload: async () => new Uint8Array(32),
        download: async (id: Uint8Array) => {
          asked.push(hex(id));
          return null;
        },
      };
      const reader = new BundledTraceStore(registry, [irysOnly]);
      assert.equal(await reader.openSession(genesis), 0);
      assert.isNull(await reader.get(sha256(blobs[0])));
      assert.deepEqual(asked, [], "an Irys id is Irys's own; no hash predicts one");
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("makes every hash unavailable when the bundle is tampered with, and none of them a trace", async () => {
      const dir = tempDir();
      const { registry, cells, backend } = await seal(dir);
      // Rewrite the uploaded blob in place, keeping it a well-formed bundle: the entries decode,
      // they just hash to something other than what the chain committed. This is the case an
      // operator-run store could not be caught at.
      const locator = cells.get(hex(bundleKey(genesis)))!;
      const held = (await backend.download(locator.id))!;
      const tampered = encodeBundle(decodeBundle(held).map((e) => new Uint8Array([...e, 0x21])));
      fs.writeFileSync(path.join(dir, hex(locator.id)), tampered);

      const reader = new BundledTraceStore(registry, [backend]);
      assert.equal(await reader.openSession(genesis), blobs.length, "it still decodes; that is the point");
      for (const blob of blobs) {
        assert.isNull(await reader.get(sha256(blob)), "a tampered entry answers for no committed hash");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("seals what the store holds, so an encrypted session's bundle carries no plaintext", async () => {
      // The whole point of encrypting the trace directory is lost if the copy made for readers —
      // one file, on a public gateway — is the plaintext the runtime handed in. The recorder asks
      // the store what it stored. No SDK store in this build encrypts; the encrypting writer in
      // `tests/fixtures/sealed-traces.ts` stands in for any store that transforms its bytes.
      const dir = tempDir();
      const { registry, cells } = stubRegistry();
      const backend = new FsLocatorBackend(dir);
      const key = traceKey();
      const encrypted = new SealingTraceStore(new MemoryBackend(), key);
      const recording = new RecordingTraceStore(encrypted, { backend, registry });
      for (const blob of blobs) await recording.put(blob);
      const sealed = await recording.seal(genesis);
      assert.isUndefined(sealed.error);

      const uploaded = (await backend.download(cells.get(hex(bundleKey(genesis)))!.id))!;
      const text = new TextDecoder("utf8", { fatal: false }).decode(uploaded);
      for (const secret of ["the system prompt", "solana.slot", "the final answer"]) {
        assert.notInclude(text, secret, "no plaintext byte of any trace is in the sealed bundle");
      }
      // And it is still readable by the owner: every entry is keyed by the hash the chain has.
      const index = indexBundle(uploaded);
      for (const blob of blobs) {
        const entry = index.get(hex(sha256(blob)));
        assert.isDefined(entry, `${hex(sha256(blob))} is in the bundle under its committed hash`);
        assert.isTrue(isEncryptedTraceBlob(entry!), "as ciphertext");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reports a seal it could not make instead of throwing", async () => {
      const { registry } = stubRegistry();
      const refuses = {
        scheme: LocatorScheme.Irys,
        upload: async (): Promise<Uint8Array> => {
          throw new Error("this account has no balance at Irys");
        },
        download: async () => null,
      };
      const recording = new RecordingTraceStore(new MemoryTraceStore(), { backend: refuses, registry });
      await recording.put(utf8("a blob"));
      const sealed = await recording.seal(genesis);
      assert.match(sealed.error!, /no balance at Irys/);
      assert.isUndefined(sealed.locator);
    });

    it("keeps the first locator when a seal is run again", async () => {
      const dir = tempDir();
      const { registry, cells, backend } = await seal(dir);
      const first = cells.get(hex(bundleKey(genesis)))!;
      const again = new RecordingTraceStore(new MemoryTraceStore(), { backend, registry });
      await again.put(blobs[0]);
      const sealed = await again.seal(genesis);
      assert.isUndefined(sealed.error);
      assert.equal(hex(sealed.locator!.id), hex(first.id), "a key already anchored keeps its first locator");
      assert.equal(cells.size, 1);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  /**
   * A settlement is not a session, so it has no bundle and needs cells of its own.
   *
   * A loop's channel is settled by a runner built only for that (`defaultLoopSettle`): it opens no
   * session, the three blobs of its `loop.settlement` record — the Action's args, its result, its
   * payload preimage — belong to no genesis, and `bundleKey` is derived from a genesis payload
   * hash. Nothing on chain pointed at those bytes, so `verify-channel --gateway` answered *no
   * preimage* for a settlement the local trace directory resolved. Pinned here is the reader's
   * side: a gateway reader that never opened a session resolves them, which is the auditor the
   * flag exists for.
   */
  describe("a settlement, anchored one cell per blob", () => {
    /** What a settlement-only runner puts, in order: the system prompt first, then the record's. */
    const prompt = utf8("the system prompt the construction puts before the settle");
    const settlement = [
      utf8('{"loopId":"loop-1","steps":2,"payer":"0xtreasury","channelId":"0xa5c19084"}'),
      utf8('{"payer":"0xtreasury","channelId":"0xa5c19084","closed":true,"txHash":"0x67c06cb8","spent":"4500"}'),
      utf8("the payload preimage of the loop.settlement Action"),
    ];

    async function settle(dir: string, key?: Uint8Array) {
      const { registry, cells } = stubRegistry();
      const backend = new FsLocatorBackend(dir);
      const inner = key ? new SealingTraceStore(new MemoryBackend(), key) : new MemoryTraceStore();
      const recording = new RecordingTraceStore(inner, { backend, registry });
      const hashes: Uint8Array[] = [await recording.put(prompt)];
      // `publish(from)` is given the count taken before the runner settled, the way the console
      // takes it, so the prompt blob — inside every step's bundle already — is not paid for twice.
      const before = recording.entries.length;
      for (const blob of settlement) hashes.push(await recording.put(blob));
      const published = await recording.publish(before);
      return { registry, cells, backend, published, hashes };
    }

    it("puts the settlement's blobs where a step's go: readable from the gateway with no session", async () => {
      const dir = tempDir();
      const { registry, cells, backend, published, hashes } = await settle(dir);
      assert.isUndefined(published.error);
      assert.equal(published.published, settlement.length, "one cell per blob of the record");
      assert.equal(cells.size, settlement.length, "and the prompt blob before them is not one of them");
      assert.isFalse(cells.has(hex(hashes[0])));

      // The auditor: this registry and one gateway, no local directory and no bundle to open.
      const reader = new BundledTraceStore(registry, [backend]);
      for (let i = 0; i < settlement.length; i++) {
        const hash = hashes[i + 1];
        const got = await reader.get(hash);
        assert.isNotNull(got, `${hex(hash)} should resolve through its own cell`);
        assert.equal(hex(sha256(got!)), hex(hash), "and re-hash to the hash the chain committed");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("anchors the ciphertext under the plaintext hash when the store encrypts", async () => {
      // The owner's directory is encrypted, so the bytes on the gateway are ciphertext and the
      // cell has to answer the hash the record names — the rule `indexBundle` follows inside a
      // bundle, followed here for a blob that has no bundle.
      const dir = tempDir();
      const key = traceKey();
      const { registry, backend, published, hashes } = await settle(dir, key);
      assert.isUndefined(published.error);
      const reader = new BundledTraceStore(registry, [backend]);
      const got = await reader.get(hashes[2]);
      assert.isNotNull(got, "the result blob resolves");
      assert.isTrue(isEncryptedTraceBlob(got!), "as ciphertext, which is what a public gateway should hold");
      const side = new MemoryBackend();
      await side.set(hex(hashes[2]), got!);
      const opened = await new EncryptedTraceStore(side, key).get(hashes[2]);
      assert.equal(new TextDecoder().decode(opened!), new TextDecoder().decode(settlement[1]));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("counts a blob already anchored instead of re-pointing it", async () => {
      const dir = tempDir();
      const { registry, cells, backend } = await settle(dir);
      const again = new RecordingTraceStore(new MemoryTraceStore(), { backend, registry });
      for (const blob of settlement) await again.put(blob);
      const second = await again.publish();
      assert.isUndefined(second.error);
      assert.equal(second.published, 0);
      assert.equal(second.already, settlement.length, "the first mapping is the binding one");
      assert.equal(cells.size, settlement.length);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reports a backend that refused instead of throwing, the way a seal does", async () => {
      const refuses = {
        scheme: LocatorScheme.Irys,
        upload: async (): Promise<Uint8Array> => {
          throw new Error("this account has no balance at Irys");
        },
        download: async () => null,
      };
      const broken = new RecordingTraceStore(new MemoryTraceStore(), {
        backend: refuses,
        registry: stubRegistry().registry,
      });
      for (const blob of settlement) await broken.put(blob);
      const failed = await broken.publish();
      // A settlement that closed a channel is not failed by the copy made for readers.
      assert.match(failed.error!, /no balance at Irys/);
      assert.equal(failed.published, 0);
    });
  });
});

/**
 * A plaintext that happens to open with the four bytes `LTE2`. "Is this ciphertext?" is a
 * check of those bytes and a length, and a loop memory is the model's final answer verbatim, so
 * injected content can make an honest step's memory look like ciphertext. A bundle that filed
 * such an entry only under bytes 4..36 of itself, a per-blob cell anchored there too, and reader
 * legs that refused the exact bytes from a raw store for not naming the hash in a header would
 * have a stranger auditing with a gateway read the memory as missing and fail the goal step.
 */
describe("a plaintext that opens with LTE2", () => {
  const memory = utf8(`LTE2${"x".repeat(70)} … the model's answer. GOAL REACHED`);
  const hash = sha256(memory);
  const genesis = sha256(utf8("genesis of the step whose memory this is"));

  it("is filed under the hash it re-hashes to", () => {
    assert.isTrue(isEncryptedTraceBlob(memory), "the premise: its first bytes are a header's");
    const index = indexBundle(encodeBundle([memory, utf8("another blob")]));
    assert.equal(hex(index.get(hex(hash))!), hex(memory));
  });

  it("is never displaced from that slot by an entry that only claims it", async () => {
    const backend = new MemoryBackend();
    const otherHash = await new SealingTraceStore(backend, traceKey()).put(utf8("other"));
    const forged = new Uint8Array((await backend.get(hex(otherHash)))!);
    forged.set(hash, 4);
    for (const order of [
      [memory, forged],
      [forged, memory],
    ]) {
      assert.equal(hex(indexBundle(encodeBundle(order)).get(hex(hash))!), hex(memory));
    }
  });

  it("resolves through the session's bundle, a direct cell, and a raw store by hash", async () => {
    const dir = tempDir();
    const backend = new FsLocatorBackend(dir);

    // The bundle: what a loop step seals.
    const sealed = stubRegistry();
    const recording = new RecordingTraceStore(new MemoryTraceStore(), { backend, registry: sealed.registry });
    assert.equal(hex(await recording.put(memory)), hex(hash));
    assert.isUndefined((await recording.seal(genesis)).error);
    const bundled = new BundledTraceStore(sealed.registry, [backend]);
    assert.equal(await bundled.openSession(genesis), 1, "one entry, counted once");
    assert.equal(hex((await bundled.get(hash))!), hex(memory));

    // A direct cell: what `publish` anchors for a blob with no bundle, under the hash the store answered.
    const cells = stubRegistry();
    const once = new RecordingTraceStore(new MemoryTraceStore(), { backend, registry: cells.registry });
    await once.put(memory);
    assert.deepEqual(await once.publish(), { published: 1, already: 0 });
    assert.isTrue(cells.cells.has(hex(hash)), "anchored under its sha256, not under bytes 4..36 of itself");
    assert.equal(hex((await new BundledTraceStore(cells.registry, [backend]).get(hash))!), hex(memory));

    // A raw store asked by hash, with nothing anchored at all.
    fs.writeFileSync(path.join(dir, hex(hash)), memory);
    assert.equal(hex((await new BundledTraceStore(stubRegistry().registry, [backend]).get(hash))!), hex(memory));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The verification bundle the browser exports and `scripts/verify-bundle.ts` replays — a
 * different document from the session bundle above, and here for the same reason: it is a file a
 * stranger checks with no chain in reach, so what it can and cannot conclude is worth pinning.
 *
 * The case: a chain written by the console begins with a `create_struct` and a few
 * cell writes (the NameRecord and the policy cells a deploy makes), and those share the owner's
 * operation counter with events without leaving a record or an epoch. A bundle that carried only
 * records and epochs would have a hole at seq 0 and replay as FAILED for every deployed
 * agent. Version 2 carries those writes, so the fold crosses them; what still cannot be carried —
 * a compact event, or a cell closed or replaced away — is reported as **verified with gaps**, with
 * the seqs named, rather than as a failure.
 */
describe("verification bundle (the export the browser writes)", () => {
  const AGENT = sha256(utf8("bundle-verify-agent"));
  const STRUCT = sha256(utf8("profile"));

  const input = (n: number): EventInput => ({
    timestamp: BigInt(1_700_000_000 + n),
    kind: n % 2 === 0 ? EventKind.Action : EventKind.Genesis,
    status: 0,
    reference: sha256(utf8(`ref-${n}`)),
    payloadHash: sha256(utf8(`payload-${n}`)),
  });

  /**
   * A chain shaped like a deployed agent's: a structure header, a cell write, a record, then an
   * epoch of two steps. Every head is the real fold, so the checker's arithmetic is being tested
   * against the SDK's and not against a fixture someone typed.
   */
  function chain(): { bundle: any; heads: Bytes32[] } {
    const header: StructHeader = {
      ownerId: AGENT,
      structId: STRUCT,
      kind: StructKind.Map,
      mode: StructMode.Public,
      lenOrCount: 1n,
      createdOpSeq: 0n,
      consumable: false,
      appendPolicy: AppendPolicy.OwnerOnly,
      policyRef: new Uint8Array(32),
    };
    const h0 = computeStructHead(ZERO32, header, 0n);

    const cell: Cell = {
      ownerId: AGENT,
      structId: STRUCT,
      indexOrVersion: 0n,
      opSeq: 1n,
      timestamp: 1_700_000_100n,
      tag: 3,
      status: 0,
      keySlot: sha256(utf8("name")),
      valueSlot: valueSlot("walk-0917-a"),
      head: new Uint8Array(32),
    };
    cell.head = computeCellHead(h0, CellOp.Create, cell);

    const rec = input(2);
    const h2 = computeHead(cell.head, AGENT, 2n, rec);

    const steps = [input(3), input(4)];
    const root = epochRootOf(3n, steps);
    const tree = createEpochMerkleTree(epochLeaves(3n, steps));
    const h4 = computeEpochHead(h2, AGENT, root, 3n, 5n);

    const bundle = {
      version: 2,
      cluster: "devnet",
      kind: "agent",
      id: hex(AGENT),
      programId: "3JVKp1sfLPGNPG5DtpKh4mXvJDb2eV6nxhacmQmKBKJf",
      header: { seq: "5", head: hex(h4), authority: "So11111111111111111111111111111111111111112" },
      records: [
        {
          seq: "2",
          timestamp: rec.timestamp.toString(),
          kind: rec.kind,
          status: rec.status,
          reference: hex(rec.reference),
          payloadHash: hex(rec.payloadHash),
          head: hex(h2),
        },
      ],
      epochs: [
        {
          ordinal: 1,
          startSeq: "3",
          endSeq: "5",
          root: hex(root),
          head: hex(h4),
          signature: "4Q6…",
          steps: steps.map((s, i) => {
            const proof = generateEpochProof(tree, i);
            return {
              seq: (3n + BigInt(i)).toString(),
              timestamp: s.timestamp.toString(),
              kind: s.kind,
              status: s.status,
              reference: hex(s.reference),
              payloadHash: hex(s.payloadHash),
              leaf: hex(proof.leaf),
              proof: proof.proof.map(hex),
              index: i,
            };
          }),
        },
      ],
      unavailable: [],
      operations: [
        {
          type: "struct",
          seq: "0",
          structId: hex(STRUCT),
          structKind: StructKind.Map,
          mode: StructMode.Public,
          consumable: false,
          appendPolicy: AppendPolicy.OwnerOnly,
          policyRef: hex(new Uint8Array(32)),
        },
        {
          type: "cell",
          seq: "1",
          structId: hex(STRUCT),
          cellOp: CellOp.Create,
          indexOrVersion: "0",
          timestamp: cell.timestamp.toString(),
          tag: cell.tag,
          status: cell.status,
          keySlot: hex(cell.keySlot),
          valueSlot: hex(cell.valueSlot),
          head: hex(cell.head),
        },
      ],
      operationsStatus: "scanned",
      readme: ["…"],
      exportedAt: "2026-09-18T00:00:00.000Z",
    };
    return { bundle, heads: [h0, cell.head, h2, h4] };
  }

  it("replays a chain that starts with a structure header and a cell write", () => {
    const { bundle } = chain();
    const replay = replayBundle(bundle);
    assert.equal(replay.verdict, "verified", replay.summary);
    assert.equal(replay.failures, 0);
    assert.deepEqual(replay.missingSeqs, []);
    // The header's head is derived from zero, which is the whole claim: seqs 0 and 1 were folded
    // across rather than re-synchronised from a head the file asserts.
    assert.match(replay.summary, /VERIFIED —/);
  });

  it("reports a version 1 export of the same chain as verified with gaps, naming the seqs", () => {
    const { bundle } = chain();
    // A version 1 export: no operations at all.
    const old = { ...bundle, version: 1, operations: undefined, operationsStatus: undefined, readme: undefined };
    const replay = replayBundle(old);
    assert.equal(replay.verdict, "verified-with-gaps", replay.summary);
    assert.equal(replay.failures, 0, "a gap is not a disagreement");
    assert.deepEqual(replay.missingSeqs.map(String), ["0", "1"]);
    assert.match(replay.summary, /VERIFIED WITH GAPS/);
    assert.match(replay.summary, /seq 0–1/);
  });

  it("reports a compact event in the middle as a gap, not a failure", () => {
    const { bundle } = chain();
    // Seq 2's record is the one a `compact: true` write would not have left behind.
    const compact = { ...bundle, records: [] };
    const replay = replayBundle(compact);
    assert.equal(replay.verdict, "verified-with-gaps", replay.summary);
    assert.deepEqual(replay.missingSeqs.map(String), ["2"]);
    // The epoch after the hole still checks against its own recorded head, so its steps and root
    // are verified even though the head before them could not be derived.
    assert.isTrue(replay.lines.some((l) => l.ok === true && /steps rebuild the committed root/.test(l.text)));
  });

  it("fails on an edited cell, naming the seq", () => {
    const { bundle } = chain();
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.operations[1].valueSlot = hex(valueSlot("walk-0917-b"));
    const replay = replayBundle(tampered);
    assert.equal(replay.verdict, "failed", replay.summary);
    assert.equal(replay.firstBadSeq?.toString(), "1");
  });

  it("fails on an edited record head", () => {
    const { bundle } = chain();
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.records[0].head = hex(sha256(utf8("not the head")));
    const replay = replayBundle(tampered);
    assert.equal(replay.verdict, "failed", replay.summary);
    assert.equal(replay.firstBadSeq?.toString(), "2");
  });

  // The encoders wrap: a byte of 257 is 1 and a u16 of 65736 is 200, so these hashed as the chain's.
  it("refuses a kind, status or timestamp that only matches because the encoder wraps it", () => {
    const { bundle } = chain();
    const edits: [string, (b: any) => void][] = [
      ["records[0].kind", (b) => (b.records[0].kind += 256)],
      ["records[0].status", (b) => (b.records[0].status += 65_536)],
      [
        "records[0].timestamp",
        (b) => (b.records[0].timestamp = (BigInt(b.records[0].timestamp) + (1n << 64n)).toString()),
      ],
      ["epochs[0].steps[0].kind", (b) => (b.epochs[0].steps[0].kind += 256)],
    ];
    for (const [where, edit] of edits) {
      const tampered = JSON.parse(JSON.stringify(bundle));
      edit(tampered);
      assert.throws(() => replayBundle(tampered), /expected|does not fit/, where);
    }
  });

  it("says when the exporter's structure scan did not answer", () => {
    const { bundle } = chain();
    const blind = { ...bundle, operations: [], operationsStatus: "unavailable" };
    const replay = replayBundle(blind);
    assert.equal(replay.verdict, "verified-with-gaps", replay.summary);
    assert.isTrue(replay.lines.some((l) => /structure scan did not answer/.test(l.text)));
  });

  // An epoch the exporter could not open is carried with no steps: its fold still checks, but
  // VERIFIED promises every epoch's steps rebuild their root, and here none were looked at.
  it("holds an epoch carried without its steps at verified with gaps, naming the epoch", () => {
    const { bundle } = chain();
    const stripped = JSON.parse(JSON.stringify(bundle));
    delete stripped.epochs[0].steps;
    stripped.unavailable = [1];
    const replay = replayBundle(stripped);
    assert.equal(replay.verdict, "verified-with-gaps", replay.summary);
    assert.equal(replay.failures, 0, "a stepless epoch is not a disagreement");
    assert.deepEqual(replay.missingSeqs, [], "every seq is still covered");
    assert.deepEqual(replay.steplessEpochs, [1]);
    assert.match(replay.summary, /VERIFIED WITH GAPS/);
    assert.match(replay.summary, /#1/);
    assert.notMatch(replay.summary, /--recover/, "no seq is missing, so nothing for --recover to refill");
  });

  it("groups consecutive missing seqs into ranges", () => {
    assert.equal(seqRanges([0n, 1n, 2n, 3n, 4n, 5n, 12n, 14n]), "0–5, 12, 14");
  });

  /**
   * The same chain with a `set_append_policy` between the record and the epoch. The `struct`
   * row carries the header as the browser reads it afterwards — `Anyone`, say, if the owner opened
   * it — so a checker folding the creation from that row alone fails at seq 1; the version 3
   * `policy` row carries the policy the rewrite replaced, and `headerFolds` puts it back.
   */
  function rewrittenChain(): { bundle: any; h3: Bytes32 } {
    const { bundle } = chain();
    const header: StructHeader = {
      ownerId: AGENT,
      structId: STRUCT,
      kind: StructKind.Map,
      mode: StructMode.Public,
      lenOrCount: 1n,
      createdOpSeq: 0n,
      consumable: false,
      appendPolicy: AppendPolicy.Anyone,
      policyRef: new Uint8Array(32),
    };
    const h2 = b32(bundle.records[0].head);
    const h3 = computeStructHead(h2, header, 3n, CellOp.SetAppendPolicy);
    const steps = [input(4), input(5)];
    const root = epochRootOf(4n, steps);
    const tree = createEpochMerkleTree(epochLeaves(4n, steps));
    const h5 = computeEpochHead(h3, AGENT, root, 4n, 6n);
    const rewritten = {
      ...bundle,
      version: 3,
      header: { ...bundle.header, seq: "6", head: hex(h5) },
      epochs: [
        {
          ...bundle.epochs[0],
          startSeq: "4",
          endSeq: "6",
          root: hex(root),
          head: hex(h5),
          steps: steps.map((s, i) => {
            const proof = generateEpochProof(tree, i);
            return {
              seq: (4n + BigInt(i)).toString(),
              timestamp: s.timestamp.toString(),
              kind: s.kind,
              status: s.status,
              reference: hex(s.reference),
              payloadHash: hex(s.payloadHash),
              leaf: hex(proof.leaf),
              proof: proof.proof.map(hex),
              index: i,
            };
          }),
        },
      ],
      operations: [
        { ...bundle.operations[0], appendPolicy: AppendPolicy.Anyone },
        bundle.operations[1],
        {
          type: "policy",
          seq: "3",
          structId: hex(STRUCT),
          appendPolicy: AppendPolicy.Anyone,
          policyRef: hex(new Uint8Array(32)),
          previousPolicy: AppendPolicy.OwnerOnly,
          previousPolicyRef: hex(new Uint8Array(32)),
          head: hex(h3),
        },
      ],
    };
    return { bundle: rewritten, h3 };
  }
  const b32 = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

  it("replays a chain whose header was rewritten by set_append_policy", () => {
    const { bundle } = rewrittenChain();
    const replay = replayBundle(bundle);
    assert.equal(replay.verdict, "verified", replay.summary);
    assert.deepEqual(replay.missingSeqs, []);
    assert.isTrue(replay.lines.some((l) => l.ok === true && /seq 3 policy rewrite/.test(l.text)));
  });

  it("fails a version 2 export of the rewritten chain at the first head after the creation", () => {
    // A version 2 export: the header as read, no policy row. The creation fold is
    // over the wrong policy and seq 1's recorded head says so; seq 3 is a hole on top.
    const { bundle } = rewrittenChain();
    const old = { ...bundle, version: 2, operations: bundle.operations.slice(0, 2) };
    const replay = replayBundle(old);
    assert.equal(replay.verdict, "failed", replay.summary);
    assert.equal(replay.firstBadSeq?.toString(), "1");
    assert.deepEqual(replay.missingSeqs.map(String), ["3"]);
    assert.isTrue(replay.lines.some((l) => /before policy rewrites/.test(l.text)));
  });

  it("fails on a tampered previous_policy in the policy row", () => {
    const { bundle } = rewrittenChain();
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.operations[2].previousPolicy = AppendPolicy.Anyone;
    const replay = replayBundle(tampered);
    assert.equal(replay.verdict, "failed", replay.summary);
    assert.equal(replay.firstBadSeq?.toString(), "1");
  });

  it("fails on a policy row whose head is not the fold", () => {
    const { bundle } = rewrittenChain();
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.operations[2].head = hex(sha256(utf8("not the head")));
    const replay = replayBundle(tampered);
    assert.equal(replay.verdict, "failed", replay.summary);
    assert.equal(replay.firstBadSeq?.toString(), "3");
  });

  it("leaves a policy row whose structure is not in the file as a gap, not a fold", () => {
    const { bundle } = rewrittenChain();
    const orphan = { ...bundle, operations: bundle.operations.slice(2) };
    const replay = replayBundle(orphan);
    assert.equal(replay.verdict, "verified-with-gaps", replay.summary);
    assert.deepEqual(replay.missingSeqs.map(String), ["0", "1", "3"]);
  });
});
