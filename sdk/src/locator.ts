/**
 * `sha256 → locator`, on-chain (SPEC.md §14.1): the piece that makes *any* decentralized blob
 * store adoptable.
 *
 * The problem: Lath commits `sha256(bytes)`, while a blob store addresses content by an
 * identifier of its own — Irys hands back a transaction id that the payload hash does not
 * predict. Adopting one therefore buys `hash → ??? → bytes`, and the middle arrow is a lookup
 * somebody has to serve, which is exactly the operator trust a decentralized store is meant to
 * remove.
 *
 * So the arrow goes on the chain. A `LocatorRegistry` is a public `LathMap` owned by the
 * agent, keyed by the payload hash, whose value is the backend locator — the same shape
 * `PolicyRegistry` uses for policies. The chain then says "the bytes behind `sha256 X` are at
 * locator `L`", first-write-wins by address non-inclusion, squat-proof by owner namespace,
 * folded into the same hash chain as everything else.
 *
 * ## What goes in the cell
 *
 * | field | carries |
 * |---|---|
 * | key slot | `sha256(payload)` — the hash already on-chain in `payload_hash` / a sub-hash |
 * | `value_slot` | the locator's bytes, zero-padded to 32 |
 * | `tag` (u8) | the scheme: which backend the locator belongs to |
 * | `status` (u16) | the locator's true length, since `value_slot` pads |
 *
 * Three deliberate constraints follow, and they are the point rather than a limitation:
 *
 * 1. **Locators must fit in 32 bytes.** Longer ones would be stored by `Structure.encode` as a
 *    `sha256` commitment with the bytes in a `TraceStore` — which puts the mapping back
 *    off-chain and reintroduces the operator the design removes. `publish` throws instead.
 *    The natural identifiers fit: an Irys transaction id is 32 bytes, and so is a raw payload
 *    hash. An HTTP URL does not, and that is the correct verdict.
 * 2. **The registry is public-mode only.** Private mode salts every value into a commitment,
 *    with the same consequence.
 * 3. **The backend is never trusted for correctness.** `AnchoredTraceStore.get` re-hashes what
 *    comes back and returns `null` on a mismatch, so a lying store is caught by the reader, not
 *    by a promise. What a store is trusted for is availability — a retention decision that
 *    stays with the operator whichever backend sits underneath.
 */
import { Cell, StructMode } from "./cells";
import { CellWriteResult, LathClient, UploadRetryPolicy } from "./client";
import { Bytes32, hex, idFromString, sha256, toBytes32, u16le, utf8 } from "./hash";
import { Entry, LathMap, StructureOptions } from "./structures";
import { TraceStore } from "./trace-store";
import type { EpochStore } from "./rollup";

/**
 * Which backend a locator belongs to. A `u8`, because it rides in the cell's `tag`. Two schemes
 * exist, one per backend Lath actually writes; every other value is unassigned, so a reader
 * that meets one has no gateway for it and reports the bytes unavailable. Anything ≥ 128 is yours.
 * The numbers never move — scheme 4 is already in cells on devnet and those chains must keep
 * verifying.
 */
export const LocatorScheme = {
  /** Opaque 32 bytes, meaning known only to whoever wrote it; `FsLocatorBackend` uses it. */
  Raw: 0,
  /** Irys transaction id (32 B). */
  Irys: 4,
} as const;

export type LocatorSchemeValue = number;

/** Where bytes live, in the backend's own address space. */
export interface Locator {
  scheme: LocatorSchemeValue;
  /** At most 32 bytes — see the module note. */
  id: Uint8Array;
}

/** The maximum locator length the cell can carry inline, and therefore at all. */
export const MAX_LOCATOR_BYTES = 32;

function locatorHex(l: Locator): string {
  return `${l.scheme}:${hex(l.id)}`;
}

/**
 * A blob store addressed by *its own* identifier — the shape every decentralized blob store
 * actually has, as opposed to `BlobBackend`, whose caller chooses the key.
 */
export interface LocatorBackend {
  /** The scheme `upload` returns locators in. */
  readonly scheme: LocatorSchemeValue;
  /** Stores bytes; returns the backend's identifier for them (≤ 32 B). */
  upload(bytes: Uint8Array): Promise<Uint8Array>;
  /** Fetches by that identifier. `null` if the backend does not have it. */
  download(id: Uint8Array): Promise<Uint8Array | null>;
}

/** What `resolve` gives back: the locator plus the cell facts that make it auditable. */
export interface ResolvedLocator {
  hash: Bytes32;
  locator: Locator;
  /** Bumped by `repoint`; 0 for the first publication. */
  version: bigint;
  publishedAt: bigint;
  cell: Cell;
}

