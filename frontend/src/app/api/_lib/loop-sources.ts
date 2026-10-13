/**
 * A loop's pinned sources (`_lib/loops.ts` re-exports it): the start form's check, the fetch at a
 * start under a process-wide bound, and the copy published to Irys behind the loop
 * agent's locator cell. Also the start's progress stages, which are mostly these.
 */
import * as fs from "fs";
import * as path from "path";
import {
  FileTraceStore,
  LathClient,
  LocatorRegistry,
  LocatorScheme,
  decodeIrysId,
  irysIdString,
  type Locator,
  hex,
  idFromString,
  toBytes32,
  type TraceStore,
} from "@lath/sdk";
import {
  sourceDir,
  sourcesIndex,
  sourcesIndexProblem,
  sourcesManifestBytes,
  SOURCES_INDEX_MAX_BYTES,
  type SourcesManifest,
} from "@lath/runtime";
// Server-only, and so not in the package index the client pages import (see `runtime/src/index.ts`).
import { zeroclawHome } from "@lath/runtime/zeroclaw/runtime";
import type { LoopSourcesIrys } from "../../../types/loop";
import type { RestoredSourcesCheck } from "../../../types/zeroclaw";
import { sourcesIrysKey, type IrysSourceInput, type LoopSourceInput } from "@lath/runtime/zeroclaw/sources";
import {
  SourcesRefused,
  checkSources,
  defaultSourcesDeps,
  fetchSources,
  parseSourceInputs,
  sourcesRefusal,
  type CheckedSource,
  type SourcesDeps,
} from "./sources";
import {
  SourcesPublishFailed,
  irysSourcesUploader,
  publishSources,
  restoreSources,
  type LocateSourcesIndex,
  type SourcesGateway,
  type SourcesUploader,
} from "./sources-irys";
import {
  type DeployedAgent,
  RPC_URL,
  TRACE_DIR,
  deployedRoles,
  ensureFunded,
  loadKeypair,
  rateLimit,
  rpcFor,
  irysSourcesSettings,
} from "./runner";
import { boundedEnvNumber, errorText, type Refusal, STEP_DEADLINE_MS } from "./loop-terms";
import { withRunSlotWaiting } from "./loop-state";
import { fetchedSourcesDir, type ZeroClawReadiness } from "./loop-sandbox";

/**
 * _Check sources_ per caller per hour, and at once in this process. The check makes this server
 * fetch on a stranger's say-so — a repo's tarball is up to `TARBALL_MAX_BYTES` read and inflated —
 * with no signature to key a limit on, so it is keyed on the caller's address (`callerIp`, which is
 * one shared bucket unless a trusted proxy names the address) and bounded in flight as well.
 */
export const SOURCE_CHECKS_PER_HOUR = Math.floor(
  boundedEnvNumber("LATH_SOURCE_CHECKS_PER_HOUR", process.env.LATH_SOURCE_CHECKS_PER_HOUR, 30, { min: 0 })
);

/**
 * Source fetches at once in this process, a check's and a start's together. A check is refused at
 * the bound; a start, which the wallet has signed, waits for a fetch to finish and takes its place,
 * ahead of any check that arrives meanwhile. Counting only checks would let any number of signed
 * starts each be reading a repo's tarball at once.
 */
const SOURCE_FETCHES_IN_FLIGHT = 2;

let sourceFetchesInFlight = 0;

const sourceFetchWaiters: (() => void)[] = [];

/** A fetch finished: its place goes to the start waiting longest, still counted, or is freed. */
function releaseSourceFetch(): void {
  const next = sourceFetchWaiters.shift();
  if (next) next();
  else sourceFetchesInFlight--;
}

/** `fetch` once there is room for it — a start's, which waits rather than being refused. */
async function underSourceFetchBound<T>(fetch: () => Promise<T>): Promise<T> {
  if (sourceFetchesInFlight < SOURCE_FETCHES_IN_FLIGHT) sourceFetchesInFlight++;
  else await new Promise<void>((handed) => sourceFetchWaiters.push(handed));
  try {
    return await fetch();
  } finally {
    releaseSourceFetch();
  }
}

