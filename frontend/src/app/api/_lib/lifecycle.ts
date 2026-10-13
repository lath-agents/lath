/**
 * The console's half of the lifecycle records (`sdk/src/lifecycle.ts`): the documents a decision
 * owes, the writer that puts one on the agent's chain, and the reads a console rebuilds its lists
 * from when its own `loops.json` and `agents.json` are gone.
 *
 * What a console decides — a loop started, paused, resumed or stopped, an agent deployed or archived
 * — it owes the chain from that moment, as a document built **then** (its `at`, `by`, `auth` and
 * `reason` are the decision's, not the write's) and kept on the row as `lifecycle.owed`. The write
 * comes later, under the run slot, in order (`payOwedLifecycle` in `_lib/loop-registry.ts`): a record is a
 * direct write on the agent's chain and takes the next seq, so it may never land beside a step, a
 * settlement or a session, nor between a step's Resolution and its `loop.step` (whose leaf commits to
 * the head at seq − 1). A write that fails leaves the entry owed with the reason beside it, and the
 * next pass tries again; nothing here ever fails the decision itself.
 *
 * **Public only.** The documents go through the agent's plain store and are anchored one locator cell
 * per blob, so a reader with the chain and Irys alone finds every leaf. No owner-only half is written
 * beside them (the standing prompt and the signed start body, encrypted under the agent's trace key
 * and named by `privateHash`): owner privacy is on the roadmap. An older record that names one still
 * audits; `lath-audit --trace-key` opens it.
 *
 * **Not through `AnchoredTraceStore` inside `logger.action`.** The logger puts `args` and `result`
 * concurrently, and two cell writes at once race for one seq. The record is written over a
 * `RecordingTraceStore` and its blobs are anchored after it, one at a time, as `defaultLoopSettle`
 * anchors a settlement's.
 *
 * `LATH_LIFECYCLE` (`0|off|false|no`) is the kill switch: off, nothing is owed, written or rebuilt.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AGENT_DEPLOY_TOOL,
  AgentLogger,
  AnchoredTraceStore,
  Bytes32,
  EventKind,
  FileTraceStore,
  FsLocatorBackend,
  HttpGatewayBackend,
  IRYS_ENCODING,
  LIFECYCLE_VERSION,
  LathClient,
  LifecycleResultDoc,
  LifecycleTool,
  LifecycleWrite,
  LocatorBackend,
  LocatorRegistry,
  LocatorScheme,
  LoopStartDoc,
  LoopTransitionDoc,
  RecordingTraceStore,
  SignedMessage,
  TraceStore,
  hex,
  idFromString,
  lifecycleAction,
  lifecycleResult,
  loopStartBodyHash,
  readLifecycle,
  sha256,
  toBytes32,
} from "@lath/sdk";
import { NoopBilling } from "@lath/runtime";
import {
  DeployedAgent,
  IRYS_GATEWAY_URL,
  RPC_URL,
  TRACE_DIR,
  deployedRoles,
  ensureFunded,
  loadKeypair,
  rpcFor,
  traceBackend,
} from "./runner";
import { anchorQueue, bindAnchorChain, carriedCharges } from "./anchor";
// Type only: the loop modules behind `loops.ts` import this module, and a value import back would be a
// runtime cycle.
import type { LoopRecord } from "./loops";
import type { LifecycleRef, LoopChainView } from "../../../types/loop";

// ─── The switch ─────────────────────────────────────────────────────────────

/**
 * Whether this console owes, writes and rebuilds lifecycle records: on unless `LATH_LIFECYCLE` is
 * `0|off|false|no`. Read at each call, so a suite (or an operator's restart) changes it without a
 * rebuild of anything. Off writes and queues nothing — a row decided while it was off owes nothing
 * later — and a row that already owes entries keeps them, unwritten, until it is on again.
 */
