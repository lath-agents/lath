/**
 * The session bundle: every blob one session wrote, in one upload and under one on-chain cell.
 *
 * `AnchoredTraceStore` anchors one cell per blob, which is the honest shape for a handful of
 * blobs and the wrong one for a session: a console session writes about twenty, and twenty cells
 * at 15 000 lamports costs five times the session's own chain writes while twenty serial uploads
 * add fifteen seconds. So the preimage behind each record and every blob inside them — prompt,
 * arguments, results, final output, loop memory — go into one blob, uploaded once and anchored
 * once under a key the reader *derives* rather than looks up:
 *
 * ```
 * bundle key = sha256("lattice.preimages" ‖ genesis payload_hash)
 * bundle     = "LPB1" ‖ count u32 ‖ count × (len u32 ‖ bytes)
 * ```
 *
 * No second map is needed for it, because every reader holding a record also holds the kind-0
 * record that opened its session — that is the whole reason the key is the genesis payload hash
 * and not something the writer chose.
 *
 * **Correctness is never the bundle's own hash.** The index is keyed by `sha256(entry)` — and, for
 * an encrypted entry, also by the plaintext hash in its header, which is the same number the chain
 * committed — so an entry answers only for the hash it actually re-hashes to or, as ciphertext,
 * the one its header names, and the hashes the chain committed are the only ones ever asked for.
 * A bundle whose bytes were tampered with therefore indexes to entries that match nothing: every
 * hash of that session reads `unavailable`, and none of them renders as a trace. A gateway is
 * trusted for being up and for nothing else, exactly as in `AnchoredTraceStore`.
 *
 * Nothing here reaches for a Node built-in, so it ships in `@lath/sdk/browser` too.
 */
import { Bytes32, hex, sha256, u32le, utf8 } from "./hash";
import {
  Locator,
  LocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  LocatorSchemeValue,
  ResolvedLocator,
  routeLocatorRead,
} from "./locator";
import { encryptedTraceHash, storesTransformed, TraceStore } from "./trace-store";

/** `"LPB1"` — Lath Preimage Bundle, format 1. */
const BUNDLE_MAGIC = utf8("LPB1");

/**
 * The domain separator in front of the genesis payload hash. A frozen hash input: devnet chains
 * already published bundles under keys derived from it, and changing the domain would send every
 * reader of those sessions to a key nothing was ever uploaded under.
 */
const BUNDLE_KEY_DOMAIN = utf8("lattice.preimages");

/**
 * The ceiling on one bundle, encoded. It is a sanity bound rather than a protocol limit: a
 * session that wrote sixteen megabytes of blobs is a session whose traces belong somewhere other
 * than one upload, and a reader asked to decode an arbitrary download should refuse before it
 * allocates.
 */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** The registry key a session's bundle is anchored under. Derived, never looked up. */
export function bundleKey(genesisPayloadHash: Uint8Array): Bytes32 {
  return sha256(BUNDLE_KEY_DOMAIN, genesisPayloadHash);
}

function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** `"LPB1" ‖ count u32 ‖ count × (len u32 ‖ bytes)`, entries in the order they were put. */
export function encodeBundle(entries: readonly Uint8Array[]): Uint8Array {
  const total = 8 + entries.reduce((n, e) => n + 4 + e.length, 0);
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(
      `a session bundle holds at most ${MAX_BUNDLE_BYTES} bytes; these ${entries.length} encode to ${total}`
    );
  }
  const out = new Uint8Array(total);
  out.set(BUNDLE_MAGIC, 0);
  out.set(u32le(entries.length), 4);
  let at = 8;
  for (const entry of entries) {
    out.set(u32le(entry.length), at);
    out.set(entry, at + 4);
    at += 4 + entry.length;
  }
  return out;
}

/**
 * The inverse. Throws rather than returning `null`, and the message says **where** the bytes
 * stopped making sense: a bundle that does not decode is a download to go and look at, and
 * "malformed" alone does not tell anyone which byte to look at.
 */
