/**
 * Lifecycle records: an agent's deploy and a loop's start, pause, resume and stop, written on the
 * agent's own chain so that a console's lists can be rebuilt from the chain and Irys alone, and
 * so that the status a console shows is one the chain records rather than a row in its own disk.
 *
 * Without these records, the chain holds a loop's steps (`loop.step`), its settlement and the
 * hashes of its prompt and goal, while everything a list shows — that the loop exists before its
 * first step, who started it, that it is paused, why it stopped, which wallet deployed an agent —
 * would live only in the console's `loops.json` and `agents.json`. A fresh console directory would
 * forget all of it, and a row could say *running* for a loop the chain had long stopped writing.
 *
 * Each record is one standalone full-mode `Action`, signed by the key that registered the agent:
 *
 * ```text
 * tool_id      agent.deploy · agent.archive · agent.unarchive · loop.start · loop.pause · loop.resume · loop.stop
 * args_hash    sha256(canonicalJson(document))      // the documents below, public
 * result_hash  sha256(canonicalJson(LifecycleResultDoc))
 * status       200
 * ```
 *
 * Full mode, never inside an epoch, because `listByTool` finds only records an account holds
 * (SPEC §15), and these are the records a reader lists. New tool ids on the existing `Action`
 * kind, so no program change, no new layout and no change to the §4.4 formula; a chain that
 * carries none is read as *not recorded*, never as a failure.
 *
 * **Public, and the private half of chains written encrypted.** The documents are written in the
 * clear — through the agent's locator registry to Irys, preimage and both leaves alike, so an audit
 * without a trace key finds every leaf (mixing a plaintext preimage with an encrypted leaf fails
 * it). This build writes nothing else: owner privacy is on the roadmap. An older record may name,
 * by `privateHash`, an owner-only half beside it — the standing prompt, and the start body that
 * carries it, encrypted under the agent's trace key — and those are read for the audit only
 * (`parseLoopPrivateDoc`, `parseAgentPrivateDoc`; `lath-audit --trace-key` opens them). The goal
 * is public either way, as it is on screen.
 *
 * **Who said so.** A record is signed by the agent's key, which the console holds; the owner's
 * word is the wallet's own signature, carried in the document: the `"Lath loop"` message a start,
 * pause, resume or stop was posted with (its `Request ID` line binds the start body's hash), or the
 * deploy transaction the wallet signed. `lath-audit` checks both.
 *
 * Nothing here reaches for a Node built-in, so it ships in the browser entry.
 */
import { LathClient } from "./client";
import { EventKind } from "./events";
import { Bytes32, canonicalJson, hex, utf8 } from "./hash";
import { EventRecord } from "./layout";
import { subHashes } from "./audit/core";
import { LOOP_STEP_TOOL, LoopStepStatus } from "./loops";
import { TraceStore } from "./trace-store";

/** An agent was deployed: who owns it, what it was deployed with. Written once, after `register_agent`. */
export const AGENT_DEPLOY_TOOL = "agent.deploy";
/** The owner archived the agent: lists leave it out. */
export const AGENT_ARCHIVE_TOOL = "agent.archive";
/** The owner brought an archived agent back. */
export const AGENT_UNARCHIVE_TOOL = "agent.unarchive";
/** A loop was started on this agent, before its first step. */
export const LOOP_START_TOOL = "loop.start";
/** The owner paused a loop. */
export const LOOP_PAUSE_TOOL = "loop.pause";
/** A paused or stopped loop runs again. */
export const LOOP_RESUME_TOOL = "loop.resume";
/** A loop stopped, for the reason the document gives. */
export const LOOP_STOP_TOOL = "loop.stop";

export const AGENT_LIFECYCLE_TOOLS = [AGENT_DEPLOY_TOOL, AGENT_ARCHIVE_TOOL, AGENT_UNARCHIVE_TOOL] as const;
export const LOOP_LIFECYCLE_TOOLS = [LOOP_START_TOOL, LOOP_PAUSE_TOOL, LOOP_RESUME_TOOL, LOOP_STOP_TOOL] as const;
export const LIFECYCLE_TOOLS = [...AGENT_LIFECYCLE_TOOLS, ...LOOP_LIFECYCLE_TOOLS] as const;
export type LifecycleTool = (typeof LIFECYCLE_TOOLS)[number];

