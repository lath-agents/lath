/**
 * The `tempo` rail: an agent's inference is paid for at OpenRouter's MPP gateway, per call, from
 * the account this transport is handed.
 *
 * *Whose* account that is, this file does not decide: the caller passes the operator's Tempo
 * treasury, which signs the vouchers of every agent on the rail, while older records name a wallet
 * derived from the agent's own Solana key as `payer`. The transport takes any account, so the
 * choice is one line at each construction site (`frontend/src/app/api/_lib/tempo.ts`), and the
 * ordering of channel opens and closes on that shared account belongs there too — a transport
 * cannot know its account is shared.
 *
 * There is no API key here at all — a TIP-1034 payment channel is the credential. One
 * `SessionManager` lives per transport instance, which is one per `AgentRuntime.start()` or per
 * `LoopRunner` (never per run slot: a slot lapses on a TTL under a wedged drain); it opens
 * the channel lazily on the first call and signs one cumulative voucher per request. The channel
 * is the only hold a session has — the runtime places no Solana `reserve` — so
 * `maxDeposit` is what caps a session's spend on this rail, and `close()` settles it once.
 *
 * What the record commits is the delta: `session.cumulative` read immediately before the fetch
 * and again after the body is drained brackets exactly one call, because one Action is exactly
 * one LLM call and tool calls are never billed. That delta is the gateway's flat per-request
 * quote (750 base units for `openai/gpt-4o-mini`, whatever the tokens), not a token cost;
 * the body's own `usage.cost` is recorded beside it as `usageCost` and never reconciled with it.
 *
 * A refused voucher throws out of `chat`, which is before every `store.put` and
 * every charge, so nothing is written for a call that was not paid for. A call that *was* paid
 * for and then failed — a stream cut after its 2xx headers, a mid-stream `error` frame, an abort
 * mid-body — throws `PaidCallFailed` with its voucher bracket instead, and the runtime records it
 * as a failed `llm.*` Action: mppx advances the cumulative when it signs, so the gateway
 * holds that voucher whether or not the body arrived. The test is the cumulative itself, read
 * again after the failure, not the error's type. Nothing is retried: a second attempt
 * would sign a second voucher for a completion the first attempt may already have bought.
 */
import {
  chatCore,
  ChatRequest,
  ChatResult,
  ChatStreamOptions,
  ChatTransport,
  decideCore,
  DecideRequest,
  DecideResult,
  DecideTransport,
  NoAnswerTimeout,
  PaidCallFailed,
  TempoPayment,
} from "../openrouter";

/** Tempo mainnet, as `eth_chainId` at `https://rpc.tempo.xyz` answers (`0x1079`). */
export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_RPC_URL = "https://rpc.tempo.xyz";
/** OpenRouter's MPP gateway: no signup, no key, the channel is the credential. */
export const TEMPO_GATEWAY_URL = "https://openrouter.mpp.tempo.xyz/v1/chat/completions";
/**
 * The same gateway's Decisions API: `/alpha/decisions`, not the OpenRouter-native
 * `/api/alpha/decisions`, which it 404s. It answers the same `tempo`
 * 402 challenge as chat completions, so a decision is one more paid request on the channel the
 * loop already holds — no second channel, no second payer, no key.
 */
export const TEMPO_DECISIONS_URL = "https://openrouter.mpp.tempo.xyz/alpha/decisions";
/** USDC.e has six decimals — the same base unit as the Solana vault's micro-USDC. */
export const TEMPO_DECIMALS = 6;
/**
 * Tempo's own storage service, over the `charge` intent: an object
 * is stored under `<payer address>/<key>`, and a key is one flat path segment — a `/` in it gets an
 * unpaid 404 before any challenge.
 */
export const TEMPO_STORAGE_URL = "https://storage.mpp.tempo.xyz";
/** Tempo's paid JSON-RPC, over the `session` intent: the same reads `TEMPO_RPC_URL` serves free. */
export const TEMPO_RPC_MPP_URL = "https://rpc.mpp.tempo.xyz";

/**
 * The half of a viem `PrivateKeyAccount` this module names. The account itself is handed to
 * mppx untouched; the address is what a record commits as `payer` — the operator treasury, which
 * `verifyInference` is told with `--payer`, or, on an older record, the agent's derived address,
 * which it re-derives from the agent key. Structural on purpose, so the
 * runtime's published types carry no viem type and a test can pass an address and no key.
 */
export interface TempoAccountLike {
  readonly address: string;
  /**
   * Set on a `viem/tempo` access-key account (`Account.fromSecp256k1(pk, { access: root })`), whose
   * `address` is the root's: the key that actually signs, recorded as `signer` beside `payer`.
   */
  readonly accessKeyAddress?: string;
}

/**
 * The part of mppx's session manager the transport uses. `fetch` is a `fetch` that signs a
 * voucher first and returns a `Response` with `cumulative` and `channelId` on it; `cumulative`
 * on the manager is the channel's signed total, which the gateway's receipt has advanced by the
 * time the body is drained.
 */
export interface MppSession {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  readonly cumulative: bigint | string | number;
  readonly channelId?: string;
  readonly opened: boolean;
  close(): Promise<MppCloseReceipt | undefined>;
}

/** What `session.close()` answers: the settlement transaction and what the channel paid out. */
export interface MppCloseReceipt {
  txHash?: string;
  spent?: bigint | string;
  acceptedCumulative?: bigint | string;
}

/**
 * The TIP-1034 descriptor of a channel (mppx `ChannelDescriptor`): the escrow derives the channel
 * id *from* these seven fields, so an id alone cannot be turned back into a close — every close
 * credential names the descriptor, and a process that has only the id has nothing to sign.
 */
export interface MppChannelDescriptor {
  payer: string;
  payee: string;
  operator: string;
  token: string;
  salt: string;
  authorizedSigner: string;
  expiringNonceHash: string;
}

/**
 * What mppx's `channelStore` is told about a channel: written when it opens and again on every
 * voucher, with the cumulative the payer has signed so far. The shape is mppx's `ChannelEntry`.
 */
export interface MppChannelEntry {
  channelId: string;
  cumulativeAmount: bigint;
  deposit: bigint;
  descriptor: MppChannelDescriptor;
  escrow: string;
  chainId: number;
  opened: boolean;
}

/**
 * Everything a close of this channel needs once the process that opened it is gone.
 *
 * mppx closes a channel by posting a close credential — the descriptor and a voucher signed at
 * the final cumulative — to the gateway URL the channel was challenged on, against that
 * challenge; a `SessionManager` built in a new process has none of those, so without them
 * `closeChannelById` could settle nothing. This is the same set mppx's own CLI persists as a
 * `ManagedSession` so that `mppx sessions close` can rehydrate a manager later: the channel entry,
 * the endpoint, the last challenge and the spend. Amounts are decimal strings so the whole thing
 * is JSON, because its one purpose is to be written to disk beside the channel id.
 */
export interface MppChannelRecovery {
  channelId: string;
  chainId: number;
  escrow: string;
  descriptor: MppChannelDescriptor;
  /** Base units. `cumulative` is the highest voucher this key has signed on the channel. */
  deposit: string;
  cumulative: string;
  /** What the gateway's receipts say was consumed, base units; never above `cumulative`. */
  spent: string;
  /** The URL the channel was challenged and paid on; a close is posted to the same one. */
  endpoint: string;
  /**
   * The gateway's last `tempo/session` challenge, as mppx parsed it. Absent until the first
   * response has come back, which is a window a kill can land in; a close with none probes the
   * endpoint for a fresh one, and follows the gateway's 402 refresh either way.
   */
  challenge?: unknown;
  /** False once the channel has been closed; a row for a closed channel is nothing to recover. */
  opened: boolean;
  /**
   * The Tempo block the channel opened in, decimal, once the transport knows it: copied onto the
   * ledger row (`OpenChannelRow.openBlock`) and every payment record, so an audit's `ChannelOpened`
   * read starts there. Absent until known.
   */
  openBlock?: string;
}

/** `keccak256("ChannelOpened(bytes32,address,address,address,address,address,bytes32,bytes32,uint96)")`: topic 0 of the escrow's open, whose topic 1 is the channel id. */
export const CHANNEL_OPENED_TOPIC = "0xdebaba36f0e9c7978f536fed432d9360b1f9646d7ca88531c34c3eae43f154a7";

/**
 * Turns the transaction hash a gateway receipt carried into the block the channel opened in,
 * decimal, or `undefined` when that transaction is not this channel's open (a top-up, a receipt
 * for another channel, one not mined yet). Injected by `tests/tempo-inference.ts`; the default
 * reads the transaction's receipt off Tempo (`rpcOpenBlockReader`).
 */
export type OpenBlockReader = (txHash: string, channelId: string, escrow?: string) => Promise<string | undefined>;