export function decodeBundle(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(`a session bundle holds at most ${MAX_BUNDLE_BYTES} bytes; this download is ${bytes.length}`);
  }
  if (bytes.length < 8) {
    throw new Error(`not a session bundle: ${bytes.length} bytes is short of the 8-byte header`);
  }
  if (hex(bytes.slice(0, 4)) !== hex(BUNDLE_MAGIC)) {
    throw new Error(`not a session bundle: expected "LPB1" at offset 0, found ${hex(bytes.slice(0, 4))}`);
  }
  const count = readU32(bytes, 4);
  const entries: Uint8Array[] = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 4 > bytes.length) {
      throw new Error(
        `bundle truncated at offset ${at}: entry ${i} of ${count} needs a 4-byte length and the blob ends`
      );
    }
    const len = readU32(bytes, at);
    if (at + 4 + len > bytes.length) {
      throw new Error(
        `bundle truncated at offset ${at}: entry ${i} of ${count} declares ${len} bytes and only ${
          bytes.length - at - 4
        } remain`
      );
    }
    entries.push(bytes.slice(at + 4, at + 4 + len));
    at += 4 + len;
  }
  if (at !== bytes.length) {
    throw new Error(`bundle carries ${bytes.length - at} bytes after its ${count} entries, at offset ${at}`);
  }
  return entries;
}

/**
 * A decoded bundle keyed the only way it is ever read: by the hash the chain committed.
 *
 * For a plaintext entry that is what it re-hashes to. An encrypted one (`LTE2`) re-hashes to
 * nothing anybody asks for, so it is also keyed by the plaintext hash it carries in its header —
 * which the GCM tag still binds it to, so a ciphertext filed under another hash is one that does
 * not open. Whoever gets those bytes back holds ciphertext
 * and needs the owner's key; the index has done its job either way.
 *
 * Every entry is filed under its own `sha256` first, whatever its first bytes say. "Is this
 * ciphertext?" is a check of four magic bytes, and a plaintext can open with them: a loop memory
 * is the model's final answer verbatim, and an answer that begins `LTE2` and runs to 64 bytes or
 * more, filed only under bytes 4..36 of itself, would leave the hash the chain committed for it
 * finding nothing, so an honest goal step would audit as missing its memory. Filed under its
 * re-hash it proves itself, and `indexEntry` never displaces it.
 *
 * Two entries can claim one hash, and the header of the second is only a claim: see
 * `indexEntry` for which one keeps the slot.
 */
export function indexBundle(bytes: Uint8Array): Map<string, Uint8Array> {
  return fileBundle(bytes).index;
}

/** `indexBundle`, and how many distinct entries (by their own `sha256`) the bundle held. */
function fileBundle(bytes: Uint8Array): { index: Map<string, Uint8Array>; entries: number } {
  const index = new Map<string, Uint8Array>();
  const own = new Set<string>();
  for (const entry of decodeBundle(bytes)) {
    const key = hex(sha256(entry));
    own.add(key);
    indexEntry(index, key, entry);
    const claimed = encryptedTraceHash(entry);
    if (claimed && hex(claimed) !== key) indexEntry(index, hex(claimed), entry);
  }
  return { index, entries: own.size };
}

/**
 * Files `entry` under `key` unless the slot already holds bytes that re-hash to `key`; whether it
 * was filed.
 *
 * A plaintext entry answers for its key by its own bytes. A ciphertext entry answers by the hash
 * its header claims, and anyone can write a header, so a later LTE2 entry with a forged header —
 * later in the same bundle, or in a bundle opened after — could otherwise replace a plaintext
 * entry that genuinely re-hashes. Nothing false would be shown for it, because every reader
 * re-hashes what it opens, but a hash that is answerable would read as not opening. Bytes that
 * prove themselves are never displaced by bytes that only claim to; anything else is last wins,
 * because without the key one claim is as good as another.
 */
function indexEntry(index: Map<string, Uint8Array>, key: string, entry: Uint8Array): boolean {
  const held = index.get(key);
  if (held && hex(sha256(held)) === key) return false;
  index.set(key, entry);
  return true;
}

