/**
 * What a goal loop pays Tempo's own services for, beside its model: the storage gateway, where each
 * step's report is published, and the paid RPC its own Tempo reads go through. Both are called by
 * the **host**, after a step's leaf has landed, never by the agent: no host tool, no socket, nothing
 * in the sandbox's posture or any `policy_version_hash` moves, and a loop with no treasury builds
 * none of this and runs the same without it.
 *
 * **Why a per-loop object, not part of the runner.** The console builds a `LoopRunner` per step and
 * drops it when the step returns, while a PUT takes ~2 s after the leaf and must not hold the step
 * open. So the work is queued here, on an object the console keeps for the loop's whole run, and the
 * runner of the *next* step — or the runner a stop builds to settle — is what writes it to the chain.
 *
 * **Where each result goes on chain**:
 *
 * - A PUT that came back is one `storage.put` Action, written through the anchor queue at the next
 *   point the loop's chain is quiet — the start of the next step, before its session opens, or the
 *   settlement at a stop — and debited to the owner in the same transaction, like a model call. Its
 *   `args_hash` is over `{ service, key }` and its `result_hash` is the SHA-256 of the report bytes,
 *   so the report itself is the Action's result blob.
 * - The payment is in the receipt blob `{ key, bytes, payment, … }`, which no Action hash names: it
 *   comes back after the Action's hashes were fixed by the request. The next leaf's bundle carries
 *   it, named by a `TempoCarry` blob whose hash is the manifest's fifteenth key, `tempoHash` — so the
 *   receipt is committed on Solana beside the step that published the report, and old manifests,
 *   which never carry the key, hash and verify as they did.
 * - A snapshot of the loop's Tempo state — the block, the model channel's deposit and settled total,
 *   the treasury's USDC.e, the RPC channel's own cumulative — is read after each leaf over the paid
 *   session and rides in the same carry blob of the next leaf that closes after it is ready, never
 *   in a Solana write of its own. `ofStep` names the step it was taken after, so a reader pairs it
 *   with that step however late it rode. The RPC is Lath's spend, like Jev's decisions: it is
 *   charged to nobody, and the snapshot's `rpc.cumulative` is what commits it.
 */
import { TempoRpcReader, hex, sha256, utf8 } from "@lath/sdk";
import { canonicalJson } from "./policy";
import { errorText } from "./errors";
import {
  ChargeRefused,
  PaidChargeFailed,
  TEMPO_STORAGE_URL,
  type MppChargePayment,
  type MppChargeResult,
} from "./transport/mpp";

/** The tool id every storage Action carries: `listByTool(agentId, "storage.put")` finds them. */
export const STORAGE_PUT_TOOL = "storage.put";

/** The version of the carry blob, in its bytes. */
export const TEMPO_CARRY_VERSION = 1;

/**
 * How the object on Tempo storage is encoded. This build PUTs `plain` only: it writes traces in
 * the clear (SECURITY.md §3). `LTE2` is read, never written: an older receipt on devnet may record a
 * report encrypted to the owner, for an agent whose traces were encrypted.
 */
export type StorageEncoding = "LTE2" | "plain";

/** The file a step leaves as its report: its workspace path and its bytes, PUT as they are. */
export interface StorageReportFile {
  path: string;
  bytes: Uint8Array;
}

/** What the queue needs of a charge client: `MppChargeTransport` is one. */
export interface ChargeFetcher {
  readonly payer: string;
  fetch(url: string, init?: RequestInit): Promise<MppChargeResult>;
}

/**
 * The receipt blob of one `storage.put`: what was stored, under which key, and what it cost.
 *
 * `bytes` is the size of the *report* — the plaintext the Action's `result_hash` commits and the
 * trace store hands back — because that is what an auditor can measure and what the audit's size
 * check compares it with. `storedBytes` is the object's size on the gateway: the report's own size
 * for the `plain` objects this build PUTs, and the report plus 64 bytes of header, nonce and tag for
 * an older `LTE2` object; both are absent on the oldest receipts, whose object was always the
 * plaintext.
 *
 * `latest` is read, never written: some older receipts on devnet record a second PUT of the same
 * bytes to `<loopId>-latest`, paid by Lath, and what it came to. _Open report_ reads the committed
 * key, so this build makes no such PUT.
 */