/**
 * The on-chain `sha256 → locator` map. No new program code: a public `LathMap` in the
 * owner's namespace, exactly as `PolicyRegistry` is one for policies.
 */
export class LocatorRegistry {
  readonly map: LathMap;

  constructor(
    client: LathClient,
    /** Whose chain this mapping folds into. */
    readonly ownerId: Bytes32,
    registryId: Bytes32 = idFromString("locator-registry"),
    opts: StructureOptions = {}
  ) {
    if (opts.mode !== undefined && opts.mode !== StructMode.Public) {
      throw new Error(
        "a locator registry is public: private mode salts the locator into a commitment, which puts the mapping back off-chain"
      );
    }
    this.map = new LathMap(client, ownerId, registryId, { ...opts, mode: StructMode.Public });
  }

  static id(name: string): Bytes32 {
    return idFromString(name);
  }

  async ensureCreated(): Promise<boolean> {
    return this.map.ensureCreated();
  }

  private static check(locator: Locator): void {
    if (locator.id.length === 0) throw new Error("locator is empty");
    if (locator.id.length > MAX_LOCATOR_BYTES) {
      throw new Error(
        `locator is ${locator.id.length} bytes; the cell carries ${MAX_LOCATOR_BYTES} inline, and committing it by hash would move the mapping off-chain`
      );
    }
    if (!Number.isInteger(locator.scheme) || locator.scheme < 0 || locator.scheme > 255) {
      throw new Error(`locator scheme must be a u8, got ${locator.scheme}`);
    }
  }

  /**
   * Anchors `hash → locator`. Fails if this hash was ever anchored here — creating the cell
   * requires proving its address did not exist, which is what makes the first mapping the
   * binding one and stops a later writer from re-pointing a hash by accident.
   */
  async publish(hash: Bytes32 | string, locator: Locator): Promise<CellWriteResult> {
    LocatorRegistry.check(locator);
    return this.map.put(toBytes32(hash), locator.id, { tag: locator.scheme, status: locator.id.length });
  }

  /**
   * Deliberately re-points a hash at different bytes-in-a-backend — a migration between stores,
   * or a re-upload after a backend dropped the blob. Bumps the version; the old mapping stays in
   * the chain fold as the record that it changed. It cannot change *which bytes* the hash means:
   * a reader re-hashes what it downloads.
   */
  async repoint(hash: Bytes32 | string, locator: Locator): Promise<CellWriteResult> {
    LocatorRegistry.check(locator);
    return this.map.replace(toBytes32(hash), locator.id, { tag: locator.scheme, status: locator.id.length });
  }

  /** `null` means never anchored here, or withdrawn. */
  async resolve(hash: Bytes32 | string): Promise<ResolvedLocator | null> {
    const key = toBytes32(hash);
    const entry = await this.map.get(key);
    if (!entry) return null;
    return { hash: key, ...LocatorRegistry.fromEntry(entry) };
  }

  /** Membership without reading the value. */
  async has(hash: Bytes32 | string): Promise<boolean> {
    return this.map.has(toBytes32(hash));
  }

  /** Withdraws a mapping — the operator no longer serves those bytes. */
  async withdraw(hash: Bytes32 | string): Promise<CellWriteResult> {
    return this.map.close(toBytes32(hash));
  }

  /**
   * Every live mapping. Keys come back as slots — `sha256` is not invertible — and here the
   * slot *is* `sha256(payload_hash)`, so an auditor matches by re-hashing the hash it holds.
   */
  async entries(): Promise<(Omit<ResolvedLocator, "hash"> & { keySlot: Bytes32 })[]> {
    const rows = await this.map.entries();
    return rows.map((e) => ({ keySlot: e.cell.keySlot, ...LocatorRegistry.fromEntry(e) }));
  }

  /** The slot a hash lives at, for callers matching `entries()` against hashes they hold. */
  slotOf(hash: Bytes32 | string): Bytes32 {
    return this.map.keySlot(toBytes32(hash));
  }

  private static fromEntry(entry: Entry): Omit<ResolvedLocator, "hash"> {
    // `status` is the true length; `value_slot` is zero-padded to 32.
    const len = entry.cell.status > 0 && entry.cell.status <= MAX_LOCATOR_BYTES ? entry.cell.status : MAX_LOCATOR_BYTES;
    return {
      locator: { scheme: entry.cell.tag, id: entry.slot.slice(0, len) },
      version: entry.cell.indexOrVersion,
      publishedAt: entry.cell.timestamp,
      cell: entry.cell,
    };
  }
}