/**
 * The open block out of an `eth_getTransactionReceipt` answer: its `blockNumber`, but only when the
 * transaction succeeded and logged `ChannelOpened` for this channel id — from the escrow, when the
 * caller knows which one. The hash comes from the gateway's receipt header, so it is held to the
 * chain rather than believed: a block that is not where the channel opened would point an audit's
 * `ChannelOpened` read past the log it is looking for.
 */
export function openBlockOf(receipt: any, channelId: string, escrow?: string): string | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  if (receipt.status !== undefined && receipt.status !== "0x1" && receipt.status !== "success") return undefined;
  const id = channelId.toLowerCase();
  const opened = (Array.isArray(receipt.logs) ? receipt.logs : []).some(
    (l: any) =>
      String(l?.topics?.[0] ?? "").toLowerCase() === CHANNEL_OPENED_TOPIC &&
      String(l?.topics?.[1] ?? "").toLowerCase() === id &&
      (!escrow || String(l?.address ?? "").toLowerCase() === escrow.toLowerCase())
  );
  if (!opened || receipt.blockNumber === undefined || receipt.blockNumber === null) return undefined;
  try {
    return BigInt(receipt.blockNumber).toString();
  } catch {
    return undefined;
  }
}

/**
 * The default `OpenBlockReader`: one `eth_getTransactionReceipt` against the free Tempo RPC the
 * session already names, retried twice two seconds apart for a receipt that is not there yet. The
 * gateway broadcasts the open before it answers, so the first read almost always finds it; the
 * retries cover a node that has not caught up, and nothing waits on them (`OpenBlockTracker`).
 */
export function rpcOpenBlockReader(rpcUrl: string, fetchImpl: typeof fetch = fetch): OpenBlockReader {
  return async (txHash, channelId, escrow) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          (t as { unref?: () => void }).unref?.();
        });
      }
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      });
      const body = (await res.json()) as { result?: unknown };
      if (body?.result) return openBlockOf(body.result, channelId, escrow);
    }
    return undefined;
  };
}

/**
 * What a transport learns about where its channels opened, and the rule for learning it: off the
 * transaction hash the gateway puts on the open's `Payment-Receipt` (mppx's server writes the open
 * and top-up hashes there and none on a voucher, and a top-up is posted out of band, so the hash
 * on a paid response's receipt is the open's), read once per hash in the background.
 *
 * Never on the hot path: the read is started from `observe` and not awaited, so no paid call waits
 * on Tempo's RPC, and a call that lands before the answer is recorded without `openBlock` — the
 * channel's records from the answer on carry it, and so does the recovery `onChannel` hands the
 * ledger row. A failed or empty read is left absent rather than retried forever: the audit treats
 * `openBlock` as optional and scans without it.
 */
class OpenBlockTracker {
  private readonly known = new Map<string, string>();
  private readonly asked = new Set<string>();
  private readonly inflight = new Set<string>();

  constructor(
    private readonly reader: OpenBlockReader | undefined,
    private readonly learned: () => void,
    private readonly log?: (line: string) => void
  ) {}

  get(channelId: string | undefined): string | undefined {
    return channelId ? this.known.get(channelId.toLowerCase()) : undefined;
  }

  observe(receipt: unknown, channelId: string | undefined, escrow: string | undefined): void {
    if (!this.reader || !channelId) return;
    const r = receipt as { txHash?: unknown; channelId?: unknown } | null | undefined;
    const txHash = r?.txHash;
    if (typeof txHash !== "string" || !txHash) return;
    const id = channelId.toLowerCase();
    // A receipt for another channel says nothing about this one's open.
    if (typeof r?.channelId === "string" && r.channelId.toLowerCase() !== id) return;
    // Once per channel at a time and once per hash ever: a hash that turned out to be a top-up is
    // not asked again, and a later hash may still be the open the first read could not find.
    if (this.known.has(id) || this.inflight.has(id) || this.asked.has(txHash.toLowerCase())) return;
    this.asked.add(txHash.toLowerCase());
    this.inflight.add(id);
    this.reader(txHash, id, escrow).then(
      (block) => {
        this.inflight.delete(id);
        if (!block) return;
        this.known.set(id, block);
        this.learned();
      },
      (e) => {
        this.inflight.delete(id);
        this.log?.(`tempo: the open block of ${id} was not read, records go without it: ${(e as any)?.message ?? e}`);
      }
    );
  }
}

/** How a session is built. Injected by `tests/tempo-inference.ts`; the default opens a real one. */
export type MppSessionFactory = (opts: {
  account: TempoAccountLike;
  chainId: number;
  rpcUrl: string;
  /** Human-unit USDC.e strings, which is what mppx takes. */
  maxDeposit: string;
  topUpAmount: string;
  /**
   * Told about the channel as mppx writes it to its store: at open, and on every voucher. The
   * default factory hands mppx a store that calls this; a fake session may call it itself.
   */
  onChannelUpdate?: (entry: MppChannelEntry) => void;
}) => Promise<MppSession>;

export interface MppOpenRouterOptions {
  /**
   * The account that pays: the operator treasury (older records name the agent's own derived
   * account). The transport signs with whatever it is handed (`_lib/tempo.ts` chooses).
   */
  account: TempoAccountLike;
  /**
   * The session's per-step ceiling in USDC.e base units — the same number the vault meters in.
   * `maxDeposit = maxCostBase × (maxSteps + 1)` and `topUpAmount = maxCostBase`, sized so a
   * top-up can never fall inside a body: the gateway's unit is the request and the whole price
   * is vouchered before the first byte, but a deposit that could run out mid-session would still
   * stall a step.
   */
  maxCostBase?: bigint;
  /** The session's step ceiling, from the same policy the runtime enforces. */
  maxSteps?: number;
  /**
   * The channel's deposit ceiling, base units, when the caller sized it itself — a loop:
   * `remaining owner budget + remaining Jev budget`. A loop has no per-step unit for
   * `maxCostBase × (maxSteps + 1)` to multiply, and its policy `maxCost` is the *whole* loop budget,
   * so that formula would ask the treasury to hold that budget `maxSteps + 1` times. Pass it with
   * `topUpBase`, or neither.
   */
  maxDepositBase?: bigint;
  /** The top-up unit, base units, beside `maxDepositBase`: `max(remaining ÷ stepsLeft, one gate ask)`. */
  topUpBase?: bigint;
  /** Defaults to the OpenRouter gateway. */
  url?: string;
  /** Defaults to `TEMPO_DECISIONS_URL`. */
  decisionsUrl?: string;
  chainId?: number;
  rpcUrl?: string;
  /** Replaces the mppx session with a fake. Tests only; nothing in the app passes it. */
  sessionFactory?: MppSessionFactory;
  /**
   * Called with what a close of the channel needs, every time that changes: when the channel
   * opens, when a voucher advances the cumulative, when a response carries a challenge or a
   * receipt. The console writes it onto the channel's ledger row, so a channel that
   * outlives this process can still be closed by the next one. Synchronous on purpose: a voucher
   * is signed before its request goes out, and the row must be on disk before the gateway can
   * hold a voucher the row does not know about.
   */
  onChannel?: (recovery: MppChannelRecovery) => void;
  /**
   * How long one paid call may take before it is abandoned, ms; `MPP_CALL_DEADLINE_MS` when unset.
   * Tests pass a short one.
   */
  callDeadlineMs?: number;
  /**
   * How long an aborted call is given to come back out of mppx, ms; `MPP_ABORT_GRACE_MS` when
   * unset. Tests pass a short one.
   */
  abortGraceMs?: number;
  /** One line per paid call — what it was, how long it took, how it ended. The console prints it. */
  log?: (line: string) => void;
  /**
   * Where the channel's open block is read from, on an access-key account only. Defaults to one
   * receipt read on `rpcUrl` under the default session; with an injected `sessionFactory` and no
   * reader there is none, because a fake session has no chain behind it and a test must not reach
   * Tempo.
   */
  openBlockReader?: OpenBlockReader;
}

/**
 * The most one paid call may take, ms. Under ZeroClaw's 120 s provider timeout
 * (`zeroclaw/patches/0003`), so the host gives up first and frees the queue.
 *
 * Without a deadline nothing on the path would end a gateway request that never settled: the
 * transport's queue and the model proxy's queue are promise chains, so one such request would hold
 * every later call on the loop's channel — chat and decisions alike — and every later step would
 * wait out ZeroClaw's 120 s without making a call, with nothing in the console log.
 */
export const MPP_CALL_DEADLINE_MS = 110_000;

/**
 * How long a call the deadline or the caller aborted is given to come back out of mppx before the
 * transport decides what it cost, ms.
 *
 * mppx signs the voucher — and advances `cumulative` — before the request goes out, and puts it
 * back only in `doFetch`'s catch, after the fetch's rejection has passed through its own wrappers:
 * several ticks after the abort. `untilAborted` rejects in the abort listener itself, so a counter
 * read at that moment would see a voucher mppx is about to un-sign, and a call the gateway never
 * answered would be recorded as paid — the owner charged for it, and the next call bracketing the
 * same voucher again, which `verifyChannels` fails as a cumulative that goes down. An abort reaches the fetch at
 * once, so the rollback lands within milliseconds; this bounds only an mppx stuck inside a request
 * of its own. Under `DECIDE_PAID_GRACE_MS` (2 s), so `decideWithin` and `chatWithin`, which wait
 * that long for the transport's answer, hear this one rather than their own timeout.
 */