/** `status` on every lifecycle record. The document says what happened; the code says it was recorded. */
export const LIFECYCLE_STATUS = 200;

/** Every document carries `v`, so a later shape is read as a later shape rather than misread as this one. */
export const LIFECYCLE_VERSION = 1 as const;

/**
 * A wallet's signed console message, as the console received and checked it: the SIWS text
 * (`authMessage` in `signer.ts`) and the base64 of its 64-byte Ed25519 signature.
 */
export interface SignedMessage {
  message: string;
  signature: string;
}

/** Who caused a transition: the owner's wallet (with its `auth`), or the console on its own (a budget, a goal, a failure). */
export type LifecycleActor = "owner" | "console";

/** `args` of `agent.deploy`. */
export interface AgentDeployDoc {
  v: typeof LIFECYCLE_VERSION;
  /** Lowercase hex, `sha256(name)`. */
  agentId: string;
  name: string;
  /** Base58 wallet that deployed the agent and holds its allowance. */
  owner: string;
  /** Base58 key that signed `register_agent`, and so signs every record on this chain. */
  authority: string;
  /** Unix ms. */
  createdAt: number;
  /** The deploy transaction the owner's wallet signed: `register_agent` beside its `approve_agent`. */
  deployTx?: string;
  /** What the agent was deployed with: model, tools, budget cap, expiry, payment. */
  policy: Record<string, unknown>;
  description?: string;
  template?: { id: string; version: number; hash: string };
  clonedFrom?: string;
  /**
   * Hex sha256 of the `AgentPrivateDoc` plaintext an older record stored encrypted under the
   * agent's trace key. Read for the audit only; this build writes none.
   */
  privateHash?: string;
}

/**
 * The owner-only half of a deploy, as a chain written encrypted holds it under the agent's trace
 * key. Read for the audit only; this build writes none.
 */
export interface AgentPrivateDoc {
  v: typeof LIFECYCLE_VERSION;
  agentId: string;
  prompt?: string;
}

/** `args` of `agent.archive` and `agent.unarchive`. */
export interface AgentMarkDoc {
  v: typeof LIFECYCLE_VERSION;
  agentId: string;
  /** Unix ms. */
  at: number;
  by: LifecycleActor;
  auth?: SignedMessage;
}

/** `args` of `loop.start`. */
export interface LoopStartDoc {
  v: typeof LIFECYCLE_VERSION;
  loopId: string;
  /** Lowercase hex. */
  agentId: string;
  /** Base58 wallet that started the loop. Every step's genesis names it as caller. */
  owner: string;
  /** Unix ms; the `startedAt` every step's manifest carries. */
  createdAt: number;
  intervalMs: number;
  maxSteps: number;
  /** The loop's one budget, µUSDC, as a decimal string. */
  budgetMicroUsdc: string;
  /** Hex sha256 of the standing prompt, as in every step's manifest. */
  promptHash: string;
  goal?: string;
  /** Hex sha256 of the trimmed goal, as in every step's manifest. */
  goalHash?: string;
  /** Hex sha256 of the start body's canonical JSON: the `Request ID` the owner's wallet signed. */
  startBodyHash?: string;
  /** The `"Lath loop"` message the start was posted with. */
  auth?: SignedMessage;
  /** For a loop started with its agent's deploy: the deploy transaction the wallet signed instead. */
  deployTx?: string;
  /**
   * Hex sha256 of the `LoopPrivateDoc` plaintext an older record stored encrypted under the
   * agent's trace key. Read for the audit only; this build writes none.
   */
  privateHash?: string;
  /**
   * The rest of the start's fixed terms, public: what a console needs to rebuild the row. Never a
   * secret, never the prompt.
   */
  terms: Record<string, unknown>;
}

/**
 * The owner-only half of a start, as a chain written encrypted holds it under the agent's trace
 * key. Read for the audit only; this build writes none.
 */