/**
 * `POST /api/loops { action: "check-sources" }`: every input resolved (commit, final URL and type,
 * slot) and counted, nothing kept — `checkSources` does the start's whole fetch, so the refusals a
 * start would make come before the wallet signs. Here rather than in the route so a suite can
 * reach it; `check` is the fetcher, which a suite stubs.
 *
 * A restored set (`irys`) is checked the way the start will take it: the index resolved (through
 * the named agent's locator cell, or as given), the manifest and every file downloaded and
 * re-hashed, nothing kept. The answer then lists the restored manifest's own entries — the pins the
 * first loop fetched, which are what this loop's sandbox will read — and says where the index was.
 */
export async function checkSourcesAction(
  sources: unknown,
  caller: string,
  check: (sources: unknown) => Promise<CheckedSource[] | RestoredCheck> = (s) => checkLoopSources(s)
): Promise<{ status: number; body: CheckSourcesAnswer }> {
  const limited = rateLimit("source checks", `source-check:${caller}`, SOURCE_CHECKS_PER_HOUR);
  if (limited) return { status: 429, body: { ok: false, error: limited } };
  // Refused, not queued: a check has no signature behind it, and a start waiting for a place goes first.
  if (sourceFetchesInFlight >= SOURCE_FETCHES_IN_FLIGHT || sourceFetchWaiters.length > 0) {
    return {
      status: 429,
      body: { ok: false, error: "this console is already fetching sources; try again in a moment" },
    };
  }
  sourceFetchesInFlight++;
  try {
    const answered = await check(sources);
    const restored = Array.isArray(answered) ? null : answered.restored;
    const resolved = Array.isArray(answered) ? answered : answered.resolved;
    // The index a start would put at the head of every step message, held to its budget here
    // too, so a repo too large for a step's message is refused before the wallet signs rather than
    // by the sandbox after the Genesis. `_lib/sources.ts` makes the same refusal; this is the
    // route's own, in case a fetcher answers counts it never held to the budget.
    const tooLarge = checkedIndexProblem(resolved);
    if (tooLarge) return { status: 400, body: { ok: false, error: tooLarge } };
    return {
      status: 200,
      body: {
        ok: true,
        resolved: resolved.map((c) => ({ source: c.source, files: c.files, bytes: c.bytes })),
        ...(restored ? { restored } : {}),
      },
    };
  } catch (e) {
    // A refusal is an answer (`sourcesRefusal` numbers the input it names), not a server error.
    return { status: 400, body: sourcesRefusal(e) };
  } finally {
    releaseSourceFetch();
  }
}

/** A restored set as _Check sources_ answers it: the manifest's entries, and where the index was. */
export interface RestoredCheck {
  resolved: CheckedSource[];
  restored: RestoredSourcesCheck;
}

/**
 * The real check: a fetched list through the fetcher, a restored set through `restoreSources`
 * without an `outDir`, so it downloads and re-hashes everything the start would and keeps nothing.
 * `hooks` is the start's `SandboxHooks.irys`, for a suite.
 */
export async function checkLoopSources(
  sources: unknown,
  deps: SourcesDeps = defaultSourcesDeps(RPC_URL),
  hooks: Pick<SandboxHooks, "irys"> = {}
): Promise<CheckedSource[] | RestoredCheck> {
  const inputs = parseSourceInputs(sources);
  const restoring = inputs.find((s): s is IrysSourceInput => s.kind === "irys");
  if (!restoring) return checkSources(inputs, deps);
  const irys = sourcesIrysFor(hooks);
  const { kind: _kind, ...ref } = restoring;
  let restored: Awaited<ReturnType<typeof restoreSources>>;
  try {
    restored = await restoreSources(ref, irys.reader ?? irys.gateway, { locate: irys.locate });
  } catch (e) {
    // Numbered as the form numbers its rows: a restored set is always row 1, the list's only one.
    if (e instanceof SourcesRefused && e.input === undefined) throw new SourcesRefused(e.message, 1);
    throw e;
  }
  return {
    resolved: restored.manifest.sources.map((entry) => ({
      source: entry.source,
      files: entry.files.length,
      bytes: entry.files.reduce((n, f) => n + f.size, 0),
    })),
    restored: { index: restored.resolved.index, sourcesHash: restored.hash, agent: restored.resolved.agent },
  };
}

/**
 * Why the checked sources' index would be over `SOURCES_INDEX_MAX_BYTES`, or `null`. A check keeps
 * counts, not paths or hashes, so the index is measured on the shortest one those counts allow:
 * every file a one-byte name under its source's directory, of size 0, hash and all. The real
 * index is at least that long, so what this refuses the start would refuse too, and nothing the
 * start would take is refused here. Measured by `sourcesIndexProblem` on that manifest, so the
 * line format is the runtime's and not restated.
 */