/**
 * Any `LocatorBackend`, made auditable by putting its locator on-chain. It is a `TraceStore`,
 * so it drops into `StructureOptions.store`, `AgentLogger` and the auditor wherever
 * `PlainTraceStore` goes.
 *
 * Costs one cell per anchored blob (~15 000 lamports), so it is for the blobs an
 * auditor must be able to fetch — a session manifest — not for every tool result. Wrap the
 * hot path in a plain store and anchor only what matters.
 */
export class AnchoredTraceStore implements TraceStore {
  constructor(readonly backend: LocatorBackend, readonly registry: LocatorRegistry) {}

  /**
   * Uploads, then anchors. Idempotent in the way that matters: a hash already anchored keeps its
   * first locator and nothing is uploaded again, so calling `put` twice costs one cell and one
   * upload, and two writers racing the same bytes cannot fight over the mapping.
   */
  async put(bytes: Uint8Array): Promise<Bytes32> {
    const hash = sha256(bytes);
    if (await this.registry.has(hash)) return hash;
    const id = await this.backend.upload(bytes);
    await this.registry.publish(hash, { scheme: this.backend.scheme, id });
    return hash;
  }

  /**
   * Resolves the hash through the chain, downloads, and **re-hashes**. A backend that returns
   * the wrong bytes — or an operator who re-pointed a mapping at other content — fails here
   * rather than being believed.
   */
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const found = await this.registry.resolve(hash);
    if (!found) return this.getUnanchored(hash);
    if (found.locator.scheme !== this.backend.scheme) return null;
    const bytes = await this.backend.download(found.locator.id);
    if (!bytes) return null;
    return hex(sha256(bytes)) === hex(hash) ? bytes : null;
  }

  /**
   * A hash the chain never mapped. Under the raw scheme the locator *is* the hash — a
   * content-addressed gateway serves `GET /<hex sha256>` — so there is nothing a mapping would
   * add: the reader asks for the hash and re-hashes the answer, exactly as above. This is how
   * the payload preimages behind each record reach an auditor: a runtime writes them to its
   * plain store without anchoring every one (one cell per event would undo the epoch's
   * amortisation), and `lath-audit --require-preimages` finds them here. Any other scheme
   * has ids the hash does not predict, so an unanchored hash stays unavailable.
   */
  private async getUnanchored(hash: Uint8Array): Promise<Uint8Array | null> {
    if (this.backend.scheme !== LocatorScheme.Raw) return null;
    const bytes = await this.backend.download(hash);
    if (!bytes) return null;
    return hex(sha256(bytes)) === hex(hash) ? bytes : null;
  }
}

/** How a locator's bytes become the path segment a gateway is asked for. */
export type LocatorEncoding = "hex" | "base64url";

/**
 * The gateway that serves scheme-4 locators, and the spelling it serves them under.
 *
 * It lives here rather than in `irys.ts` because reading Irys needs no uploader: a browser or a
 * `lath-audit` with nothing configured still has to resolve a scheme-4 locator the chain
 * named, and `irys.ts` is Node-only (it signs). `irys.ts` re-exports both names.
 *
 * Both networks' uploads are served from this host — `https://devnet.irys.xyz/<id>` answers for
 * devnet too — so a reader never needs to know which network wrote the blob.
 */
export const IRYS_GATEWAY = "https://gateway.irys.xyz";

/** Irys prints its transaction ids in unpadded base64url, and its gateway serves them that way. */
export const IRYS_ENCODING: LocatorEncoding = "base64url";

/** Where a reader should look for one blob, once the chain has answered. */
type LocatorRoute =
  /** The chain named a locator of a scheme this reader can fetch: ask that gateway for its id. */
  | { via: "locator"; scheme: LocatorSchemeValue }
  /** The chain named nothing, and a content-addressed gateway can be asked for the hash itself. */
  | { via: "hash" }
  /**
   * Nothing here can fetch it. `unavailable` means the chain *did* anchor these bytes and this
   * reader has no gateway for their scheme — the locator is still worth showing, since somebody
   * else can fetch it. `not-anchored` means the chain holds no mapping at all.
   */
  | { via: "none"; status: "unavailable" | "not-anchored" };