export interface LoopPrivateDoc {
  v: typeof LIFECYCLE_VERSION;
  loopId: string;
  prompt: string;
  /** The body the owner signed, less its `auth`: re-hashes to `startBodyHash`. */
  startBody?: unknown;
}

/** `args` of `loop.pause`, `loop.resume` and `loop.stop`. */
export interface LoopTransitionDoc {
  v: typeof LIFECYCLE_VERSION;
  loopId: string;
  /** Unix ms. */
  at: number;
  by: LifecycleActor;
  auth?: SignedMessage;
  /** A stop's reason, as the console names it (`goal-reached`, `max-steps`, `budget`, `stopped`, …); a resume's `retry`. */
  reason?: string;
  detail?: string;
  /** At a stop: the steps the loop recorded, and the seq of its last `loop.step`. */
  steps?: number;
  lastStepSeq?: string;
}

/** A loop's status as its lifecycle records leave it. */
export type LoopStatusOnChain = "running" | "paused" | "stopped";

/** `result` of every lifecycle record: the state the record leaves its subject in. */
export interface LifecycleResultDoc {
  v: typeof LIFECYCLE_VERSION;
  /** The loop id, or the agent id. */
  id: string;
  status: LoopStatusOnChain | "deployed" | "archived";
  reason?: string;
}

/** The bytes a document is committed as: canonical JSON, so any writer produces the same hash. */
export function lifecycleBytes(doc: object): Uint8Array {
  return utf8(canonicalJson(doc));
}

/** The `result` document a transition writes. */
export function lifecycleResult(id: string, status: LifecycleResultDoc["status"], reason?: string): LifecycleResultDoc {
  return { v: LIFECYCLE_VERSION, id, status, ...(reason ? { reason } : {}) };
}

/** What a writer hands its logger: one `Action` with both documents as canonical JSON. */
export interface LifecycleWrite {
  tool: LifecycleTool;
  args: object;
  result: LifecycleResultDoc;
}

/**
 * The `AgentLogger.action` input for a lifecycle record. Taken as a function rather than a write
 * here, because where the write happens is the caller's: under the run slot, after the agent's
 * journal has drained, with a store that anchors each blob (see the module comment).
 */
export function lifecycleAction(w: LifecycleWrite): {
  toolId: string;
  args: Uint8Array;
  result: Uint8Array;
  statusCode: number;
} {
  return {
    toolId: w.tool,
    args: lifecycleBytes(w.args),
    result: lifecycleBytes(w.result),
    statusCode: LIFECYCLE_STATUS,
  };
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isAuth = (v: unknown): boolean =>
  v === undefined || (!!v && typeof v === "object" && isStr((v as any).message) && isStr((v as any).signature));

/** `args` of a `loop.start`, or `null` when the bytes are not one this version reads. */
export function parseLoopStartDoc(bytes: Uint8Array | null): LoopStartDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION) return null;
  if (!isStr(o.loopId) || !isStr(o.agentId) || !isStr(o.owner) || !isNum(o.createdAt)) return null;
  if (!isNum(o.intervalMs) || !isNum(o.maxSteps) || !isStr(o.budgetMicroUsdc) || !isStr(o.promptHash)) return null;
  if (!o.terms || typeof o.terms !== "object" || Array.isArray(o.terms) || !isAuth(o.auth)) return null;
  return o as unknown as LoopStartDoc;
}

/** `args` of a `loop.pause`, `loop.resume` or `loop.stop`, or `null`. */
export function parseLoopTransitionDoc(bytes: Uint8Array | null): LoopTransitionDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION) return null;
  if (!isStr(o.loopId) || !isNum(o.at) || (o.by !== "owner" && o.by !== "console") || !isAuth(o.auth)) return null;
  return o as unknown as LoopTransitionDoc;
}

/** `args` of an `agent.deploy`, or `null`. */
export function parseAgentDeployDoc(bytes: Uint8Array | null): AgentDeployDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION) return null;
  if (!isStr(o.agentId) || !isStr(o.name) || !isStr(o.owner) || !isStr(o.authority) || !isNum(o.createdAt)) return null;
  if (!o.policy || typeof o.policy !== "object" || Array.isArray(o.policy)) return null;
  return o as unknown as AgentDeployDoc;
}