/**
 * The hash a blob is anchored under when no store said which: the plaintext hash an LTE2 header
 * carries, or else what the bytes re-hash to. A guess for a plaintext that opens with `LTE2`, which
 * is why `RecordingTraceStore` passes `publishBlobs` the hash its store answered instead.
 */
function committedHash(bytes: Uint8Array): Uint8Array {
  return encryptedTraceHash(bytes) ?? sha256(bytes);
}

/**
 * Whether `bytes` answer for `hash`: they re-hash to it, or they carry an encrypted-trace header
 * naming it. Believing that header costs nothing, because the bytes are useless without the key and
 * the key does not open a blob filed under the wrong hash (the hash is the GCM AAD). Both are
 * asked, not whichever the magic bytes suggest: a plaintext that opens with `LTE2` re-hashes to
 * its committed hash, and must not be refused for not naming it in a header it does not have.
 */
function answersFor(bytes: Uint8Array, hash: Uint8Array): boolean {
  const want = hex(hash);
  if (hex(sha256(bytes)) === want) return true;
  const claimed = encryptedTraceHash(bytes);
  return claimed !== null && hex(claimed) === want;
}

/**
 * Where an opened bundle came from: the derived key it is anchored under and the registry cell
 * that answered for it. A reader who got bytes *out of* a bundle has nothing on chain for those
 * bytes themselves — the cell is the bundle's — so this is the one chain fact that lets them
 * fetch the same bundle without us and check the entry for themselves.
 */
export interface BundleSource {
  key: Bytes32;
  found: ResolvedLocator;
}

/** What `BundleIndex.open` asks its caller for: the bundle's bytes and the cell that named them. */
export type BundleDownload = (key: Bytes32) => Promise<{ bytes: Uint8Array; found: ResolvedLocator } | null>;

/**
 * Bundles a reader has opened, entry by entry. One per reader — the console holds one per agent,
 * the CLI one per audit — so a session's blobs are downloaded once however many hashes are asked
 * for afterwards.
 *
 * `open` is memoised by bundle key, including the failures: a session whose bundle is not on
 * chain, or whose gateway did not answer, is not re-asked on every hash of that session. The
 * consequence is deliberate — a reader that wants to try again builds a new index.
 */
export class BundleIndex {
  private entries = new Map<string, Uint8Array>();
  /** Entry hash → the bundle key it was indexed out of, so `sourceOf` can name the cell. */
  private origin = new Map<string, string>();
  private sources = new Map<string, BundleSource>();
  private sessions = new Map<string, Promise<number>>();

  /** How many distinct entries are indexed across every bundle opened. */
  get size(): number {
    return this.entries.size;
  }

  /** Bytes that re-hash to `hash`, from any bundle opened so far. */
  get(hash: Uint8Array): Uint8Array | null {
    return this.entries.get(hex(hash)) ?? null;
  }

  has(hash: Uint8Array): boolean {
    return this.entries.has(hex(hash));
  }

  /**
   * The bundle an indexed entry came out of — its key and the registry cell that named it — or
   * `null` for a hash no open bundle holds. Stored at `open`, never looked up here: the caller
   * owns the registry, and this class stays usable without one.
   */
  sourceOf(hash: Uint8Array): BundleSource | null {
    const key = this.origin.get(hex(hash));
    return key === undefined ? null : this.sources.get(key) ?? null;
  }

  /**
   * Downloads and indexes one session's bundle; the number of entries it added, `0` when there
   * is nothing to open. `download` is handed the derived key and answers with the bytes the
   * chain points at for it, together with the cell that pointed — the caller owns the registry
   * read and the gateway choice, which is what lets the browser, the CLI and a test share this
   * class. The cell is kept so that a reader shown an entry can be shown where the whole bundle
   * is anchored, which is the only locator those bytes have.
   *
   * A download that is not a bundle is `0` and not a throw: it is the same fact as a gateway
   * that did not answer, and the hashes of that session go on to read `unavailable` one by one.
   */
  open(genesisPayloadHash: Uint8Array, download: BundleDownload): Promise<number> {
    const key = bundleKey(genesisPayloadHash);
    const name = hex(key);
    const already = this.sessions.get(name);
    if (already) return already;
    const task = (async () => {
      const got = await download(key).catch(() => null);
      if (!got) return 0;
      let found: Map<string, Uint8Array>;
      let entries: number;
      try {
        ({ index: found, entries } = fileBundle(got.bytes));
      } catch {
        return 0;
      }
      this.sources.set(name, { key, found: got.found });
      // Across bundles by the same rule as within one: a later session's forged header does not
      // displace an earlier session's plaintext that re-hashes.
      for (const [h, entry] of found) {
        if (indexEntry(this.entries, h, entry)) this.origin.set(h, name);
      }
      // Entries, not keys: an encrypted entry is filed under two.
      return entries;
    })();
    this.sessions.set(name, task);
    return task;
  }
}