export const MPP_ABORT_GRACE_MS = 1_500;

/**
 * A signal that aborts when `outer` does or when `ms` pass, whichever is first, and `done` to
 * clear the timer. The deadline's reason says what happened, since it ends up in a step's row.
 *
 * With `firstData`, a second timer aborts the call when that many ms pass before `sawData()` is
 * called — the first `data:` frame of a streamed answer. Its reason says
 * the model sent nothing, which is a different fact from a slow answer running out of time. Both
 * reasons are `NoAnswerTimeout`, so the runtime can tell the deadline from the caller's signal.
 */
function deadlineSignal(
  ms: number,
  what: string,
  outer?: AbortSignal,
  firstData?: number
): { signal: AbortSignal; done: () => void; sawData: () => void } {
  const c = new AbortController();
  const timer = setTimeout(
    () => c.abort(new NoAnswerTimeout(`the gateway did not answer the ${what} in ${ms / 1000} s`)),
    ms
  );
  (timer as { unref?: () => void }).unref?.();
  // Only when it would fire first: a first-data window as long as the call is the call's deadline.
  const first =
    firstData !== undefined && firstData < ms
      ? setTimeout(
          () => c.abort(new NoAnswerTimeout(`the gateway sent no part of the model's answer in ${firstData / 1000} s`)),
          firstData
        )
      : undefined;
  (first as { unref?: () => void } | undefined)?.unref?.();
  const onOuter = () => c.abort(outer!.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: c.signal,
    done: () => {
      clearTimeout(timer);
      clearTimeout(first);
      outer?.removeEventListener("abort", onOuter);
    },
    sawData: () => clearTimeout(first),
  };
}

/**
 * `work`, or a rejection the moment `signal` aborts. The signal also goes into the fetch, but
 * mppx may be inside a request of its own (a top-up, a voucher retry) that never heard it, and
 * the queue must be released either way: a later call meeting mppx's in-flight guard fails fast,
 * which is the whole difference from waiting forever.
 *
 * The rejection says only that the caller stopped waiting, not what the call cost: mppx has not
 * yet rolled back a voucher it signed for a request that got no 2xx. Every caller therefore reads
 * the counter only after `settledWithin`, which holds the queue for at most the grace more.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Whether mppx has given its answer on a failed call within `graceMs`: true once the call's
 * `session.fetch` has settled (mppx's `doFetch` is over, so a voucher it kept is kept and one it
 * rolled back is back), or once the whole `work` has, which covers a call that never reached the
 * fetch. Only then does the counter say whether the call was paid for. The fetch is the one that
 * matters — a call aborted after its 2xx headers is answered the moment they arrived, however long
 * its body then takes to notice the abort.
 */
