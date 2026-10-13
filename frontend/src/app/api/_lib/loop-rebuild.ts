/**
 * The console's lists rebuilt from the agents' lifecycle records on chain, for a console whose
 * `loops.json` and `agents.json` are gone (`_lib/loops.ts` re-exports it).
 */
import * as fs from "fs";
import type { Keypair } from "@solana/web3.js";
import {
  type AgentDeployDoc,
  type LoopOnChain,
  readAgentLifecycle,
  LathClient,
  hex,
  idFromString,
  toBytes32,
  type TraceStore,
} from "@lath/sdk";
import type { LoopSnapshot } from "@lath/runtime";
import type { LifecycleRef } from "../../../types/loop";
import type { TemplateLink } from "./templates";
import { type DeployedAgent, RPC_URL, deployedRoles, loadKeypair, lookupAgent, recordAgent, rpcFor } from "./runner";
import { chainReaderStore, deployCandidates, lifecycleOn, readDeploy } from "./lifecycle";
import { errorText, goalHashOf } from "./loop-terms";
import type { LoopRecord } from "./loop-record";
import { scheduler } from "./loop-state";
import { readLoop, recordLoop, REGISTRY } from "./loop-registry";

// ─── The rebuild from the chain ─────────────────────────────────────────────

/** What a rebuild reads through; the chain and this console's stores by default, a suite's fakes otherwise. */
export interface RebuildDeps {
  server?: Keypair;
  client?: LathClient;
  /** The agent's public documents, as a reader with the chain and a gateway reads them. */
  reader?: (agentId: string) => TraceStore;
}

/** How many agents a rebuild reads at once: each is a handful of RPC reads and gateway fetches. */
const REBUILD_CONCURRENCY = 5;

/** How often a process may rebuild again when an empty registry asks it to. */
const REBUILD_EVERY_MS = 10 * 60_000;

/**
 * The console's lists from the chain and Irys alone (`sdk/src/lifecycle.ts`): every `agent.deploy`
 * program-wide, kept when this console's derivation for its name is the authority the chain names,
 * then each such agent's lifecycle folded into loop rows. Only rows this console has no copy of are
 * added — never a row it already holds, whose own account is the one that ran — and every loop row
 * added is `rebuilt`: read-only here, never scheduled.
 *
 * Bounded (`REBUILD_CONCURRENCY`) and failure-tolerant: an agent that cannot be read is logged and
 * skipped, and nothing here ever fails a request.
 */
