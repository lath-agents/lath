"use client";

import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  AnchoredEpochStore,
  BundleIndex,
  EpochRecord,
  EventInput,
  EventRecord,
  HttpGatewayBackend,
  hex,
  idFromString,
  IRYS_ENCODING,
  encryptedTraceFor,
  Locator,
  LocatorRegistry,
  LocatorScheme,
  ResolvedLocator,
  routeLocatorRead,
  genesisPolicyVersionHash,
  subHashes,
  toBytes32,
  sha256,
  verifyEpochBlob,
} from "@lath/sdk/browser";
import { useLath } from "./clients";
import { config } from "./config";
import { gatewayUrl } from "./verify";
import { TraceQueryScope, tracePartQueryKey, traceQueryKey } from "./trace-keys";

/**
 * Reading the verbose material behind an event, with no service of ours in the middle.
 *
 * The chain commits `payload_hash` and, inside that preimage, the sub-hashes of the arguments
 * and results. It does not say where the bytes are — that is what the owner's on-chain
 * `LocatorRegistry` is for: a public `Map` from `sha256(payload)` to
 * a backend locator. So the app resolves a trace in three hops, all of them public:
 * chain → locator → gateway, and then re-hashes what comes back.
 *
 * Between the cell and that last chance sits the session's **bundle**: one blob holding
 * everything a session wrote, anchored under `sha256("lattice.preimages" ‖ genesis payload_hash)`
 * (`sdk/src/bundle.ts`). A panel opens it once per session, from the genesis record the timeline
 * is already showing, and answers every hash of that session from the index — which is what lets
 * a hosted console with no raw gateway at all resolve a trace.
 *
 * A blob that was never anchored and is in no bundle gets one more chance: the *raw* gateway is
 * asked for it **by its hash**. That is how `FileTraceStore` names files, and it is just as
 * trust-free — the answer is re-hashed either way — it only means the chain did not vouch for
 * where the bytes live. Irys is never asked by hash: its ids are its own, a hash predicts none of
 * them, and the request could only 404.
 */
export interface TraceReaders {
  /** The owner's on-chain `sha256 → locator` map. */
  registry: LocatorRegistry;
  /**
   * Reads scheme-4 locators. Always present: the gateway has a default in code, so a chain that
   * carries Irys locators resolves on a deployment with no environment at all.
   */
  irys: HttpGatewayBackend;
  /**
   * Reads scheme-0 locators, and is the only reader ever asked by hash. `null` when no raw
   * gateway is configured, which is the hosted console: its blobs are on Irys.
   */
  raw: HttpGatewayBackend | null;
  /**
   * Session bundles this reader has opened, indexed by what each entry re-hashes to. One per
   * agent, so a session opened twice is downloaded once.
   */
  bundles: BundleIndex;
}

export function useTraceStore(id: string): TraceReaders {
  const client = useLath();
  return useMemo(() => {
    const registry = new LocatorRegistry(
      client,
      toBytes32(id),
      config.traceRegistry ? idFromString(config.traceRegistry) : undefined
    );
    const irys = new HttpGatewayBackend(config.irysGateway, {
      scheme: LocatorScheme.Irys,
      encoding: IRYS_ENCODING,
    });
    const raw = config.traceGateway
      ? new HttpGatewayBackend(config.traceGateway, { scheme: config.traceScheme, encoding: config.traceEncoding })
      : null;
    return { registry, irys, raw, bundles: new BundleIndex() };
  }, [client, id]);
}

/**
 * Opens the bundle of the session a record belongs to, so the reads that follow can be answered
 * from it. One registry read and one download per session, memoised in the index — the misses
 * included, so a session with no bundle is not re-asked on every hash.
 *
 * Takes the genesis `payload_hash`, which is the one thing a reader holding any record of a
 * session already has. Silent about what it finds: a session with no bundle anchored, or a
 * gateway that did not answer, leaves the direct-cell and by-hash legs to report what they see.
 */
export async function openSession(readers: TraceReaders, genesisPayloadHash: Uint8Array): Promise<number> {
  return readers.bundles.open(genesisPayloadHash, async (key) => {
    const found = await readers.registry.resolve(key).catch(() => null);
    if (!found) return null;
    const reader = readerFor(readers, found.locator.scheme);
    const bytes = reader ? await reader.download(found.locator.id) : null;
    // The cell goes into the index with the bytes: an entry read out of this bundle has no
    // locator of its own, and the panel needs the bundle's to give a reader anything to fetch.
    return bytes ? { bytes, found } : null;
  });
}