/**
 * The whole read decision, as a function of what the chain returned and which schemes this
 * reader has a gateway for. No fetching, no backends, no environment — so the console, the CLI
 * and a test all make the same choice, and the interesting cases can be checked without a
 * network.
 *
 * Two rules, and both are about what the chain actually said:
 *
 * - **The gateway follows the tag, not a setting.** One chain carries locators of both schemes
 *   — the ones an owner wrote before moving stores and the ones written after — so the choice is
 *   per locator. A tag with no gateway here is `unavailable`, never `not-anchored`: claiming the
 *   chain mapped nothing when it mapped something is a false statement about the chain.
 * - **Only scheme 0 is asked by hash.** A raw store names a blob by its `sha256`, so an
 *   unanchored hash is still worth a request (the answer is re-hashed either way). Every other
 *   scheme names blobs its own way and no hash predicts one, so there is nothing to ask for.
 */
export function routeLocatorRead(
  schemes: readonly LocatorSchemeValue[],
  scheme: LocatorSchemeValue | null
): LocatorRoute {
  if (scheme !== null) {
    return schemes.includes(scheme) ? { via: "locator", scheme } : { via: "none", status: "unavailable" };
  }
  return schemes.includes(LocatorScheme.Raw) ? { via: "hash" } : { via: "none", status: "not-anchored" };
}

