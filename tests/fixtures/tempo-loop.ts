import { PublicKey } from "@solana/web3.js";
import { EpochStore, MemoryTraceStore, hex, idFromString } from "../../sdk/src";
import {
  AgentRuntime,
  AnchorQueue,
  LoopRunner,
  MemoryAnchorJournal,
  type ChatRequest,
  type ChatResult,
  type ChatTransport,
  type LoopEvent,
  type LoopRunnerOptions,
  type LoopTempoServices,
  type StorageReportFile,
} from "../../runtime/src";
import { FakeChain, RecordingBilling } from "./fake-chain";

/**
 * A loop over the anchor queue and the in-memory chain, for the Tempo storage and RPC suites
 * (`tests/tempo-storage.ts`, `tests/tempo-snapshot.ts`): the runtime `tests/loop-anchor.ts` builds,
 * with the loop's Tempo services and its report reader handed in. No validator, no RPC, no Tempo.
 */

export const TEMPO_LOOP_AGENT = idFromString("tempo-loop-agent");
const USER = new PublicKey("11111111111111111111111111111112");
const T = 1_700_000_000_000;

/** Answers every call at once, at a fixed cost: 0.001 USD, 1 100 µUSDC with the margin. */
class Answering implements ChatTransport {
  calls = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    return {
      status: 200,
      body: {
        id: `gen-${this.calls}`,
        model: "test/model",
        choices: [{ index: 0, message: { role: "assistant", content: `answer ${this.calls}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
    };
  }
}

/** A blob store with no `anchor`: the epoch is committed and owes no locator cell. */
function epochStore(): EpochStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(root: Uint8Array, blob: Uint8Array) {
      blobs.set(hex(root), blob);
    },
    async get(root: Uint8Array) {
      return blobs.get(hex(root)) ?? null;
    },
  } as EpochStore;
}

export function tempoLoop(o: {
  loopId: string;
  services?: LoopTempoServices;
  report?: () => Promise<StorageReportFile | null>;
  chain?: FakeChain;
  billing?: RecordingBilling;
  queue?: AnchorQueue;
  store?: MemoryTraceStore;
  events?: LoopEvent[];
  resume?: LoopRunnerOptions["resume"];
  tempo?: LoopRunnerOptions["tempo"];
  maxSteps?: number;
}) {
  const chain = o.chain ?? new FakeChain();
  const billing = o.billing ?? new RecordingBilling();
  const queue =
    o.queue ??
    new AnchorQueue({
      client: chain.asClient(),
      journal: new MemoryAnchorJournal(),
      billing,
      // One attempt, so a single `failNext` is a failed entry and a halted chain.
      maxAttempts: 1,
      indexerWaitMs: 200,
      retryDelayMs: 5,
    });
  const store = o.store ?? new MemoryTraceStore();
  const runtime = new AgentRuntime({
    client: chain.asClient(),
    agentId: TEMPO_LOOP_AGENT,
    transport: new Answering(),
    policy: { model: "test/model", temperature: 0, toolAllowList: [], maxCost: 1_000_000 },
    billing,
    structures: false,
    publishPolicy: false,
    now: () => T,
    store,
    storePayloads: true,
    rollup: { store: epochStore(), batchSize: 16 },
    anchor: { queue, drain: true },
  });
  const runner = new LoopRunner({
    runtime,
    loopId: o.loopId,
    prompt: "Keep your answer in report/authority.md.",
    intervalMs: 0,
    maxSteps: o.maxSteps ?? 5,
    user: USER,
    startedAt: T,
    now: () => T,
    sleep: async () => undefined,
    ...(o.services ? { tempoServices: o.services } : {}),
    ...(o.report ? { stepReport: o.report } : {}),
    ...(o.events ? { onEvent: (e: LoopEvent) => o.events!.push(e) } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.tempo ? { tempo: o.tempo } : {}),
  });
  return { chain, billing, queue, store, runtime, runner };
}