/** The reader for a scheme the chain named, or `null` when this deployment has none for it. */
export function readerFor(readers: TraceReaders, scheme: number): HttpGatewayBackend | null {
  if (scheme === LocatorScheme.Irys) return readers.irys;
  if (readers.raw && scheme === readers.raw.scheme) return readers.raw;
  return null;
}

/** Why a trace is not on screen — each one means something different to a reader. */
export type TraceStatus =
  /** No gateway configured; the app is chain-only. */
  | "unconfigured"
  /** Neither anchored on chain nor served by hash: nothing to fetch. */
  | "not-anchored"
  /** Found a locator or a name, but the bytes came back wrong or not at all. */
  | "unavailable"
  /**
   * The trace was written encrypted to its agent's owner (an `LTE` header, naming this hash when it
   * is LTE2): the bytes are there and this console does not open them; `lath-audit --trace-key`
   * does. It is not a failed fetch and must never be shown as one.
   */
  | "encrypted"
  | "ok";

/** Which of the three legs answered. Each one is a different thing for a reader to check. */
export type TraceVia = "chain" | "bundle" | "hash";

export interface ResolvedTrace {
  status: TraceStatus;
  bytes?: Uint8Array;
  /**
   * `chain` when the on-chain registry named a locator for this hash, `bundle` when the bytes
   * came out of the session bundle the chain anchored for the session as a whole, `hash` when a
   * content-addressed gateway was asked for the hash itself.
   */
  via?: TraceVia;
  /** Sub-hashes found inside a resolved payload preimage, per the event's kind. */
  parts?: { hash: string; label: string }[];
  /** The locator the chain named, when it named one — the backend and its id for these bytes. */
  locator?: Locator;
  /**
   * The url this fetch actually used. Kept even when the fetch failed: a gateway that did not
   * answer us is exactly the thing a reader may want to try themselves, and a url that 404s in
   * their browser too is an answer.
   */
  url?: string;
  /** The compressed account the `hash → locator` mapping lives in, when the chain named one. */
  locatorAccount?: PublicKey;
  /**
   * Set when `via` is `bundle`: the session bundle these bytes were read out of. It, not the
   * bytes, is what the chain anchored — `key` is `sha256("lattice.preimages" ‖ genesis
   * payload_hash)`, `locator` and `locatorAccount` are the bundle's cell, and `url` is where
   * this browser fetched the whole bundle. Kept apart from `locator` above because that field
   * means "the chain named a locator for *this* hash", which for a bundled entry it did not.
   */
  bundle?: { key: Uint8Array; locator: Locator; url?: string; locatorAccount?: PublicKey };
  /**
   * Hashes the payload commits to that are **not** blobs anyone can fetch — so they are shown
   * rather than resolved. A genesis's `policy_version_hash` is the only one today: it is the one
   * chain fact about what an agent *was* when it ran that session, and the agent page shows it
   * here.
   */
  commitments?: { label: string; hash: string }[];
  /**
   * The served bytes carry an encryption header for this hash (always with
   * `encrypted`): the chain commits to the plaintext, and what sits behind `url` / `bundle.url` is
   * its ciphertext, so a hash of the download is not the check and the verify block must not offer
   * one.
   */
  sealed?: true;
  /**
   * Bytes were served (from `via`, at `url` or `bundle.url`) and they are not what the chain
   * committed: they do not re-hash to it and carry no encryption header for it. Always with
   * `unavailable`, which also covers bytes that never came back; this is how a reader tells
   * _the store answered with something else_ from _nothing was served_, and only the first is a
   * broken commitment.
   */
  mismatch?: true;
}

const PART_LABELS: Record<number, string[]> = {
  0: ["input payload"],
  1: ["args", "result"],
  2: ["scope"],
  3: ["final output"],
};

/** Re-hash, and when the bytes are not the plaintext, say whether they are ciphertext or garbage. */
function judge(bytes: Uint8Array, hash: Uint8Array, via: TraceVia): ResolvedTrace {
  if (hex(sha256(bytes)) === hex(hash)) return { status: "ok", bytes, via };
  // Header-bound, as `lath-audit` reads it: an LTE2 header naming another hash is bytes
  // filed under the wrong key, not this trace withheld, and saying "encrypted by the owner" of it
  // would vouch for a claim anyone can write into a header.
  if (!encryptedTraceFor(bytes, hash)) return { status: "unavailable", via, mismatch: true };
  // The bytes behind `url` / `bundle.url` are ciphertext, so a hash of the download is not the
  // check — `sealed` is how the verify block knows.
  return { status: "encrypted", via, sealed: true };
}