/** `args` of an `agent.archive` or `agent.unarchive`, or `null`. */
export function parseAgentMarkDoc(bytes: Uint8Array | null): AgentMarkDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION) return null;
  if (!isStr(o.agentId) || !isNum(o.at) || (o.by !== "owner" && o.by !== "console") || !isAuth(o.auth)) return null;
  return o as unknown as AgentMarkDoc;
}

/** An older record's private document, decrypted by a store holding the trace key, or `null`. */
export function parseLoopPrivateDoc(bytes: Uint8Array | null): LoopPrivateDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION || !isStr(o.loopId) || !isStr(o.prompt)) return null;
  return o as unknown as LoopPrivateDoc;
}

export function parseAgentPrivateDoc(bytes: Uint8Array | null): AgentPrivateDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION || !isStr(o.agentId)) return null;
  if (o.prompt !== undefined && !isStr(o.prompt)) return null;
  return o as unknown as AgentPrivateDoc;
}

export function parseLifecycleResult(bytes: Uint8Array | null): LifecycleResultDoc | null {
  const o = parseObject(bytes);
  if (!o || o.v !== LIFECYCLE_VERSION || !isStr(o.id) || !isStr(o.status)) return null;
  return o as unknown as LifecycleResultDoc;
}

/**
 * The fields of a console's signed message (`authMessage` in `signer.ts`), or `null` when the text
 * is not in that shape. Reading only: whether the signature covers it is the verifier's question.
 */