export function lifecycleOn(): boolean {
  const v = (process.env.LATH_LIFECYCLE ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(v);
}

// ─── What a row keeps ───────────────────────────────────────────────────────

/** One record decided and not yet written: the documents as they were built at the decision. */
export interface OwedLifecycle {
  /** Random, so the payer takes off exactly the entry it wrote, whatever else was owed meanwhile. */
  id: string;
  tool: LifecycleTool;
  /** The public document. */
  args: Record<string, unknown>;
  result: LifecycleResultDoc;
  /** Unix ms of the decision. */
  at: number;
}

/**
 * A loop's or an agent's lifecycle, on its row (`LoopRecord.lifecycle`, `DeployedAgent.lifecycle`).
 * Absent on an older row and on one written while the switch was off, and such a row owes nothing
 * for its later transitions either: its chain has no start for them to follow.
 */
export interface LifecycleState {
  /** What is on chain, oldest first. */
  records: LifecycleRef[];
  /** What is decided and not yet written, in the order it must land. */
  owed: OwedLifecycle[];
  /** Why the last write failed, while its entry waits for the retry. */
  error?: string;
  /**
   * The row was rebuilt from the chain by a console that did not start it. A rebuilt loop is
   * read-only here: nothing schedules it and its controls refuse (`REBUILT_REFUSAL`).
   */
  rebuilt?: true;
}

export const REBUILT_REFUSAL =
  "this loop was rebuilt from the chain by a console that did not start it; it is read-only here";

/** Who decided a transition, as the route that verified the signature hands it down. */
export interface LifecycleActorContext {
  by: "owner" | "console";
  auth?: SignedMessage;
  /** A resume's reason: `retry` when a Retry put a stopped run back on its schedule. */
  resumeReason?: string;
}

/** How a loop's start was authorised, threaded from the route that checked it to the row it owes. */
export interface LoopStartOrigin {
  /** The `"Lath loop"` message the start was posted with, as the route verified it. */
  auth?: SignedMessage;
  /** The start body less its `auth`: what `startBodyHash` re-hashes. */
  startBody?: Record<string, unknown>;
  /** A loop started with its agent's deploy: the deploy transaction the wallet signed instead. */
  deployTx?: string;
}

function randomId(): string {
  return hex(Keypair.generate().publicKey.toBytes()).slice(0, 16);
}

/** Only the two fields a signed message is: a `SessionAuth` may grow others that are not the owner's word. */
export function signedMessageOf(
  auth: { message?: unknown; signature?: unknown } | undefined
): SignedMessage | undefined {
  if (!auth || typeof auth.message !== "string" || typeof auth.signature !== "string") return undefined;
  return { message: auth.message, signature: auth.signature };
}

/** `undefined` keys out, so the canonical bytes are the same whichever optional fields a caller passed. */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function owedEntry(
  tool: LifecycleTool,
  args: Record<string, unknown>,
  result: LifecycleResultDoc,
  at: number = Date.now()
): OwedLifecycle {
  return { id: randomId(), tool, args: defined(args), result, at };
}

/** The empty state a new row starts with: nothing on chain, nothing owed. */
export function freshLifecycle(owed: OwedLifecycle[] = []): LifecycleState {
  return { records: [], owed };
}

// ─── Documents ──────────────────────────────────────────────────────────────

/**
 * A loop's fixed-at-start terms, as the public start document carries them: what a console needs to
 * rebuild the row. The prompt is committed by `promptHash`; a sandbox's sources as typed and a team
 * slot's system prompt (its role) are left out, since they belong to an owner-only half this build
 * does not write; the access keys are public addresses, never their files (`LoopTempoKey` holds no
 * path).
 */
export function loopTerms(loop: LoopRecord): Record<string, unknown> {
  const sandbox = loop.sandbox
    ? (() => {
        const { sources: _sources, ...config } = loop.sandbox!.config as Record<string, unknown>;
        return defined({ config, sourcesHash: loop.sandbox!.sourcesHash, irys: loop.sandbox!.irys });
      })()
    : undefined;
  const workers = loop.workers
    ? {
        ...loop.workers,
        ...(Array.isArray(loop.workers.slots)
          ? {
              slots: loop.workers.slots.map(({ policy, ...slot }) =>
                policy?.tools ? { ...slot, policy: { tools: policy.tools } } : slot
              ),
            }
          : {}),
      }
    : undefined;
  return defined({
    agentName: loop.agentName,
    model: loop.model,
    fallbackModel: loop.fallbackModel,
    trigger: loop.trigger ?? { kind: "schedule" },
    verify: loop.verify,
    goalCheck: loop.goalCheck,
    traceAudit: loop.traceAudit,
    workers,
    gate: loop.gate,
    sandbox,
    template: loop.template,
    trial: loop.trial,
    jevBudgetBase: loop.jevBudgetBase,
    tempoKey: loop.tempoKey,
    grants: loop.grants,
    solanaKey: loop.solanaKey ? { address: loop.solanaKey.address, createdAt: loop.solanaKey.createdAt } : undefined,
    receipt: loop.receipt,
  });
}

/**
 * The `loop.start` a new row owes. `startBodyHash` is what the wallet's
 * `Request ID` line names (`loopStartBodyHash`), so it is written only beside the body it hashes;
 * a start that came with its deploy carries the deploy transaction instead of a message.
 */
export function loopStartEntry(loop: LoopRecord, origin: LoopStartOrigin = {}, at: number = Date.now()): OwedLifecycle {
  const auth = signedMessageOf(origin.auth);
  // `loopStartBodyHash` drops `auth` itself; a body handed here has none, and hashes the same either way.
  const startBodyHash = origin.startBody ? loopStartBodyHash(origin.startBody) : undefined;
  const args: Omit<LoopStartDoc, "privateHash"> = defined({
    v: LIFECYCLE_VERSION,
    loopId: loop.id,
    agentId: loop.agentId,
    owner: loop.owner,
    createdAt: loop.createdAt,
    intervalMs: loop.intervalMs,
    maxSteps: loop.maxSteps,
    budgetMicroUsdc: loop.budgetMicroUsdc ?? String(BigInt(loop.budgetMicroUsdcPerStep) * BigInt(loop.maxSteps)),
    promptHash: loop.promptHash,
    goal: loop.goal,
    goalHash: loop.goalHash,
    startBodyHash,
    auth,
    deployTx: origin.deployTx,
    terms: loopTerms(loop),
  });
  return owedEntry("loop.start", args as unknown as Record<string, unknown>, lifecycleResult(loop.id, "running"), at);
}

/** A pause, a resume or a stop, as `LoopTransitionDoc`. */
export function loopTransitionEntry(
  tool: "loop.pause" | "loop.resume" | "loop.stop",
  loopId: string,
  o: Omit<LoopTransitionDoc, "v" | "loopId" | "at" | "by"> & { by?: LoopTransitionDoc["by"]; at?: number }
): OwedLifecycle {
  const at = o.at ?? Date.now();
  const args: LoopTransitionDoc = defined({
    v: LIFECYCLE_VERSION,
    loopId,
    at,
    by: o.by ?? "console",
    auth: signedMessageOf(o.auth),
    reason: o.reason,
    detail: o.detail,
    steps: o.steps,
    lastStepSeq: o.lastStepSeq,
  });
  const status = tool === "loop.pause" ? "paused" : tool === "loop.resume" ? "running" : "stopped";
  const result = lifecycleResult(loopId, status, tool === "loop.resume" ? undefined : o.reason);
  return owedEntry(tool, args as unknown as Record<string, unknown>, result, at);
}

/**
 * What a row's change of status owes, or `null` when it owes nothing: the transition from `current`
 * to `next`, with the actor the caller set (`console` when none did). A stopped run whose reason
 * changes owes another stop — a Retry that finishes an `anchor-failed` run as `max-steps`, a Discard
 * that makes it `anchor-discarded` — since the fold takes the last stop's reason; one still owed is
 * replaced rather than followed, so a reason nobody will read again costs no transaction.
 */
export function transitionOwed(
  current: Pick<LoopRecord, "status" | "stopReason">,
  next: Pick<LoopRecord, "id" | "status" | "stopReason" | "stopDetail" | "snapshot">,
  ctx: LifecycleActorContext | null
): OwedLifecycle | null {
  const reasonMoved =
    next.status === "stopped" && current.status === "stopped" && current.stopReason !== next.stopReason;
  if (current.status === next.status && !reasonMoved) return null;
  const actor = { by: ctx?.by ?? ("console" as const), auth: ctx?.auth };
  if (next.status === "paused") return loopTransitionEntry("loop.pause", next.id, actor);
  if (next.status === "running") {
    return loopTransitionEntry("loop.resume", next.id, { ...actor, reason: ctx?.resumeReason });
  }
  return loopTransitionEntry("loop.stop", next.id, {
    ...actor,
    reason: next.stopReason ?? "stopped",
    detail: next.stopDetail,
    steps: next.snapshot.steps,
    lastStepSeq: next.snapshot.lastSeq,
  });
}

/** `state` with `entry` owed after what is owed already; a stop replaces a stop still owed. */
export function withOwed(state: LifecycleState, entry: OwedLifecycle): LifecycleState {
  const last = state.owed[state.owed.length - 1];
  const owed =
    entry.tool === "loop.stop" && last?.tool === "loop.stop"
      ? [...state.owed.slice(0, -1), entry]
      : [...state.owed, entry];
  return { ...state, owed };
}

/**
 * The `agent.deploy` a newly recorded agent owes. `deployTx` is the confirmed transaction the owner's
 * wallet signed (`register_agent` beside its `approve_agent`); a clone is a deploy, with `clonedFrom`.
 */
export function agentDeployEntry(id: string, agent: DeployedAgent, deployTx?: string): OwedLifecycle {
  return owedEntry(
    "agent.deploy",
    {
      v: LIFECYCLE_VERSION,
      agentId: id,
      name: agent.name,
      owner: agent.owner ?? "",
      authority: agent.authority,
      createdAt: agent.createdAt,
      deployTx,
      policy: agent.policy as unknown as Record<string, unknown>,
      description: agent.description,
      template: agent.template,
      clonedFrom: agent.clonedFrom?.agentId,
    },
    lifecycleResult(id, "deployed")
  );
}

/** An owner-signed `agent.archive` or `agent.unarchive`. */
export function agentMarkEntry(
  tool: "agent.archive" | "agent.unarchive",
  id: string,
  auth: SignedMessage | undefined,
  at: number = Date.now()
): OwedLifecycle {
  return owedEntry(
    tool,
    { v: LIFECYCLE_VERSION, agentId: id, at, by: "owner", auth: signedMessageOf(auth) },
    lifecycleResult(id, tool === "agent.archive" ? "archived" : "deployed"),
    at
  );
}

// ─── Views ──────────────────────────────────────────────────────────────────

/** `LoopView.chain`: the refs, the owed tool ids, the error and whether the row was rebuilt. Never a document. */
export function loopChainView(state: LifecycleState | undefined): LoopChainView | undefined {
  if (!state) return undefined;
  return {
    records: state.records,
    owed: state.owed.map((o) => o.tool),
    ...(state.error ? { error: state.error } : {}),
    ...(state.rebuilt ? { rebuilt: true } : {}),
  };
}

/** A `GET /api/agents` row's `chain`. */
export function agentChainView(
  state: LifecycleState | undefined
): { records: LifecycleRef[]; owed: string[]; error?: string } | undefined {
  if (!state) return undefined;
  return {
    records: state.records,
    owed: state.owed.map((o) => o.tool),
    ...(state.error ? { error: state.error } : {}),
  };
}

// ─── The writer ─────────────────────────────────────────────────────────────

/** A write that will not succeed by trying again: no key, no agent, a chain this runtime does not operate. */
export class LifecycleRefused extends Error {}

/** Which agent a record goes on: its id and the name its key is derived from. */
export interface LifecycleTarget {
  agentId: string;
  name: string;
}

/** What the writer writes through; the real ones by default, a suite's in `tests/console-lifecycle.ts`. */
export interface LifecycleWriterDeps {
  client: LathClient;
  /** The key that registered the agent, when known: the chain's header must name it. */
  authority?: PublicKey;
  queue: { carried(agentId: Bytes32): Promise<unknown[]>; drain(agentId: Bytes32): Promise<void> };
  /** Whom the journal's carried charges are owed by; a drain is not this writer's to pay. */
  carriedPayers?: (agentId: Bytes32) => Promise<string[]>;
  /** Binds the chain's writer before a drain (`bindAnchorChain`), so the queue signs with the agent key. */
  bind?: () => void;
  fund?: () => Promise<unknown>;
  /** The agent's plain store: the documents and the record's preimage. */
  plain: TraceStore;
  anchor: { backend: LocatorBackend; registry: LocatorRegistry };
}

export type LifecycleWriter = (target: LifecycleTarget, entry: OwedLifecycle) => Promise<LifecycleRef>;

/** The real dependencies for one agent: its derived key, the console's backend and stores. */
export async function defaultLifecycleDeps(target: LifecycleTarget): Promise<LifecycleWriterDeps> {
  const server = loadKeypair();
  if (!server || !RPC_URL) throw new LifecycleRefused("the server has no runtime keypair or RPC configured");
  if (hex(idFromString(target.name)) !== target.agentId.toLowerCase()) {
    throw new LifecycleRefused(`the agent ${target.agentId} is not the one its name ${target.name} derives`);
  }
  const key = deployedRoles(server, target.name).agent.key;
  const rpc = rpcFor();
  const client = LathClient.fromIdl(rpc, key);
  const idBytes = toBytes32(target.agentId);
  const stored = new FileTraceStore(TRACE_DIR);
  const backend = await traceBackend(server);
  return {
    client,
    authority: key.publicKey,
    queue: anchorQueue(),
    carriedPayers: async (agentId) => (await carriedCharges(agentId)).payers,
    // `NoopBilling` only ever reaches a journal that carries no charge: the writer refuses one that
    // does before it binds, so nothing journaled can be settled unpaid through it. A later step binds
    // its own billing again (`runnerBaseFor`).
    bind: () => bindAnchorChain(idBytes, { client, billing: new NoopBilling() }),
    fund: () => ensureFunded(rpc, server, key.publicKey),
    plain: stored,
    anchor: { backend, registry: new LocatorRegistry(client, idBytes) },
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Writes one owed record on the agent's chain and returns its ref. The caller holds the run slot.
 *
 * 1. The journal first. A direct write on a chain whose journal owes entries takes their seq, and the
 *    queue then halts on _head diverged_ for good: so a journal that carries nothing is left alone,
 *    one that carries records is drained, and one that holds a failed entry (a Retry's) or a charge
 *    (its payer's) is refused — the entry stays owed until those land.
 * 2. The agent key's SOL.
 * 3. The record, through a recording store over the plain backend, then its blobs one cell each.
 *
 * A failure before the record leaves nothing written that matters; one after it — the cells — is
 * said in the log and not thrown, because the record is on chain and must not be written twice.
 */
export async function writeLifecycle(
  target: LifecycleTarget,
  entry: OwedLifecycle,
  given?: LifecycleWriterDeps
): Promise<LifecycleRef> {
  const deps = given ?? (await defaultLifecycleDeps(target));
  const agentId = toBytes32(target.agentId);

  const state = await deps.client.getAgentState(agentId);
  if (!state) throw new Error(`the agent ${target.name} is not registered on chain yet (or the indexer is behind)`);
  if (deps.authority && !state.state.authority.equals(deps.authority)) {
    throw new LifecycleRefused(`the chain of ${target.name} is not operated by this runtime`);
  }

  const carried = await deps.queue.carried(agentId);
  if (carried.length > 0) {
    if (carried.some((e) => (e as { state?: string }).state === "failed")) {
      throw new Error(
        `${target.name}'s journal holds writes that failed; they land first (Retry), then this record is written`
      );
    }
    const payers = deps.carriedPayers ? await deps.carriedPayers(agentId) : [];
    if (payers.length > 0) {
      throw new Error(
        `${target.name}'s journal carries charges owed by ${payers.join(", ")}; the next step or Retry pays them first`
      );
    }
    deps.bind?.();
    try {
      await deps.queue.drain(agentId);
    } catch (e) {
      throw new Error(`${target.name}'s journal did not drain: ${errorText(e)}`);
    }
  }

  await deps.fund?.();

  const args: Record<string, unknown> = entry.args;
  const recorder = new RecordingTraceStore(deps.plain, deps.anchor);
  const logger = new AgentLogger(deps.client, agentId, { store: recorder, compact: false, storePayloads: true });
  const written = await logger.action(
    lifecycleAction({ tool: entry.tool, args, result: entry.result } satisfies LifecycleWrite)
  );
  const anchored = await recorder.publish(0);
  if (anchored.error) {
    console.warn(
      `[lifecycle] ${entry.tool} on ${target.name} is on chain at seq ${written.seq}, but its blobs were not all ` +
        `anchored: ${anchored.error}`
    );
  }
  return { tool: entry.tool, seq: written.seq.toString(), signature: written.signature, at: Date.now() };
}

// ─── Reading back (the rebuild) ─────────────────────────────────────────────

/** The backends a rebuild reads a locator through, by scheme: the console's own directory, and Irys's gateway. */
function readBackends(): Map<number, LocatorBackend> {
  return new Map<number, LocatorBackend>([
    [LocatorScheme.Raw, new FsLocatorBackend(TRACE_DIR, { scheme: LocatorScheme.Raw, encoding: "hex" })],
    [
      LocatorScheme.Irys,
      new HttpGatewayBackend(IRYS_GATEWAY_URL, { scheme: LocatorScheme.Irys, encoding: IRYS_ENCODING }),
    ],
  ]);
}

/**
 * The agent's public documents as a reader with the chain and a gateway reads them: this disk first
 * (re-hashed), then the agent's locator cells through whichever backend the cell's scheme names.
 */
export function chainReaderStore(client: LathClient, agentId: Bytes32): TraceStore {
  const local = new FileTraceStore(TRACE_DIR);
  const registry = new LocatorRegistry(client, agentId);
  const backends = readBackends();
  return {
    put: (bytes) => local.put(bytes),
    async get(hash) {
      const near = await local.get(hash).catch(() => null);
      if (near && hex(sha256(near)) === hex(hash)) return near;
      const found = await registry.resolve(hash).catch(() => null);
      const backend = found ? backends.get(found.locator.scheme) : backends.get(LocatorScheme.Raw);
      if (!backend) return null;
      return new AnchoredTraceStore(backend, registry).get(hash).catch(() => null);
    },
  };
}

/**
 * Every `agent.deploy` record program-wide, grouped by agent: the candidates a rebuild reads. The
 * reference is `sha256("agent.deploy")` on kind 1, so this is one `memcmp` scan whatever wrote them.
 */
export async function deployCandidates(client: LathClient): Promise<string[]> {
  const records = await client.listByReference(idFromString(AGENT_DEPLOY_TOOL), EventKind.Action);
  return [...new Set(records.map((r) => hex(r.agentId)))];
}

/** The agent's deploy record and document as read through `store`, or `null`. */
export async function readDeploy(
  client: LathClient,
  store: TraceStore,
  agentId: Bytes32
): Promise<{ doc: Record<string, unknown>; ref: LifecycleRef } | null> {
  const [first] = await readLifecycle(client, store, agentId, [AGENT_DEPLOY_TOOL]);
  if (!first?.argsBytes) return null;
  try {
    const doc = JSON.parse(new TextDecoder().decode(first.argsBytes));
    return {
      doc,
      ref: { tool: AGENT_DEPLOY_TOOL, seq: first.seq.toString(), at: Number(first.timestamp) },
    };
  } catch {
    return null;
  }
}