export function checkedIndexProblem(resolved: readonly CheckedSource[]): string | null {
  const shortest: SourcesManifest = {
    v: 1,
    sources: resolved.map((c) => {
      const dir = sourceDir(c.source);
      return {
        source: c.source,
        dir,
        files: Array.from({ length: c.files }, () => ({ path: `${dir}/x`, size: 0, sha256: "0".repeat(64) })),
      };
    }),
  };
  if (sourcesIndexProblem(shortest) === null) return null;
  const files = resolved.reduce((n, c) => n + c.files, 0);
  const least = new TextEncoder().encode(sourcesIndex(shortest)).length;
  return (
    `the sources' index would be at least ${least} bytes for ${files} files, over the ${SOURCES_INDEX_MAX_BYTES} ` +
    `a step's message can give it; narrow a repo to a subpath (…/tree/<ref>/<path>) or list fewer sources`
  );
}

/** `CheckSourcesResponse` (`lib/loops.ts`), restated because a server module does not import the client's. */
export type CheckSourcesAnswer =
  | { ok: true; resolved: CheckedSource[]; restored?: RestoredSourcesCheck }
  | { ok: false; error: string; input?: number };

/**
 * A start's sources, fetched once: into `fetchedSourcesDir` under a loop id minted here, every file and
 * the manifest stored as blobs in the loop agent's trace store — so `lath-audit replay` can seed step 0
 * from them by hash — and the manifest's hash returned for the record. All or nothing: a refusal, or a
 * blob that will not store, leaves no directory behind.
 *
 * Then Irys, still before any step and before any member is registered:
 *
 * - a set **restored** from another loop's sources (`irys`, the list's only entry) is read from
 *   Irys in place of a fetch, every file re-hashed against the manifest and the manifest against
 *   the `sourcesHash` the owner named (`restoreSources`), and laid out where a fetch would be. The
 *   manifest is the first loop's, byte for byte, so this loop's posture commits the same hash;
 * - a fetched set is **published** in clear (`publishSources`) when the console anchors to Irys, and
 *   not at all when it anchors to its own directory — so a loop on such a console records and
 *   commits exactly what it did;
 * - either way the loop agent gets one `LocatorRegistry` cell naming the index, the path a
 *   stranger takes from the posture on chain to the bytes on Irys with no console in between.
 *
 * All of it is the server's, inside the start the owner already signed: no second prompt. A
 * failed upload or cell refuses the start with the reason and discards the fetch, like any refusal
 * here; the objects already uploaded stay on Irys unreferenced, which costs their bytes and nothing
 * else.
 */