/**
 * What to fetch and with which reader, once the chain has answered — the routing decision and
 * nothing else, so it can be read and tested without a browser or a network.
 *
 * Four outcomes, and the differences between them are the point:
 *
 * - a locator whose scheme this deployment can read: that reader, that id;
 * - no usable locator, but an open session bundle holds bytes that re-hash to this hash: those
 *   bytes, with nothing left to fetch;
 * - a locator whose scheme this deployment cannot read and no bundle entry: `unavailable`,
 *   **with the locator on screen**, because the chain does vouch for these bytes and somebody
 *   else can fetch them;
 * - no locator at all: the raw gateway by hash, and `not-anchored` when there is no raw gateway.
 *
 * `not-anchored` says the chain holds no cell for this hash. Reporting it for a scheme this
 * deployment merely has no gateway for would be a claim about the chain that is not true.
 *
 * The bundle sits between the direct cell and the by-hash fall-through, in that order, because a
 * cell naming these exact bytes is the stronger statement — and because that is how a chain
 * written before bundles existed keeps reading as it always did.
 */
export interface ByHashPlan {
  /** The reader that should answer, or `null` when nothing configured here can. */
  reader: HttpGatewayBackend | null;
  /** What to ask it for: the locator's id, or the hash itself when asking by hash. */
  id: Uint8Array;
  /** How the bytes were found, for the line on screen that says so. */
  via: TraceVia;
  /** Bytes an open bundle already holds, so there is nothing left to fetch. */
  bytes?: Uint8Array;
  /** The status to report without fetching anything, when `reader` is null. */
  status?: "unavailable" | "not-anchored";
  /** The chain facts, carried on every outcome — happy or not. */
  at: Pick<ResolvedTrace, "locator" | "url" | "locatorAccount" | "bundle">;
}

export function planByHash(readers: TraceReaders, found: ResolvedLocator | null, hash: Uint8Array): ByHashPlan {
  // The choice itself is `routeLocatorRead` in the SDK, so the console, `lath-audit` and
  // tests/trace-routing.ts all make it the same way. What is left here is turning it into a
  // request: which reader, which id, and the chain facts the panel shows either way.
  const schemes = [readers.irys.scheme, ...(readers.raw ? [readers.raw.scheme] : [])];
  const route = routeLocatorRead(schemes, found ? found.locator.scheme : null);
  // Carried on every outcome, not only the happy one: the point of showing the locator is to
  // let a reader fetch the bytes without us, which matters most when we could not.
  const at = found
    ? {
        locator: found.locator,
        url: gatewayUrl(found.locator.id, found.locator.scheme) ?? undefined,
        locatorAccount: found.cell.address,
      }
    : {};
  if (found) {
    const reader = route.via === "locator" ? readerFor(readers, route.scheme) : null;
    if (reader) return { reader, id: found.locator.id, via: "chain", at };
  }
  // The session's bundle, when one has been opened and holds bytes for this hash. The index keys
  // a plaintext entry by its sha256 and a ciphertext entry by the hash its header claims. A
  // plaintext hit re-hashes by construction; a ciphertext hit never reads as ok (`judge`), and it
  // cannot displace a plaintext that re-hashes (`indexBundle`).
  const bundled = readers.bundles.get(hash);
  if (bundled) {
    // On a bundle-sealing console this is the rule for a record payload, not the exception: the
    // bundle is anchored and the payloads inside it are not, so `found` is null here and `at`
    // is empty. The bundle's own cell is the one thing the chain does say about these bytes,
    // and the panel cannot offer a check without it. `sourceOf` cannot miss for a hash
    // `get` just answered, but a stale index is reported as a bundle without a source rather
    // than a throw.
    const source = readers.bundles.sourceOf(hash);
    const bundle = source
      ? {
          key: source.key,
          locator: source.found.locator,
          url: gatewayUrl(source.found.locator.id, source.found.locator.scheme) ?? undefined,
          locatorAccount: source.found.cell.address,
        }
      : undefined;
    return { reader: null, id: hash, via: "bundle", bytes: bundled, at: { ...at, bundle } };
  }
  if (found) return { reader: null, id: found.locator.id, via: "chain", status: "unavailable", at };
  if (route.via !== "hash" || !readers.raw)
    return { reader: null, id: hash, via: "hash", status: "not-anchored", at: {} };
  return { reader: readers.raw, id: hash, via: "hash", at: { url: gatewayUrl(hash, readers.raw.scheme) ?? undefined } };
}