export interface StorageReceipt {
  key: string;
  bytes: number;
  encoding?: StorageEncoding;
  storedBytes?: number;
  /** The workspace path the report was read from. */
  path: string;
  /** The gateway's answer; absent when no answer came back. */
  status?: number;
  payment?: MppChargePayment;
  error?: string;
  /** Present only on older receipts; see above. */
  latest?: { key: string; status?: number; payment?: MppChargePayment; error?: string };
}

/** One PUT that has come back and whose `storage.put` Action the next quiet point writes. */
export interface StoragePut {
  /** The step whose leaf the report was taken after. */
  ofStep: number;
  service: string;
  key: string;
  /** The report itself: the Action's result blob, so `result_hash` is its SHA-256. */
  report: Uint8Array;
  /** The Action's status: the gateway's, `402` for a charge refused, `502` for no answer. */
  statusCode: number;
  receipt: StorageReceipt;
  /**
   * What the owner is debited for, USDC.e base units before the margin: the committed PUT's amount
   * when its receipt names a Tempo transaction, and 0 otherwise — a refused charge moved nothing,
   * and a call whose receipt never came back names no transaction the owner could be shown.
   */
  ownerBase: bigint;
}

/** A `storage.put` Action as a leaf's carry blob names it. */
export interface CarriedStorage {
  ofStep: number;
  /** The Action's seq, decimal. */
  seq: string;
  key: string;
  statusCode: number;
  /** `sha256` of the receipt blob, hex. */
  receiptHash: string;
}

/**
 * The loop's Tempo state after one step's leaf, read over the paid RPC. Amounts are USDC.e base
 * units and `block` a block number, all decimal strings. A read that failed leaves its field absent
 * and says why in `error`: the snapshot is carried all the same, because "the read failed after
 * step N" is itself what happened.
 */
export interface TempoSnapshot {
  /** The step whose leaf this was taken after. */
  ofStep: number;
  /** Unix ms the reads began. */
  takenAt: number;
  /** `eth_blockNumber` when the reads began: every figure below is at or after it. */
  block?: string;
  /** The loop's model channel: the escrow's deposit and settled total, and the payer's signed cumulative. */
  channel?: { id: string; deposit?: string; settled?: string; cumulative?: string };
  /** The treasury's USDC.e balance. */
  treasury?: { usdcE?: string };
  /** The RPC session's own channel and cumulative after these reads: what Lath paid for them so far. */
  rpc: { channelId?: string; cumulative?: string };
  error?: string;
}

/**
 * What a leaf carries of the loop's Tempo services, under the manifest's `tempoHash`: every
 * `storage.put` written since the last leaf that carried one, with its receipt's hash, and every
 * snapshot finished since. Each list is present only when it has entries; a step with neither
 * writes no carry blob and no fifteenth key.
 */
export interface TempoCarry {
  v: typeof TEMPO_CARRY_VERSION;
  storage?: CarriedStorage[];
  snapshots?: TempoSnapshot[];
}

/** What the snapshot needs of a paid RPC session: `MppRpcSession` is one. */
export interface RpcSessionLike {
  readonly channelId?: string;
  readonly cumulative?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  call(method: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<{ txHash?: string; spent?: string }>;
}

/**
 * A key is one flat path segment, so anything outside the gateway's safe set in a loop id is
 * folded to `-`: a console loop id is already safe, and one that is not gets a key that still lands
 * rather than an unpaid 404.
 */
function flat(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** `<loopId>-<sha256 hex>`: the committed key, one per report content. */
export function storageKey(loopId: string, sha256Hex: string): string {
  return `${flat(loopId)}-${sha256Hex}`;
}

/** The Action's args blob: `{ service, key }`, canonical. */
export function storageArgsBytes(service: string, key: string): Uint8Array {
  return utf8(canonicalJson({ service, key }));
}

export function storageReceiptBytes(receipt: StorageReceipt): Uint8Array {
  return utf8(canonicalJson(receipt));
}

export function tempoCarryBytes(carry: TempoCarry): Uint8Array {
  return utf8(canonicalJson(carry));
}

/** The inverse, for bytes fetched by `tempoHash`. `null` for anything that is not a carry blob. */
export function decodeTempoCarry(bytes: Uint8Array): TempoCarry | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || parsed.v !== TEMPO_CARRY_VERSION) return null;
    if (parsed.storage !== undefined && !Array.isArray(parsed.storage)) return null;
    if (parsed.snapshots !== undefined && !Array.isArray(parsed.snapshots)) return null;
    return parsed as TempoCarry;
  } catch {
    return null;
  }
}

