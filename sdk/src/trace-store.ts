import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { hex, sha256, toBytes32, utf8 } from "./hash";

/**
 * The runtime-neutral half of trace storage: the `TraceStore` / `BlobBackend` interfaces and
 * the in-memory implementation. Everything that needs a filesystem lives in
 * `trace-store-node.ts`, so that importing the SDK in a browser does not pull in `fs`.
 *
 * Off-chain storage for verbose material (prompts, transcripts, tool args/results, outputs,
 * vector lookups). Content-addressed by sha256 of the *plaintext*, so the on-chain
 * `payload_hash` / `args_hash` / `result_hash` fields resolve to bytes without trusting the
 * store, and any backend (disk, an object store, a database) is interchangeable.
 *
 * Nothing stored here ever reaches the chain.
 */
export interface TraceStore {
  /** Stores bytes; returns sha256(plaintext) — the key committed on-chain. */
  put(bytes: Uint8Array): Promise<Uint8Array>;
  /** Returns plaintext bytes for a hash, or null if unknown. */
  get(hash: Uint8Array): Promise<Uint8Array | null>;
}

/** Raw key → blob backend. Implement this for an object store or a database and wrap it below. */
export interface BlobBackend {
  set(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class MemoryBackend implements BlobBackend {
  private map = new Map<string, Uint8Array>();
  async set(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }
  get size(): number {
    return this.map.size;
  }
}

/** Plaintext content-addressed store over any backend. */
export class PlainTraceStore implements TraceStore {
  constructor(readonly backend: BlobBackend) {}
  async put(bytes: Uint8Array): Promise<Uint8Array> {
    const h = sha256(bytes);
    await this.backend.set(hex(h), bytes);
    return h;
  }
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.backend.get(hex(hash));
  }
}

export class MemoryTraceStore extends PlainTraceStore {
  constructor() {
    super(new MemoryBackend());
  }
  get size(): number {
    return (this.backend as MemoryBackend).size;
  }
}

// ─── Encrypted traces ───────────────────────────────────────────────────────
//
// An encrypted blob is `"LTE2" ‖ plaintext_hash(32) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`
// (AES-256-GCM). The four-byte magic is what makes "is this ciphertext?" a byte check rather than
// a guess: a reader that fetches a blob by hash and finds it does not re-hash to its key can tell
// a plaintext that was corrupted in transit (fails, no magic) from a trace the owner encrypted
// (magic, needs a key). The plaintext hash is bound into the GCM additional data, so a ciphertext
// cannot be moved under another key.
//
// In LTE2 that hash is also *in* the blob, because the session bundle keys its entries by
// `sha256(entry)` and a ciphertext hashes to nothing the chain committed: an LTE1 entry indexes
// under a key nobody ever asks for, and every lookup of that session misses. The hash is on chain
// already, so carrying it in the clear leaks nothing, and it stays the AAD, so the binding is
// unchanged.
//
// This build writes neither format: traces are written in the clear, and owner encryption is a
// roadmap item (SECURITY.md §3). What stays is the read side, both stores opening LTE2 and LTE1
// alike, because devnet carries chains written encrypted and those chains must keep auditing
// (`lath-audit --trace-key`).

/** `"LTE1"` — the format whose hash is only the AAD. Read, never written. */
const ENCRYPTED_TRACE_MAGIC_V1 = utf8("LTE1");
/** `"LTE2"` — Lath Trace, Encrypted, format 2, which carries its hash. Read, never written. */
const ENCRYPTED_TRACE_MAGIC = utf8("LTE2");
const MAGIC_LEN = 4;
export const ENCRYPTED_TRACE_HASH_LEN = 32;
export const ENCRYPTED_TRACE_NONCE_LEN = 12;
export const ENCRYPTED_TRACE_TAG_LEN = 16;

/** Which format a blob carries, or `null` when it carries neither header. */
function encryptedTraceVersion(bytes: Uint8Array): 1 | 2 | null {
  const magicIs = (m: Uint8Array) => {
    for (let i = 0; i < MAGIC_LEN; i++) if (bytes[i] !== m[i]) return false;
    return true;
  };
  const body = ENCRYPTED_TRACE_NONCE_LEN + ENCRYPTED_TRACE_TAG_LEN;
  if (bytes.length >= MAGIC_LEN + body && magicIs(ENCRYPTED_TRACE_MAGIC_V1)) return 1;
  return bytes.length >= MAGIC_LEN + ENCRYPTED_TRACE_HASH_LEN + body && magicIs(ENCRYPTED_TRACE_MAGIC) ? 2 : null;
}

/** Does `bytes` carry an encrypted-trace header, of either format? A byte check, not a length heuristic. */
export function isEncryptedTraceBlob(bytes: Uint8Array): boolean {
  return encryptedTraceVersion(bytes) !== null;
}

/**
 * Is `blob` plausibly the owner's ciphertext *of the bytes behind `hash`*? `'lte2'` or `'lte1'`
 * for the format it carries, `null` when it is not.
 *
 * `isEncryptedTraceBlob` answers a narrower question — does it carry a header at all — and a
 * header is four bytes anyone can write: `"LTE1"` and 28 zeros would pass for an encrypted
 * preimage. Without the key nothing can tell ciphertext from bytes shaped like it, but two things
 * bind more than the magic does:
 *
 * - An LTE2 header names the plaintext hash in the clear, so one naming another hash is a blob
 *   filed under the wrong key. That catches misfiling, not forgery — the header is cleartext.
 * - AES-GCM adds no padding, so ciphertext is exactly as long as its plaintext. Where the
 *   plaintext's length is fixed — a payload preimage is 129, 99, 129 or 70 bytes by kind — the
 *   blob's length is fixed too: `4 + 32 + 12 + L + 16` for LTE2 and `4 + 12 + L + 16` for LTE1.
 *
 * LTE1 carries no hash, so for it the length is the only check there is. It is still accepted:
 * LTE1 blobs are on devnet, and they have to keep auditing.
 *
 * Browser-safe, like the rest of this file.
 */
export function encryptedTraceFor(blob: Uint8Array, hash: Uint8Array, plaintextLen?: number): "lte2" | "lte1" | null {
  const version = encryptedTraceVersion(blob);
  const overhead = MAGIC_LEN + ENCRYPTED_TRACE_NONCE_LEN + ENCRYPTED_TRACE_TAG_LEN;
  if (version === 2) {
    if (hex(blob.subarray(MAGIC_LEN, MAGIC_LEN + ENCRYPTED_TRACE_HASH_LEN)) !== hex(hash)) return null;
    if (plaintextLen !== undefined && blob.length !== overhead + ENCRYPTED_TRACE_HASH_LEN + plaintextLen) return null;
    return "lte2";
  }
  if (version === 1) {
    if (plaintextLen !== undefined && blob.length !== overhead + plaintextLen) return null;
    return "lte1";
  }
  return null;
}

/**
 * The plaintext hash an LTE2 blob carries — what the chain committed, and what a bundle keys it
 * by. `null` for an LTE1 blob, whose hash is nowhere in its bytes, and for anything that is not
 * ciphertext at all: a caller holding `null` has to be told the hash by whoever asked for it.
 */
export function encryptedTraceHash(blob: Uint8Array): Uint8Array | null {
  return encryptedTraceVersion(blob) === 2 ? blob.subarray(MAGIC_LEN, MAGIC_LEN + ENCRYPTED_TRACE_HASH_LEN) : null;
}

/** Splits an encrypted blob into its parts, or returns `null` when it is not one. */
export function splitEncryptedTraceBlob(
  blob: Uint8Array
): { hash: Uint8Array | null; nonce: Uint8Array; ciphertextAndTag: Uint8Array } | null {
  const version = encryptedTraceVersion(blob);
  if (version === null) return null;
  const o = MAGIC_LEN + (version === 2 ? ENCRYPTED_TRACE_HASH_LEN : 0);
  return {
    hash: encryptedTraceHash(blob),
    nonce: blob.subarray(o, o + ENCRYPTED_TRACE_NONCE_LEN),
    ciphertextAndTag: blob.subarray(o + ENCRYPTED_TRACE_NONCE_LEN),
  };
}

/**
 * What the backend actually holds for a `put`, for the one caller that must copy those bytes
 * rather than the ones it handed in: the session bundle (`bundle.ts`), whose entries would be
 * ciphertext under a store that encrypts. No store in this SDK transforms its bytes — encrypted
 * writes are part of owner privacy, on the roadmap — but the bundle honours one that does, so a
 * caller's own transforming store never has its plaintext bundled. Returned from the call
 * rather than left on the store as "the last thing stored" — a session puts blobs in parallel (a
 * loop step's members), so a field read after an `await` would be whichever put happened to
 * finish last.
 */
export interface StoringTraceStore extends TraceStore {
  putStored(bytes: Uint8Array): Promise<{ hash: Uint8Array; stored: Uint8Array }>;
}

/**
 * Why both encrypted stores refuse `put`: they exist to open chains written encrypted, and this
 * build writes traces in the clear (SECURITY.md §3). A store that quietly wrote plaintext where its
 * caller expected ciphertext would be worse than one that says no.
 */
export const ENCRYPTED_TRACE_WRITE_REFUSED = "encrypted trace stores only read: this build writes traces in the clear";

// ─── Two keys, one plaintext ────────────────────────────────────────────────
//
// The store is content-addressed by `sha256(plaintext)`, because that is what the chain commits.
// But encrypted stores share one directory, and nothing in a payload preimage names its agent: an
// Action is `kind ‖ tool_id ‖ args_hash ‖ result_hash ‖ status`, so two agents making the same
// call with the same result — a loop's team reading the same sources in their sandboxes — put the same
// plaintext under different keys. Had the later write replaced the earlier one, the agent whose
// blob was replaced could no longer open its own record.
//
// So an encrypting store never replaces a blob it cannot open. The first writer keeps the plain
// name, which is what every reader uses; a later writer whose key does not open what is there
// writes `<hash>.<tag>` instead, a name only a holder of its key can compute. This build writes no
// ciphertext, but directories holding those variants exist, so every keyed read tries the plain
// name first and that variant second. The chain, the audit's size rule and the blob format are
// untouched — a variant is the same LTE2 bytes under a second name.

/**
 * The domain of a variant's tag. A name derivation input, so it is frozen like the `lattice` hash
 * inputs: changing it would lose every variant already written.
 */
const TRACE_VARIANT_DOMAIN = utf8("lath.trace-variant.v1");

/**
 * Where an encrypting store puts a blob when its content-addressed name is held by a blob its key
 * does not open, and so where a keyed read looks second: `<hash hex>.<32 hex>`, the tag being the
 * first 16 bytes of `sha256(domain ‖ key ‖ hash)`.
 *
 * Per hash as well as per key, so the names give nothing away that the chain does not: a
 * fingerprint of the key alone would let anyone listing the directory link every variant of one
 * agent together. A reader with the key computes the name; a reader without it has no use for
 * the bytes anyway. It is one-way, so publishing it says nothing about the key.
 */
export function traceVariantName(key: Uint8Array, hash: Uint8Array): string {
  return `${hex(hash)}.${hex(sha256(TRACE_VARIANT_DOMAIN, key, hash)).slice(0, 32)}`;
}

/** Structural, so nothing has to know which stores transform their bytes on the way out. */
export function storesTransformed(store: TraceStore): store is StoringTraceStore {
  return typeof (store as StoringTraceStore).putStored === "function";
}

/**
 * A `BlobBackend` view of another `TraceStore`, so a decrypting store can be layered over a
 * reader that already knows how to find bytes — the audit CLI's `--trace-key` over the bundle
 * reader. Keys are hex hashes, which is what every backend here is keyed by; a variant name
 * (`traceVariantName`) is not one, and a store answering by hash alone holds no variants, so it
 * reads as nothing rather than as a malformed hash.
 */
export function traceStoreBackend(store: TraceStore): BlobBackend {
  return {
    set: async (_key, bytes) => void (await store.put(bytes)),
    get: async (key) => (/^[0-9a-f]{64}$/i.test(key) ? store.get(toBytes32(key)) : null),
  };
}

/**
 * The message a wallet signs to derive a trace key (`deriveTraceKeyFromSignature`). One caveat
 * governs whether this is usable at all: the derivation is only as stable as the wallet's
 * signatures. Ed25519 as specified is deterministic, and Phantom, Solflare and Backpack sign
 * the same message to the same bytes; a wallet that adds randomness (some hardware wallets,
 * some MPC wallets) produces a different key on every signature and the traces become
 * unreadable. A per-agent random key held by the operator avoids that; a signature-derived key is
 * safe only where the wallet is known to be deterministic. This build derives no key to write
 * with; the derivation stays because an owner whose traces were sealed under a wallet-derived key
 * re-derives it here to open them.
 *
 * The message text is frozen: every trace already encrypted was written under a key derived from
 * these exact bytes, and any other text would make those blobs undecryptable by the wallet that
 * wrote them.
 */
export function getTraceSignMessage(ownerId: string, authorityPubkey: string): string {
  return `Lattice Sovereign Trace Decryption Key v1\nOwner: ${authorityPubkey}\nTarget: ${ownerId}\nAuthorize client-side trace decryption for this session.`;
}

/**
 * HKDF-SHA256 over a wallet signature → a 32-byte AES-256 key. See `getTraceSignMessage`.
 *
 * The salt and info strings are frozen for the same reason as the signed message: they are
 * key-derivation inputs behind traces that already exist on devnet.
 */
export function deriveTraceKeyFromSignature(
  signature: Uint8Array,
  salt: Uint8Array = utf8("lattice-trace-encryption-v1"),
  info: string | Uint8Array = "lattice-trace-key"
): Uint8Array {
  const infoBytes = typeof info === "string" ? utf8(info) : info;
  return hkdf(nobleSha256, signature, salt, infoBytes, 32);
}

/**
 * Opens an `LTE2` or `LTE1` blob with WebCrypto (AES-256-GCM, the plaintext hash as the
 * additional data). Returns the blob untouched when it is not ciphertext —
 * a chain mixes encrypted traces with plaintext epoch blobs (`LEP1`) and bundles (`LPB1`), and a
 * reader handed a key still has to read those — and `null` when the tag does not verify (wrong
 * key, wrong `aad`, or tampered bytes).
 */
async function decryptTracePayload(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array | null> {
  if (key.length !== 32) throw new Error("Trace encryption key must be 32 bytes");
  const parts = splitEncryptedTraceBlob(blob);
  if (!parts) return blob;
  // A header naming another hash is a blob filed under the wrong key: nothing here is what the
  // caller asked for, and the tag would refuse it a moment later anyway.
  if (parts.hash && aad && hex(parts.hash) !== hex(aad)) return null;
  const cryptoKey = await crypto.subtle.importKey("raw", key as any, { name: "AES-GCM" }, false, ["decrypt"]);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: parts.nonce as any, additionalData: aad ? (aad as any) : undefined, tagLength: 128 },
      cryptoKey,
      parts.ciphertextAndTag as any
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

/**
 * A decrypting `TraceStore` over any `BlobBackend`, WebCrypto only, so it runs in a browser and in
 * Node alike. Keys are `sha256(plaintext)` — the value the chain commits — and it opens blobs
 * written encrypted: `"LTE2" ‖ plaintext_hash ‖ nonce ‖ ciphertext ‖ tag`, and the older LTE1.
 * `EncryptedTraceStore` in the Node entry opens the same formats with `node:crypto`.
 *
 * Read-only: `put` refuses (`ENCRYPTED_TRACE_WRITE_REFUSED`). `verifyTrace` and `audit` work
 * through it because `get` decrypts, and a reader **without** the key sees ciphertext that a byte
 * check (`isEncryptedTraceBlob`) identifies as such.
 */
export class WebEncryptedTraceStore implements TraceStore {
  constructor(readonly backend: BlobBackend, private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error("WebEncryptedTraceStore needs a 32-byte key");
  }

  async put(_bytes?: Uint8Array): Promise<never> {
    throw new Error(ENCRYPTED_TRACE_WRITE_REFUSED);
  }

  /** Plain name first; the key's variant only when the plain name holds bytes this key refuses. */
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const blob = await this.backend.get(hex(hash));
    if (!blob) return null;
    // Filed under its re-hash, a blob proves itself (as in `bundle.ts`): a plaintext that
    // happens to begin with `LTE1`/`LTE2` is not ciphertext to open, and read as one it came back
    // `null`. No ciphertext re-hashes to the plaintext hash it is filed under.
    if (hex(sha256(blob)) === hex(hash)) return blob;
    const opened = await decryptTracePayload(this.key, blob, hash);
    if (opened) return opened;
    const variant = await this.backend.get(traceVariantName(this.key, hash));
    return variant ? decryptTracePayload(this.key, variant, hash) : null;
  }
}

/** Verifies that stored bytes hash to the expected key (i.e. match the on-chain commitment). */
export async function verifyTrace(store: TraceStore, hash: Uint8Array): Promise<boolean> {
  const bytes = await store.get(hash);
  return bytes !== null && hex(sha256(bytes)) === hex(hash);
}