export async function fetchByHash(readers: TraceReaders, hash: Uint8Array): Promise<ResolvedTrace> {
  const plan = planByHash(readers, await readers.registry.resolve(hash), hash);
  if (plan.bytes) return { ...judge(plan.bytes, hash, "bundle"), ...plan.at };
  if (!plan.reader) return { status: plan.status!, ...plan.at };
  const bytes = await plan.reader.download(plan.id);
  // Nothing under the hash at a content-addressed gateway means nothing anchored it anywhere;
  // nothing under a locator means the chain pointed somewhere the bytes did not come back from.
  if (!bytes) return plan.via === "hash" ? { status: "not-anchored" } : { status: "unavailable", ...plan.at };
  return { ...judge(bytes, hash, plan.via), ...plan.at };
}

/**
 * Whose read a cached trace answer is (`lib/trace-keys.ts`): the agent whose registry and bundles
 * the reader resolves through, the genesis naming the bundle and the gateway. Without
 * the agent and the genesis an answer full of one chain's facts would be served on another's page.
 * The registry name is the deployment's (`config.traceRegistry`), the same for every
 * reader here, so it needs no place in the key.
 */
function traceScope(store: TraceReaders | null, genesis: Uint8Array | undefined): TraceQueryScope {
  return {
    agent: store?.registry?.ownerId ? hex(store.registry.ownerId) : "",
    genesis: genesis ? hex(genesis) : "",
    gateway: config.traceGateway,
  };
}

/**
 * Resolves one record's `payload_hash` and lists the sub-hashes inside it.
 *
 * `genesis` is the `payload_hash` of the kind-0 record that opened this record's session, which
 * names its bundle. Optional, and `undefined` for a record with no genesis before it on the
 * chain: the read then falls back to the direct cell and the by-hash leg, which is what every
 * chain written before bundles existed reads through.
 */
export function useTrace(
  store: TraceReaders | null,
  record: EventRecord | null,
  enabled: boolean,
  genesis?: Uint8Array
): UseQueryResult<ResolvedTrace> {
  return useQuery({
    // The agent and the genesis are part of the cache key, since the answer states facts about that
    // agent's chain (`traceScope`).
    queryKey: traceQueryKey(record ? hex(record.payloadHash) : "", traceScope(store, genesis)),
    enabled: enabled && !!record,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ResolvedTrace> => {
      if (!store) return { status: "unconfigured" };
      if (genesis) await openSession(store, genesis);
      const found = await fetchByHash(store, record!.payloadHash);
      if (found.status !== "ok") return found;
      const labels = PART_LABELS[record!.kind] ?? [];
      // The preimage is `kind ‖ encodePayload(payload)`; the offsets are into the encoding.
      const encoding = found.bytes!.slice(1);
      const parts = subHashes(record!.kind, encoding).map((h, i) => ({
        hash: hex(h),
        label: labels[i] ?? `part ${i + 1}`,
      }));
      const policy = genesisPolicyVersionHash(record!.kind, encoding);
      const commitments = policy ? [{ label: "policy version", hash: hex(policy) }] : undefined;
      return { ...found, parts, ...(commitments ? { commitments } : {}) };
    },
  });
}

/** One sub-hash, fetched on its own — the leaves `AgentLogger` actually stores. */
export function useTracePart(
  store: TraceReaders | null,
  hash: string | null,
  enabled: boolean,
  genesis?: Uint8Array
): UseQueryResult<ResolvedTrace> {
  return useQuery(tracePartQuery(store, hash, enabled, genesis));
}

/**
 * `useTracePart`'s query, for a caller that reads several parts at once through `useQueries` —
 * `useChainSettlement` in `lib/tempo.ts`. Same key, so a blob one panel fetched is the other's
 * cache hit rather than a second download — for the same agent and session only (`traceScope`):
 * the answer carries that chain's locator, bundle and anchoring status, not just the bytes.
 */