export function encodeLocatorId(id: Uint8Array, encoding: LocatorEncoding): string {
  if (encoding === "hex") return hex(id);
  // base64url without padding — how Irys prints its ids.
  let bin = "";
  for (const b of id) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(id).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The most one gateway read may take, headers and body together, ms.
 *
 * Without a deadline, a gateway or proxy that accepted the connection and never answered would
 * hold an audit, a mocha run or a trace panel open for as long as the socket lived. A blob here is
 * a trace, a bundle or an epoch, kilobytes, which a gateway that is up serves in well under a
 * second, so 15 s is generous for a live gateway and still bounds a dead one.
 */
export const GATEWAY_READ_TIMEOUT_MS = 15_000;

/**
 * A read-only `LocatorBackend` over an HTTP gateway: `GET <base>/<locator>`. This is what makes
 * the registry usable by someone who holds no keys and runs no infrastructure — an auditor with
 * an RPC and a URL. Any store with an HTTP gateway is reachable this way — Irys through
 * `gateway.irys.xyz`, a raw directory through whatever serves it — which is the point: the chain
 * says *which* bytes, the gateway merely serves them, and
 * `AnchoredTraceStore.get` re-hashes the answer, so the gateway is never trusted for
 * correctness — only for being up.
 *
 * `upload` throws. A gateway is a way to read someone else's store, not a way to write one; a
 * publisher uses the backend's own SDK and hands the id to `LocatorRegistry.publish`.
 */
export class HttpGatewayBackend implements LocatorBackend {
  readonly scheme: LocatorSchemeValue;
  private readonly base: string;
  private readonly encoding: LocatorEncoding;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    opts: {
      scheme?: LocatorSchemeValue;
      /** Defaults to `hex`; Irys prints `base64url`. */
      encoding?: LocatorEncoding;
      /** Injected for tests, and for callers who need headers or a proxy. */
      fetch?: typeof fetch;
      /** How long one read may take before it reads as missing; `GATEWAY_READ_TIMEOUT_MS` unless set. */
      timeoutMs?: number;
    } = {}
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.scheme = opts.scheme ?? LocatorScheme.Raw;
    this.encoding = opts.encoding ?? "hex";
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? GATEWAY_READ_TIMEOUT_MS;
  }

  /** The URL a locator resolves to — worth printing when an audit reports bytes missing. */
  urlFor(id: Uint8Array): string {
    return `${this.base}/${encodeLocatorId(id, this.encoding)}`;
  }

  async upload(): Promise<Uint8Array> {
    throw new Error(
      "HttpGatewayBackend is read-only: publish with the backend's own client and anchor the id it returns"
    );
  }

  async download(id: Uint8Array): Promise<Uint8Array | null> {
    // A controller and a timer rather than `AbortSignal.timeout`, so the timer is cleared the
    // moment the read ends (no stray timer keeps a mocha run or a CLI alive) and the same code
    // runs in a browser that predates `AbortSignal.timeout`. The signal covers the body as well
    // as the headers: a gateway that answers 200 and then drips is the same stall.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.urlFor(id), { signal: abort.signal });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      // A gateway that is down is indistinguishable from one that never had the blob, and the
      // audit reports both the same way: the bytes are not available. Nothing is trusted either
      // way, so there is no reason to fail louder than "missing". A read past the deadline lands
      // here too: a stalled gateway is a gateway that is down, not a reason to hang.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Epoch manifests ────────────────────────────────────────────────────────
//
// One locator cell per epoch is 15 000 lamports on top of the 10 000 the epoch itself costs —
// more than the epoch. A manifest amortises it: `root → locator` pairs for K epochs go into one
// small blob, and one cell in a second public map, `epoch-manifests`, points at that blob. Per
// epoch that is 10 000 + 15 000 / K; at K = 10 the anchor is a rounding error on the epoch.
//
// The trade is discovery lag: an epoch's locator is on chain only once its manifest is, up to
// K epochs later (or at `flush()`). Nothing else changes for a reader — the root still commits
// to the bytes, and a manifest that lies produces a blob that fails to rebuild its root, which
// is the same failure a lying gateway produces.

/** The map that holds manifest cells, in the owner's namespace next to the locator registry. */
const EPOCH_MANIFEST_REGISTRY = "epoch-manifests";

const MANIFEST_MAGIC = utf8("LEM1");
/** `root[32] ‖ scheme u8 ‖ len u8 ‖ id[32]` */
const MANIFEST_ENTRY_LEN = 66;

interface EpochManifestEntry {
  root: Bytes32;
  locator: Locator;
}

/** `"LEM1" ‖ count u16 ‖ count × (root[32] ‖ scheme u8 ‖ len u8 ‖ id zero-padded to 32)`. */
export function encodeEpochManifest(entries: EpochManifestEntry[]): Uint8Array {
  if (entries.length === 0 || entries.length > 0xffff)
    throw new Error(`a manifest holds 1..65535 epochs, got ${entries.length}`);
  const out = new Uint8Array(4 + 2 + entries.length * MANIFEST_ENTRY_LEN);
  out.set(MANIFEST_MAGIC, 0);
  out.set(u16le(entries.length), 4);
  entries.forEach((e, i) => {
    if (e.locator.id.length === 0 || e.locator.id.length > MAX_LOCATOR_BYTES) {
      throw new Error(`locator is ${e.locator.id.length} bytes; a manifest entry carries ${MAX_LOCATOR_BYTES}`);
    }
    const at = 6 + i * MANIFEST_ENTRY_LEN;
    out.set(e.root, at);
    out[at + 32] = e.locator.scheme;
    out[at + 33] = e.locator.id.length;
    out.set(e.locator.id, at + 34);
  });
  return out;
}

/** The inverse; `null` for bytes that are not a manifest. */
export function decodeEpochManifest(bytes: Uint8Array): EpochManifestEntry[] | null {
  if (bytes.length < 6 || hex(bytes.slice(0, 4)) !== hex(MANIFEST_MAGIC)) return null;
  const count = bytes[4] | (bytes[5] << 8);
  if (bytes.length !== 6 + count * MANIFEST_ENTRY_LEN) return null;
  const entries: EpochManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * MANIFEST_ENTRY_LEN;
    const len = bytes[at + 33];
    if (len === 0 || len > MAX_LOCATOR_BYTES) return null;
    entries.push({
      root: bytes.slice(at, at + 32),
      locator: { scheme: bytes[at + 32], id: bytes.slice(at + 34, at + 34 + len) },
    });
  }
  return entries;
}

/** An anchored-but-unpublished epoch, as a caller persists it between processes. */
export interface PendingAnchor {
  /** Epoch root, hex. */
  root: string;
  scheme: LocatorSchemeValue;
  /** Locator id, hex. */
  id: string;
}

interface AnchoredEpochStoreOptions {
  /**
   * Epochs per manifest. `1` (the default) publishes one `root → locator` cell per epoch in
   * the locator registry and writes no manifests. Above 1, `anchor` queues and
   * every `every`-th epoch — or `flush()` — writes one manifest cell for the queue.
   */
  every?: number;
  /** Where manifest cells go. Defaults to `epoch-manifests` in the same owner's namespace. */
  manifests?: LocatorRegistry;
  /** A queue from an earlier process (`pendingAnchors`), so a restart does not orphan epochs. */
  pending?: PendingAnchor[];
  /**
   * Where an epoch blob goes when `backend.upload` throws. `createEpochCommitter` writes it
   * there and commits the epoch unanchored rather than losing it. Defaults to a `fallback` the
   * backend itself carries, which is how the console hands
   * its trace directory to every store it builds without threading it through each call site.
   */
  fallback?: EpochStore;
  /**
   * How many times `createEpochCommitter` retries a failed upload before it uses the fallback.
   * Defaults to a `retry` the backend carries, for the same reason `fallback` does: the console
   * builds these stores in three places and the policy is one setting.
   */
  retry?: UploadRetryPolicy;
}

/** What one `flush()` wrote. */
interface ManifestFlush {
  /** `sha256(manifest bytes)` — the key of the manifest cell. */
  hash: Bytes32;
  roots: Bytes32[];
  locator: Locator;
}

/**
 * Epoch blobs (`rollup.ts`) in a locator-addressed backend, with `root → locator` published in
 * the owner's on-chain `LocatorRegistry`. The registry's key is normally `sha256(bytes)`; here
 * it is the epoch root, which commits to the bytes just as strongly (`verifyEpochBlob`) and is
 * what a reader holding an `EpochCommitted` event actually has.
 *
 * One cell per epoch by default; with `every: K`, one manifest cell per K epochs (above). A
 * reader tries the direct cell first, then the manifests, so a chain that switched from one to
 * the other reads the same either way.
 */
export class AnchoredEpochStore implements EpochStore {
  /** Locators uploaded but not yet anchored, by root. */
  private pending = new Map<string, Locator>();
  /**
   * The bytes behind each `pending` locator, held only when there is a fallback to copy them into
   * should the cell write fail (`keepForReanchor`). Reading them back from the backend instead is
   * not reliable that soon: an Irys gateway can answer 404 for a transaction seconds old. Dropped
   * with the locator, or once the fallback holds them, so what stays is bounded by the epochs
   * uploaded and not yet anchored.
   */
  private held = new Map<string, Uint8Array>();
  /** Anchored, waiting for a manifest (only when `every > 1`), in anchor order. */
  private queue: EpochManifestEntry[] = [];
  /** `root → locator` learned from manifests, and which manifests have been opened. */
  private index = new Map<string, Locator>();
  private opened = new Set<string>();
  /** `put` calls per root, including the ones that threw. Read with `uploadAttempts`. */
  private attempts = new Map<string, number>();
  readonly every: number;
  readonly manifests: LocatorRegistry;
  /** Where a blob this backend could not take is kept instead; see the option of the same name. */
  readonly fallback?: EpochStore;
  /** The upload retry policy `createEpochCommitter` reads off this store; see the same option. */
  readonly retry?: UploadRetryPolicy;

  constructor(
    readonly backend: LocatorBackend,
    readonly registry: LocatorRegistry,
    opts: AnchoredEpochStoreOptions = {}
  ) {
    this.every = opts.every ?? 1;
    if (!Number.isInteger(this.every) || this.every < 1)
      throw new Error(`every must be a positive integer, got ${opts.every}`);
    const carried = backend as LocatorBackend & { fallback?: EpochStore; retry?: UploadRetryPolicy };
    this.fallback = opts.fallback ?? carried.fallback;
    this.retry = opts.retry ?? carried.retry;
    this.manifests =
      opts.manifests ??
      new LocatorRegistry(registry.map.client, registry.ownerId, idFromString(EPOCH_MANIFEST_REGISTRY));
    for (const p of opts.pending ?? []) {
      this.queue.push({ root: toBytes32(p.root), locator: { scheme: p.scheme, id: toBytes32Loose(p.id) } });
    }
  }

  /** Uploads only. The mapping goes on chain in `anchor`, after the epoch it belongs to. */
  async put(root: Bytes32, blob: Uint8Array): Promise<void> {
    // Counted before the upload, so a throw counts too: the committer retries by calling `put`
    // again, and this is what the console reports as `anchorAttempts` for a live epoch — the
    // `EpochCommit` that carries the same number only reaches it in the closing summary.
    this.attempts.set(hex(root), (this.attempts.get(hex(root)) ?? 0) + 1);
    const id = await this.backend.upload(blob);
    this.pending.set(hex(root), { scheme: this.backend.scheme, id });
    if (this.fallback) this.held.set(hex(root), blob);
  }

  /** Uploads attempted for `root` so far, successful or not. 0 for a root this store never saw. */
  uploadAttempts(root: Bytes32 | string): number {
    return this.attempts.get(typeof root === "string" ? root : hex(root)) ?? 0;
  }

  /**
   * Publishes `root → locator` — directly when `every` is 1, otherwise into the queue the next
   * manifest will carry. `published` says which happened; an epoch that is queued is on chain
   * but not yet discoverable from it.
   */
  async anchor(root: Bytes32): Promise<{ published: boolean }> {
    const key = hex(root);
    const locator = this.pending.get(key);
    if (!locator) throw new Error(`no uploaded blob for epoch ${key}`);
    if (this.every === 1) {
      // The locator stays in `pending` until its cell is written. It is the only record of where
      // the uploaded bytes went, so dropping it before the publish would turn one failed cell write
      // into an epoch nobody could anchor: every retry (`publishOwedLocators`, the console's
      // `payOwedLocators`) would throw "no uploaded blob", and `reanchorEpochs` would find nothing
      // in the fallback because the upload had succeeded.
      try {
        // The registry is a structure in the owner's namespace; the first epoch creates it.
        await this.registry.ensureCreated();
        if (!(await this.registry.has(root))) await this.registry.publish(root, locator);
      } catch (e) {
        await this.keepForReanchor(root, locator);
        throw e;
      }
      this.pending.delete(key);
      this.held.delete(key);
      return { published: true };
    }
    // The manifest queue carries the locator from here on (and the console persists it).
    this.pending.delete(key);
    this.held.delete(key);
    this.queue.push({ root, locator });
    if (this.queue.length >= this.every) {
      await this.flush();
      return { published: true };
    }
    return { published: false };
  }

  /**
   * After a cell write failed: copies the epoch's bytes into the fallback, where `reanchorEpochs`
   * (which reads the fallback and nothing else) can find them after a restart, when this process's
   * `pending` locator is gone. The bytes come from what `put` held; only a root `put` did not see in
   * this process — one whose bytes are not in hand — is read back from the backend, which may not
   * serve it yet. Best effort: a fallback that refuses the write leaves the root as before, the cell
   * write's own error is the one the caller is owed, and a retry in this process still has `pending`.
   */
  private async keepForReanchor(root: Bytes32, locator: Locator): Promise<void> {
    if (!this.fallback) return;
    const key = hex(root);
    try {
      if (!(await this.fallback.get(root))) {
        const bytes = this.held.get(key) ?? (await this.backend.download(locator.id));
        if (!bytes) return;
        await this.fallback.put(root, bytes);
      }
      // In the fallback now, so holding them as well buys nothing.
      this.held.delete(key);
    } catch {
      // Nothing more to do: the debt stays owed on the journal entry either way.
    }
  }

  /** Epochs anchored but not yet in a manifest. Persist this; pass it back as `pending`. */
  get pendingAnchors(): PendingAnchor[] {
    return this.queue.map((e) => ({ root: hex(e.root), scheme: e.locator.scheme, id: hex(e.locator.id) }));
  }

  /**
   * Writes one manifest cell for whatever is queued — the end of a session, a loop stopping, a
   * process shutting down. `null` when nothing was queued. Idempotent on retry: the manifest
   * is keyed by its own hash, so a publish that already landed is found rather than repeated.
   */
  async flush(): Promise<ManifestFlush | null> {
    if (this.queue.length === 0) return null;
    const entries = this.queue.slice();
    const bytes = encodeEpochManifest(entries);
    const hash = sha256(bytes);
    await this.manifests.ensureCreated();
    let locator: Locator;
    const already = await this.manifests.resolve(hash);
    if (already) {
      locator = already.locator;
    } else {
      locator = { scheme: this.backend.scheme, id: await this.backend.upload(bytes) };
      await this.manifests.publish(hash, locator);
    }
    for (const e of entries) this.index.set(hex(e.root), e.locator);
    this.queue = [];
    return { hash, roots: entries.map((e) => e.root), locator };
  }

  /**
   * Where the chain says `root`'s bytes are: the direct cell, a manifest, or — for the writer
   * only — its own queue. `null` when the chain does not (yet) point anywhere.
   */
  async locate(root: Bytes32): Promise<Locator | null> {
    const key = hex(root);
    const direct = await this.registry.resolve(root);
    if (direct) return direct.locator;
    const queued =
      this.queue.find((e) => hex(e.root) === key) ??
      (this.pending.has(key) ? { locator: this.pending.get(key)! } : null);
    if (queued) return queued.locator;
    if (!this.index.has(key)) await this.readManifests();
    return this.index.get(key) ?? null;
  }

  /**
   * The bytes the chain points at for `root`. The caller re-derives the root (`verifyEpochBlob`).
   * A root the chain points nowhere for is looked for in the fallback, because that is exactly
   * where an epoch whose upload failed was kept — the commit is on chain, the locator is not.
   */
  async get(root: Bytes32): Promise<Uint8Array | null> {
    const locator = await this.locate(root);
    if (!locator) return this.fallback ? this.fallback.get(root) : null;
    if (locator.scheme !== this.backend.scheme) return null;
    return this.backend.download(locator.id);
  }

  /** Opens every manifest this reader has not opened yet and adds its pairs to the index. */
  private async readManifests(): Promise<void> {
    let rows: Awaited<ReturnType<LocatorRegistry["entries"]>>;
    try {
      rows = await this.manifests.entries();
    } catch {
      // No manifests structure for this owner: a chain that only ever anchored directly.
      return;
    }
    for (const row of rows) {
      const name = locatorHex(row.locator);
      if (this.opened.has(name) || row.locator.scheme !== this.backend.scheme) continue;
      this.opened.add(name);
      const bytes = await this.backend.download(row.locator.id);
      const entries = bytes ? decodeEpochManifest(bytes) : null;
      if (!entries) continue;
      for (const e of entries) this.index.set(hex(e.root), e.locator);
    }
  }
}

/**
 * Re-anchoring: what an operator runs after an upload outage.
 *
 * An epoch whose blob could not be uploaded is committed anyway, with the bytes in the console's
 * fallback store and no locator cell (`createEpochCommitter`).
 * That is a delay, not a verdict: the bytes still hash to the root the chain holds, so uploading
 * them later and pointing the cell at the result makes the epoch readable to an auditor who has
 * only an RPC and a gateway. Nothing here runs inside a session — it uploads and it writes cells,
 * both of which cost money and neither of which a session should decide to spend on old epochs.
 */
interface ReanchorOptions {
  client: LathClient;
  /** The agent's own locator registry — where its `root → locator` cells live. */
  registry: LocatorRegistry;
  /** Where the blobs are uploaded now, and whose scheme the cell should end up carrying. */
  backend: LocatorBackend;
  /** Where the blobs were kept when the upload failed — the console's trace directory. */
  fallback: EpochStore;
  agentId: Bytes32;
  /**
   * Which epoch roots to consider. Defaults to every epoch this agent committed, read from
   * transaction history, which is the only complete list of roots that exists off the chain.
   */
  roots?: (Bytes32 | string)[];
  /** Reports each root as it is decided, so a command line can print as it goes. */
  onRoot?: (root: Bytes32, outcome: "reanchored" | "skipped" | "failed", detail?: string) => void;
}

interface ReanchorResult {
  /** Roots uploaded and pointed at, hex. */
  reanchored: string[];
  /** Roots already on this backend's scheme, or whose bytes the fallback does not have. */
  skipped: string[];
  /** One entry per root that could not be re-anchored; the walk carries on past each. */
  failed: { root: string; error: string }[];
}

/**
 * Uploads every fallen-back epoch blob and publishes `root → locator`, one root at a time.
 *
 * A root is skipped when the chain already points at it with this backend's scheme (there is
 * nothing to fix) or when the fallback does not hold its bytes (they were never ours to
 * re-upload). A root the chain points at under a *different* scheme — a cell written by a
 * console anchoring to the filesystem, re-anchored to Irys — is repointed: the version
 * bumps and the old mapping stays in the chain fold as the record that it changed.
 *
 * One blob's failure never ends the walk: it goes in `failed` with its message and the next root
 * is tried, because an operator running this after an outage wants everything that can be fixed
 * fixed in one pass.
 */
export async function reanchorEpochs(opts: ReanchorOptions): Promise<ReanchorResult> {
  const { client, registry, backend, fallback, agentId } = opts;
  const roots = opts.roots
    ? opts.roots.map((r) => toBytes32(r))
    : (await client.listEpochs(agentId)).map((e) => e.epochRoot);
  const result: ReanchorResult = { reanchored: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  let created = false;
  for (const root of roots) {
    const key = hex(root);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const existing = await registry.resolve(root);
      if (existing && existing.locator.scheme === backend.scheme) {
        result.skipped.push(key);
        opts.onRoot?.(root, "skipped", "already anchored");
        continue;
      }
      const blob = await fallback.get(root);
      if (!blob) {
        result.skipped.push(key);
        opts.onRoot?.(root, "skipped", "no bytes in the fallback store");
        continue;
      }
      const locator = { scheme: backend.scheme, id: await backend.upload(blob) };
      // `repoint` replaces a cell that exists; a root that was never anchored at all needs the
      // structure and the cell created first — what the session's own anchor would have done.
      if (existing) {
        await registry.repoint(root, locator);
      } else {
        if (!created) {
          await registry.ensureCreated();
          created = true;
        }
        await registry.publish(root, locator);
      }
      result.reanchored.push(key);
      opts.onRoot?.(root, "reanchored", locatorHex(locator));
    } catch (e) {
      const error = (e as any)?.message ?? String(e);
      result.failed.push({ root: key, error });
      opts.onRoot?.(root, "failed", error);
    }
  }
  return result;
}

/** A hex locator id of any length ≤ 32 bytes (`toBytes32` insists on exactly 32). */
function toBytes32Loose(id: string): Uint8Array {
  if (!/^([0-9a-f]{2}){1,32}$/i.test(id)) throw new Error(`locator id must be 1..32 bytes of hex, got ${id}`);
  return new Uint8Array(id.match(/../g)!.map((b) => parseInt(b, 16)));
}