export async function rebuildFromChain(deps: RebuildDeps = {}): Promise<{ agents: number; loops: number }> {
  const out = { agents: 0, loops: 0 };
  if (!lifecycleOn()) return out;
  const server = deps.server ?? loadKeypair();
  if (!server || (!deps.client && !RPC_URL)) return out;
  // Reads only: the server's own key signs nothing here.
  const client = deps.client ?? LathClient.fromIdl(rpcFor(), server);
  // An agent this console still has a row for, beside a `loops.json` it still has, is one whose lists
  // are intact: its own rows are the account that ran, and reading its whole lifecycle again on every
  // console start would be a handful of RPC reads per agent for nothing. Only a lost file is rebuilt.
  const loopsKept = fs.existsSync(REGISTRY());
  const candidates = (await deployCandidates(client)).filter((id) => !(loopsKept && lookupAgent(id)));
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const agentId = candidates[next++];
      try {
        const added = await rebuildAgent(agentId, client, server, deps);
        out.agents += added.agent;
        out.loops += added.loops;
      } catch (e) {
        console.warn(`[loops] the rebuild skipped agent ${agentId}: ${errorText(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REBUILD_CONCURRENCY, candidates.length) }, worker));
  return out;
}

async function rebuildAgent(
  agentId: string,
  client: LathClient,
  server: Keypair,
  deps: RebuildDeps
): Promise<{ agent: number; loops: number }> {
  const idBytes = toBytes32(agentId);
  const reader = deps.reader?.(agentId) ?? chainReaderStore(client, idBytes);
  const deploy = await readDeploy(client, reader, idBytes);
  const doc = deploy?.doc as Partial<AgentDeployDoc> | undefined;
  if (!deploy || !doc || typeof doc.name !== "string" || typeof doc.authority !== "string")
    return { agent: 0, loops: 0 };
  // This console's agent, and no one else's: the name derives the id, this server's derivation for
  // the name is the authority the document names, and the chain's header names that same key — a
  // document anyone could write on a chain of their own claims nothing the header does not back.
  if (hex(idFromString(doc.name)) !== agentId || doc.agentId !== agentId) return { agent: 0, loops: 0 };
  const mine = deployedRoles(server, doc.name).agent.key.publicKey.toBase58();
  if (doc.authority !== mine) return { agent: 0, loops: 0 };
  const header = await client.getAgentState(idBytes);
  if (!header || header.state.authority.toBase58() !== mine) return { agent: 0, loops: 0 };

  const read = await readAgentLifecycle(client, reader, idBytes);
  const ref = (e: { tool: string; seq: bigint; timestamp: bigint }): LifecycleRef => ({
    tool: e.tool,
    seq: e.seq.toString(),
    at: Number(e.timestamp),
  });
  let agent = 0;
  if (!lookupAgent(agentId)) {
    const lastMark = read.agent.marks[read.agent.marks.length - 1];
    recordAgent(agentId, {
      name: doc.name,
      authority: doc.authority,
      ...(typeof doc.owner === "string" && doc.owner ? { owner: doc.owner } : {}),
      createdAt: typeof doc.createdAt === "number" ? doc.createdAt : Number(deploy.ref.at),
      policy: (doc.policy ?? {}) as unknown as DeployedAgent["policy"],
      ...(typeof doc.description === "string" ? { description: doc.description } : {}),
      ...(doc.template ? { template: doc.template as TemplateLink } : {}),
      ...(typeof doc.clonedFrom === "string" ? { clonedFrom: { agentId: doc.clonedFrom, name: doc.clonedFrom } } : {}),
      ...(read.agent.archived && lastMark ? { archivedAt: lastMark.doc.at } : {}),
      lifecycle: {
        records: [deploy.ref, ...read.agent.marks.map((m) => ref(m.entry))],
        owed: [],
        rebuilt: true,
      },
    });
    agent = 1;
  }

  let loops = 0;
  for (const l of read.loops) {
    if (readLoop(l.loopId)) continue;
    const d = l.start.doc;
    // The prompt is on chain only as its hash; a loop whose instruction is its goal (every loop the
    // form starts) has it back from the goal, whose hash is the same text's.
    const prompt = d.goal && d.goalHash === d.promptHash ? d.goal : undefined;
    recordLoop(
      rebuiltLoopRow(agentId, doc.name, l, prompt, [l.start.entry, ...l.transitions.map((t) => t.entry)].map(ref))
    );
    loops++;
  }
  return { agent, loops };
}

/**
 * A loop row from its chain: the start's terms, the fold's status, the prompt when the caller has it
 * (`""` when not). Left off on purpose: the access keys, the grants and
 * the receipt pointer, which drive revokes, sweeps and publishes that are the starting console's to
 * make — a rebuilt row is something to read, not something to settle.
 */
export function rebuiltLoopRow(
  agentId: string,
  name: string,
  l: LoopOnChain,
  prompt: string | undefined,
  records: LifecycleRef[]
): LoopRecord {
  const d = l.start.doc;
  const t = d.terms as Record<string, any>;
  const maxSteps = Math.max(1, Math.floor(d.maxSteps));
  const budget = /^\d+$/.test(d.budgetMicroUsdc) ? BigInt(d.budgetMicroUsdc) : 0n;
  return {
    id: d.loopId,
    agentId,
    agentName: name,
    owner: d.owner,
    prompt: prompt ?? "",
    promptHash: d.promptHash,
    intervalMs: d.intervalMs,
    maxSteps,
    budgetMicroUsdc: budget.toString(),
    budgetMicroUsdcPerStep: (budget / BigInt(maxSteps)).toString(),
    ...(typeof t.jevBudgetBase === "string" ? { jevBudgetBase: t.jevBudgetBase } : {}),
    jevSpentBase: "0",
    model: typeof t.model === "string" ? t.model : "",
    ...(typeof t.fallbackModel === "string" ? { fallbackModel: t.fallbackModel } : {}),
    createdAt: d.createdAt,
    ...(t.trigger ? { trigger: t.trigger } : {}),
    ...(t.verify ? { verify: t.verify } : {}),
    ...(d.goal ? { goal: d.goal, goalHash: d.goalHash ?? goalHashOf(d.goal) } : {}),
    ...(t.goalCheck ? { goalCheck: t.goalCheck } : {}),
    ...(t.traceAudit ? { traceAudit: t.traceAudit } : {}),
    ...(t.workers ? { workers: t.workers } : {}),
    ...(t.gate ? { gate: t.gate } : {}),
    ...(t.sandbox?.config ? { sandbox: t.sandbox } : {}),
    ...(t.template ? { template: t.template } : {}),
    status: l.status,
    ...(l.stopReason ? { stopReason: l.stopReason } : {}),
    ...(l.stopDetail ? { stopDetail: l.stopDetail } : {}),
    snapshot: {
      loopId: d.loopId,
      steps: l.steps ?? 0,
      status: "idle",
      totalCostMicroUsdc: "0",
      spentMicroUsdc: "0",
      consecutiveFailures: 0,
    } as LoopSnapshot,
    history: [],
    lifecycle: { records, owed: [], rebuilt: true },
  };
}

/** One rebuild per process at a time, and at most every `REBUILD_EVERY_MS`; logged, never thrown. */
export function rebuildFromChainOnce(): Promise<void> {
  const s = scheduler();
  if (!lifecycleOn()) return Promise.resolve();
  if (s.rebuild && Date.now() - s.rebuild.at < REBUILD_EVERY_MS) return s.rebuild.run;
  const run = rebuildFromChain()
    .then((added) => {
      if (added.agents || added.loops) {
        console.log(`[loops] rebuilt ${added.agents} agent(s) and ${added.loops} loop(s) from the chain`);
      }
    })
    .catch((e) => console.error(`[loops] the rebuild from the chain failed: ${errorText(e)}`));
  s.rebuild = { at: Date.now(), run };
  return run;
}

/**
 * The rebuild, waited for up to `waitMs`: what `GET /api/agents` asks when it finds an empty registry,
 * so a fresh console's first list can already carry what the chain holds. A rebuild still running
 * after that keeps running; the next request reads what it added.
 */
export async function rebuildListsFromChain(waitMs = 8_000): Promise<void> {
  await Promise.race([
    rebuildFromChainOnce(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]);
}
