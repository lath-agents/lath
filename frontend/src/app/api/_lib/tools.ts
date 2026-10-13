/**
 * Every tool name the console runtime can hand a model, the tools themselves, and the scripted
 * transport that stands in for one when there is no model key.
 *
 * The deploy route validates a policy's allow-list against `TOOL_NAMES`, and the session route
 * filters by it, so the two cannot drift.
 */
import { Rpc } from "@lightprotocol/stateless.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  AgentStore,
  Bytes32,
  CellWriteResult,
  FileTraceStore,
  GOAL_ANSWER,
  LathClient,
  StoreWriter,
  goalReachedIn,
  hex,
} from "@lath/sdk";
import { ChatRequest, ChatResult, ChatTransport, DecideRequest, DecideResult, ToolDefinition } from "@lath/runtime";
import { anchorQueue } from "./anchor";
import { CLUSTER, TRACE_DIR } from "./runner";
import { WEB_TOOL_NAMES, webTools } from "./web-tools";

export const CHAIN_TOOL_NAMES = ["solana.slot", "solana.fees", "solana.balance", "lath.verify_chain"];
/**
 * Names that are accepted but do nothing.
 *
 * `hire` paid another agent for a sub-task, a path this build does not have. The name stays valid
 * here because older policies carry it — on deployed agents, in stored templates, and in the `toolAllowList` their
 * `policy_version_hash` commits to — so refusing it would make an existing agent uncopyable and
 * move a hash already on chain. Nothing offers it to a model but the runtime's retired entry,
 * which answers that it is gone.
 */
export const RETIRED_TOOL_NAMES = ["hire"];

/**
 * Older spellings of a tool's name, still dispatched under the name a stored policy carries.
 *
 * `lattice.verify_chain` is the older spelling of `lath.verify_chain`. An agent deployed with it has
 * that spelling in the `toolAllowList` its `policy_version_hash` commits to, and that hash is in an
 * `Allowance` on chain that `charge` re-checks — so the older name cannot be rewritten on the way in
 * without moving a hash the chain already holds. It is aliased instead: same implementation, older
 * name, offered only to a policy that actually asks for it (see `picked` in
 * `/api/run` and the loop scheduler, which drops aliases when a policy names no tools at all).
 */
export const LEGACY_TOOL_NAMES = ["lattice.verify_chain"];

/**
 * The agent's own key-value store (`sdk/src/store.ts`): `store.get` reads it, `store.set` writes
 * it. Two names rather than one so a policy can grant read without write.
 */
export const STORE_TOOL_NAMES = ["store.get", "store.set"];

/**
 * Offered only to a policy that names them. A policy that names no tools gets every tool, and its
 * `policy_version_hash` commits to that list — so a tool added to the default would move the hash
 * of every such agent already deployed, and `charge` re-checks that hash against the `Allowance`
 * on chain. The older spellings are opt-in for the reason in `LEGACY_TOOL_NAMES`.
 */
export const OPT_IN_TOOL_NAMES = [...LEGACY_TOOL_NAMES, ...STORE_TOOL_NAMES];

export const TOOL_NAMES = [
  ...CHAIN_TOOL_NAMES,
  ...LEGACY_TOOL_NAMES,
  ...WEB_TOOL_NAMES,
  ...STORE_TOOL_NAMES,
  ...RETIRED_TOOL_NAMES,
];

/**
 * What a new policy is offered, and what a refusal lists as shipped.
 *
 * `TOOL_NAMES` is what is *accepted*, and it has to keep the retired `hire` and the older spelling
 * `lattice.verify_chain`: stored policies name them and their `policy_version_hash` commits to the
 * names, so clones, `useVersion` and older templates must keep validating. But an unknown-tool refusal
 * that printed `TOOL_NAMES` as "the runtime ships …" would put a retired tool and an older alias on
 * screen as things a person could pick — and `hire` is a word nothing may say on screen.
 * Acceptance stays on `TOOL_NAMES`; only the sentence reads this.
 */
export const OFFERED_TOOL_NAMES = [...CHAIN_TOOL_NAMES, ...WEB_TOOL_NAMES, ...STORE_TOOL_NAMES];

/**
 * A Solana address as `solana.balance` takes it: base58, 32–44 characters (a 32-byte key spelled in
 * base58). Checked before `new PublicKey`, which hands anything else to `new BN` — and `new BN` given
 * `{"length": 3e9}` zero-fills a billion words and aborts the process. `callTool` refuses a
 * non-string first; this is the backstop for a caller that does not go through it.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** An agent id as `lath.verify_chain` takes it: 32 bytes in hex. Checked before `Buffer.from`. */
const AGENT_ID_HEX = /^[0-9a-f]{64}$/i;

// ─── The tools themselves, and the transport that stands in for a model ─────