export function parseSignedMessage(message: string): {
  domain: string;
  wallet: string;
  purpose: string;
  action: string;
  target: string;
  field: (name: string) => string | undefined;
} | null {
  const suffix = " wants you to sign in with your Solana account:";
  const lines = message.split("\n");
  if (lines.length < 10 || !lines[0].endsWith(suffix)) return null;
  const statement = /^(.+?): (\S+) (\S+)$/.exec(lines[3] ?? "");
  if (!statement) return null;
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  return {
    domain: lines[0].slice(0, -suffix.length),
    wallet: lines[1],
    purpose: statement[1],
    action: statement[2],
    target: statement[3],
    field,
  };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/** One lifecycle record as read back, with its documents when the store has them. */
export interface LifecycleEntry {
  tool: string;
  record: EventRecord;
  seq: bigint;
  /** Client-attested unix ms, from the record. */
  timestamp: bigint;
  statusCode: number;
  /** Hex, read from the payload preimage; `null` when the preimage is not retrievable here. */
  argsHash: string | null;
  resultHash: string | null;
  /** The raw `args` document bytes, or `null` when the store does not have them. */
  argsBytes: Uint8Array | null;
  result: LifecycleResultDoc | null;
}

/**
 * Every lifecycle record on an agent's chain, ascending by seq — plus its `loop.step` and
 * `loop.settlement` records when `tools` asks for them — each with its documents fetched through
 * `store` (the agent's locator registry over Irys, for a reader with nothing else).
 *
 * One `listByTool` per tool, then two or three store reads per record. A record whose preimage or
 * documents the store cannot produce is still returned, with `null`s: a reader shows *recorded,
 * unreadable here* rather than dropping it.
 */
export async function readLifecycle(
  client: LathClient,
  store: TraceStore | null,
  agentId: Bytes32,
  tools: readonly string[] = LIFECYCLE_TOOLS
): Promise<LifecycleEntry[]> {
  const lists = await Promise.all(
    tools.map(async (tool) => ({ tool, records: await client.listByTool(agentId, tool) }))
  );
  const out: LifecycleEntry[] = [];
  for (const { tool, records } of lists) {
    for (const record of records) {
      out.push(await readEntry(tool, record, store));
    }
  }
  return out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

async function readEntry(tool: string, record: EventRecord, store: TraceStore | null): Promise<LifecycleEntry> {
  const entry: LifecycleEntry = {
    tool,
    record,
    seq: record.seq,
    timestamp: record.timestamp,
    statusCode: record.status,
    argsHash: null,
    resultHash: null,
    argsBytes: null,
    result: null,
  };
  if (!store) return entry;
  const preimage = await store.get(record.payloadHash).catch(() => null);
  if (!preimage || preimage[0] !== EventKind.Action) return entry;
  const [args, result] = subHashes(EventKind.Action, preimage.slice(1));
  if (!args || !result) return entry;
  entry.argsHash = hex(args);
  entry.resultHash = hex(result);
  entry.argsBytes = await store.get(args).catch(() => null);
  entry.result = parseLifecycleResult(await store.get(result).catch(() => null));
  return entry;
}

// ─── Folding ──────────────────────────────────────────────────────────────────

/** A loop as its agent's chain records it. */
export interface LoopOnChain {
  loopId: string;
  agentId: string;
  start: { entry: LifecycleEntry; doc: LoopStartDoc };
  /** The status the last transition leaves: `running` after the start alone. */
  status: LoopStatusOnChain;
  stopReason?: string;
  stopDetail?: string;
  /** The pause, resume and stop records, ascending by seq. */
  transitions: { entry: LifecycleEntry; doc: LoopTransitionDoc }[];
  /**
   * Steps recorded: the stop record's count when there is one, else the `loop.step` records
   * between the start and now — `null` when another loop on the same agent ran in the same span,
   * so the seq window cannot say whose steps they are.
   */
  steps: number | null;
  /** A `loop.step` in the loop's window says `GOAL REACHED` (201), or its stop names `goal-reached`. */
  goalReached: boolean;
  /** Lifecycle records of this loop that land out of order (a transition before its start, anything after a stop but a resume). */
  outOfOrder: number;
}

/** An agent as its chain records it. */
export interface AgentOnChain {
  agentId: string;
  deploy: { entry: LifecycleEntry; doc: AgentDeployDoc } | null;
  archived: boolean;
  marks: { entry: LifecycleEntry; doc: AgentMarkDoc }[];
}

/**
 * Loops from an agent's lifecycle records, oldest start first. `steps` are the agent's `loop.step`
 * records (`listByTool(agentId, "loop.step")`), used for the seq windows.
 *
 * A start whose document is not readable here is not a loop this can key, and is counted by
 * `unkeyedStarts` instead; a transition naming a loop with no readable start is ignored.
 */
export function foldLoops(
  agentId: string,
  entries: LifecycleEntry[],
  steps: { seq: bigint; statusCode: number }[] = []
): LoopOnChain[] {
  const starts: { entry: LifecycleEntry; doc: LoopStartDoc }[] = [];
  const transitions = new Map<string, { entry: LifecycleEntry; doc: LoopTransitionDoc }[]>();
  for (const entry of entries) {
    if (entry.tool === LOOP_START_TOOL) {
      const doc = parseLoopStartDoc(entry.argsBytes);
      if (doc) starts.push({ entry, doc });
    } else if (entry.tool === LOOP_PAUSE_TOOL || entry.tool === LOOP_RESUME_TOOL || entry.tool === LOOP_STOP_TOOL) {
      const doc = parseLoopTransitionDoc(entry.argsBytes);
      if (!doc) continue;
      const list = transitions.get(doc.loopId) ?? [];
      list.push({ entry, doc });
      transitions.set(doc.loopId, list);
    }
  }
  starts.sort((a, b) => (a.entry.seq < b.entry.seq ? -1 : 1));

  const loops = starts.map(({ entry, doc }) => {
    const mine = (transitions.get(doc.loopId) ?? []).sort((a, b) => (a.entry.seq < b.entry.seq ? -1 : 1));
    let status: LoopStatusOnChain = "running";
    let stopReason: string | undefined;
    let stopDetail: string | undefined;
    let outOfOrder = 0;
    let lastStop: { entry: LifecycleEntry; doc: LoopTransitionDoc } | undefined;
    for (const t of mine) {
      if (t.entry.seq < entry.seq) {
        outOfOrder++;
        continue;
      }
      if (t.entry.tool === LOOP_PAUSE_TOOL) {
        if (status !== "running") outOfOrder++;
        status = "paused";
      } else if (t.entry.tool === LOOP_RESUME_TOOL) {
        status = "running";
        stopReason = undefined;
        stopDetail = undefined;
      } else {
        status = "stopped";
        stopReason = t.doc.reason;
        stopDetail = t.doc.detail;
        lastStop = t;
      }
    }
    return { entry, doc, transitions: mine, status, stopReason, stopDetail, outOfOrder, lastStop };
  });

  // Seq windows: from a loop's start to its last stop (or the tip, while it runs). Another loop
  // whose window meets this one's leaves the steps in it unattributable.
  const end = (l: (typeof loops)[number]) => (l.status === "stopped" && l.lastStop ? l.lastStop.entry.seq : null);
  return loops.map((l) => {
    const lo = l.entry.seq;
    const hi = end(l);
    const overlaps = loops.some((o) => {
      if (o === l) return false;
      const oHi = end(o);
      return o.entry.seq < (hi ?? BigInt(Number.MAX_SAFE_INTEGER)) && (oHi === null || oHi > lo);
    });
    const inWindow = steps.filter((s) => s.seq > lo && (hi === null || s.seq < hi));
    const counted = l.lastStop?.doc.steps;
    const stepCount = l.status === "stopped" && counted !== undefined ? counted : overlaps ? null : inWindow.length;
    const goalReached =
      l.stopReason === "goal-reached" ||
      (!overlaps && inWindow.some((s) => s.statusCode === LoopStepStatus.GoalReached));
    return {
      loopId: l.doc.loopId,
      agentId,
      start: { entry: l.entry, doc: l.doc },
      status: l.status,
      ...(l.stopReason ? { stopReason: l.stopReason } : {}),
      ...(l.stopDetail ? { stopDetail: l.stopDetail } : {}),
      transitions: l.transitions,
      steps: stepCount,
      goalReached,
      outOfOrder: l.outOfOrder,
    };
  });
}

/** Starts whose document this reader could not open: recorded loops it cannot name. */
export function unkeyedStarts(entries: LifecycleEntry[]): LifecycleEntry[] {
  return entries.filter((e) => e.tool === LOOP_START_TOOL && !parseLoopStartDoc(e.argsBytes));
}

/** The agent's deploy and archive marks. The first readable `agent.deploy` is the deploy; a later one is ignored. */
export function foldAgent(agentId: string, entries: LifecycleEntry[]): AgentOnChain {
  let deploy: AgentOnChain["deploy"] = null;
  const marks: AgentOnChain["marks"] = [];
  for (const entry of entries) {
    if (entry.tool === AGENT_DEPLOY_TOOL && !deploy) {
      const doc = parseAgentDeployDoc(entry.argsBytes);
      if (doc) deploy = { entry, doc };
    } else if (entry.tool === AGENT_ARCHIVE_TOOL || entry.tool === AGENT_UNARCHIVE_TOOL) {
      const doc = parseAgentMarkDoc(entry.argsBytes);
      if (doc) marks.push({ entry, doc });
    }
  }
  const last = marks[marks.length - 1];
  return { agentId, deploy, archived: last?.entry.tool === AGENT_ARCHIVE_TOOL, marks };
}

/**
 * An agent's lifecycle, read and folded: its deploy, its loops with their status, and the starts
 * this reader could not open. Lifecycle records plus `loop.step` (for the windows); the settlement
 * is left out, since its documents go through the agent's trace store (encrypted, on chains written
 * encrypted) rather than the lifecycle's public path.
 */
export async function readAgentLifecycle(
  client: LathClient,
  store: TraceStore | null,
  agentId: Bytes32
): Promise<{ agent: AgentOnChain; loops: LoopOnChain[]; unkeyed: number; entries: LifecycleEntry[] }> {
  const [entries, steps] = await Promise.all([
    readLifecycle(client, store, agentId),
    client.listByTool(agentId, LOOP_STEP_TOOL),
  ]);
  const id = hex(agentId);
  return {
    agent: foldAgent(id, entries),
    loops: foldLoops(
      id,
      entries,
      steps.map((s) => ({ seq: s.seq, statusCode: s.status }))
    ),
    unkeyed: unkeyedStarts(entries).length,
    entries,
  };
}