/** What `RecordingTraceStore.seal` did, or why it did not. A seal never throws. */
export type SealResult =
  | { locator: Locator; count: number; bytes: number; error?: undefined }
  | { error: string; locator?: undefined; count?: undefined; bytes?: undefined };

/**
 * A `TraceStore` that forwards to the session's own store and remembers what went through it, so
 * that the caller which owns the session can seal one bundle when it ends.
 *
 * Wrapping rather than replacing is the point: the blobs still land where they always did (the
 * console's trace directory), and the bundle is a second copy made once, at the end, for readers
 * who are not us. A seal that fails costs the session nothing — the bytes are still in the
 * store, the chain is untouched, and `seal` can be run again by hand.
 */
export class RecordingTraceStore implements TraceStore {
  /** Every distinct blob put through this store, in put order. */
  private readonly recorded: Uint8Array[] = [];
  /** The hash the inner store answered for each of `recorded`, at the same index. */
  private readonly recordedHashes: Uint8Array[] = [];
  private readonly seen = new Set<string>();
  /** How many `put` calls were made, duplicates included. */
  puts = 0;

  constructor(
    readonly inner: TraceStore,
    /** Where the bundle is uploaded and where its key is anchored — the session's own. */
    private readonly anchor: { backend: LocatorBackend; registry: LocatorRegistry }
  ) {}

  /**
   * A blob already recorded is not recorded twice. A session puts the same bytes more than once
   * — a loop step carries the previous memory forward under the same hash — and the index a
   * reader builds is keyed by hash anyway, so a second copy would be bytes uploaded for nothing.
   *
   * What is recorded is **what the store holds**, not what the caller handed in: a store that
   * encrypts answers `putStored` with its ciphertext, and bundling the plaintext instead would
   * publish, in one file on a public gateway, exactly what the owner encrypted the directory to
   * hide. Stores that transform nothing return the same bytes, so for every plaintext session what
   * is recorded is what the caller handed in.
   */
  async put(bytes: Uint8Array): Promise<Uint8Array> {
    const inner = this.inner;
    const { hash, stored } = storesTransformed(inner)
      ? await inner.putStored(bytes)
      : { hash: await inner.put(bytes), stored: bytes };
    this.puts++;
    const key = hex(hash);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      // Copied: the caller may reuse its buffer, and the bundle is encoded much later.
      this.recorded.push(stored.slice());
      this.recordedHashes.push(Uint8Array.from(hash));
    }
    return hash;
  }

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.inner.get(hash);
  }

  get entries(): readonly Uint8Array[] {
    return this.recorded;
  }

  /** Encodes what the session wrote, uploads it, and publishes `bundleKey → locator` — one cell. */
  async seal(genesisPayloadHash: Uint8Array): Promise<SealResult> {
    return sealBundle(this.anchor, this.recorded, genesisPayloadHash);
  }

  /**
   * Anchors what this store recorded **one cell per blob**, for the writes that are not a session
   * and therefore have no bundle key: a loop's `loop.settlement` record is the one of those.
   * It is written by a runner built only to settle, its blobs belong to no genesis, and
   * `bundleKey` is derived from a genesis payload hash — so a reader holding only the chain and a
   * gateway has nothing to open and reads *no preimage* for a settlement that is on chain.
   *
   * Three blobs (the Action's args, its result, its payload preimage) once per loop is the
   * handful of blobs `AnchoredTraceStore` is the honest shape for, so this does what that store
   * does, on the bytes the inner store actually holds.
   *
   * `from` skips the blobs recorded before it — the construction around a settlement puts the
   * agent's system prompt through this store too, and that blob is already inside every step's
   * bundle, so a caller says which of its puts it is anchoring and pays for no more.
   */
  async publish(from = 0): Promise<PublishResult> {
    // With the hashes the store answered: recomputing them from the bytes reads a plaintext that
    // opens with `LTE2` as ciphertext and anchors it under bytes of itself.
    return publishBlobs(this.anchor, this.recorded.slice(from), this.recordedHashes.slice(from));
  }

  /**
   * The hashes of `entries`, in the same order — enough to rebuild this session's bundle from a
   * store that still holds the bytes, in a process that never saw the session.
   *
   * That is what a seal deferred by a failed drain needs: the blobs are content-addressed in the
   * trace directory and outlive the request, but `recorded` is memory and does not.
   */
  get hashes(): readonly string[] {
    return [...this.seen];
  }
}