/**
 * The longest one read tool may keep a session waiting before the session is handed an error instead.
 * `AgentRuntime.callTool` awaits `execute` with no limit, and `/api/run` holds the console's one run
 * slot until the session *exits* — its heartbeat comment rests on "every submit is bounded" — so a tool
 * that never settles would hold every other session and every loop step out for as long as it hangs.
 * The web tools have their own deadline (`FETCH_DEADLINE_MS`, well inside this); this is for whatever
 * else a read waits on. Two minutes, because a replay of a long chain over a slow indexer is a read
 * that legitimately takes a while.
 */
export const TOOL_DEADLINE_MS = 120_000;

/**
 * `tool`, with its `execute` raced against `ms` of wall clock: past it the call throws, `callTool`
 * records the throw as a 500 Action like any other failure, and the session goes on.
 *
 * The work itself is not cancelled — nothing here can reach into an RPC read — it is only no longer
 * waited for, and its late answer or error lands on a promise nobody reads (the race holds it, so a
 * late rejection is not an unhandled one). That is why only *reads* are wrapped: `store.set` is a
 * chain write, and answering "failed" while the write may still land would commit a record that
 * says the opposite of what the chain then holds, and invite the model to write it twice.
 */
export function boundedTool(tool: ToolDefinition, ms = TOOL_DEADLINE_MS): ToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${tool.name} did not answer in ${Math.round(ms / 1000)} s and was given up on`)),
          ms
        );
      });
      try {
        return await Promise.race([tool.execute(args, ctx), late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The chain reads every agent gets, plus the web tools.
 *
 * One builder for both callers, `/api/run` and the loop scheduler, so the two cannot drift apart. It
 * is a library rather than part of the route, because a route module is not a library and a step that
 * reached into one would drag the session route's module state along with it: both import this, and
 * nothing imports a route.
 *
 * `label` is the noun for the thing being run — a session, or a step — and appears only where a
 * message has to name it. `self` defaults `lath.verify_chain` to the caller's own chain.
 */
export function consoleTools(
  rpc: Rpc,
  client: LathClient,
  self: Bytes32 | undefined,
  label: "session" | "step",
  writeCell?: CellWriter
): ToolDefinition[] {
  // Pulled out of the list so the older-spelling alias below is the same tool, not a copy.
  const verifyChain: ToolDefinition = {
    name: "lath.verify_chain",
    description:
      "Replays a hash chain from the indexer and reports whether it holds, plus any records " +
      "of it still anchoring. Defaults to your own chain; pass agentId to verify another agent's.",
    parameters: { type: "object", properties: { agentId: { type: "string" } } },
    async execute(args: { agentId?: unknown }) {
      // Empty or absent is the caller's own chain; anything else must be an id.
      // `Buffer.from({"length": 2e9}, "hex")` allocates two gigabytes before it reads a byte.
      const given = args?.agentId;
      if (given !== undefined && given !== null && given !== "") {
        if (typeof given !== "string" || !AGENT_ID_HEX.test(given)) {
          throw new Error("agentId must be an agent id: 64 hex characters");
        }
      }
      const id = typeof given === "string" && given ? Uint8Array.from(Buffer.from(given, "hex")) : self;
      if (!id) throw new Error(`this ${label} has no agent of its own; pass agentId`);
      const v = await client.verifyChain(id);
      // `ok` keeps meaning exactly what it has always meant: the *confirmed* chain replays.
      // A record this process has built but not yet landed is not part of that verdict — it is
      // not on chain, so an indexer cannot be asked about it — but a model that answers "your
      // chain is verified to seq 11" while three records of its own session are still in the
      // queue is answering with a number it will contradict a few seconds later. So the
      // journal's view rides along beside the chain's: `pendingSeqs` are the seqs this process
      // owes the chain, and `localHead` is the head they lead to.
      const queue = anchorQueue();
      const tip = await queue.tip(id);
      const owed = [...queue.pending(id), ...queue.failed(id)];
      const pendingSeqs: string[] = [];
      for (const e of owed) {
        // A charge moves no seq; an epoch occupies the range it folds.
        if (e.kind === "event") pendingSeqs.push(e.seq);
        else if (e.kind === "epoch") {
          for (let s = BigInt(e.startSeq); s < BigInt(e.endSeq); s++) pendingSeqs.push(s.toString());
        }
      }
      return {
        agentId: hex(id),
        ok: v.ok,
        seq: v.seq.toString(),
        records: v.records,
        epochs: v.epochs.length,
        head: hex(v.head),
        pendingSeqs,
        localHead: hex(tip.head),
      };
    },
  };

  // Every read is bounded in wall-clock time (`boundedTool`); `storeTools` bounds its read and
  // leaves its write alone, for the reason given there.
  const reads: ToolDefinition[] = [
    {
      name: "solana.slot",
      description: "The cluster's current slot and block time.",
      async execute() {
        const slot = await rpc.getSlot("confirmed");
        const blockTime = await rpc.getBlockTime(slot);
        // The cluster rides along: a slot number alone reads as mainnet to a model.
        return { cluster: CLUSTER, slot, blockTime };
      },
    },
    {
      name: "solana.fees",
      description: "Recent prioritization fees, so a write can be priced.",
      async execute() {
        const fees = await rpc.getRecentPrioritizationFees();
        const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
        return { samples: values.length, medianMicroLamports: values[Math.floor(values.length / 2)] ?? 0 };
      },
    },
    {
      name: "solana.balance",
      description: "Lamports held by an address.",
      parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
      async execute(args: { address?: unknown }) {
        const address = args?.address;
        if (typeof address !== "string" || !BASE58_ADDRESS.test(address)) {
          throw new Error("address must be a base58 Solana address of 32 to 44 characters");
        }
        const lamports = await rpc.getBalance(new PublicKey(address));
        return { address, lamports, sol: lamports / LAMPORTS_PER_SOL };
      },
    },
    verifyChain,
    // Same definition under the pre-rename name; see `LEGACY_TOOL_NAMES`.
    { ...verifyChain, name: "lattice.verify_chain" },
    ...webTools(),
  ];
  return [...reads.map((t) => boundedTool(t)), ...(self ? storeTools(client, self, writeCell) : [])];
}

/**
 * How a tool's cell write reaches the chain. A running session passes `AgentRuntime.writeCell`,
 * which lands the batched epoch and the journal first; with nothing to order against, the write
 * goes straight through.
 */
export type CellWriter = (write: () => Promise<CellWriteResult>) => Promise<CellWriteResult>;

/**
 * `store.get` and `store.set` over the agent's `AgentStore`. Entries go to `TRACE_DIR` in the
 * clear — `/api/traces` serves them and the browser re-hashes them — so a store is public, and the
 * descriptions say so to the model that decides what to put in it.
 */
function storeTools(client: LathClient, self: Bytes32, writeCell: CellWriter = (w) => w()): ToolDefinition[] {
  const store = new AgentStore(client, self, new FileTraceStore(TRACE_DIR));
  return [
    // The read is bounded like every other read (`boundedTool`); `store.set` below is not, because
    // a write reported failed while it may still land is a record that contradicts the chain.
    boundedTool({
      name: "store.get",
      description:
        "Reads your key-value store, which persists across sessions and loop steps and which your owner can " +
        "also write. Pass key to read one value; omit it to list every key.",
      parameters: { type: "object", properties: { key: { type: "string" } } },
      async execute(args: { key?: unknown }) {
        // A key that is not a string is not one the store could hold: refused rather than coerced to
        // "[object Object]" and looked up (the backstop behind `callTool`, as for every tool here).
        if (args?.key !== undefined && args?.key !== null && typeof args.key !== "string") {
          throw new Error("key must be a string");
        }
        if (typeof args?.key === "string" && args.key) {
          const entry = await store.get(args.key);
          if (!entry) return { key: args.key, found: false };
          return { ...describe(entry), key: args.key, found: entry.status === "ok" };
        }
        return { entries: (await store.entries()).map(describe) };
      },
    }),
    {
      name: "store.set",
      description:
        "Writes a value under a key in your store, on chain. Public: anyone can read it. Keys are 1–64 of " +
        "A-Z a-z 0-9 . _ : - ; values are text up to 1024 bytes. Each write costs a chain transaction, so " +
        "write what should outlast this run, not scratch work.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
      },
      async execute(args: { key?: unknown; value?: unknown }) {
        const key = args?.key;
        if (typeof key !== "string") throw new Error("key must be a string");
        // A non-string value is stringified rather than refused here, as it was before `callTool`
        // checked types: the JSON it came from bounds it, and the store's byte cap still applies.
        const value = typeof args.value === "string" ? args.value : JSON.stringify(args.value);
        const written = await writeCell(async () => {
          await store.ensureCreated();
          return store.set(key, value, StoreWriter.Agent);
        });
        return {
          key,
          version: written.cell.indexOrVersion.toString(),
          opSeq: written.cell.opSeq.toString(),
          signature: written.signature,
        };
      },
    },
  ];
}

function describe(e: Awaited<ReturnType<AgentStore["get"]>> & object) {
  return {
    key: e.key,
    value: e.value,
    status: e.status,
    version: e.version.toString(),
    writer: e.writer === StoreWriter.Owner ? "owner" : "agent",
  };
}

/** One turn of a scripted transcript: a set of tool calls, or the closing sentence. */
export interface ScriptTurn {
  calls?: Array<{ name: string; args: unknown }>;
  text?: string;
}

/**
 * The fixed walk a run takes when there is no model key: read the cluster, then say what it did.
 *
 * Only the tools the caller is actually allowed are called — a scripted turn naming a tool the
 * policy refuses would be a 404 the transcript wrote for itself — so the walk is shorter for a
 * narrower policy and the sentence is always last.
 *
 * `lath.verify_chain` is not in this walk. It would only spend visible time on a run with no model
 * behind it, and it reads the anchor queue as well as the indexer: a scripted session replaying its
 * own half-written chain would report the seqs its own genesis is waiting on, which reads as a fault
 * in the chain rather than as the queue doing its work. A real model still has the tool.
 *
 * `agentId` stays in the signature because it is what a turn naming the caller's own chain would
 * pass, and both callers have it to hand.
 */
export function scriptedTurns(names: string[], agentId: string, sentence: string): ScriptTurn[] {
  void agentId;
  const turns: ScriptTurn[] = [];
  const first = ["solana.slot", "solana.fees"].filter((n) => names.includes(n)).map((n) => ({ name: n, args: {} }));
  if (first.length) turns.push({ calls: first });
  turns.push({ text: sentence });
  return turns;
}

/**
 * Replays a scripted transcript as if it were a model. Every turn past the end repeats the last
 * one, which is the closing sentence, so a runtime that asks once more gets an answer rather
 * than a crash.
 *
 * `label` distinguishes one caller's ids from another's in a trace; nothing reads them but the
 * runtime, which only needs a tool call and its reply to agree.
 */
export function scriptedTransport(turns: ScriptTurn[], label: string): ChatTransport {
  let turn = 0;
  let decisions = 0;
  return {
    async chat(req: ChatRequest): Promise<ChatResult> {
      const step = turns[Math.min(turn, turns.length - 1)];
      turn++;
      const message = step.calls
        ? {
            role: "assistant" as const,
            content: null,
            tool_calls: step.calls.map((c, i) => ({
              id: `${label}_${turn}_${i}`,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          }
        : { role: "assistant" as const, content: step.text ?? "" };
      return {
        status: 200,
        body: {
          id: `scripted-${label}-${turn}`,
          model: req.model,
          choices: [{ index: 0, finish_reason: step.calls ? "tool_calls" : "stop", message }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
        },
      };
    },
    /**
     * The verify step on a scripted run: a fixed `accept` at 0.99.
     *
     * A scripted session pays nobody, so there is no channel to ask Jev over and no voucher to
     * commit — hence no `payment`, which is what tells a reader of the blob that this verdict
     * cost nothing and decided nothing about anyone's money. It answers rather than being absent
     * so `--e2e` and CI walk the same code path a paid step walks, and so the step summary can
     * say `verify: scripted` instead of `unavailable`, which would be a claim the verifier was
     * asked and failed.
     */
    async decide(req: DecideRequest): Promise<DecideResult> {
      // Its own counter: `turn` walks the chat transcript, and a decision that advanced it would
      // skip whichever turn the next `chat` was owed.
      decisions++;
      const goal = scriptedGoalAnswer(req);
      // The goal-only request asks nothing else, so it gets nothing else.
      if (goal && Object.keys(req.questions ?? {}).length === 1) {
        return { answers: goal, model: "scripted", id: `scripted-${label}-goal-${decisions}`, payment: undefined };
      }
      return {
        answers: {
          followed_plan: { noul: 0.99, confidence: 0.99 },
          verdict: {
            choice: "accept",
            confidence: 0.99,
            probabilities: { accept: 0.99, retry: 0.005, escalate: 0.005 },
          },
          ...goal,
        },
        model: "scripted",
        id: `scripted-${label}-decide-${decisions}`,
        payment: undefined,
      };
    },
  };
}

/**
 * What a scripted run answers Jev's goal question with, or `undefined` when the request does not ask
 * it. The fixture mirrors the agent's own claim — `achieved` when the step output ends with
 * `GOAL REACHED`, `continue` otherwise — so `--e2e` and CI stop a scripted goal loop where the agent
 * says it is done, through the check's own path. The row
 * says `scripted` beside it, because nobody judged anything.
 */
export function scriptedGoalAnswer(req: DecideRequest): DecideResult["answers"] | undefined {
  if (!(req.questions as Record<string, unknown> | undefined)?.[GOAL_ANSWER]) return undefined;
  const state = String(req.state ?? "");
  const at = state.lastIndexOf("\n\nSTEP OUTPUT: ");
  const claimed = goalReachedIn(at < 0 ? state : state.slice(at + "\n\nSTEP OUTPUT: ".length));
  const choice = claimed ? "achieved" : "continue";
  return {
    [GOAL_ANSWER]: {
      choice,
      confidence: 0.99,
      probabilities: claimed ? { achieved: 0.99, continue: 0.01 } : { achieved: 0.01, continue: 0.99 },
    },
  };
}
