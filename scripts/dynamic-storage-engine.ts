/**
 * The two-tier storage engine: a bench and test harness, not a product path.
 *
 * It routes *critical* events (genesis, delegation, resolution) to an immediate write and
 * batches *standard* ones (tool calls, LLM steps) into epochs. Nothing in `runtime/` or
 * `frontend/` uses it — the runtime drives `RollupBatcher` directly and writes its critical
 * events through `AgentLogger` — so it lives here, outside `@lath/sdk`, where the epoch tests
 * (`tests/rollup.ts`, `tests/devnet.ts`) are its only callers.
 *
 * The invariant it states is real and still holds in `RollupBatcher`, which is why the class is
 * kept rather than deleted: **a critical write flushes the standard queue first.** An epoch
 * occupies `[seq, seq + n)` as of commit time and a record occupies `seq`, so the two must never
 * race — every queued step lands before the event that follows it.
 */
import { EventInput, EventKind, EventPayload, toEventInput } from "../sdk/src/events";
import { EpochCommit, EpochCommitter, RollupBatcher } from "../sdk/src/rollup";
import { DEFAULT_AGENT_DYNAMIC_CONFIG, DynamicStorageConfig } from "../sdk/src/storage";

export enum EventTier {
  /** Written individually, at once: Genesis, Delegation, Resolution. */
  Critical = "critical",
  /** Batched into an epoch: Action. */
  Standard = "standard",
}

interface DynamicEngineMetrics {
  totalPushed: number;
  criticalPushed: number;
  standardPushed: number;
  ingestionRatePerSec: number;
  standardPending: number;
  epochsCommitted: number;
  /** The last chain signals the batcher sampled, when `config.signals` is set. */
  priorityFeeMicroLamports: number | null;
  payerBalanceLamports: number | null;
}

/** Writes one critical event now and returns what the chain said. */
type CriticalWriter<T = unknown> = (input: EventInput) => Promise<T>;

export class DynamicStorageEngine<T = unknown> {
  readonly batcher: RollupBatcher;
  private recent: number[] = [];
  private total = 0;
  private critical = 0;
  private standard = 0;

  constructor(
    public readonly config: DynamicStorageConfig = DEFAULT_AGENT_DYNAMIC_CONFIG,
    private readonly writeCritical: CriticalWriter<T>,
    commitEpoch: EpochCommitter
  ) {
    this.batcher = new RollupBatcher(
      { batchSize: config.standardBatchSize, maxFlushDelayMs: config.standardFlushDelayMs, signals: config.signals },
      commitEpoch
    );
  }

  classify(kind: EventKind): EventTier {
    if (this.config.mode === "interactive") return EventTier.Critical;
    if (this.config.mode === "batch") return EventTier.Standard;
    return kind === EventKind.Action ? EventTier.Standard : EventTier.Critical;
  }

  /**
   * Routes one event. A critical event resolves to whatever `writeCritical` returned; a
   * standard one resolves to the `EpochCommit` if it completed an epoch, else `null`.
   */
  async push(
    step: EventInput | EventPayload,
    opts: { tier?: EventTier; timestamp?: number } = {}
  ): Promise<T | EpochCommit | null> {
    const input = "payloadHash" in step ? step : toEventInput(step, opts.timestamp ?? Date.now());
    this.total++;
    this.sample();
    const tier = opts.tier ?? this.classify(input.kind);
    if (tier === EventTier.Critical) {
      this.critical++;
      await this.batcher.flush();
      return this.writeCritical(input);
    }
    this.standard++;
    return this.batcher.push(input);
  }

  /** Commits whatever is queued. Call before reading `seq` or shutting down. */
  flush(): Promise<EpochCommit | null> {
    return this.batcher.flush();
  }

  getMetrics(): DynamicEngineMetrics {
    this.trim();
    const windowSecs = Math.max(1, this.config.rateSampleWindowMs / 1000);
    return {
      totalPushed: this.total,
      criticalPushed: this.critical,
      standardPushed: this.standard,
      ingestionRatePerSec: Math.round((this.recent.length / windowSecs) * 10) / 10,
      standardPending: this.batcher.pendingCount,
      epochsCommitted: this.batcher.epochs.length,
      priorityFeeMicroLamports: this.batcher.signalsSeen.priorityFee,
      payerBalanceLamports: this.batcher.signalsSeen.payerBalance,
    };
  }

  dispose(): void {
    this.batcher.dispose();
  }

  private sample(): void {
    this.recent.push(Date.now());
    this.trim();
  }

  private trim(): void {
    const cutoff = Date.now() - this.config.rateSampleWindowMs;
    while (this.recent.length && this.recent[0] < cutoff) this.recent.shift();
  }
}