/** What a report is served as; the gateway stores whatever it is told. */
function contentTypeOf(path: string): string {
  if (/\.md$/i.test(path)) return "text/markdown; charset=utf-8";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.(txt|csv|log)$/i.test(path)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** A JSON-RPC quantity (`0x…`) as a decimal string. */
function quantity(v: unknown): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v))
    throw new Error(`not a quantity: ${String(v).slice(0, 80)}`);
  return BigInt(v).toString();
}

/** The treasury's USDC.e on Tempo mainnet: the token the snapshot's `treasury.usdcE` reads. */
export const TEMPO_USDC_E_TOKEN = "0x20c000000000000000000000b9537d11c60e8b50";

export interface LoopTempoServicesOptions {
  loopId: string;
  /** Storage's charge client; absent is no PUTs at all. */
  storage?: ChargeFetcher;
  /** Defaults to Tempo's gateway. */
  storageUrl?: string;
  /** Told about every PUT as it comes back, before its Action is written: the step row's chip. */
  onStorage?: (put: StoragePut) => void;
  /** The paid RPC session the snapshots read through; absent is no snapshots at all. */
  rpc?: RpcSessionLike;
  /** The treasury whose USDC.e a snapshot reads. */
  treasury?: string;
  /** The token that balance is in. Defaults to USDC.e. */
  usdcE?: string;
  /** The loop's model channel as it stands when a snapshot is taken: its id and signed cumulative. */
  channel?: () => { id?: string; cumulative?: string };
  /**
   * The escrow's `(deposit, settled)` for a channel. Defaults to `TempoRpcReader` routed through
   * `rpc`, so the read is one more paid call on the session. A test passes its own.
   */
  readChannel?: (channelId: string) => Promise<{ deposit: bigint; settled: bigint } | null>;
  /** Told about every snapshot as it is taken: the step row's _read from Tempo at block N_. */
  onSnapshot?: (snapshot: TempoSnapshot) => void;
  now?: () => number;
  /** How `blockOf` waits between its reads of a close receipt. A test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a stop waits for the jobs in flight before it settles the model channel, ms; `TEMPO_STOP_DRAIN_MS` when unset. */
  stopDrainMs?: number;
}

/**
 * How long a loop's stop waits for its PUTs and reads in flight before it closes the model channel,
 * ms. Each call has a deadline of its own (`MPP_CHARGE_DEADLINE_MS`, `MPP_RPC_DEADLINE_MS`), but the
 * reads queue one after another on a single session, so several snapshots behind a stalled gateway
 * still add up. The model channel holds the loop's whole remaining deposit, and no PUT or read is
 * worth holding it open longer than this. Past the bound the channel is closed first. What comes
 * back after it is written when the services close, before the stop record is built, so the record
 * still names every PUT.
 */
export const TEMPO_STOP_DRAIN_MS = 90_000;

/**
 * The loop's Tempo services: a queue of jobs started after each leaf, and what came back of them,
 * held until a runner writes it. Never throws out of a job — a failure is a failed `storage.put`
 * Action — and never blocks a step: `afterLeaf` returns at once.
 */
