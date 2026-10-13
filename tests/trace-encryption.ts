/**
 * The encrypted-trace blob format (SECURITY.md §3): `"LTE2" ‖ plaintext_hash(32) ‖ nonce(12) ‖
 * ciphertext ‖ tag(16)`.
 *
 * No validator and no network — this is bytes, a key and two AES implementations.
 *
 * This build writes traces in the clear, and the SDK's encrypted stores only read: devnet carries
 * chains whose blobs are encrypted, and those must keep auditing. So every blob here is
 * sealed by `tests/fixtures/sealed-traces.ts`, which writes what those chains hold byte for byte,
 * and what is asserted is that both SDK readers open it.
 *
 * What is pinned is why the hash moved into the blob and what stops that from weakening anything.
 * It is there so a bundle can key an entry by the hash the chain committed, since a ciphertext
 * re-hashes to a number nobody ever asks for; it is still the GCM additional data, so a ciphertext
 * re-filed under another hash does not open. Both of those are asserted, in the same case, because
 * either one alone would be a format that looks fine and is not.
 */
import { assert } from "chai";
import {
  deriveTraceKeyFromSignature,
  ENCRYPTED_TRACE_WRITE_REFUSED,
  encryptedTraceHash,
  EncryptedTraceStore,
  encodeBundle,
  getTraceSignMessage,
  hex,
  indexBundle,
  isEncryptedTraceBlob,
  MemoryBackend,
  sha256,
  splitEncryptedTraceBlob,
  traceVariantName,
  utf8,
  WebEncryptedTraceStore,
} from "../sdk/src";
import { SealingTraceStore, sealTrace, traceKey } from "./fixtures/sealed-traces";

const plaintext = utf8('{"prompt":"the thing the owner does not want published"}');