export function tracePartQuery(
  store: TraceReaders | null,
  hash: string | null,
  enabled: boolean,
  genesis?: Uint8Array
) {
  return {
    queryKey: tracePartQueryKey(hash, traceScope(store, genesis)),
    enabled: enabled && !!hash,
    // An answer that is final — the bytes re-hashed, or a ciphertext written for this hash —
    // is kept for five minutes. Any other is a state of the read, not of the chain: a step's report
    // opened before its storage.put record lands resolves `not-anchored`, and cached for five
    // minutes that would stick — reopening the report would never ask again. Stale at once, so the next mount
    // reads afresh (window-focus refetch is off app-wide, so this costs nothing while it stays shut).
    staleTime: (query: { state: { data?: ResolvedTrace } }) =>
      query.state.data?.status === "ok" || query.state.data?.status === "encrypted" ? 5 * 60_000 : 0,
    queryFn: async (): Promise<ResolvedTrace> => {
      if (!store) return { status: "unconfigured" };
      // The sub-hashes of a record are in the same session's bundle as the record itself; the
      // index is memoised, so this is a no-op once the panel above has opened it.
      if (genesis) await openSession(store, genesis);
      return fetchByHash(store, toBytes32(hash!));
    },
  };
}

/** Bytes as text when they plainly are text, and as hex when they are not. */
export function renderTrace(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/^[\s\x20-\x7e]*$/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return hex(bytes);
}

// ─── Epochs ─────────────────────────────────────────────────────────────────

export interface ResolvedEpoch {
  status: "unconfigured" | "not-anchored" | "unavailable" | "mismatch" | "ok";
  /** The steps the blob holds, once its root has been rebuilt and matched the chain's. */
  steps?: { seq: bigint; input: EventInput }[];
  /** The locator the chain named for this root — directly, or through a manifest. */
  locator?: Locator;
  /** The url the blob was fetched from, kept whether or not the bytes arrived. */
  url?: string;
}

/** The cache key for one epoch's steps. Shared so a panel and the exporter never fetch twice. */
export function epochStepsKey(epoch: EpochRecord | null): unknown[] {
  return ["epoch", epoch ? hex(epoch.epochRoot) : "", config.traceGateway];
}

/**
 * The steps inside an epoch: the blob is found through the owner's registry (`root → locator`),
 * downloaded, and its Merkle root **rebuilt in the browser** and compared to the root the chain
 * folded. `mismatch` means the gateway served bytes that are not this epoch.
 *
 * A plain function rather than only a hook, because the verification export needs the same
 * answer for epochs no panel has opened — and it goes through the same query cache, so an epoch
 * already on screen is not fetched a second time.
 */
export async function fetchEpochSteps(store: TraceReaders | null, epoch: EpochRecord): Promise<ResolvedEpoch> {
  if (!store) return { status: "unconfigured" };
  // Direct cell first, then the owner's epoch manifests (one cell per K epochs). The store reads
  // manifests with the backend it is built on and skips manifests of any other scheme, so it is
  // built on the reader this deployment writes with — the raw gateway where there is one, Irys
  // otherwise. The *epoch blob* is then fetched with the reader for the scheme the chain
  // answered with, which is what lets a chain that switched backends to Irys partway open
  // both halves.
  const epochs = new AnchoredEpochStore(store.raw ?? store.irys, store.registry);
  const located = await epochs.locate(epoch.epochRoot);
  if (!located) return { status: "not-anchored" };
  const at = { locator: located, url: gatewayUrl(located.id, located.scheme) ?? undefined };
  const reader = readerFor(store, located.scheme);
  const blob = reader ? await reader.download(located.id) : null;
  if (!blob) return { status: "unavailable", ...at };
  const decoded = verifyEpochBlob(blob, epoch.epochRoot, epoch.startSeq, epoch.endSeq);
  if (!decoded) return { status: "mismatch", ...at };
  return {
    status: "ok",
    ...at,
    steps: decoded.inputs.map((input, i) => ({ seq: decoded.startSeq + BigInt(i), input })),
  };
}

export function useEpochSteps(
  store: TraceReaders | null,
  epoch: EpochRecord | null,
  enabled: boolean
): UseQueryResult<ResolvedEpoch> {
  return useQuery({
    queryKey: epochStepsKey(epoch),
    enabled: enabled && !!epoch,
    staleTime: 5 * 60_000,
    queryFn: () => fetchEpochSteps(store, epoch!),
  });
}