export class LoopTempoServices {
  readonly loopId: string;
  private readonly storage?: ChargeFetcher;
  private readonly storageUrl: string;
  private readonly onStorage?: (put: StoragePut) => void;
  /** Jobs in flight. A job removes itself when it settles, whatever it came to. */
  private readonly pending = new Set<Promise<void>>();
  /** PUTs that came back and whose Action no runner has written yet. */
  private puts: StoragePut[] = [];
  /** Actions written and not yet named by a leaf's (or the stop record's) carry blob. */
  private uncarried: CarriedStorage[] = [];
  private closed = false;
  private readonly rpc?: RpcSessionLike;
  private readonly treasury?: string;
  private readonly usdcE: string;
  private readonly channel?: () => { id?: string; cumulative?: string };
  private readonly readChannel?: (channelId: string) => Promise<{ deposit: bigint; settled: bigint } | null>;
  private readonly onSnapshot?: (snapshot: TempoSnapshot) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The session's open, fired once at the loop's start and never awaited by a step. */
  private opening?: Promise<void>;
  /** Snapshots taken and not yet named by a carry blob, oldest first. */
  private snapshots: TempoSnapshot[] = [];
  /** The latest snapshot taken, carried or not: what a stop record names as the last one. */
  private latest?: TempoSnapshot;
  private closing?: Promise<TempoServicesClose>;
  /** What a stop waits for the jobs in flight before it settles the model channel (`TEMPO_STOP_DRAIN_MS`). */
  readonly stopDrainMs: number;

  constructor(opts: LoopTempoServicesOptions) {
    this.loopId = opts.loopId;
    this.storage = opts.storage;
    this.storageUrl = (opts.storageUrl ?? TEMPO_STORAGE_URL).replace(/\/+$/, "");
    this.onStorage = opts.onStorage;
    this.rpc = opts.rpc;
    this.treasury = opts.treasury;
    this.usdcE = opts.usdcE ?? TEMPO_USDC_E_TOKEN;
    this.channel = opts.channel;
    const rpc = opts.rpc;
    this.readChannel =
      opts.readChannel ??
      (rpc
        ? (() => {
            const reader = new TempoRpcReader({ request: (method, params) => rpc.call(method, params) });
            return (id: string) => reader.channelState(id);
          })()
        : undefined);
    this.onSnapshot = opts.onSnapshot;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stopDrainMs = opts.stopDrainMs ?? TEMPO_STOP_DRAIN_MS;
  }

  /** The latest snapshot taken, whether or not a leaf has carried it yet. */
  get lastSnapshot(): TempoSnapshot | undefined {
    return this.latest;
  }

  /**
   * Opens the RPC session in the background, once: called when the loop's first step starts, so the
   * open — the slow call, 5.9 s measured — runs beside that step and is never on a step's clock. A
   * failed open is not remembered as fatal: the session opens lazily on its next call, which is the
   * snapshot's, and a snapshot that still cannot read says so in its `error`.
   */
  start(): void {
    if (!this.rpc || this.opening || this.closed) return;
    this.opening = this.rpc.open().catch(() => undefined);
  }

  /** Whether a report would be published: a charge client, and a loop not yet closed. */
  get storageOn(): boolean {
    return !!this.storage && !this.closed;
  }

  /** Jobs still in flight. */
  get inFlight(): number {
    return this.pending.size;
  }

  private track(job: Promise<void>): void {
    const settled: Promise<void> = job.then(
      () => {
        this.pending.delete(settled);
      },
      () => {
        this.pending.delete(settled);
      }
    );
    this.pending.add(settled);
  }

  /**
   * The step's leaf has landed: start its jobs and return at once. `report` is read inside the job,
   * so even finding the file is off the step's clock; it answers `null` for a step that wrote no
   * report, which publishes nothing and records nothing.
   */
  afterLeaf(step: number, report: () => Promise<StorageReportFile | null>): void {
    if (this.closed) return;
    if (this.storage) this.track(this.publish(step, report));
    if (this.rpc) this.track(this.snapshot(step));
  }