describe("encrypted traces", () => {
  const key = traceKey();

  describe("the LTE2 blob", () => {
    it("carries the plaintext hash in the clear and keeps it as the AAD", async () => {
      const backend = new MemoryBackend();
      const hash = await new SealingTraceStore(backend, key).put(plaintext);
      const blob = (await backend.get(hex(hash)))!;

      assert.equal(new TextDecoder().decode(blob.slice(0, 4)), "LTE2");
      assert.isTrue(isEncryptedTraceBlob(blob));
      assert.equal(hex(encryptedTraceHash(blob)!), hex(hash), "the hash the chain committed, readable without a key");
      assert.equal(hex(splitEncryptedTraceBlob(blob)!.nonce), hex(blob.slice(36, 48)));
      // And the ciphertext is not the plaintext under a header.
      assert.notInclude(new TextDecoder().decode(blob), "the thing the owner does not want published");
    });

    it("is opened by both readers, node:crypto and WebCrypto", async () => {
      const backend = new MemoryBackend();
      const hash = await new SealingTraceStore(backend, key).put(plaintext);
      assert.equal(hex((await new EncryptedTraceStore(backend, key).get(hash))!), hex(plaintext));
      assert.equal(hex((await new WebEncryptedTraceStore(backend, key).get(hash))!), hex(plaintext));
    });

    it("still opens an LTE1 blob, and reports no embedded hash for one", async () => {
      // Devnet carries blobs in the older format, and a change that made them unreadable would be
      // a breaking change rather than a cleanup (docs/ARCHITECTURE.md §13).
      const backend = new MemoryBackend();
      const { blob, hash } = sealTrace(key, plaintext, "LTE1");
      await backend.set(hex(hash), blob);
      assert.isTrue(isEncryptedTraceBlob(blob), "the old header is still a header");
      assert.isNull(encryptedTraceHash(blob), "but its hash is in the AAD and nowhere in the bytes");
      assert.isNull(splitEncryptedTraceBlob(blob)!.hash);
      assert.equal(hex((await new EncryptedTraceStore(backend, key).get(hash))!), hex(plaintext));
      assert.equal(hex((await new WebEncryptedTraceStore(backend, key).get(hash))!), hex(plaintext));
    });

    it("hands back a blob that is not ciphertext instead of refusing it", async () => {
      // A chain mixes encrypted traces with plaintext epoch blobs and bundles, and a reader given
      // a key still has to read those: one key must not be the price of reading anything.
      const backend = new MemoryBackend();
      const epochBlob = utf8("LEP1 and whatever a fold input looks like");
      await backend.set(hex(sha256(epochBlob)), epochBlob);
      const store = new EncryptedTraceStore(backend, key);
      assert.equal(hex((await store.get(sha256(epochBlob)))!), hex(epochBlob));
      assert.isNull(await store.get(sha256(utf8("nothing stored under this"))));
    });

    it("is never written by this build: both readers refuse a put and leave the backend as it was", async () => {
      // Owner encryption is a roadmap item (SECURITY.md §3). A store that quietly wrote plaintext
      // where its caller expected ciphertext would be worse than one that says no.
      const backend = new MemoryBackend();
      for (const store of [new EncryptedTraceStore(backend, key), new WebEncryptedTraceStore(backend, key)]) {
        const refused = await store.put(plaintext).then(
          () => null,
          (e: any) => String(e?.message ?? e)
        );
        assert.equal(refused, ENCRYPTED_TRACE_WRITE_REFUSED);
      }
      assert.equal(backend.size, 0);
    });
  });

  describe("a hash swapped in the header", () => {
    it("fails to open, and indexes under the hash it claims rather than the one it holds", async () => {
      const backend = new MemoryBackend();
      const hash = await new SealingTraceStore(backend, key).put(plaintext);
      const blob = (await backend.get(hex(hash)))!;

      // The mutation: the same ciphertext, filed under another hash the chain also committed.
      const other = sha256(utf8("some other blob of this session"));
      const swapped = new Uint8Array(blob);
      swapped.set(other, 4);
      assert.equal(hex(encryptedTraceHash(swapped)!), hex(other));

      // It does not open: the hash is the GCM additional data, so the tag no longer verifies —
      // whether it is asked for under the hash it claims or the one it was written under.
      const tampered = new MemoryBackend();
      await tampered.set(hex(other), swapped);
      await tampered.set(hex(hash), swapped);
      const store = new EncryptedTraceStore(tampered, key);
      const web = new WebEncryptedTraceStore(tampered, key);
      const threw = async (hashAsked: Uint8Array) =>
        store.get(hashAsked).then(
          () => null,
          (e: any) => String(e?.message ?? e)
        );
      assert.isNotNull(await threw(other), "the swapped hash is the AAD now, and the tag does not verify");
      assert.isNotNull(await threw(hash), "nor does the hash it was written under, which is no longer in the blob");
      assert.isNull(await web.get(other), "WebCrypto says the same thing by returning nothing");

      // And it does not index: a bundle is keyed by the header, so the entry answers for a hash
      // whose bytes it is not, and the hash the chain committed for it misses entirely.
      const index = indexBundle(encodeBundle([swapped]));
      assert.isUndefined(index.get(hex(hash)), "the committed hash finds nothing");
      assert.isDefined(index.get(hex(other)), "and what it does answer for does not decrypt");
    });
  });

  describe("a plaintext that begins with the magic", () => {
    it("is returned by both encrypted stores when it is filed under its own re-hash", async () => {
      // An epoch blob or a tool output can begin with any four bytes; these happen to be `LTE2`
      // followed by a header that names another hash, so read as ciphertext it would be refused.
      for (const magic of ["LTE1", "LTE2"]) {
        const bytes = new Uint8Array([
          ...utf8(magic),
          ...sha256(utf8("not this blob")),
          ...utf8(" plain text after it"),
        ]);
        const backend = new MemoryBackend();
        const hash = sha256(bytes);
        await backend.set(hex(hash), bytes);
        assert.equal(hex((await new EncryptedTraceStore(backend, key).get(hash))!), hex(bytes), `${magic}: node`);
        assert.equal(hex((await new WebEncryptedTraceStore(backend, key).get(hash))!), hex(bytes), `${magic}: web`);
      }
    });
  });

  describe("two keys, one plaintext", () => {
    // An orchestrator and a team member can make the same call with the same result, so both put
    // the same 99-byte Action preimage, and the member's write would replace the orchestrator's
    // blob under the shared name. Nothing in a preimage names its agent, so the encrypting stores
    // kept both, the second under its key's variant;
    // directories holding such pairs exist, and each key's reader still has to find its own.
    const preimage = new Uint8Array(99).fill(7);
    preimage[0] = 1;
    const mine = traceKey();
    const theirs = traceKey();

    for (const [label, Store] of [
      ["node:crypto", EncryptedTraceStore],
      ["WebCrypto", WebEncryptedTraceStore],
    ] as const) {
      it(`lets both agents open their own record, through ${label}`, async () => {
        const backend = new MemoryBackend();
        const hash = await new SealingTraceStore(backend, mine).put(preimage);
        const first = (await backend.get(hex(hash)))!;
        assert.equal(hex(await new SealingTraceStore(backend, theirs).put(preimage)), hex(hash), "the same commitment");

        assert.equal(hex((await backend.get(hex(hash)))!), hex(first), "the first writer kept the plain name");
        const variant = (await backend.get(traceVariantName(theirs, hash)))!;
        assert.isNotNull(variant, "the second wrote its variant");
        assert.equal(variant.length, 4 + 32 + 12 + 99 + 16, "the same LTE2 bytes, so the audit's size rule holds");
        assert.equal(hex(encryptedTraceHash(variant)!), hex(hash));

        assert.equal(hex((await new Store(backend, mine).get(hash))!), hex(preimage));
        assert.equal(hex((await new Store(backend, theirs).get(hash))!), hex(preimage));
      });
    }

    it("does not open a record for a key that wrote none", async () => {
      // The variant is only ever a key's own, so a third key finds nothing it was not given.
      const backend = new MemoryBackend();
      const hash = await new SealingTraceStore(backend, mine).put(preimage);
      let refused = false;
      await new EncryptedTraceStore(backend, theirs).get(hash).catch(() => (refused = true));
      assert.isTrue(refused);
      assert.isNull(await new WebEncryptedTraceStore(backend, theirs).get(hash));
    });

    it("still opens a blob written before variants existed, under the plain name only", async () => {
      // What `frontend/.traces-devnet` holds: one blob per hash, whichever key wrote it last.
      const backend = new MemoryBackend();
      const { blob, hash } = sealTrace(mine, preimage, "LTE1");
      await backend.set(hex(hash), blob);
      assert.equal(hex((await new EncryptedTraceStore(backend, mine).get(hash))!), hex(preimage));
      assert.equal(hex((await new WebEncryptedTraceStore(backend, mine).get(hash))!), hex(preimage));
    });

    it("names a variant by hash and key, so a directory listing links no two blobs to one key", () => {
      const a = sha256(utf8("a"));
      const b = sha256(utf8("b"));
      assert.match(traceVariantName(mine, a), /^[0-9a-f]{64}\.[0-9a-f]{32}$/);
      assert.isTrue(traceVariantName(mine, a).startsWith(hex(a)));
      assert.notEqual(traceVariantName(mine, a).slice(65), traceVariantName(mine, b).slice(65));
      assert.notEqual(traceVariantName(mine, a), traceVariantName(theirs, a));
    });
  });

  describe("a key derived from a wallet signature", () => {
    it("is the same 32 bytes for the same signature, and different for another", () => {
      const signature = sha256(utf8("a deterministic Ed25519 signature over the sign-in message"));
      const derived = deriveTraceKeyFromSignature(signature);
      assert.lengthOf(derived, 32);
      assert.equal(hex(deriveTraceKeyFromSignature(signature)), hex(derived), "or the traces become unreadable");
      assert.notEqual(hex(deriveTraceKeyFromSignature(sha256(utf8("another signature")))), hex(derived));
    });

    it("names the owner and the target in the message the wallet shows", () => {
      const message = getTraceSignMessage("agent-alpha", "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy");
      assert.include(message, "agent-alpha");
      assert.include(message, "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy");
      // The version is in the first line: a message that changed silently would change the key.
      assert.match(message.split("\n")[0], /v1$/);
    });

    // The sign message, the HKDF salt and the HKDF info are three of the frozen `lattice`
    // literals (docs/ARCHITECTURE.md §13): every trace a wallet
    // key encrypted was sealed under a key derived from exactly these bytes. The cases above
    // check determinism and content, which a rename sweep over `lattice` would leave green while
    // making every such trace unopenable; a spelled-out literal here would be swept with them. A
    // hex digest would not. Both were derived outside the SDK from the literal strings — paste,
    // never recompute from the SDK at test time.
    it("keeps the sign message frozen at its pinned bytes", () => {
      const message = getTraceSignMessage("agent-alpha", "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy");
      assert.equal(hex(sha256(utf8(message))), "3a7fa92f5d974e29462897afc62568a55dc2eb03f8365bf5ef284f8c0d7f4e7c");
    });

    it("keeps the default salt and info frozen at their pinned bytes", () => {
      assert.equal(
        hex(deriveTraceKeyFromSignature(new Uint8Array(64).fill(7))),
        "172fa48868eca3b97ba7d8ec1832ca628d4913dbc1a55bfa73e8b3bd23003e2a"
      );
    });
  });
});