export async function fetchLoopSources(
  sources: LoopSourceInput[],
  agentId: string,
  deployed: DeployedAgent,
  hooks: SandboxHooks
): Promise<ResolvedLoopSources | Refusal> {
  const home = hooks.zeroclawHome ?? zeroclawHome();
  const traces = hooks.sourcesStore ?? sourcesStoreFor();
  if (!traces) return { error: "the server has no runtime keypair to store a loop's sources under", status: 503 };
  const deps = hooks.sourcesDeps ?? defaultSourcesDeps(RPC_URL);
  const irys = sourcesIrysFor(hooks);
  // `parseSourceInputs` has held an `irys` input to being the list's only one (`loopSourcesProblem`).
  const restoring = sources.find((s): s is IrysSourceInput => s.kind === "irys");
  const loopId = mintLoopId(agentId, Date.now());
  const dir = fetchedSourcesDir(loopId, home);
  const loopDir = path.dirname(dir);
  // The loop's own directory, made here and by nobody else: `fetchSources` stages beside `dir` and
  // renames into place, and the loop's sandboxes are laid out beside it later. Not `recursive`, which
  // would succeed on a directory that already exists: two starts of one agent in one millisecond
  // mint one id, and the second must not fetch into the first's directory — nor, when it fails,
  // remove the first's files with its own. `EEXIST` is that second start, refused before it
  // writes anything.
  try {
    fs.mkdirSync(path.dirname(loopDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(loopDir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return { error: "another start of this agent is fetching its sources at this moment; try again", status: 409 };
    }
    return {
      error: `the loop's sources have nowhere to go: ${e instanceof Error ? e.message : String(e)}`,
      status: 500,
    };
  }
  // Named here rather than before the `mkdir`: a start refused for a directory that exists never
  // began a fetch, and the button should not have said it had.
  tellStage(hooks.onStage, { stage: "fetching sources", sources: sources.length, restoring: !!restoring });
  try {
    let manifest: SourcesManifest;
    let hash: string;
    let restoredFrom: { index: string; agent: string | null } | null = null;
    if (restoring) {
      const { kind: _kind, ...ref } = restoring;
      const restored = await restoreSources(ref, irys.reader ?? irys.gateway, { outDir: dir, locate: irys.locate });
      manifest = restored.manifest;
      hash = restored.hash;
      restoredFrom = { index: restored.resolved.index, agent: restored.resolved.agent };
    } else {
      ({ manifest, hash } = await underSourceFetchBound(() => fetchSources(sources, deps, dir)));
    }
    // The index opens every step message, in every sandbox; a manifest whose index is over its
    // budget would have the sandbox refuse every step after the Genesis. Refused here, before a blob
    // is stored and before any member is registered. `fetchSources` makes the same refusal; this
    // is the start's own, so no fetcher can hand a loop sources its steps cannot carry.
    const tooLarge = sourcesIndexProblem(manifest);
    if (tooLarge) throw new SourcesRefused(tooLarge);
    for (const entry of manifest.sources) {
      for (const file of entry.files) await traces.put(fs.readFileSync(path.join(dir, ...file.path.split("/"))));
    }
    const stored = hex(await traces.put(sourcesManifestBytes(manifest)));
    // `put` is content-addressed over the plaintext, so this is the manifest's own hash unless the
    // store is not what it claims; a record naming a hash nothing serves could never be replayed.
    if (stored !== hash) throw new Error(`the manifest stored as ${stored}, not ${hash}`);

    const onIrys = await sourcesOnIrys(manifest, hash, dir, agentId, deployed, irys, restoredFrom, hooks.onStage);
    return { loopId, sourcesHash: hash, ...(onIrys ? { irys: onIrys } : {}) };
  } catch (e) {
    // The directory this call made, and everything in it: nothing else can have been written
    // there, since the `mkdir` above refuses one that exists.
    fs.rmSync(loopDir, { recursive: true, force: true });
    if (e instanceof SourcesRefused) return { error: e.message, status: 400 };
    if (e instanceof SourcesPublishFailed) {
      return { error: `the loop's sources could not be published to Irys: ${e.message}`, status: 502 };
    }
    if (e instanceof SourcesCellFailed) return { error: e.message, status: 502 };
    return {
      error: `the loop's sources could not be kept: ${e instanceof Error ? e.message : String(e)}`,
      status: 500,
    };
  }
}

/** What `prepareLoopStart` hands `planLoopStart` of a start's sources: the loop id, the hash, and Irys. */
export interface ResolvedLoopSources {
  loopId: string;
  sourcesHash: string;
  /** Absent when the console published nothing and the start restored nothing. */
  irys?: LoopSourcesIrys;
}

/** The index cell could not be read or written. Nothing is started; the owner can simply try again. */
class SourcesCellFailed extends Error {}

/**
 * The Irys half of a start's sources, once they are fetched (or restored) and kept: the index, from
 * an upload or the restore, and the one locator cell under the loop agent naming it. `null` when
 * there is nothing on Irys to name — a fetched set on a console that does not publish.
 *
 * The cell is read first. It is keyed by the sources' hash, so a restart of the same sources finds
 * the index its first start published and uploads nothing: the index names the same bytes, and the
 * cell is first-write-wins, so a second upload could never be named by it anyway. A cell that is
 * there but not an Irys locator is refused rather than written over — the key is this module's, and
 * something else under it is a mapping nobody here made.
 */
async function sourcesOnIrys(
  manifest: SourcesManifest,
  hash: string,
  dir: string,
  agentId: string,
  deployed: DeployedAgent,
  irys: SourcesIrysContext,
  restoredFrom: { index: string; agent: string | null } | null,
  onStage?: (stage: LoopStartStage) => void
): Promise<LoopSourcesIrys | null> {
  if (!restoredFrom && !irys.uploader) return null;
  // Through `sourcesIrysKey` only, so the key — a domain-separated form of the hash rather than the
  // hash itself — is decided in one place.
  const key = sourcesIrysKey(hash);
  const cell = irys.cell(deployed, agentId);
  let found: Locator | null;
  try {
    found = await cell.read(key);
  } catch (e) {
    throw new SourcesCellFailed(`the loop agent's locator cell could not be read: ${errorText(e)}`);
  }
  if (found && found.scheme !== LocatorScheme.Irys) {
    throw new SourcesCellFailed(
      `the loop agent already maps these sources to locator scheme ${found.scheme}, not to an Irys index`
    );
  }
  const base = {
    network: irys.network,
    gateway: irys.gateway.replace(/\/+$/, ""),
  };
  // Which of the two the button names is known only now, after the cell is read: a restart of the
  // same sources finds its first start's index and uploads nothing, which is a reuse, not a pin.
  if (restoredFrom || found) tellStage(onStage, { stage: "reusing Irys pin" });
  else
    tellStage(onStage, { stage: "pinning on Irys", files: manifest.sources.reduce((n, s) => n + s.files.length, 0) });
  if (restoredFrom) {
    // A restored set is on Irys already, under the index it was read from: nothing is uploaded. The
    // cell names that index from this agent too, so a stranger holding this loop's posture reaches
    // the bytes the same way as from the first loop's.
    const index = found ? irysIdString(found.id) : restoredFrom.index;
    if (!found) await writeCell(cell, key, index);
    return {
      index,
      uploads: 0,
      bytes: 0,
      ...base,
      cell: { key: hex(key), written: !found },
      restored: { agent: restoredFrom.agent },
    };
  }
  if (found) {
    return { index: irysIdString(found.id), uploads: 0, bytes: 0, ...base, cell: { key: hex(key), written: false } };
  }
  const published = await publishSources(manifest, dir, irys.uploader!);
  // `publishSources` hashes the manifest's bytes itself; a different answer is a manifest that
  // changed between the fetch and the upload, and its index must not be anchored under this key.
  if (published.sourcesHash !== hash) {
    throw new SourcesPublishFailed(`the published manifest hashes to ${published.sourcesHash}, not ${hash}`);
  }
  await writeCell(cell, key, published.index);
  return {
    index: published.index,
    manifest: published.manifest,
    uploads: published.uploads,
    bytes: published.bytes,
    ...base,
    cell: { key: hex(key), written: true },
  };
}

async function writeCell(cell: SourcesCell, key: Uint8Array, index: string): Promise<void> {
  try {
    await cell.write(key, { scheme: LocatorScheme.Irys, id: decodeIrysId(index) });
  } catch (e) {
    throw new SourcesCellFailed(
      `the sources are on Irys (index ${index}), but the loop agent's locator cell naming them could not be ` +
        `written: ${errorText(e)}`
    );
  }
}

/** The loop agent's `LocatorRegistry`, reduced to the one key a start reads and writes. */
export interface SourcesCell {
  read(key: Uint8Array): Promise<Locator | null>;
  write(key: Uint8Array, locator: Locator): Promise<void>;
}

/**
 * The real cell: the loop agent's default `LocatorRegistry` — the one its epochs and bundles anchor
 * through, and the one `restoreSources({ agent })` reads — written with the agent's own key, since
 * only the key that registered an agent may append to its chain. Before any step, so the cell takes
 * a seq no step's journal is holding.
 */
function chainSourcesCell(deployed: DeployedAgent, agentId: string): SourcesCell {
  const server = loadKeypair();
  if (!server) throw new SourcesCellFailed("the server has no runtime keypair to write the sources' locator cell with");
  const key = deployedRoles(server, deployed.name).agent.key;
  const rpc = rpcFor();
  const registry = new LocatorRegistry(LathClient.fromIdl(rpc, key), toBytes32(agentId));
  return {
    async read(k) {
      return (await registry.resolve(k))?.locator ?? null;
    },
    // Under the run slot: the cell takes a seq on the loop agent's chain like any record, and a chat
    // session with the same agent, or a step or settlement of another run on it, would otherwise race
    // it for that seq. Waited for rather than refused at once, because a start that gives up here has
    // already uploaded its sources; a slot still taken after a step's whole deadline refuses the start
    // with the reason, as a failed write does.
    async write(k, locator) {
      const ran = await withRunSlotWaiting(
        `loop sources for ${deployed.name}`,
        STEP_DEADLINE_MS,
        async () => {
          await ensureFunded(rpc, server, key.publicKey);
          await registry.ensureCreated();
          await registry.publish(k, locator);
        },
        STEP_DEADLINE_MS
      );
      if (ran === "busy") throw new Error("another run held this console's run slot the whole time; start again");
    },
  };
}

/** What a start's Irys half runs through, resolved from `SandboxHooks.irys` and this console's settings. */
interface SourcesIrysContext {
  uploader: SourcesUploader | null;
  gateway: string;
  network: "devnet" | "mainnet";
  locate?: LocateSourcesIndex;
  reader?: SourcesGateway;
  cell: (deployed: DeployedAgent, agentId: string) => SourcesCell;
}

function sourcesIrysFor(hooks: Pick<SandboxHooks, "irys">): SourcesIrysContext {
  const settings = irysSourcesSettings();
  const h = hooks.irys ?? {};
  let uploader: SourcesUploader | null;
  if (h.uploader !== undefined) {
    uploader = h.uploader;
  } else if (settings.publish) {
    // Built lazily by `irysSourcesUploader` (nothing loads until the first upload); a console with no
    // keypair cannot publish, and the start has already been refused for that by the trace store.
    const server = loadKeypair();
    uploader = server
      ? irysSourcesUploader({ wallet: server, network: settings.network, rpc: settings.rpc, node: settings.node })
      : null;
  } else {
    uploader = null;
  }
  return {
    uploader,
    gateway: h.gateway ?? settings.gateway,
    network: h.network ?? settings.network,
    locate: h.locate,
    reader: h.reader,
    cell: h.cell ?? chainSourcesCell,
  };
}

/** The trace store a step reads its sources through, or `null` on a console with no keypair. */
function sourcesStoreFor(): TraceStore | null {
  return loadKeypair() ? new FileTraceStore(TRACE_DIR) : null;
}

/**
 * What a start's sources are fetched and kept with. The real network, `LATH_ZEROCLAW_HOME` and the
 * loop agent's trace store by default; a suite passes its own, for the reason `StartHooks` exists.
 */
export interface SandboxHooks {
  sourcesDeps?: SourcesDeps;
  zeroclawHome?: string;
  sourcesStore?: TraceStore;
  /** `zeroclawReadiness` by default; a suite that never spawns a sandbox answers it without a binary. */
  readiness?: () => ZeroClawReadiness;
  /**
   * Irys, each part defaulting to this console's: the uploader (`null` publishes nothing; unset
   * is `irysSourcesUploader` when `LATH_TRACE_BACKEND=irys`, else nothing), the gateway a restore reads
   * and a page links to, or a `reader` in its place, the chain read a restore by agent resolves the
   * index through, and the loop agent's locator cell.
   */
  irys?: {
    uploader?: SourcesUploader | null;
    gateway?: string;
    network?: "devnet" | "mainnet";
    reader?: SourcesGateway;
    locate?: LocateSourcesIndex;
    cell?: (deployed: DeployedAgent, agentId: string) => SourcesCell;
  };
  /**
   * Told each stage of the sources as it begins: the fetch, and then the Irys pin or its reuse.
   * What a streamed `POST /api/loops` names on the Start button, since the fetch and the upload are
   * the minute a start can take. Told only, never asked: a listener that throws is ignored
   * (`tellStage`), because the owner has already signed and the start must not fail on its display.
   */
  onStage?: (stage: LoopStartStage) => void;
}

/**
 * A stage of a start, as `POST /api/loops` streams it to a client that asked for `text/event-stream`
 * (`_lib/loop-start.ts`). `checking` and `starting` are the route's; the two source stages are
 * `fetchLoopSources`'s, and the Irys pair is `sourcesOnIrys`'s. Counts are what is known when the stage
 * begins: the inputs for a fetch, the files the manifest names for a pin — never the manifest and the
 * index, which are the pin's own two uploads.
 */
export type LoopStartStage =
  | { stage: "checking" }
  | { stage: "fetching sources"; sources: number; restoring: boolean }
  | { stage: "pinning on Irys"; files: number }
  | { stage: "reusing Irys pin" }
  | { stage: "starting" };

/** Tells a stage to a listener that may be absent, or may throw — neither can touch the start. */
export function tellStage(onStage: ((stage: LoopStartStage) => void) | undefined, stage: LoopStartStage): void {
  try {
    onStage?.(stage);
  } catch {
    /* a display, not a step of the start */
  }
}

/** A loop's id: the one `planLoopStart` has always minted, minted earlier when a fetch needs it. */
export function mintLoopId(agentId: string, now: number): string {
  return `loop-${hex(idFromString(`${agentId}:${now}`)).slice(0, 16)}`;
}