  /** The reads after step `ofStep`'s leaf, one after another on the session (`MppRpcSession`). */
  private async snapshot(ofStep: number): Promise<void> {
    const rpc = this.rpc!;
    const snap: TempoSnapshot = { ofStep, takenAt: this.now(), rpc: {} };
    try {
      this.start();
      await this.opening;
      snap.block = quantity(await rpc.call("eth_blockNumber", []));
      const mark = this.channel?.();
      if (mark?.id) {
        const state = this.readChannel ? await this.readChannel(mark.id) : null;
        snap.channel = {
          id: mark.id,
          ...(state ? { deposit: state.deposit.toString(), settled: state.settled.toString() } : {}),
          ...(mark.cumulative !== undefined ? { cumulative: mark.cumulative } : {}),
        };
      }
      if (this.treasury) {
        const data = `0x70a08231${this.treasury.slice(2).toLowerCase().padStart(64, "0")}`;
        snap.treasury = { usdcE: quantity(await rpc.call("eth_call", [{ to: this.usdcE, data }, "latest"])) };
      }
    } catch (e) {
      snap.error = errorText(e, 400);
    }
    snap.rpc = {
      ...(rpc.channelId ? { channelId: rpc.channelId } : {}),
      ...(rpc.cumulative !== undefined ? { cumulative: rpc.cumulative } : {}),
    };
    this.snapshots.push(snap);
    this.snapshots.sort((a, b) => a.ofStep - b.ofStep);
    if (!this.latest || snap.ofStep >= this.latest.ofStep) this.latest = snap;
    try {
      this.onSnapshot?.(snap);
    } catch {
      // An observer; it cannot lose a snapshot.
    }
  }