/**
 * The seal itself, apart from the store that recorded it, so that a caller holding the bytes
 * some other way can run it: the retry of a session whose drain failed rebuilds `blobs` from the
 * trace directory and publishes the bundle the session could not.
 *
 * Idempotent in the way that matters: a key already anchored keeps its first locator and nothing
 * is uploaded again, so a seal re-run after a failure cannot fight with the mapping that landed.
 * Never throws — a session that resolved on chain is not failed by the copy made for readers.
 */
export async function sealBundle(
  anchor: { backend: LocatorBackend; registry: LocatorRegistry },
  blobs: readonly Uint8Array[],
  genesisPayloadHash: Uint8Array
): Promise<SealResult> {
  try {
    if (blobs.length === 0) return { error: "the session put no blobs, so there is nothing to bundle" };
    const key = bundleKey(genesisPayloadHash);
    const bytes = encodeBundle(blobs);
    await anchor.registry.ensureCreated();
    const already = await anchor.registry.resolve(key);
    if (already) return { locator: already.locator, count: blobs.length, bytes: bytes.length };
    const locator: Locator = { scheme: anchor.backend.scheme, id: await anchor.backend.upload(bytes) };
    await anchor.registry.publish(key, locator);
    return { locator, count: blobs.length, bytes: bytes.length };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

/** What `publishBlobs` anchored, or why it did not. Like a seal, it never throws. */
export type PublishResult = {
  /** Cells written now — a blob already anchored is counted in `already` instead. */
  published: number;
  already: number;
  /** The first failure, when one blob of several could not be anchored. */
  error?: string;
};

/**
 * Uploads each blob and anchors `hash → locator` for it, one cell each.
 *
 * The hash is the one **the chain committed**: what the bytes re-hash to, or, for a blob a store
 * encrypted, the plaintext hash its header carries. So the cell answers the hash an auditor holds
 * from the record while the bytes on the gateway stay ciphertext, exactly as inside a bundle
 * (`indexBundle`). `hashes[i]`, when given, is that hash for `blobs[i]` as the writer's store
 * answered it, and is what is anchored; without it the hash is read off the bytes
 * (`committedHash`), which a plaintext opening with `LTE2` defeats.
 *
 * Idempotent and never throwing, for the same reason `sealBundle` is: the blobs are in the
 * writer's own store either way, and a settlement that closed a channel is not failed by the copy
 * made for readers. A hash already anchored is left alone rather than re-pointed — the first
 * mapping is the binding one — and one blob that fails does not stop the rest.
 */
export async function publishBlobs(
  anchor: { backend: LocatorBackend; registry: LocatorRegistry },
  blobs: readonly Uint8Array[],
  hashes?: readonly Uint8Array[]
): Promise<PublishResult> {
  const out: PublishResult = { published: 0, already: 0 };
  if (blobs.length === 0) return out;
  try {
    await anchor.registry.ensureCreated();
  } catch (e: any) {
    return { ...out, error: e?.message ?? String(e) };
  }
  for (let i = 0; i < blobs.length; i++) {
    const bytes = blobs[i];
    const hash = hashes?.[i] ?? committedHash(bytes);
    try {
      if (await anchor.registry.has(hash)) {
        out.already++;
        continue;
      }
      const locator: Locator = { scheme: anchor.backend.scheme, id: await anchor.backend.upload(bytes) };
      await anchor.registry.publish(hash, locator);
      out.published++;
    } catch (e: any) {
      out.error ??= `${hex(hash)}: ${e?.message ?? String(e)}`;
    }
  }
  return out;
}

/**
 * A trace store that has to be told which session it is reading, because that is what names the
 * bundle its blobs are in. `audit()` calls `openSession` at every kind-0 record it walks.
 */
export interface SessionScopedTraceStore extends TraceStore {
  openSession(genesisPayloadHash: Uint8Array): Promise<number>;
}

/** Structural, so `audit.ts` need not know about any particular store. */
export function isSessionScoped(store: TraceStore | undefined): store is SessionScopedTraceStore {
  return !!store && typeof (store as SessionScopedTraceStore).openSession === "function";
}

/**
 * The reader's side of the bundle: an auditor with an RPC and a gateway, and the console's
 * timeline, resolve a hash through it.
 *
 * Three legs, in this order, and the order is the argument:
 *
 * 1. **A direct cell for the hash.** The chain vouching for these exact bytes beats anything
 *    else, and it is how every blob anchored one-per-cell reads.
 * 2. **The open bundle.** Whatever `openSession` indexed for the session being walked.
 * 3. **By hash, scheme 0 only.** A raw store names a blob by its `sha256`, so an unanchored hash
 *    is still worth a request. Irys names blobs its own way and no hash predicts one, so it is
 *    never asked by hash — `routeLocatorRead` makes that decision here as it does in the
 *    console, rather than being re-decided.
 *
 * Every leg re-hashes what comes back. `put` throws: this reads someone else's store.
 */
export class BundledTraceStore implements SessionScopedTraceStore {
  readonly bundles: BundleIndex;

  constructor(
    readonly registry: LocatorRegistry,
    /** One reader per scheme this caller can fetch. */
    readonly backends: readonly LocatorBackend[],
    bundles: BundleIndex = new BundleIndex()
  ) {
    this.bundles = bundles;
  }

  private get schemes(): LocatorSchemeValue[] {
    return this.backends.map((b) => b.scheme);
  }

  private readerFor(scheme: LocatorSchemeValue): LocatorBackend | null {
    return this.backends.find((b) => b.scheme === scheme) ?? null;
  }

  /** Resolves the session's bundle key (one registry read), downloads it, and indexes it. */
  async openSession(genesisPayloadHash: Uint8Array): Promise<number> {
    return this.bundles.open(genesisPayloadHash, async (key) => {
      const found = await this.registry.resolve(key).catch(() => null);
      if (!found) return null;
      const route = routeLocatorRead(this.schemes, found.locator.scheme);
      if (route.via !== "locator") return null;
      const bytes = await this.readerFor(route.scheme)!.download(found.locator.id);
      return bytes ? { bytes, found } : null;
    });
  }

  async put(): Promise<never> {
    throw new Error("BundledTraceStore reads; a writer puts through the session's own store and seals it");
  }

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const found = await this.registry.resolve(hash).catch(() => null);
    if (found) {
      const route = routeLocatorRead(this.schemes, found.locator.scheme);
      if (route.via === "locator") {
        const bytes = await this.readerFor(route.scheme)!.download(found.locator.id);
        // A cell that pointed somewhere the right bytes did not come back from falls through:
        // the session's bundle may still hold them, and the answer is re-hashed either way.
        if (bytes && answersFor(bytes, hash)) return bytes;
      }
    }
    const bundled = this.bundles.get(hash);
    if (bundled) return bundled;
    if (routeLocatorRead(this.schemes, null).via !== "hash") return null;
    const raw = this.readerFor(LocatorScheme.Raw)!;
    const bytes = await raw.download(hash);
    return bytes && answersFor(bytes, hash) ? bytes : null;
  }
}