async function settledWithin(
  work: Promise<unknown>,
  fetching: Promise<unknown> | undefined,
  graceMs: number
): Promise<boolean> {
  const done = (p: Promise<unknown>) =>
    p.then(
      () => true,
      () => true
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([done(work), ...(fetching ? [done(fetching)] : []), grace]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `import()` survives the CommonJS transform only when the compiler cannot see it. `mppx` is
 * ESM-only, and `runtime/dist/index.js` is required by the Next server, so the import
 * has to stay an import at runtime rather than become a `require` at build time.
 */
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

/** Base units to the human-unit string mppx takes (`1500n` → `"0.001500"`). */
export function toHumanUsdc(base: bigint): string {
  const unit = BigInt(10) ** BigInt(TEMPO_DECIMALS);
  const whole = base / unit;
  const frac = (base % unit).toString().padStart(TEMPO_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/**
 * What the channel is opened with, base units. Two shapes, and exactly one per caller:
 *
 * - **explicit** — `maxDepositBase` and `topUpBase`, sized by the caller (a loop). Both or
 *   neither: a deposit with no top-up unit, or the reverse, is half of a sizing and the other half
 *   would silently come from a formula the caller meant to replace.
 * - **per call** — `maxCostBase × (maxSteps + 1)` and `maxCostBase`, for every caller that does not
 *   size its own channel, including its `maxSteps ≥ 1` refusal.
 *
 * A top-up of zero is refused on the explicit path: mppx would open a channel it can never refill,
 * and the first call past the deposit would stall rather than fail. A top-up above the deposit is
 * not refused: a loop floors the unit at one gate ask, and a loop with less than that left is still a
 * loop whose owner may spend it — the console's treasury check is what decides whether it opens.
 */
export function mppChannelSizing(
  opts: Pick<MppOpenRouterOptions, "maxCostBase" | "maxSteps" | "maxDepositBase" | "topUpBase">
): { maxDepositBase: bigint; topUpBase: bigint } {
  const explicit = opts.maxDepositBase !== undefined || opts.topUpBase !== undefined;
  if (explicit) {
    if (opts.maxDepositBase === undefined || opts.topUpBase === undefined) {
      throw new Error("MppOpenRouterTransport takes maxDepositBase and topUpBase together, or neither");
    }
    if (opts.topUpBase <= BigInt(0)) throw new Error("MppOpenRouterTransport needs topUpBase > 0");
    return { maxDepositBase: opts.maxDepositBase, topUpBase: opts.topUpBase };
  }
  if (opts.maxCostBase === undefined || opts.maxSteps === undefined) {
    throw new Error("MppOpenRouterTransport needs maxCostBase and maxSteps, or maxDepositBase and topUpBase");
  }
  if (opts.maxSteps < 1) throw new Error("MppOpenRouterTransport needs maxSteps ≥ 1");
  return { maxDepositBase: opts.maxCostBase * BigInt(opts.maxSteps + 1), topUpBase: opts.maxCostBase };
}

const defaultSessionFactory: MppSessionFactory = async (o) => {
  const { tempo, entryKey } = await dynamicImport("mppx/client");
  // mppx's default store, with one addition: every write is reported. The store is where the
  // manager keeps the descriptor and the signed cumulative, and it is written before the
  // request that the voucher pays for goes out — which is the only moment the console can learn
  // both in time to survive a kill. Per manager, in memory, like the default.
  const entries = new Map<string, MppChannelEntry>();
  const channelStore = {
    get: (key: string) => entries.get(key),
    set: (entry: MppChannelEntry) => {
      entries.set(entryKey(entry), entry);
      o.onChannelUpdate?.(entry);
    },
    delete: (key: string) => {
      entries.delete(key);
    },
  };
  return tempo.session.manager({
    account: o.account,
    rpcUrl: { [o.chainId]: o.rpcUrl },
    allowedChainIds: [o.chainId],
    maxDeposit: o.maxDeposit,
    topUpAmount: o.topUpAmount,
    channelStore,
  }) as MppSession;
};

/** A `ChatTransport` that pays for each call over MPP instead of presenting an operator key. */
export class MppOpenRouterTransport implements ChatTransport, DecideTransport {
  private readonly url: string;
  private readonly decisionsUrl: string;
  private readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly maxDeposit: string;
  private readonly topUpAmount: string;
  private readonly factory: MppSessionFactory;
  private session: MppSession | undefined;
  /** One in-flight open, so two concurrent steps of a loop share one channel. */
  private opening: Promise<MppSession> | undefined;
  /** The channel as mppx last wrote it to its store; undefined until one has opened. */
  private entry: MppChannelEntry | undefined;
  /** The gateway's last `tempo/session` challenge, off the last response that carried one. */
  private lastChallenge: unknown;
  /** The highest `spent` a receipt has reported, base units. */
  private spent = BigInt(0);
  /**
   * The tail of the request queue. One cumulative is signed per request on one channel, so two
   * requests in flight on the same transport would read and advance the same counter at once and
   * the delta each one commits would be the other's as well. So callers that share the channel
   * (a loop's concurrent steps, or a team's members, which are on the roadmap) have their model
   * calls queued here, and everything else about them — tool calls, proofs, chain writes — still
   * runs at the same time. Three back-to-back gateway round trips at 1–6 s each is nothing beside a
   * devnet write; a channel per caller is the roadmap answer if that is ever model-bound.
   *
   * `decide` rides the same queue as `chat` for the same reason: the cumulative it advances is the
   * one channel's.
   */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Calls given up on while still inside mppx: their grace ran out before `session.fetch` settled.
   * mppx refuses a second request while one is in flight, unsigned, so a call made meanwhile cannot
   * have bought anything — but the counter it reads can still move under it, when the abandoned
   * call signs or rolls back. Its failure is therefore never classified as paid by the counter.
   */
  private abandoned = 0;
  /** Where this transport's channels opened, once known; access-key accounts only. */
  private readonly openBlocks: OpenBlockTracker;

  constructor(private readonly opts: MppOpenRouterOptions) {
    if (!opts.account?.address) throw new Error("MppOpenRouterTransport needs a Tempo account");
    const sizing = mppChannelSizing(opts);
    this.url = opts.url ?? TEMPO_GATEWAY_URL;
    this.decisionsUrl = opts.decisionsUrl ?? TEMPO_DECISIONS_URL;
    this.chainId = opts.chainId ?? TEMPO_CHAIN_ID;
    this.rpcUrl = opts.rpcUrl ?? TEMPO_RPC_URL;
    this.maxDeposit = toHumanUsdc(sizing.maxDepositBase);
    this.topUpAmount = toHumanUsdc(sizing.topUpBase);
    this.factory = opts.sessionFactory ?? defaultSessionFactory;
    // Only a channel a loop key signs is ever read for its open block. `openBlock` exists to bound
    // the audit's `authorizedSigner` check, which only a `tempoKey` chain has; a treasury channel
    // learning it would put a key on every record and ledger row it writes, and those must keep the
    // keyless shape byte for byte.
    const reader = opts.account.accessKeyAddress
      ? opts.openBlockReader ?? (opts.sessionFactory ? undefined : rpcOpenBlockReader(this.rpcUrl))
      : undefined;
    this.openBlocks = new OpenBlockTracker(reader, () => this.notify(), opts.log);
  }

  /**
   * What every record of a call on `channelId` carries beyond the bracket: the key that signed it,
   * when the account is a loop's key (`payer` stays the root), and the channel's open block once it
   * is known. Both spread only when present, so a treasury record has neither key and serialises as
   * a keyless record does.
   */
  private keyed(channelId: string | undefined): Pick<TempoPayment, "signer" | "openBlock"> {
    const signer = this.opts.account.accessKeyAddress;
    const openBlock = this.openBlocks.get(channelId);
    return { ...(signer ? { signer } : {}), ...(openBlock ? { openBlock } : {}) };
  }

  /** The address every record of this session names as `payer`. */
  get payer(): string {
    return this.opts.account.address;
  }

  /** The channel, once one has been opened; undefined before the first call. */
  get channelId(): string | undefined {
    return this.session?.channelId;
  }

  /** Whether a channel is open and therefore whether there is anything to settle. */
  get opened(): boolean {
    return this.session?.opened ?? false;
  }

  /**
   * The channel's cumulative after the last paid call, base units as a decimal string, or
   * `undefined` before the first call has opened a session.
   *
   * Read by a caller that holds one channel across many steps — the console's per-loop channel —
   * so a row can say what the channel owes so far without re-reading the chain. The
   * per-call delta a record commits still comes from `payment`, which brackets one request; this
   * is the running total the same vouchers add up to, and it never moves on its own.
   */
  get cumulative(): string | undefined {
    return this.session ? big(this.session.cumulative).toString() : undefined;
  }

  /**
   * What the next process would need to close this channel, or undefined before one
   * has opened. The console writes it on the channel's ledger row; `onChannel` says when.
   */
  get recovery(): MppChannelRecovery | undefined {
    const e = this.entry;
    if (!e) return undefined;
    const openBlock = this.openBlocks.get(e.channelId);
    return {
      channelId: e.channelId,
      chainId: e.chainId,
      escrow: e.escrow,
      descriptor: e.descriptor,
      deposit: e.deposit.toString(),
      cumulative: e.cumulativeAmount.toString(),
      spent: (this.spent > e.cumulativeAmount ? e.cumulativeAmount : this.spent).toString(),
      endpoint: this.url,
      ...(this.lastChallenge ? { challenge: this.lastChallenge } : {}),
      opened: e.opened,
      // Spread, never `undefined`: the console writes this object to the ledger row as JSON, and a
      // treasury channel's row must carry no `openBlock` key at all.
      ...(openBlock ? { openBlock } : {}),
    };
  }

  /**
   * Runs `work` after everything already queued on this transport, whatever became of it. A
   * predecessor that threw must not take its successor with it — a refused voucher fails one
   * call, not the channel — so both settlements of the tail lead to the same place.
   */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private get callDeadlineMs(): number {
    return this.opts.callDeadlineMs ?? MPP_CALL_DEADLINE_MS;
  }

  private get abortGraceMs(): number {
    return this.opts.abortGraceMs ?? MPP_ABORT_GRACE_MS;
  }

  /**
   * What a failed `chat` or `decide` throws: `PaidCallFailed` with its voucher bracket when the
   * gateway holds a voucher for it, the error as it was otherwise. Shared so the two cannot drift.
   *
   * Whether the failure was paid for is the counter's answer, not the error's: mppx moves the
   * cumulative when it signs and puts it back only for a request that never got a 2xx. Moved means
   * the gateway holds a voucher for this call, and the record of it is owed whatever became of the
   * body. Unmoved is a refusal, which writes nothing. The counter is read only once
   * mppx has answered — an abort rejects before mppx's rollback has run.
   *
   * A call still inside mppx when the grace runs out has given no answer, and it is thrown as
   * unpaid: the conservative reading. Charging it would bill the owner for a voucher mppx may yet
   * roll back, and would fail the audit when it does (the next record opening below this one's
   * close). If it does settle paid, the channel holds a voucher no record names — the treasury
   * carries it, the console log says so, and `verifyChannels` reads it as a gap between calls
   * rather than a total that goes down.
   */
  private async failure(
    kind: string,
    e: unknown,
    t0: number,
    session: MppSession,
    cumulativeBefore: bigint,
    overlapped: boolean,
    work: Promise<unknown>,
    fetching: Promise<unknown> | undefined
  ): Promise<unknown> {
    if (!(await settledWithin(work, fetching, this.abortGraceMs))) {
      this.abandon(kind, t0, session, cumulativeBefore, fetching ?? work, e);
      return e;
    }
    this.logCall(kind, t0, cumulativeBefore, session, e);
    const after = big(session.cumulative);
    if (after <= cumulativeBefore || overlapped) return e;
    this.notify();
    const status = (e as { status?: unknown })?.status;
    return new PaidCallFailed(
      (e as any)?.message ?? String(e),
      {
        rail: "tempo",
        chainId: this.chainId,
        payer: this.payer,
        channelId: session.channelId ?? "",
        cumulativeBefore: cumulativeBefore.toString(),
        cumulativeAfter: after.toString(),
        // The bracket a failed call records names its signer as a successful call's does: the
        // audit holds every voucher on a key-signed channel to the key, failed or not.
        ...this.keyed(session.channelId),
      },
      // A failure after 2xx headers carries the 200 it streamed under, which is not the
      // call's outcome; only a failure status the gateway kept the voucher for is recorded.
      typeof status === "number" && (status < 200 || status >= 300) ? status : undefined,
      // Our own deadline, said so the runtime need not parse the message: it is the one paid
      // failure that means the model got nothing out in time. Absent otherwise, so for every other
      // cause the error is built without it.
      NoAnswerTimeout.is(e) ? true : undefined
    );
  }

  /**
   * A call given up on inside mppx: counted in `abandoned` until its fetch settles, and logged
   * twice — now, and when mppx finally answers, with what the counter then says it cost — so an
   * operator reconciling the treasury can find a voucher no record names.
   */
  private abandon(
    kind: string,
    t0: number,
    session: MppSession,
    cumulativeBefore: bigint,
    pending: Promise<unknown>,
    e: unknown
  ): void {
    this.abandoned++;
    const log = this.opts.log;
    const message = (e as any)?.message ?? String(e);
    log?.(
      `tempo ${kind}: ${((Date.now() - t0) / 1000).toFixed(1)} s, still inside mppx ` +
        `${this.abortGraceMs / 1000} s after it was abandoned, recorded as unpaid: ${message}`
    );
    const settle = () => {
      this.abandoned--;
      const moved = big(session.cumulative) - cumulativeBefore;
      log?.(
        `tempo ${kind}: the call abandoned ${((Date.now() - t0) / 1000).toFixed(1)} s ago came out of mppx, ` +
          (moved > BigInt(0)
            ? `+${moved} base units vouchered that no record names — the treasury carries them`
            : `+0 base units`)
      );
    };
    pending.then(settle, settle);
  }

  /** The one line a paid call leaves in the console: kind, duration, the voucher delta, the outcome. */
  private logCall(kind: string, t0: number, before: bigint, session: MppSession, error?: unknown): void {
    if (!this.opts.log) return;
    const delta = big(session.cumulative) - before;
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    const outcome = error === undefined ? "ok" : `failed: ${(error as any)?.message ?? String(error)}`;
    this.opts.log(`tempo ${kind}: ${took} s, +${delta} base units, ${outcome}`);
  }

  private notify(): void {
    const recovery = this.recovery;
    if (recovery) this.opts.onChannel?.(recovery);
  }

  /** What a `PaymentResponse` carries beyond the body: the challenge it answered and its receipt. */
  private observe(res: Response): void {
    const r = res as Response & {
      challenge?: unknown;
      receipt?: { spent?: bigint | string; txHash?: string; channelId?: string } | null;
      channelId?: string | null;
    };
    if (r.challenge) this.lastChallenge = r.challenge;
    const spent = r.receipt?.spent;
    if (spent !== undefined && spent !== null && big(spent) > this.spent) this.spent = big(spent);
    // The open's receipt is the first paid response on a channel; its hash is turned into a block
    // in the background (`OpenBlockTracker`), never awaited here.
    this.openBlocks.observe(r.receipt, r.channelId ?? this.session?.channelId, this.entry?.escrow);
  }

  private async open(): Promise<MppSession> {
    if (this.session) return this.session;
    if (!this.opening) {
      this.opening = this.factory({
        account: this.opts.account,
        chainId: this.chainId,
        rpcUrl: this.rpcUrl,
        maxDeposit: this.maxDeposit,
        topUpAmount: this.topUpAmount,
        onChannelUpdate: (entry) => {
          this.entry = entry;
          this.notify();
        },
      })
        .then((s) => (this.session = s))
        .catch((e) => {
          // A factory that failed built nothing; the next call may try again, as `MppRpcSession`'s
          // may. Kept, the rejection would answer every later call for the life of the process.
          this.opening = undefined;
          throw e;
        });
    }
    return this.opening;
  }

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
    // The label rides the log line only, so a call without one logs as a plain `chat`.
    const kind = opts?.attempt ? `chat (${opts.attempt})` : "chat";
    // The whole bracket is inside the queue, not just the fetch: the delta this call commits is
    // the difference between two reads of one counter, and a read that straddled another call's
    // voucher would commit that call's price as well as this one's.
    return this.serialized(async () => {
      // A caller's absolute deadline is measured here, after the queue, because the time spent
      // waiting behind another call is time the caller no longer has. One that has already passed
      // is refused before `open()` and before any voucher is signed: nothing was bought.
      const ms = opts?.deadlineAt !== undefined ? opts.deadlineAt - Date.now() : this.callDeadlineMs;
      if (ms <= 0) throw new NoAnswerTimeout("the model call's time ran out before it could be sent");
      const session = await this.open();
      // Read before the fetch and after the body is drained: between the two lies exactly one
      // request, because `chatCore` returns only once the terminal frame has arrived.
      const cumulativeBefore = big(session.cumulative);
      const overlapped = this.abandoned > 0;
      // The first-data window only means something on a stream; a buffered body has no frames.
      const deadline = deadlineSignal(ms, "model call", opts?.signal, opts?.onToken ? opts.firstDataMs : undefined);
      const t0 = Date.now();
      // The fetch is kept apart from the call because it is mppx's part of it: once it settles,
      // the voucher is final whatever the body does after (`failure`).
      let fetching: Promise<Response> | undefined;
      const work = chatCore(
        async (url, init) => {
          fetching = session.fetch(String(url), init as RequestInit);
          const r = await fetching;
          this.observe(r);
          return r;
        },
        this.url,
        { "content-type": "application/json" },
        req,
        { ...opts, signal: deadline.signal, terminal: "receipt", onFirstData: deadline.sawData }
      );
      let res: ChatResult;
      try {
        res = await untilAborted(work, deadline.signal);
      } catch (e) {
        deadline.done();
        throw await this.failure(kind, e, t0, session, cumulativeBefore, overlapped, work, fetching);
      }
      deadline.done();
      this.logCall(kind, t0, cumulativeBefore, session);
      const cumulativeAfter = big(session.cumulative);
      // The challenge and the receipt arrived with this response; the row learns them now.
      this.notify();

      const payment: TempoPayment = {
        rail: "tempo",
        chainId: this.chainId,
        payer: this.payer,
        // The channel is opened by the first 402 inside that fetch, so the id exists by now.
        channelId: session.channelId ?? "",
        cumulativeBefore: cumulativeBefore.toString(),
        cumulativeAfter: cumulativeAfter.toString(),
        ...this.keyed(session.channelId),
      };
      // Recorded when the gateway returned one, absent otherwise — never defaulted to zero, which
      // would read as "the model was free" rather than "the gateway said nothing about it".
      const usageCost = res.body.usage?.cost;
      if (typeof usageCost === "number") payment.usageCost = usageCost;
      return { ...res, payment };
    });
  }

  /**
   * A typed decision on the same channel as the loop's chat calls, because it goes through the
   * same `session.fetch`: the voucher is signed by the same payer against the same TIP-1034
   * channel, which is the check `verify-step` makes on the blob.
   *
   * Non-streaming, one attempt, no retry here. A retry would sign a second voucher for a decision
   * the first attempt may already have bought, and the manifest could not tell the two apart;
   * the "unavailable" fallback belongs to the runner.
   *
   * The runner's 20 s deadline arrives as `opts.signal`, because a deadline the fetch never hears
   * about (a `Promise.race`) would let a decision landing at 21 s be vouchered for — 42 base units
   * the gateway keeps — and then thrown away as _unavailable_, so the channel would pay out more
   * than the chain's blobs bought and `verifyChannels` would say so. Two checks close it: an
   * already-aborted signal raises **before** `open()` and before any voucher is signed, so a
   * decision the runner has stopped waiting for is never bought at all; and the signal goes into
   * the fetch, so one that was signed for stops the moment the deadline passes instead of being
   * paid for and discarded.
   *
   * That closure holds for an abort before the headers. One after them — or a body cut short —
   * was still paid for, and raises `PaidCallFailed` with its voucher bracket as `chat` does, so
   * the runner can store the blob that records it.
   */
  async decide(req: DecideRequest, opts?: { signal?: AbortSignal }): Promise<DecideResult> {
    return this.serialized(async () => {
      // Before `open()`: the queue may have held this call past its deadline, and a channel
      // opened for a decision nobody is waiting for is a deposit for nothing.
      if (opts?.signal?.aborted) throw new Error("the decision was abandoned before it was paid for");
      const session = await this.open();
      // The same bracket as `chat`: read before the fetch, and again after the body is drained —
      // for a buffered response, after `decideCore` has read it to the end.
      const cumulativeBefore = big(session.cumulative);
      const overlapped = this.abandoned > 0;
      // The runner's own deadline is 20 s; this one is the backstop for a caller that sent none,
      // and `untilAborted` releases the queue whichever fires, as `chat` does.
      const deadline = deadlineSignal(this.callDeadlineMs, "decision", opts?.signal);
      const t0 = Date.now();
      let fetching: Promise<Response> | undefined;
      const work = decideCore(
        async (url, init) => {
          if (deadline.signal.aborted) throw new Error("the decision was abandoned before it was paid for");
          fetching = session.fetch(String(url), { ...(init as RequestInit), signal: deadline.signal });
          const r = await fetching;
          this.observe(r);
          return r;
        },
        this.decisionsUrl,
        { "content-type": "application/json" },
        req
      );
      let res: Awaited<ReturnType<typeof decideCore>>;
      try {
        res = await untilAborted(work, deadline.signal);
      } catch (e) {
        deadline.done();
        // `chat`'s rule, for the same reason: a deadline that fires after the 2xx headers,
        // or a body cut short, leaves a voucher the gateway keeps, and the runner owes the blob
        // that records it; one before them is rolled back by mppx and records nothing.
        throw await this.failure("decide", e, t0, session, cumulativeBefore, overlapped, work, fetching);
      }
      deadline.done();
      this.logCall("decide", t0, cumulativeBefore, session);
      const cumulativeAfter = big(session.cumulative);
      // The challenge and the receipt arrived with this response; the row learns them now.
      this.notify();

      const payment: TempoPayment = {
        rail: "tempo",
        chainId: this.chainId,
        payer: this.payer,
        channelId: session.channelId ?? "",
        cumulativeBefore: cumulativeBefore.toString(),
        cumulativeAfter: cumulativeAfter.toString(),
        // A decision rides the loop's channel, so it is signed by the same key as the loop's chat.
        ...this.keyed(session.channelId),
      };
      // Absent rather than zero, exactly as `chat` records it.
      const usageCost = res.body.usage?.cost;
      if (typeof usageCost === "number") payment.usageCost = usageCost;
      return { ...res.body, payment };
    });
  }

  /**
   * Settles the channel, once, at the end of the session or the loop. The caller records
   * `txHash` in the Resolution (or a `loop.settlement` Action) and reports a failure rather than
   * throwing it: a session whose calls were paid for is not failed by its receipt.
   */
  async close(): Promise<{ txHash?: string; spent?: string }> {
    const session = this.session;
    if (!session?.opened) return {};
    return settledBy(await session.close(), this.channelId);
  }
}

/**
 * A close's answer, or a throw when it proves nothing settled. mppx's `closeHttpSession` answers
 * `undefined` to a 2xx close that carries no `Payment-Receipt` (it refuses a receipt with no valid
 * `txHash` itself). Turned into `{ txHash: undefined }`, that would read as a settlement to every
 * caller: `AgentRuntime` and `LoopRunner` would record `closed: true`, the ledgered wrappers in
 * `_lib/tempo.ts` would drop the channel's recovery row, and a keyed loop's access key would be revoked
 * with its deposit possibly still in escrow. `closeChannelById` holds the opposite rule: with no
 * receipt nothing is known to have settled, and the row stays. A throw here gives every caller that
 * rule, through the path it already has for a failed close: `closed: false` with this reason, the row
 * kept for the restart's recovery, and the key kept.
 */
function settledBy(
  receipt: MppCloseReceipt | undefined,
  channelId: string | undefined
): { txHash: string; spent?: string } {
  if (!receipt?.txHash) {
    throw new Error(
      `the close of channel ${channelId ?? "(unknown)"} returned no receipt, so nothing is known to have settled`
    );
  }
  return { txHash: receipt.txHash, spent: receipt.spent === undefined ? undefined : String(receipt.spent) };
}

// ─── Tempo's paid RPC: a session to a service that is not a model ──────────────────────────────
//
// The same TIP-1034 session the model transport holds, opened by the same `tempo.session.manager`
// against `rpc.mpp.tempo.xyz` (it opens unchanged), with JSON-RPC in the body instead of a chat
// request. Paid by Lath as overhead, like Jev: nothing here is metered into anyone's USDC debit, and
// what a loop commits is the channel's cumulative inside the snapshot the reads produce.

export interface MppRpcSessionOptions {
  /** The account that pays: the operator treasury (`_lib/tempo.ts`). */
  account: TempoAccountLike;
  /** The channel's deposit and top-up unit, base units. A call is $0.001. */
  maxDepositBase: bigint;
  topUpBase: bigint;
  /** Defaults to `TEMPO_RPC_MPP_URL`. */
  url?: string;
  chainId?: number;
  rpcUrl?: string;
  /** Replaces the mppx session with a fake. Tests only. */
  sessionFactory?: MppSessionFactory;
  /** What a close of the channel needs, every time it changes, as `MppOpenRouterTransport` reports it. */
  onChannel?: (recovery: MppChannelRecovery) => void;
  /** How long one call may take, ms; `MPP_RPC_DEADLINE_MS` when unset. Tests pass a short one. */
  callDeadlineMs?: number;
  /** How long an abandoned call is given to come back out of mppx, ms; `MPP_ABORT_GRACE_MS` when unset. */
  abortGraceMs?: number;
}

/**
 * The most one paid JSON-RPC call on `rpc.mpp.tempo.xyz` may take, ms. A read answers in 1.5–3.9 s,
 * and the open, the slow one, in 5.9 s.
 *
 * Without a deadline, a gateway that accepted the connection and then stalled would hold the call for
 * undici's 300 s when it said nothing, and forever when it trickled bytes. The session serializes
 * every call, its `close` included, so a loop's stop would wait behind the stalled call to settle this
 * channel, and would wait to close the model channel too, which holds the loop's whole remaining
 * deposit.
 */
export const MPP_RPC_DEADLINE_MS = 30_000;

/**
 * JSON-RPC over a paid session. One call at a time, queued, for the reason the model transport
 * queues: one channel has one cumulative, and two vouchers signed
 * against it at once would race for the same counter. So a snapshot's three reads run one after the
 * other on the channel — at 1.5–3.9 s a call, which is what the interval absorbs and the carry rule
 * covers when it does not.
 */
export class MppRpcSession {
  private readonly url: string;
  private readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly factory: MppSessionFactory;
  private session: MppSession | undefined;
  private opening: Promise<MppSession> | undefined;
  private entry: MppChannelEntry | undefined;
  private lastChallenge: unknown;
  private spent = BigInt(0);
  private tail: Promise<unknown> = Promise.resolve();
  private id = 0;

  constructor(private readonly opts: MppRpcSessionOptions) {
    if (!opts.account?.address) throw new Error("MppRpcSession needs a Tempo account");
    if (opts.topUpBase <= BigInt(0)) throw new Error("MppRpcSession needs topUpBase > 0");
    this.url = opts.url ?? TEMPO_RPC_MPP_URL;
    this.chainId = opts.chainId ?? TEMPO_CHAIN_ID;
    this.rpcUrl = opts.rpcUrl ?? TEMPO_RPC_URL;
    this.factory = opts.sessionFactory ?? defaultSessionFactory;
  }

  get payer(): string {
    return this.opts.account.address;
  }

  get channelId(): string | undefined {
    return this.session?.channelId;
  }

  get opened(): boolean {
    return this.session?.opened ?? false;
  }

  /** The channel's signed total, base units as a decimal string; undefined before the first call. */
  get cumulative(): string | undefined {
    return this.session ? big(this.session.cumulative).toString() : undefined;
  }

  /** What the next process would need to close this channel; undefined before it opened. */
  get recovery(): MppChannelRecovery | undefined {
    const e = this.entry;
    if (!e) return undefined;
    return {
      channelId: e.channelId,
      chainId: e.chainId,
      escrow: e.escrow,
      descriptor: e.descriptor,
      deposit: e.deposit.toString(),
      cumulative: e.cumulativeAmount.toString(),
      spent: (this.spent > e.cumulativeAmount ? e.cumulativeAmount : this.spent).toString(),
      endpoint: this.url,
      ...(this.lastChallenge ? { challenge: this.lastChallenge } : {}),
      opened: e.opened,
    };
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private notify(): void {
    const recovery = this.recovery;
    if (recovery) this.opts.onChannel?.(recovery);
  }

  private async manager(): Promise<MppSession> {
    if (this.session) return this.session;
    if (!this.opening) {
      this.opening = this.factory({
        account: this.opts.account,
        chainId: this.chainId,
        rpcUrl: this.rpcUrl,
        maxDeposit: toHumanUsdc(this.opts.maxDepositBase),
        topUpAmount: toHumanUsdc(this.opts.topUpBase),
        onChannelUpdate: (entry) => {
          this.entry = entry;
          this.notify();
        },
      })
        .then((s) => (this.session = s))
        .catch((e) => {
          // A factory that failed built nothing; the next call may try again.
          this.opening = undefined;
          throw e;
        });
    }
    return this.opening;
  }

  /**
   * One JSON-RPC call on the channel. A JSON-RPC error, or a non-2xx, throws with what came back,
   * and so does a call still unanswered, its body included, at `MPP_RPC_DEADLINE_MS`.
   */
  call(method: string, params: unknown[] = []): Promise<unknown> {
    return this.serialized(async () => {
      const session = await this.manager();
      const ms = this.opts.callDeadlineMs ?? MPP_RPC_DEADLINE_MS;
      const deadline = deadlineSignal(ms, `RPC call ${method}`);
      // The signal reaches the fetch, which is what tells a real gateway to stop. `untilAborted`
      // releases the queue even when mppx is inside a request of its own that never heard it.
      const fetching = session.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: deadline.signal,
      });
      let res: Response;
      let text: string;
      try {
        res = await untilAborted(fetching, deadline.signal);
        const r = res as Response & { challenge?: unknown; receipt?: { spent?: bigint | string } | null };
        if (r.challenge) this.lastChallenge = r.challenge;
        const spent = r.receipt?.spent;
        if (spent !== undefined && spent !== null && big(spent) > this.spent) this.spent = big(spent);
        this.notify();
        text = await untilAborted(res.text(), deadline.signal);
      } catch (e) {
        // The next call signs its voucher against the same cumulative, so the queue is held until
        // mppx has put back one it signed for a request that got no answer, or for the grace at
        // most: the model transport's rule (`settledWithin`). The row then learns where the counter came to rest.
        if (deadline.signal.aborted) {
          await settledWithin(fetching, fetching, this.opts.abortGraceMs ?? MPP_ABORT_GRACE_MS);
          this.notify();
        }
        throw e;
      } finally {
        deadline.done();
      }
      if (!res.ok) throw new Error(`${method} failed (${res.status}): ${text.slice(0, 200)}`);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${method}: the answer is not JSON`);
      }
      if (body?.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
      return body?.result;
    });
  }

  /**
   * Opens the channel with a first call that is worth making: `eth_chainId`, held to the chain every
   * record names. The open is the slow call (5.9 s measured), so a loop fires this beside its
   * first step rather than inside a snapshot.
   */
  async open(): Promise<void> {
    const id = Number(BigInt(String(await this.call("eth_chainId"))));
    if (id !== this.chainId)
      throw new Error(`${this.url} answers chain ${id}, and this session pays on ${this.chainId}`);
  }

  /**
   * Settles the channel, once; `{}` when none was opened, and a throw when the close came back
   * with no receipt (`settledBy`). Queued behind any call still in flight.
   */
  close(): Promise<{ txHash?: string; spent?: string }> {
    return this.serialized(async () => {
      const session = this.session;
      if (!session?.opened) return {};
      return settledBy(await session.close(), session.channelId);
    });
  }
}

// ─── The charge intent: one Tempo transaction per call ──────────────────────────────────────────
//
// Everything above is the `session` intent, where a channel is the credential and the meter is a
// voucher delta. Tempo's storage gateway answers the other intent, `charge`: each call's 402 names
// a price, the payer signs one TIP-20 transfer for exactly that (pull mode, fee sponsored — the
// gateway broadcasts), and the receipt's `reference` is that transaction's hash. There is no
// channel to open or settle and nothing to recover after a kill, so none of the ledger machinery
// above applies. Nothing needs serialising either: mppx signs a charge with a
// TIP-1009 expiring nonce and binds each transfer's memo to its own challenge id, so two charges
// from the treasury at once, or a charge beside a channel open, never share a nonce or a hash.

/**
 * What one paid charge call records. `amount` is what the challenge asked and the payer signed,
 * base units as a decimal string; `recipient` is the challenge's, so a verifier can hold the
 * transfer the `reference` names to both. `reference` is the Tempo transaction hash off the
 * receipt, and `""` when no receipt came back for a call that was signed for — the payment may
 * have been broadcast and nothing here can say so, which is a different fact from "unpaid".
 */
export interface MppChargePayment {
  intent: "charge";
  chainId: number;
  payer: string;
  /** The access key that signed the transfer, when the account was one; absent for the treasury. */
  signer?: string;
  recipient?: string;
  amount: string;
  currency: string;
  reference: string;
}

/** What `MppChargeTransport.fetch` answers: the status, the body, and the payment when one was made. */
export interface MppChargeResult {
  status: number;
  bytes: Uint8Array;
  /** Absent on an answer nobody paid for: an unpaid 404, or a credential the gateway refused. */
  payment?: MppChargePayment;
}

/** The part of an mppx `Challenge` the ceiling reads. Structural, so a test can hand one in. */
export interface MppChargeChallenge {
  method?: string;
  intent?: string;
  request?: {
    amount?: string | number;
    currency?: string;
    recipient?: string;
    decimals?: number;
    chainId?: number;
    /**
     * `memo`: a memo the gateway asks to be written in place of mppx's attribution memo (mppx then
     * drops `clientId`). `splits`: further recipients the same transfer pays. Read only to refuse
     * them on a charge that must carry the loop's attribution (`MppChargeOptions.clientId`).
     */
    methodDetails?: { chainId?: number; memo?: unknown; splits?: unknown };
  };
}

/**
 * How a charge client is built, once per call. Injected by `tests/tempo-storage.ts`; the default is
 * mppx's own. `approve` is called with every 402 challenge **before** a credential is created, and
 * throws to refuse it — which is the only moment a refusal costs nothing, because a credential is a
 * signed transfer the gateway may broadcast.
 */
export type MppChargeClientFactory = (opts: {
  account: TempoAccountLike;
  chainId: number;
  rpcUrl: string;
  expectedRecipients?: readonly string[];
  /** mppx's `clientId`, present only when the transport was given one (`MppChargeOptions.clientId`). */
  clientId?: string;
  approve: (challenge: MppChargeChallenge) => void;
}) => Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;

/** Reads the `Payment-Receipt` a response carries, or `null` when it carries none. */
export type MppReceiptReader = (res: Response) => Promise<{ reference?: string } | null>;

/**
 * A charge refused before anything was signed: over the per-call ceiling, in a currency or on a
 * chain this payer does not pay in, a second challenge inside one call, or not a charge at all.
 * Thrown out of `fetch`, so a caller writes nothing for a call that was never paid for.
 */
export class ChargeRefused extends Error {
  constructor(message: string, readonly challenge?: MppChargeChallenge) {
    super(message);
    this.name = "ChargeRefused";
  }
}

/**
 * A call that was signed for and then failed before an answer came back — a connection cut after
 * the credential went out. The transfer may or may not have been broadcast, so `payment.reference`
 * is `""`: the caller records the call as failed with what it approved, the way a paid model call
 * whose body was lost is recorded (`PaidCallFailed`), and charges nobody for a transaction nothing names.
 */
export class PaidChargeFailed extends Error {
  constructor(message: string, readonly payment: MppChargePayment) {
    super(message);
    this.name = "PaidChargeFailed";
  }
}

export interface MppChargeOptions {
  /** The account that signs every transfer: the operator treasury (`_lib/tempo.ts`). */
  account: TempoAccountLike;
  /**
   * The most one call may cost, base units. Checked against the challenge before a credential is
   * created, so a gateway that re-prices a call past it is refused rather than paid: the loop's
   * owner is debited what the challenge said, and nothing else bounds a single call.
   */
  maxCostBase: bigint;
  /** The token every challenge must be priced in (USDC.e). Unset accepts whatever the challenge names. */
  currency?: string;
  /**
   * The recipients a charge may pay, when the caller pins the payee: a keyed, scoped loop's storage
   * payee. Checked here before a credential is created — a challenge naming
   * anyone else, as its recipient or in a split, is a `ChargeRefused` — and handed to mppx as its own
   * allowlist too. mppx's check alone would throw from inside `createCredential`, after `approve`,
   * which this transport could only record as a call signed for; and a transfer the key's scopes do
   * not admit may be mined and revert, a fee for nothing on every step.
   */
  expectedRecipients?: readonly string[];
  /**
   * mppx's `clientId`: `keccak256(clientId)[0..9]` goes into bytes 15..24 of each transfer's MPP
   * attribution memo. Set to the loop id on a keyed loop's charges; unset, the memo keeps mppx's
   * anonymous zeros. With it set, a challenge that names a
   * memo or splits of its own is refused before anything is signed (`priced`).
   */
  clientId?: string;
  chainId?: number;
  rpcUrl?: string;
  /** Replaces mppx with a fake. Tests only. */
  clientFactory?: MppChargeClientFactory;
  /** Replaces `Receipt.fromResponse`. Tests only. */
  readReceipt?: MppReceiptReader;
  /** How long one call may take, its body included, ms; `MPP_CHARGE_DEADLINE_MS` when unset. Tests pass a short one. */
  callDeadlineMs?: number;
}

/**
 * The most one charge call may take, ms: the 402, the credential, the paid request and its body. A
 * 1.5 KB PUT answered in about a second, and this leaves room for a report of a few hundred KB on a
 * slow link.
 *
 * Without a deadline, a storage gateway that stalled after it accepted the connection would hold the
 * publish job for undici's 300 s, or forever while it trickled bytes. A loop's stop drains every
 * publish before it closes the model channel, so that channel would stay open for as long, with the
 * loop's remaining deposit in it.
 */
export const MPP_CHARGE_DEADLINE_MS = 60_000;

/**
 * What the default factory hands mppx's `tempo.charge`, apart so a test can read it without mppx.
 *
 * `clientId` is spread only when it is a non-empty string. mppx writes `keccak256(clientId)[0..9]`
 * into the attribution memo when it has one and ten zero bytes when it has none (`Attribution.encode`
 * tests truthiness), so a charge built without a loop's id passes mppx no `clientId` at all, and its
 * memo — and with it the transfer's bytes — is the anonymous one.
 */
export function chargeMethodParameters(o: Parameters<MppChargeClientFactory>[0]): Record<string, unknown> {
  return {
    account: o.account,
    expectedChainId: o.chainId,
    allowedChainIds: [o.chainId],
    rpcUrl: { [o.chainId]: o.rpcUrl },
    ...(o.expectedRecipients ? { expectedRecipients: o.expectedRecipients } : {}),
    ...(o.clientId ? { clientId: o.clientId } : {}),
  };
}

const defaultChargeClientFactory: MppChargeClientFactory = async (o) => {
  const { Mppx, tempo } = await dynamicImport("mppx/client");
  return Mppx.create({
    methods: [tempo.charge(chargeMethodParameters(o))],
    // Never the global `fetch`: the console makes unpaid requests too, and a polyfill would pay
    // for any of them that met a 402.
    polyfill: false,
    // One payment per call. mppx retries a 402 that follows a paid attempt up to three times, and
    // each retry is a new transfer; a call whose credential was refused is recorded as refused
    // rather than bought twice (the transport's no-retry rule for vouchers, held for transfers).
    maxPaymentRetries: 1,
    onChallenge: async (challenge: MppChargeChallenge, helpers: { createCredential: () => Promise<string> }) => {
      o.approve(challenge);
      return helpers.createCredential();
    },
  });
};

const defaultReceiptReader: MppReceiptReader = async (res) => {
  const { Receipt } = await dynamicImport("mppx");
  try {
    const r = Receipt.fromResponse(res);
    return { reference: typeof r?.reference === "string" ? r.reference : undefined };
  } catch {
    // No receipt header, or one that does not parse: the answer names no payment.
    return null;
  }
};

/**
 * The price a charge challenge names, base units. The gateway serialises the request after mppx's
 * own transform, so `amount` is already base units; a decimal string is read in the challenge's
 * `decimals` in case a gateway ever sends the human form. `null` is a price this payer cannot read,
 * which is refused rather than guessed at.
 */
export function chargeAmountBase(request: MppChargeChallenge["request"]): bigint | null {
  const raw = request?.amount;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw !== "string") return null;
  if (/^\d+$/.test(raw)) return BigInt(raw);
  const m = /^(\d+)\.(\d+)$/.exec(raw);
  const decimals = request?.decimals ?? TEMPO_DECIMALS;
  if (!m || m[2].length > decimals) return null;
  return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt(m[2].padEnd(decimals, "0"));
}

/** Pays one HTTP call per call, from `account`, never above `maxCostBase`. */
export class MppChargeTransport {
  private readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly factory: MppChargeClientFactory;
  private readonly readReceipt: MppReceiptReader;

  constructor(private readonly opts: MppChargeOptions) {
    if (!opts.account?.address) throw new Error("MppChargeTransport needs a Tempo account");
    if (opts.maxCostBase <= BigInt(0)) throw new Error("MppChargeTransport needs maxCostBase > 0");
    this.chainId = opts.chainId ?? TEMPO_CHAIN_ID;
    this.rpcUrl = opts.rpcUrl ?? TEMPO_RPC_URL;
    this.factory = opts.clientFactory ?? defaultChargeClientFactory;
    this.readReceipt = opts.readReceipt ?? defaultReceiptReader;
  }

  /** The address every payment this transport makes names as `payer`. */
  get payer(): string {
    return this.opts.account.address;
  }

  /** The per-call ceiling, base units. */
  get maxCostBase(): bigint {
    return this.opts.maxCostBase;
  }

  /** The payment a challenge asks for, or a `ChargeRefused` saying why it will not be made. */
  private priced(c: MppChargeChallenge): Omit<MppChargePayment, "reference"> {
    if (c.method !== undefined && c.method !== "tempo") {
      throw new ChargeRefused(`the challenge is for method ${c.method}, not tempo`, c);
    }
    if (c.intent !== "charge")
      throw new ChargeRefused(`the challenge's intent is ${c.intent ?? "unnamed"}, not charge`, c);
    const amount = chargeAmountBase(c.request);
    if (amount === null || amount <= BigInt(0)) {
      throw new ChargeRefused(`the challenge's amount ${String(c.request?.amount)} is not a price`, c);
    }
    if (amount > this.opts.maxCostBase) {
      throw new ChargeRefused(
        `the challenge asks ${amount} base units and one call may cost at most ${this.opts.maxCostBase}`,
        c
      );
    }
    const currency = c.request?.currency ?? "";
    if (this.opts.currency && currency.toLowerCase() !== this.opts.currency.toLowerCase()) {
      throw new ChargeRefused(`the challenge is priced in ${currency || "nothing"}, not ${this.opts.currency}`, c);
    }
    // mppx refuses another chain as well (`expectedChainId`); said here too so the refusal is this
    // module's, thrown before a client is even asked for a credential.
    const chain = c.request?.methodDetails?.chainId ?? c.request?.chainId;
    if (chain !== undefined && chain !== this.chainId) {
      throw new ChargeRefused(`the challenge is on chain ${chain}, not ${this.chainId}`, c);
    }
    // A charge that must name its loop. mppx writes a challenge's own `memo` in place of the
    // attribution memo and drops `clientId` (`tempo/client/Charge.js`), so the transfer would carry
    // the gateway's bytes and the audit's attribution check could never hold it to the loop; `splits`
    // add transfers to recipients no loop key's scope admits. Refused, so the call is an unpaid storage
    // call like an over-ceiling one — fail closed, rather than a paid charge nothing ties to the loop.
    // A charge without a `clientId` reads neither.
    if (this.opts.clientId) {
      const details = c.request?.methodDetails;
      if (details?.memo !== undefined && details.memo !== null && details.memo !== "") {
        throw new ChargeRefused(
          `the challenge names a memo of its own, which would replace this loop's attribution memo`,
          c
        );
      }
      const splits = details?.splits;
      if (splits !== undefined && splits !== null && (!Array.isArray(splits) || splits.length > 0)) {
        throw new ChargeRefused(`the challenge splits the payment to further recipients`, c);
      }
    }
    if (this.opts.expectedRecipients) {
      const allowed = new Set(this.opts.expectedRecipients.map((a) => a.toLowerCase()));
      const recipient = c.request?.recipient;
      if (typeof recipient !== "string" || !allowed.has(recipient.toLowerCase())) {
        throw new ChargeRefused(`the challenge pays ${recipient ?? "nobody"}, not a recipient this payer pins`, c);
      }
      const splits = c.request?.methodDetails?.splits;
      for (const split of Array.isArray(splits) ? splits : []) {
        const to = (split as { recipient?: unknown })?.recipient;
        if (typeof to !== "string" || !allowed.has(to.toLowerCase())) {
          throw new ChargeRefused(`the challenge splits the payment to ${String(to)}, not a pinned recipient`, c);
        }
      }
    }
    const signer = this.opts.account.accessKeyAddress;
    return {
      intent: "charge",
      chainId: this.chainId,
      payer: this.payer,
      // The loop's key, when it signs the transfer; spread so a treasury charge records no `signer`
      // key at all. No `openBlock`: a charge opens no channel.
      ...(signer ? { signer } : {}),
      ...(c.request?.recipient ? { recipient: c.request.recipient } : {}),
      amount: amount.toString(),
      currency,
    };
  }

  /**
   * One call. A refused charge throws `ChargeRefused` before anything is signed; a call signed for
   * that then failed throws `PaidChargeFailed`; anything else answers `{ status, bytes, payment }`,
   * with `payment` present exactly when the gateway accepted a credential — a paid 404 included,
   * because a GET of a key that is not there is still a call the gateway charged for.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<MppChargeResult> {
    let approved: Omit<MppChargePayment, "reference"> | undefined;
    let refused: ChargeRefused | undefined;
    const client = await this.factory({
      account: this.opts.account,
      chainId: this.chainId,
      rpcUrl: this.rpcUrl,
      ...(this.opts.expectedRecipients ? { expectedRecipients: this.opts.expectedRecipients } : {}),
      // Only a keyed loop's charges carry one; spread so every other charge asks its factory for a
      // client with no `clientId`. The payment record does not repeat it: the memo is on the transfer
      // `reference` names, where the audit reads it.
      ...(this.opts.clientId ? { clientId: this.opts.clientId } : {}),
      approve: (challenge) => {
        try {
          // A second challenge after one was paid for is the gateway asking again for a call it
          // has already been sent a transfer for; `maxPaymentRetries: 1` stops mppx asking, and
          // this stops a factory that does not.
          if (approved) throw new ChargeRefused("a second challenge inside one call", challenge);
          approved = this.priced(challenge);
        } catch (e) {
          refused = e instanceof ChargeRefused ? e : new ChargeRefused((e as Error)?.message ?? String(e), challenge);
          throw refused;
        }
      },
    });
    // One deadline over the whole call, the body included, following any signal the caller passed.
    // It fires as an ordinary failure below. Before a credential it rejects as it is, and
    // after one it is a `PaidChargeFailed` naming what was approved: the 502 Action the publish job
    // records for a signed call that got no answer.
    const ms = this.opts.callDeadlineMs ?? MPP_CHARGE_DEADLINE_MS;
    const deadline = deadlineSignal(ms, "charge call", init.signal ?? undefined);
    try {
      let res: Response;
      try {
        res = await untilAborted(client.fetch(url, { ...init, signal: deadline.signal }), deadline.signal);
      } catch (e) {
        if (refused) throw refused;
        if (!approved) throw e;
        throw new PaidChargeFailed((e as any)?.message ?? String(e), { ...approved, reference: "" });
      }
      // A 402 after the credential went out is the gateway refusing it — mppx hands that answer back
      // rather than paying again — and a refused credential moved nothing.
      const paid = approved && res.status !== 402 ? approved : undefined;
      const receipt = paid ? await this.readReceipt(res).catch(() => null) : null;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await untilAborted(res.arrayBuffer(), deadline.signal));
      } catch (e) {
        if (!paid) throw e;
        throw new PaidChargeFailed((e as any)?.message ?? String(e), { ...paid, reference: receipt?.reference ?? "" });
      }
      return {
        status: res.status,
        bytes,
        ...(paid ? { payment: { ...paid, reference: receipt?.reference ?? "" } } : {}),
      };
    } finally {
      deadline.done();
    }
  }
}

/** mppx reports the cumulative as a bigint; a fake or a JSON round-trip may hand back a string. */
function big(v: bigint | string | number | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (v === undefined || v === null || v === "") return BigInt(0);
  return BigInt(v);
}