  private async publish(step: number, report: () => Promise<StorageReportFile | null>): Promise<void> {
    let file: StorageReportFile | null;
    try {
      file = await report();
    } catch {
      // A report that cannot be read is a step that published nothing, not a failed PUT: nothing
      // was sent, so there is no Action to record.
      file = null;
    }
    if (!file || !this.storage) return;
    // The key names the bytes' hash: it is what the Action commits and what an auditor re-hashes
    // (`verifyStorageCharge`).
    const hash = hex(sha256(file.bytes));
    const key = storageKey(this.loopId, hash);
    const body = file.bytes;
    const encoding: StorageEncoding = "plain";
    const contentType = contentTypeOf(file.path);
    // One PUT, under the committed key: _Open report_ reads that key, so nothing needs a second
    // copy under `<loopId>-latest`.
    const main: PromiseSettledResult<MppChargeResult> = await this.storage
      .fetch(`${this.storageUrl}/${key}`, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: body as unknown as NonNullable<RequestInit["body"]>,
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason })
      );
    const receipt: StorageReceipt = {
      key,
      bytes: file.bytes.length,
      encoding,
      storedBytes: body.length,
      path: file.path,
    };
    let statusCode: number;
    if (main.status === "fulfilled") {
      statusCode = main.value.status;
      receipt.status = main.value.status;
      if (main.value.payment) receipt.payment = main.value.payment;
      if (main.value.status < 200 || main.value.status >= 300) {
        receipt.error = new TextDecoder().decode(main.value.bytes.slice(0, 300)) || `status ${main.value.status}`;
      }
    } else if (main.reason instanceof ChargeRefused) {
      statusCode = 402;
      receipt.error = errorText(main.reason, 400);
    } else if (main.reason instanceof PaidChargeFailed) {
      // Signed for, no answer: a failed Action that says what it approved.
      statusCode = 502;
      receipt.payment = main.reason.payment;
      receipt.error = errorText(main.reason, 400);
    } else {
      statusCode = 502;
      receipt.error = errorText(main.reason, 400);
    }
    const ownerBase = receipt.payment?.reference ? BigInt(receipt.payment.amount) : BigInt(0);
    const put: StoragePut = {
      ofStep: step,
      service: this.storageUrl,
      key,
      report: file.bytes,
      statusCode,
      receipt,
      ownerBase,
    };
    this.puts.push(put);
    try {
      this.onStorage?.(put);
    } catch {
      // An observer; it cannot lose a PUT.
    }
  }

  /** The PUTs that came back, oldest first, handed to the runner that writes their Actions. */
  takePuts(): StoragePut[] {
    const out = this.puts;
    this.puts = [];
    return out;
  }

  /** Puts back PUTs a runner could not write, so the next quiet point writes them. */
  returnPuts(puts: StoragePut[]): void {
    this.puts = [...puts, ...this.puts];
  }

  /** The runner wrote these Actions; a leaf's carry blob names them next. */
  wrote(entries: CarriedStorage[]): void {
    this.uncarried.push(...entries);
  }

  /** What the next leaf would carry, or `null` when there is nothing to carry. Not consumed. */
  carry(): TempoCarry | null {
    if (this.uncarried.length === 0 && this.snapshots.length === 0) return null;
    return {
      v: TEMPO_CARRY_VERSION,
      ...(this.uncarried.length ? { storage: [...this.uncarried] } : {}),
      ...(this.snapshots.length ? { snapshots: [...this.snapshots] } : {}),
    };
  }

  /** A leaf (or the stop record) committed `carry`: those entries are named and are not carried again. */
  carried(carry: TempoCarry): void {
    const done = new Set((carry.storage ?? []).map((s) => s.seq));
    this.uncarried = this.uncarried.filter((s) => !done.has(s.seq));
    const taken = new Set(carry.snapshots ?? []);
    this.snapshots = this.snapshots.filter((s) => !taken.has(s));
  }

  /**
   * Waits for every job in flight, whatever each comes to. With `withinMs`, no longer than that.
   * The answer is whether nothing was left in flight, and a job still running is left running.
   */
  async drain(withinMs?: number): Promise<boolean> {
    if (withinMs === undefined) {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), withinMs);
    });
    try {
      while (this.pending.size > 0) {
        if ((await Promise.race([Promise.allSettled([...this.pending]), expired])) === "expired") return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The block a Tempo transaction landed in, read over the paid session — the model channel's close
   * settlement, for the stop record. Three reads 1.5 s apart, because a close can hand back its
   * hash a moment before the node serving the read has the receipt; `undefined` when none of them
   * found it, which the record then simply lacks. Call it before `close()`: the session closes there.
   */
  async blockOf(txHash: string | undefined): Promise<string | undefined> {
    if (!this.rpc || !txHash) return undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const receipt = (await this.rpc.call("eth_getTransactionReceipt", [txHash])) as {
          blockNumber?: unknown;
        } | null;
        if (receipt?.blockNumber !== undefined && receipt?.blockNumber !== null) return quantity(receipt.blockNumber);
      } catch {
        // Not yet, or not reachable: the next attempt, then nothing.
      }
      if (attempt < 2) await this.sleep(1_500);
    }
    return undefined;
  }

  /**
   * Takes no more work, waits for what is in flight, then settles the RPC channel. Idempotent — a
   * second caller gets the first one's answer — and never throwing: a close that fails is
   * `closed: false` with the reason, the shape a model channel's failed close has.
   */
  close(): Promise<TempoServicesClose> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async (): Promise<TempoServicesClose> => {
        await this.drain();
        const rpc = this.rpc;
        if (!rpc) return {};
        // An open still in flight is waited out first: a close that ran before it would find nothing
        // opened, and the channel the open then made would be left holding its deposit.
        await this.opening;
        if (!rpc.opened) return {};
        const channelId = rpc.channelId;
        try {
          const receipt = await rpc.close();
          return { rpc: { ...(channelId ? { channelId } : {}), closed: true, ...receipt } };
        } catch (e) {
          return { rpc: { ...(channelId ? { channelId } : {}), closed: false, error: errorText(e, 400) } };
        }
      })();
    }
    return this.closing;
  }
}

/** What closing a loop's services came to: the RPC channel's settlement, when one was open. */
export interface TempoServicesClose {
  rpc?: { channelId?: string; closed: boolean; txHash?: string; spent?: string; error?: string };
}

/**
 * What the stop record — the `loop.settlement` Action's result blob, `TempoSettlement.services` —
 * says of a loop's Tempo services once they are drained: the carry no leaf got to name (the
 * `storage.put` Actions the drain wrote and the snapshots taken after the last leaf), the last
 * snapshot however it was carried, the block the model channel's close settled in, and the RPC
 * channel's own close.
 */
export interface TempoServicesStop extends TempoCarry {
  lastSnapshot?: TempoSnapshot;
  /** The block of the model channel's close transaction (`TempoSettlement.txHash`), decimal. */
  closeBlock?: string;
  rpc?: TempoServicesClose["rpc"];
}
