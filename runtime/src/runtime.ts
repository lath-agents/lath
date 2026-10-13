import { PublicKey } from "@solana/web3.js";
import {
  ActionPayload,
  AgentLogger,
  AppendPolicy,
  Bytes32,
  GOAL_REACHED_LINE,
  goalHash,
  CellWriteResult,
  DEFAULT_AGENT_DYNAMIC_CONFIG,
  ChainSignals,
  EpochCommit,
  EpochFlushTrigger,
  EpochStore,
  EpochCommitter,
  EventKind,
  LathClient,
  LogResult,
  Mailbox,
  MemoryTraceStore,
  hashPayload,
  payloadPreimage,
  PolicyRegistry,
  ResolutionStatus,
  RollupBatcher,
  TaskGraph,
  TraceStore,
  computeEpochHead,
  createEpochMerkleTree,
  encodeEpochBlob,
  epochLeaves,
  hex,
  idFromString,
  sha256,
  toBytes32,
  utf8,
} from "@lath/sdk";
import { AnchorFailed, AnchorQueue, AnchorState } from "./anchor";
import type { TempoServicesStop } from "./loop-tempo";
import { BillingBackend, NoopBilling, margin, toMicroUsdc, toMicroUsdcFromBase } from "./billing";
import {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatTransport,
  ChatUsage,
  NoAnswerTimeout,
  PaidCallFailed,
  TempoPayment,
  ToolCall,
  ToolSchema,
} from "./openrouter";
import { MPP_CALL_DEADLINE_MS } from "./transport/mpp";
import {
  AgentConfig,
  canonicalJson,
  policyDocument,
  policyVersionHash,
  RuntimePolicy,
  toRuntimePolicy,
} from "./policy";

/** The reserved tool name that hands work to a child agent. */
export const DELEGATE_TOOL = "delegate";

/**
 * The payment channel a session on the `tempo` rail spends through, as much of it as the runtime
 * touches (`MppOpenRouterTransport` is one). Structural rather than the class itself, so the
 * runtime carries no dependency on mppx or viem and a test can hand over a fake.
 *
 * The runtime does not open it — the transport does, lazily, on the first call — and does not
 * meter through it either: the delta a record commits comes from `ChatResult.payment`. What the
 * runtime owns is the *end* of it: one `close()` per session, whose receipt goes into the
 * Resolution.
 */
export interface TempoChannel {
  /** The agent's Tempo address; what every record of this session names as `payer`. */
  readonly payer: string;
  /** The channel, once the first call has opened one. */
  readonly channelId?: string;
  /** Whether there is anything to settle. */
  readonly opened: boolean;
  close(): Promise<{ txHash?: string; spent?: string }>;
}

/**
 * What became of the channel, reported on the session rather than thrown: a session
 * whose calls were paid for is not failed by its receipt, and a screen (or the console's restart
 * recovery) needs the channel id to retry a close that did not land.
 */
export interface TempoSettlement {
  payer: string;
  channelId?: string;
  /** False when `close()` threw, or when the process is leaving a channel open behind it. */
  closed: boolean;
  /** The settlement transaction, when the close returned one. */
  txHash?: string;
  /** What the channel paid out, USDC.e base units as a decimal string. */
  spent?: string;
  /** Why the close did not happen. */
  error?: string;
  /**
   * True when the channel is settled and the `loop.settlement` record is not written yet, because
   * the chain's journal still owes earlier writes; the loop's Retry writes it. Set on a
   * loop's snapshot only, and never part of the settlement blob the record hashes: that is built
   * from the settlement itself, so a record written by the Retry carries the bytes the original
   * write would have carried.
   */
  recordOwed?: boolean;
  /**
   * What the loop's Tempo services came to at the stop: the carry no
   * leaf named, the last snapshot, the close settlement's block and the RPC channel's close. Only on
   * a loop whose host pays those services; part of the settlement blob the record hashes, and kept
   * by the Retry's replay so an owed record carries the bytes the original would have.
   */
  services?: TempoServicesStop;
}

export interface ToolContext {
  sessionId: string;
  agentId: Bytes32;
  /** Micro-USDC charged so far in this session. */
  spentMicroUsdc: bigint;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /**
   * JSON Schema for the arguments, passed to OpenRouter verbatim — and held against
   * every call before `execute` runs (`toolArgumentsProblem`): `type`, `properties`, `required` and
   * `items`, which is all any tool here declares.
   */
  parameters?: Record<string, unknown>;
  execute(args: any, ctx: ToolContext): Promise<unknown>;
}

/**
 * What an Action records for a call to a name this runtime did not declare: `unknown:<name>`, never
 * the name itself.
 *
 * The host writes Actions under ids readers act on — `loop.step` is a checkpoint, `storage.put` and
 * `loop.settlement` feed the charge and settlement walks, `oracle.feed`, `delegate.<name>`,
 * `llm.<model>`, `zc.file_*` — and a model can call a function by any name it likes. Recorded as
 * given, an invented `loop.step` would be a 404 Action whose reference is `sha256("loop.step")`,
 * which `lath-audit` would read as a checkpoint and `verify-charge` as a settlement. No id the host
 * writes contains `:`, so nothing a model calls can land on one; a declared tool's id is unchanged,
 * and so is every record an honest chain already holds. An older chain with an unprefixed 404 keeps
 * verifying: the audit checks a checkpoint's status and leaf on its own.
 */
export const UNDECLARED_TOOL_PREFIX = "unknown:";

export function undeclaredToolId(name: string): string {
  return `${UNDECLARED_TOOL_PREFIX}${name}`;
}

/**
 * The longest string a tool is handed anywhere in its arguments, in UTF-16 code units: 16 Ki.
 *
 * Generous on purpose. The longest legitimate strings any tool here takes are a URL (`web.fetch_page`
 * — servers commonly stop at 8 KiB of request line) and a store value (1024 bytes), so this is twice
 * the one and sixteen times the other. A JSON string's length is honest, so this is not what stops a
 * crash — the type check is — but every argument is copied into the Action's args blob, the step's
 * trace and the next model request, and the tools run regexes and URL encoders over it: one bound
 * here is cheaper than one per tool.
 */
export const MAX_TOOL_STRING_CHARS = 16 * 1024;

/** How deep the check walks; an argument nested past it is refused rather than walked. */
const MAX_TOOL_ARG_DEPTH = 32;

/** The seven JSON Schema type names and what each admits. Any other name admits nothing. */
const JSON_TYPES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Why `args` cannot be handed to a tool declaring `parameters`, or `null` when it can.
 *
 * A tool's `execute` is written against its schema — `address` is a string, `ids` an array — and the
 * model chooses the arguments. Unchecked, `{"address": {"length": 3e9}}` would reach `new PublicKey`
 * and `new BN`, which zero-fill `length / 3` words before anything can refuse them, and V8 would abort
 * the console with every loop in it: a fatal error, not a throw, so no `try` around `execute` sees it.
 * The cure is upstream of every tool at once: the arguments must be a plain object, each declared
 * property must be of its declared JSON type (array items too), each `required` one must be there,
 * and no string anywhere may pass `MAX_TOOL_STRING_CHARS`. A property the schema does not declare is
 * left alone, as JSON Schema leaves it, because no tool reads one; it is still held to the string cap.
 *
 * `null` for an optional property counts as leaving it out. Models fill optional fields with `null`
 * routinely, every tool here reads a falsy optional as absent, and `null` has nothing to allocate.
 */
export function toolArgumentsProblem(parameters: Record<string, unknown> | undefined, args: unknown): string | null {
  if (!isPlainObject(args)) return `the arguments must be a JSON object, not ${jsonTypeOf(args)}`;
  return valueProblem(parameters ?? { type: "object", properties: {} }, args, "arguments", 0);
}

function valueProblem(schema: unknown, value: unknown, at: string, depth: number): string | null {
  if (typeof value === "string" && value.length > MAX_TOOL_STRING_CHARS) {
    return `${at} is ${value.length} characters; a tool takes at most ${MAX_TOOL_STRING_CHARS}`;
  }
  const s = (isPlainObject(schema) ? schema : {}) as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
    items?: unknown;
  };
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]).map(String);
    // Own keys only: `toString` is not a JSON type, and the prototype's would admit anything.
    if (!types.some((t) => Object.prototype.hasOwnProperty.call(JSON_TYPES, t) && JSON_TYPES[t](value)))
      return `${at} must be ${types.join(" or ")}, not ${jsonTypeOf(value)}`;
  }
  const nested = isPlainObject(value) || Array.isArray(value);
  if (!nested) return null;
  if (depth >= MAX_TOOL_ARG_DEPTH) return `${at} is nested deeper than ${MAX_TOOL_ARG_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = valueProblem(s.items, value[i], `${at}[${i}]`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  const properties = isPlainObject(s.properties) ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.map(String) : [];
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) return `${at}.${key} is required`;
  }
  for (const [key, v] of Object.entries(value)) {
    if (v === null && !required.includes(key)) continue;
    const declared = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
    const problem = valueProblem(declared, v, `${at}.${key}`, depth + 1);
    if (problem) return problem;
  }
  return null;
}

/** A child agent this session may hand work to via the `delegate` tool. */
export interface DelegateDefinition {
  name: string;
  description?: string;
  /** Built lazily so a session that never delegates never constructs a child runtime. */
  create(): AgentRuntime | Promise<AgentRuntime>;
}

/**
 * A delegation this agent has opened and not yet closed: the child is built, the mandate is in
 * its mailbox, the `Delegation` record and the graph edge are on this agent's chain, and what is
 * still owed is the `delegate.<name>` Action that says how it went.
 *
 * It exists because the two halves are separated in time for an orchestrator loop: the runner opens every member
 * serially on the orchestrator's chain, waits for all of them in parallel on their own chains, and closes them serially
 * again. Holding the open's own writes here rather than in a caller's arrays is what lets several be in flight at once
 * without their records interleaving in anyone's list.
 */
export interface OpenedDelegation {
  spec: DelegateDefinition;
  /** The child runtime `spec.create()` built. The caller runs its session. */
  worker: AgentRuntime;
  task: string;
  /** What both chains name this work: the child's `sessionId`, and the Delegation's reference. */
  taskId: string;
  /** The user the child's session debits, carried so a caller closes with what it opened. */
  user: PublicKey;
  /** The delegated capability spec, stored off-chain under the Delegation's `scope_hash`. */
  scope: unknown;
  /** The mandate waiting in the child's mailbox, when `structures` is on. */
  inbox?: { index: bigint; envelope: string };
  /** What this delegation wrote on **this** agent's chain: the Delegation, then the Action. */
  events: LogResult[];
  /** The mailbox send and the graph edge, in the order they landed. */
  cells: CellWriteResult[];
  /** Unix ms the open finished — the caller's clock, for a console showing a member's span. */
  openedAt: number;
}

/**
 * `delegateTo` wrote the Delegation and then could not finish the open. The Delegation is already
 * closed — `opened.events` holds it and the 500 Action after it — so a caller puts those records
 * with its own and treats the member as not run.
 */
export class DelegationFailed extends Error {
  constructor(readonly opened: OpenedDelegation, message: string) {
    super(message);
    this.name = "DelegationFailed";
  }
}

/**
 * Batch per-step actions into epochs (`sdk/src/rollup.ts`) instead of logging each one.
 * Genesis, delegations and resolutions are still written individually — they are what other
 * chains pair against — and every one of them flushes the pending epoch first, so the chain
 * stays dense and in order.
 */
export interface RollupOptions {
  /** Where epoch blobs go, keyed by root. `AnchoredEpochStore` makes them auditable. */
  store: EpochStore;
  /** Steps per epoch. Default `DEFAULT_AGENT_DYNAMIC_CONFIG.standardBatchSize`. */
  batchSize?: number;
  /** Timer flush, ms. Default 0: a session flushes at its own boundaries. */
  maxFlushDelayMs?: number;
  /**
   * Fee- and balance-aware batching (`ChainSignals` in the SDK): `true` reads the cluster's
   * recent priority fees and the payer's balance through the client; an object supplies or
   * tunes them. A session whose payer cannot afford an epoch fails with
   * `InsufficientPayerBalance` before the model is called and before anything is charged or
   * queued: the check runs at the top of every turn, and again right before a batched step's
   * charge. Off by default.
   */
  signals?: boolean | ChainSignals;
}

/** What `onEvent` reports as a session runs — every chain write and every batched step. */
export interface RuntimeEvent {
  type: "genesis" | "action" | "delegation" | "resolution" | "epoch" | "error" | "anchor";
  /** Hex agent id of the chain written to. */
  agentId: string;
  timestamp: number;
  seq?: string;
  head?: string;
  signature?: string;
  /** `action`: the tool, or `llm.<model>`. */
  toolId?: string;
  statusCode?: number;
  /** `action`: true when the step went into an epoch rather than its own record. */
  queued?: boolean;
  costUsd?: number;
  costMicroUsdc?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** `action`: a short rendering of what happened, for a console. */
  summary?: string;
  /**
   * `action` on the `tempo` rail: the voucher this call was paid with, exactly as the record
   * commits it. Absent on every vault-rail step, so a console that ignores the field shows a
   * vault step unchanged.
   */
  payment?: TempoPayment;
  /** `delegation`: the child. */
  childAgentId?: string;
  childAuthority?: string;
  task?: string;
  /** `epoch` */
  startSeq?: string;
  endSeq?: string;
  epochRoot?: string;
  steps?: number;
  /** `epoch`: what flushed it — a full batch, the timer, a low fee, or a milestone (`manual`). */
  trigger?: EpochFlushTrigger;
  /**
   * `epoch`: false when the commit landed but the blob is not on the backend — the locator cell
   * failed, or the upload did and the bytes fell back to the local store (`anchorError` says which).
   */
  anchored?: boolean;
  anchorError?: string;
  /** `epoch`: how many uploads the blob took before it landed or fell back (upload retries). */
  anchorAttempts?: number;
  /** `epoch`: the locator is queued for the store's next manifest cell rather than on chain yet. */
  anchorPending?: boolean;
  /**
   * `action`: the step was metered and not debited — batched under a backend with no `charge`.
   * A paid call this session's own `signal` cut short is not unbilled: it is charged its voucher
   * delta, because the gateway redeems it anyway.
   */
  unbilled?: boolean;
  /**
   * `action`: a chat attempt that got no answer, paid by Lath and debited from nobody. Its voucher is on `payment` as
   * for any paid call, and `costMicroUsdc` is `"0"`: the owner was charged nothing for it.
   */
  absorbed?: boolean;
  /** `error`: a background failure that did not stop the session, such as a timer flush. */
  error?: string;
  /** `resolution` */
  status?: SessionStatus;
  output?: string;
  reason?: string;
  /**
   * Set on an `anchor` event and on every record written through the anchor queue. A logged
   * event with `anchorState: "pending"` has an empty `signature` on purpose: the record is
   * journaled with its locally computed head and the transaction has not been sent yet.
   */
  anchorState?: AnchorState;
  anchorId?: string;
}

export interface AgentRuntimeOptions {
  client: LathClient;
  agentId: Bytes32;
  transport: ChatTransport;
  /** Batch per-step actions into epochs. Off by default: every action is its own record. */
  rollup?: RollupOptions;
  /** Observer for a console or a log. Never awaited; a throwing observer does not stop a session. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Clean agent configuration or full runtime policy. */
  policy: AgentConfig | RuntimePolicy;

  /** Where request/response JSON, tool I/O and outputs land. Default: in-memory. */
  store?: TraceStore;
  tools?: ToolDefinition[];
  delegates?: DelegateDefinition[];
  billing?: BillingBackend;
  /**
   * Operator margin on what a call cost: the voucher delta on a Tempo channel, or `usage.cost`
   * on the scripted transport (which is never charged). One margin: default `LATH_MARGIN`, 0.10;
   * see `toMicroUsdcFromBase`.
   */
  margin?: number;
  /**
   * The Tempo channel this session pays through, when it runs on that rail. The runtime closes
   * it once, after the closing epoch flush and before the Resolution, and puts the receipt in
   * the Resolution blob. Absent on the vault rail.
   *
   * A **loop** passes it to `LoopRunner` instead: the channel is per loop and the Resolution is
   * per step, so a loop settles once, in its own `loop.settlement` record.
   */
  tempo?: TempoChannel;
  /** Hard stop on assistant turns, independent of `maxCost`. Default 16. */
  maxSteps?: number;
  /**
   * A second, **unhashed** spend ceiling, micro-USDC, asked afresh every time the policy's
   * `maxCost` is checked. It is how a loop's one overall budget bounds each
   * session that draws on it: `maxCost` is hashed into every genesis through
   * `policy_version_hash`, so it holds the constant loop budget, and what is actually left of
   * that budget — which moves with every step — cannot live there without moving the policy hash
   * each step. Crossing it throws `LoopBudgetExhausted`, which resolves the session `aborted` like
   * any budget breach and tells a loop, by type rather than by wording, to stop `budget`.
   *
   * A function rather than a number because the remainder shrinks while a session runs: a team's
   * members run in parallel against the same budget, and each finished sibling is spend the next
   * check must see. `undefined` from it — or no option — is no second ceiling.
   * `StartOptions.spendCeilingMicroUsdc` overrides it per
   * session; this one is for a runtime someone else starts (a loop's member, built by the console).
   */
  spendCeilingMicroUsdc?: () => bigint | undefined;
  /** Per-step actions skip their compressed account by default. */
  compactActions?: boolean;
  /**
   * How long to wait before the one retry of a charge that never left this process.
   * Default `CHARGE_RETRY_DELAY_MS`; a test passes 0.
   */
  chargeRetryDelayMs?: number;
  /**
   * Also store each event's payload preimage under its `payload_hash`, so an auditor holding
   * only the chain can walk to the argument and result hashes inside it (`AgentLogger`'s option
   * of the same name). Off by default: it is a second store write
   * per event, and a session's own runtime already knows its leaves.
   *
   * Turn it on for any chain a third party will audit — without it `payload_hash` resolves to
   * nothing and `lath-audit --require-preimages` cannot pass.
   */
  storePayloads?: boolean;
  /**
   * v0.2 structures: a `Mailbox` this agent receives delegated work in, and a `TaskGraph` its
   * delegations are recorded in. On by default. Turning it off restores the v0.1 behaviour
   * exactly — events only — at the cost of the provable hand-off (see the class docs).
   */
  structures?: boolean;
  /**
   * Publish the policy document to this agent's `PolicyRegistry` the first time it is seen, so
   * `policy_version_hash` in every genesis event resolves to the rules it names. On with
   * `structures`; one cell per policy version, once, ever.
   */
  publishPolicy?: boolean;
  /** Structure ids, when one agent needs more than one of each. */
  mailboxId?: Bytes32;
  /**
   * Opt-in: keys *outside* this process allowed to deliver into this agent's mailbox, committed
   * as the header's allow-list root when the mailbox is created. Unset — every console caller —
   * the mailbox is `OwnerOnly`, and an in-process parent delivers with this agent's own key
   * (`deliverMandate`), so any number of parents can delegate to it. Never `Anyone`: then any
   * funded key could append a cell, and every append moves the owner's `seq` and `head`.
   *
   * The list must equal the one committed on chain, in the same order, for every runtime built
   * over this agent: an external sender's proof is built from this list, and the program checks
   * it against the root the header was created with, which can never be amended. It is never
   * added to at run time for that reason.
   */
  mailboxSenders?: PublicKey[];
  graphId?: Bytes32;
  registryId?: Bytes32;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** System prompt prepended to every session. */
  system?: string;
  /**
   * Journal every chain write this session makes and anchor it in the background. Absent: every
   * write is a transaction the session waits for — the option changes nothing for a caller that
   * does not pass it.
   *
   * `drain: true` makes the session wait for the queue at its boundaries, so a caller that
   * checkpoints the chain (a loop step) still reads a settled chain; `drain: false` returns as
   * soon as the resolution is journaled, which is what the console wants.
   *
   * The queue must be built with the same `billing` backend as this runtime: it is the queue,
   * not the session, that sends the charge a metered step carries.
   */
  anchor?: { queue: AnchorQueue; drain: boolean };
  /**
   * Retry a chat call the model got no answer out for: once more on the
   * policy's model, then once on its committed `fallbackModel` when it has one, all inside one
   * call's time. Absent — every caller but the console's loop steps — and a call is one attempt,
   * sent with no deadline or first-data window of its own.
   */
  noAnswer?: NoAnswerOptions;
}

/**
 * How `paidChat` retries a chat call that got no answer. Every field has
 * a default sized for the sandboxed step, whose model calls ZeroClaw abandons at 120 s
 * (`zeroclaw/patches/0003`): every attempt of one call has to be over before that.
 */
export interface NoAnswerOptions {
  /** All attempts of one call together, ms from when `paidChat` starts it. `CHAT_CALL_BUDGET_MS`. */
  callBudgetMs?: number;
  /**
   * How long each attempt but the last may go without the first frame of its answer, ms, by
   * attempt: `CHAT_FIRST_DATA_MS`. The last attempt has only the call's deadline.
   */
  firstDataMs?: readonly number[];
  /** The least time a retry is started with, ms; with less left, the call fails. `CHAT_MIN_ATTEMPT_MS`. */
  minAttemptMs?: number;
  /**
   * Asked before each retry: `true` lets it go, a string refuses it and is the reason the call
   * then fails with. An attempt that gets no answer is Lath's to pay, not the owner's (below), so
   * this is where the console holds retries to Lath's decision share for the loop — a retry is
   * never bought on a share that is already spent. Absent, every retry the time allows is made.
   */
  admitRetry?: () => true | string;
  /**
   * Told each attempt's voucher delta, base units, the moment an attempt that got no answer has
   * been recorded as Lath's: what the console adds to Lath's spend for the loop. A throw is
   * swallowed — the voucher is spent and recorded whatever an observer does.
   */
  onAbsorbed?: (costBase: bigint) => void;
}

/**
 * The time all attempts of one chat call share: the transport's one-call deadline, which already
 * sits under ZeroClaw's 120 s provider timeout with room for the host's own work around the call.
 * A retry adds no time; it spends what the first attempt did not use.
 */
export const CHAT_CALL_BUDGET_MS = MPP_CALL_DEADLINE_MS;

/**
 * How long attempt 1 and a same-model retry may go without the first `data:` frame of the answer,
 * ms. A frame is the model working — a reasoning delta, a role chunk, a token — and a call that is
 * producing them is left alone to the call's deadline however slowly it goes, so an 84 s call that
 * streams is not cut. What these windows cut is a call that sends nothing at all: a stalled model.
 * 45 + 25 leaves a fallback attempt at least ~35 s of the
 * 110, after the abort grace and the failed attempts' records.
 */
export const CHAT_FIRST_DATA_MS: readonly number[] = [45_000, 25_000];

/** A retry with less than this left of the call is not started: it could not answer in time. */
export const CHAT_MIN_ATTEMPT_MS = 10_000;

/**
 * The models one chat call may be tried on, in order: the policy's, the policy's again, and the
 * committed fallback when there is one. Never a model the policy does not name.
 */
export function chatAttemptModels(policy: Pick<RuntimePolicy, "model" | "fallbackModel">): string[] {
  return policy.fallbackModel ? [policy.model, policy.model, policy.fallbackModel] : [policy.model, policy.model];
}

/**
 * Whether a failed chat attempt means the model got no answer out, which is what may be retried:
 * the transport's own deadline (`NoAnswerTimeout`, paid or not), a paid stream that died after its
 * 2xx headers or answered a 5xx, or an unpaid 5xx from the gateway. Not a 4xx, not a refused
 * voucher, not a budget or admission refusal: those fail the same way on every attempt, and a
 * retry would only spend. The caller's own signal is the caller's to judge (`paidChat`).
 */
export function isNoAnswer(e: unknown): boolean {
  if (NoAnswerTimeout.is(e)) return true;
  // Tempo refusing a top-up past a loop key's limit can surface as a paid call cut mid-body; it is
  // the budget answering, and the console stops the loop on it (`withLimitRetry`), so it is never
  // a missing answer to try again.
  if (/SpendingLimitExceeded/.test(String((e as { message?: unknown } | null)?.message ?? ""))) return false;
  if (PaidCallFailed.is(e)) return e.timedOut === true || e.status === undefined || e.status >= 500;
  const named = (e as { name?: unknown } | null)?.name;
  const status = (e as { status?: unknown } | null)?.status;
  return named === "OpenRouterError" && typeof status === "number" && status >= 500;
}

/**
 * Every attempt of one chat call got no answer (`isNoAnswer`). Its own class so `start()` and a
 * loop can say *the model did not answer* rather than *the step failed*; the paid
 * attempts are each on the chain already, as failed `llm.*` Actions with their vouchers.
 */
export class ModelNoAnswer extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = "ModelNoAnswer";
  }

  /** By name as well as by class, for the reason `PaidCallFailed.is` gives. */
  static is(e: unknown): e is ModelNoAnswer {
    return e instanceof ModelNoAnswer || (e as { name?: unknown } | null)?.name === "ModelNoAnswer";
  }
}

/**
 * What a step of a goal loop is told.
 *
 * One message, not a schema: the plan the model writes back **is** the memory the next step
 * resumes from — memory is text on purpose — and `parseGoalPlan` reads the
 * shape out of it. So the shape has to be described in the words the model answers in.
 *
 * The terminal line comes from `GOAL_REACHED_LINE` rather than being typed again here, because
 * the parser is strict about it and a loop whose instruction and whose parser disagreed about
 * one character would never stop itself.
 */
function goalSystemMessage(goal: string): string {
  return [
    "You are one step of a loop working toward this goal:",
    goal,
    "Each step: read what you remember, do the single next thing that moves the goal forward, and end",
    "your answer with the plan in exactly this shape —",
    "DONE: <one line per thing finished, cumulative>",
    "NEXT: <one line per thing still to do, in order>",
    'OPEN: <one line per question you cannot settle yourself, or "none">',
    `When the goal is fully reached, make the last line of your answer exactly: ${GOAL_REACHED_LINE}`,
  ].join("\n");
}

/**
 * The conversation a session opens with — system prompt, goal, memory, prompt — exactly as
 * `start()` hands it to the turns.
 *
 * Out of `start()` and exported so the sandboxed executor (`zeroclaw/runtime.ts`) renders the sandbox's
 * `-m` message from the same array the in-process runtime would send, built by the same statements:
 * a step moved into a sandbox must not be told something else than it would have been told here.
 * `start()` builds its own conversation with this function, so the request bytes are the same either
 * way.
 *
 * `goal` is taken as given: `start()` trims it and passes the trimmed value (or `undefined`), and a
 * caller building the messages for a step must do the same.
 */
export function stepMessages(
  opts: Pick<StartOptions, "prompt" | "goal" | "memory"> & { system?: string }
): ChatMessage[] {
  const goal = opts.goal;
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  // After the policy's own system prompt and before the memory, which is the order the plan
  // depends on: the goal says what done looks like, the memory is the plan so far, and the
  // model is asked to extend the second toward the first. Putting it before the policy prompt
  // would let a loop's goal talk over the rules the policy hash commits to.
  if (goal) messages.push({ role: "system", content: goalSystemMessage(goal) });
  // Teams and gated loops are on the roadmap: this build tells no session a roster or why it
  // woke, so nothing sits between the goal and the memory.
  if (opts.memory) {
    messages.push({
      role: "system",
      content:
        `What you remember from ${opts.memory.from ?? "before"} (verified against the chain, sha256 ${
          opts.memory.hash
        }):\n` + opts.memory.text,
    });
  }
  messages.push({ role: "user", content: opts.prompt });
  return messages;
}

export interface StartOptions {
  /** The user whose balance is debited and who is named as `caller` in genesis. */
  user: PublicKey;
  prompt: string;
  /** Defaults to a hash of the prompt and the clock. */
  sessionId?: string;
  /** Overrides `user` as the genesis `caller_pubkey` (a child names its parent agent). */
  caller?: PublicKey;
  /** Ties a child session to the parent task. Defaults to `sessionId`. */
  taskId?: string;
  /**
   * A message waiting in this agent's mailbox that *is* this session's mandate. The runtime
   * checks that the cell at `index` commits to `envelope` and consumes it — a `close_cell`
   * folded into this agent's own chain — before the genesis event. Set by `runDelegation`;
   * an external producer can set it too.
   */
  inbox?: { index: bigint; envelope: string };
  /**
   * Text this session is told before the prompt, as what it remembered from before — a loop's
   * previous step. The genesis `input` commits to its hash, so a reader of the chain can see
   * what the session was resumed from, and the caller is expected to have fetched the bytes by
   * that hash and checked them before passing them here (`LoopRunner` does).
   */
  memory?: { text: string; hash: string; from?: string };
  /**
   * What this session's loop is working toward, when it has a goal.
   * The session is told it in one system message before the memory, and the genesis `input`
   * commits `goalHash` beside `memoryHash`, so a reader of the chain sees what the step was for
   * as well as what it resumed from. Absent on every session that is not a step of a goal loop,
   * which therefore opens with no goal message and commits no `goalHash`.
   */
  goal?: string;
  /**
   * Model tokens as they stream, called on the same `step` for every delta of that turn. The
   * transport has to support it (`ChatStreamOptions`); one that does not simply never calls it
   * and the session behaves as if it were unset.
   */
  onToken?: (delta: string, step: number) => void;
  /**
   * Abandons the model call in flight. Passed to `transport.chat` on every step, so a session
   * past its caller's deadline stops paying for a reply nobody is reading; the throw it
   * raises resolves the session, which is a record.
   */
  signal?: AbortSignal;
  /**
   * The session's outcome the moment the model is done with it — before the closing epoch
   * flush and the resolution. `status` is the model's outcome; the resolution record carries
   * the chain's, which differs only when the closing flush fails. With `anchor`, the flush is
   * a barrier (the epoch's locator cell must land before anything after it is journaled), so
   * this is the only place a console learns the answer before any of the session's writes.
   */
  onAnswer?: (answer: { output: string; status: SessionStatus; reason?: string }) => void;
  /**
   * The runtime's `spendCeilingMicroUsdc`, for this one session — what a `LoopRunner` passes to
   * every session of a step (session A, each member, session B), so the loop's remaining budget
   * bounds them without the console having to wire a closure into every runtime it builds. Wins
   * over the runtime's own when both are set: the caller starting the session knows its budget.
   */
  spendCeilingMicroUsdc?: () => bigint | undefined;
  /**
   * Told what this session has metered so far, every time a paid call is recorded — before the
   * session resolves, and whether or not it resolves at all — and while a `delegate` child runs,
   * with what the child has spent so far counted in `delegated`. It is how a `LoopRunner` meters a
   * step **live**: parallel members each asking "what is left?" must see what their siblings have
   * already spent, not only what finished siblings reported, or N members each spend the whole
   * remainder. A copy, never the session's own object; a throw from it is swallowed, because an
   * observer cannot be allowed to fail a call the gateway was already paid for.
   */
  onMeter?: (meter: Readonly<SessionMeter>) => void;
}

export type SessionStatus = "success" | "failed" | "aborted";

export interface SessionResult {
  sessionId: string;
  taskId: string;
  status: SessionStatus;
  /**
   * What the session's own work came to, before the chain was asked to take it.
   *
   * `status` is overwritten to `failed` when the closing drain or epoch flush rejects — which is
   * a write that failed and not work that failed, and it is what the Resolution record carries,
   * so it is what the chain says. A caller deciding something about the *work* — whether a loop
   * step produced a memory worth keeping for the step after it — has to ask this instead, or it
   * asks a question about the transaction and gets an answer about the model.
   */
  workStatus: SessionStatus;
  /** Final assistant text, or the failure message. */
  output: string;
  /** Assistant turns taken. */
  steps: number;
  /** Every event this session appended (genesis, actions, delegations, resolution). */
  events: LogResult[];
  /** Charged micro-USDC, margin included. */
  costMicroUsdc: bigint;
  /** Raw provider cost in USD, margin excluded. */
  costUsd: number;
  /** Chain head after the terminal resolution. */
  head: Bytes32;
  /**
   * The Resolution's `final_output_hash`: sha256 of the answer blob. Carried here so a caller
   * that must name the answer on chain has it without reading the Resolution's preimage back out
   * of the trace store.
   */
  outputHash: Bytes32;
  /** Why the session stopped, when it was not a clean finish. */
  reason?: string;
  /** The mailbox index this session consumed as its mandate, when it was delegated work. */
  consumedInbox?: bigint;
  /** Structure writes this session made: mailbox sends, dequeues, graph edges. */
  cells: CellWriteResult[];
  /** Epochs this session committed (`rollup` on). */
  epochs: EpochCommit[];
  /** Steps that went into epochs rather than their own records. */
  batchedSteps: number;
  /**
   * Micro-USDC the session metered but could not debit: batched steps under a billing backend
   * with no `charge`. Reported, never folded into `costMicroUsdc`, which is what was charged.
   * The `maxCost` ceiling does count it — a step nobody billed is still a step the operator
   * paid OpenRouter for — so a session can abort on budget with `costMicroUsdc` at zero.
   */
  unbilledMicroUsdc: bigint;
  /**
   * Micro-USDC this session's `delegate` children reported spending, when any did. Kept
   * apart from `costMicroUsdc`, which stays this agent's own debits — a console that sums a
   * parent and its children would otherwise count the children twice — and counted by the
   * `maxCost` ceiling, because the parent is what caused the spend and the user reads one
   * budget. Absent when nothing was delegated, so every other session reports what it did.
   */
  delegatedMicroUsdc?: bigint;
  /**
   * USDC.e base units Lath paid for chat attempts that got no answer, which the owner was not
   * debited for: the vouchers are on the chain, each in its failed `llm.*`
   * Action. Absent when there were none, so no other session's report carries the field.
   */
  absorbedBase?: bigint;
  /**
   * With `anchor`: what the session left in the writer queue. `pending` is 0 after a drained
   * session; `seq`/`head` are the local chain tip, which is where the chain will stand once the
   * queue has emptied.
   */
  anchor?: { pending: number; failed: number; seq: string; head: string };
  /**
   * The `tempo` rail's channel and what closing it came to. Absent on the vault rail. A
   * `closed: false` here is a receipt that did not land, not a session that failed — the calls
   * were paid for, and the record of each of them carries its own voucher.
   */
  tempo?: TempoSettlement;
  /**
   * `sha256` of the replay record a sandboxed session wrote (`runtime/src/zeroclaw/replay.ts`), hex. A loop step's
   * checkpoint commits it as the manifest's thirteenth key. Absent on every in-process session, which has no record to
   * write: its tools ran in this process, and replay needs a step whose every input can be committed.
   */
  replayHash?: string;
  /**
   * The budget breach this session resolved `aborted` on, as it was thrown — a `BudgetExceeded`
   * for the policy's `maxCost`, a `LoopBudgetExhausted` for the unhashed spend ceiling. Carried so
   * a loop classifies the stop by type rather than by `reason`, whose wording is the chain's
   * sentence. Absent on every session that did not stop on a budget. Not persisted anywhere: the
   * Resolution blob keeps `reason` and nothing else.
   */
  budgetStop?: BudgetExceeded;
  /**
   * Why a `failed` session failed, when it is something a reader should not take for a fault in the
   * work: `no-answer`, every attempt of a model call got no answer (`ModelNoAnswer`). A loop
   * carries it to the step's row, which then says the model did not answer and the loop goes on
   * rather than a bare _failed_. Absent on every other session; not persisted on chain — the
   * Resolution keeps `reason`.
   */
  cause?: "no-answer";
  /**
   * The session's last `llm.*` Action, as a trace audit needs it: the
   * hashes of its args blob — the whole `ChatRequest`, which carries the conversation because each
   * call resends the history — and of its result blob, and the seq the record took. The session
   * holds no call bodies, so this is how a `LoopRunner` finds them: it `store.get`s both hashes,
   * which returns the plaintext the hashes commit, whatever the store keeps at rest.
   *
   * `seq` is the record's own on an unbatched session, and on a batched one the position the
   * Action took in the epoch that folded it, found after the flush by its payload hash; it is
   * absent only when that epoch is not among this session's (a flush that failed). Absent as a
   * whole on a session that made no model call — it failed before the first — which a trace audit
   * reports as _no trace_. Never persisted: nothing on chain or in a blob moves for it.
   */
  llmTail?: LlmTail;
}

/** The last `llm.*` Action of a session: see `SessionResult.llmTail`. */
export interface LlmTail {
  /** Decimal seq of the Action record, when it is known (see `SessionResult.llmTail`). */
  seq?: string;
  /** Hex `args_hash`: the blob of the `ChatRequest` the call sent. */
  argsHash: string;
  /** Hex `result_hash`: the blob of the body that came back (with `payment`), or `{ error, payment }`. */
  resultHash: string;
  /** Hex `payload_hash` of the Action, which is how a batched record's seq is found in its epoch. */
  payloadHash: string;
}

/**
 * The tail with its seq, when it had none: a batched Action has no record of its own, and its seq
 * is the index its payload hash took in the epoch that folded it, counted from `startSeq`. The last
 * match, because a session that asked the same thing twice with the same answer stores one pair of
 * blobs under one payload hash and the tail is the later of the two.
 */
function tailWithSeq(tail: LlmTail, epochs: readonly EpochCommit[]): LlmTail {
  if (tail.seq !== undefined) return tail;
  for (let e = epochs.length - 1; e >= 0; e--) {
    const inputs = epochs[e].inputs;
    for (let i = inputs.length - 1; i >= 0; i--) {
      if (hex(inputs[i].payloadHash) === tail.payloadHash) {
        return { ...tail, seq: (epochs[e].startSeq + BigInt(i)).toString() };
      }
    }
  }
  return tail;
}

/**
 * `policy.maxCost` was passed. Exported so a subclass that drives its turns some other way — the
 * sandboxed executor, whose model calls arrive through a proxy — can hand the same throw back to
 * `start()` and have the session resolve `aborted`, as a ReAct session over budget does.
 */
export class BudgetExceeded extends Error {}

/**
 * The unhashed spend ceiling (`spendCeilingMicroUsdc`) was crossed: what is left of a loop's one
 * overall budget is spent. A `BudgetExceeded`, so every path that already
 * turns a budget breach into an `aborted` session — `start()`, the sandbox's proxy — does the same
 * with this one; its own type, so a `LoopRunner` stops `budget` on it without reading the reason.
 * The call that crossed it was paid for, as with `maxCost`: what a call costs is known only once it
 * has been answered, so a loop overshoots its budget by at most the call in flight.
 */
export class LoopBudgetExhausted extends BudgetExceeded {
  constructor(readonly meteredMicroUsdc: bigint, readonly ceilingMicroUsdc: bigint, detail: string) {
    super(detail);
    this.name = "LoopBudgetExhausted";
  }
}

/**
 * What a session has metered so far, as one object so the helpers that record a step can move
 * it. `spent` is what was debited, `unbilled` what was metered and not debited, `delegated` what
 * children reported. The ceiling reads all three.
 */
export interface SessionMeter {
  spent: bigint;
  unbilled: bigint;
  delegated: bigint;
  costUsd: number;
  /**
   * USDC.e base units of chat attempts that got no answer, which Lath paid and nobody was debited
   * for. Never read by a ceiling: it is not the owner's spend. Optional, so a meter without it — a
   * test's, an observer's copy — is still a meter.
   */
  absorbed?: bigint;
}

/**
 * One running session, as the parts of `start()` that write to it need it: `runTurns`, `paidChat`
 * and `callTool`. `start()` builds it after the genesis and reads it back for the Resolution, so
 * whatever drives the turns — the ReAct loop here, or a subclass whose model calls arrive from a
 * sandbox — appends to the same lists and moves the same meter, and the session closes the same
 * way whichever one ran.
 */
/** Whichever of the given signals aborts first; undefined when none was given. */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const given = signals.filter((x): x is AbortSignal => !!x);
  return given.length <= 1 ? given[0] : AbortSignal.any(given);
}

export interface SessionCtx {
  readonly sessionId: string;
  readonly taskId: string;
  /** What `start()` was called with: the user every step debits, the caller's `signal`. */
  readonly opts: StartOptions;
  /** Every event this session appended, in the order the chain took them. */
  readonly events: LogResult[];
  readonly cells: CellWriteResult[];
  readonly meter: SessionMeter;
  /** Assistant turns taken: one per paid model call, counted by `paidChat` before it pays. */
  steps: number;
  /**
   * The last `llm.*` Action recorded, moved by every paid call: what `SessionResult.llmTail` is
   * built from once the epochs have been flushed and a batched record has a seq.
   */
  llmTail?: LlmTail;
}

/**
 * How the turns ended when nothing threw: the model answered (`success`), or the turns ran out
 * (`aborted`, with the reason). A throw is the third way, and `start()` sorts it — a
 * `BudgetExceeded` resolves `aborted`, anything else `failed`.
 */
export interface TurnsOutcome {
  status: SessionStatus;
  output: string;
  reason?: string;
}

/**
 * One paid model call, as the record of it needs it — the answer that came back, or the failure
 * of one the gateway was already paid for.
 */
interface LlmStep {
  req: ChatRequest;
  /** The blob `result_hash` commits: the body with `payment` beside it, or `{ error, payment }`. */
  result: unknown;
  statusCode: number;
  toolId: string;
  payment?: TempoPayment;
  stepUsd: number;
  usage?: ChatUsage;
  /**
   * Whether the amount is debited or only metered as unbilled. Both paid-call paths pass true: a
   * call this session's own `signal` cut (the `/api/run` deadline) is charged its delta too,
   * because its voucher is redeemed all the same.
   */
  billable: boolean;
  /**
   * A chat attempt that got no answer: recorded with its voucher, debited
   * from nobody, and metered as Lath's (`SessionMeter.absorbed`) rather than the owner's. Set only
   * by `paidAttempt` on a retrying runtime, with `billable` false.
   */
  absorbed?: boolean;
  summary?: string;
}
/** A step's debit did not land; the session resolves `failed` with this message. */
/** The pause before a charge that never left the process is tried once more. */
export const CHARGE_RETRY_DELAY_MS = 1500;

/**
 * True only for a failure that happened *before* the transaction was sent: the client could not
 * fetch a recent blockhash, so nothing was signed onto the wire and nothing can have landed.
 * That is the one failure a charge may be retried after without risking a double debit. A 429 or
 * timeout while sending or confirming is deliberately not here: the transaction may have landed,
 * and a double charge is a loss the payer cannot see.
 */
export function chargeNeverSent(e: unknown): boolean {
  return /failed to get recent blockhash|getLatestBlockhash|blockhash not found/i.test(
    `${(e as any)?.message ?? ""} ${String(e)}`
  );
}

export class ChargeFailed extends Error {
  constructor(readonly cause: unknown) {
    super(`billing charge failed: ${(cause as any)?.message ?? cause}`);
  }
}

/**
 * Runs a charge, and runs it once more after `delayMs` if the first attempt provably never left
 * the process (`chargeNeverSent`). The second failure, or any failure that may have landed,
 * propagates for the caller to wrap in `ChargeFailed`, which stops the loop.
 *
 * For `charge` alone, whose send fetches its blockhash before signing. Never `chargeAndLog`: its
 * write retries a blockhash failure inside `LathClient.logEvent`, so the error that surfaces may
 * follow an attempt that was sent, and only that call's in-doubt ledger knows it.
 */
async function chargeWithRetry<T>(delayMs: number, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!chargeNeverSent(e)) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return send();
  }
}

/** A short, single-line rendering of a tool result for an observer. */
function summarize(v: unknown): string {
  const text = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function toBlob(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return utf8(v);
  return utf8(JSON.stringify(v ?? null));
}

/**
 * Drives one agent session against OpenRouter and anchors every boundary crossing in Lath.
 *
 * The turn loop, `runTurns()` inside `start()`, is a ReAct kernel — one model turn, the tool
 * calls it asked for, the results back as the next turn's input — with `maxSteps` and
 * `policy.maxCost` as its only stops. What sets it apart from any other such loop is that the control flow is not a log the
 * process keeps: a genesis event opens the session, every LLM call and every tool call is an `Action`, a
 * `delegate` tool call is a `Delegation` plus a child session, and a terminal `Resolution`
 * closes it. Reasoning and read-only work are deliberately *not* logged (SPEC §3).
 *
 * Metering: OpenRouter's `usage.cost` (USD) is converted to micro-USDC with the operator
 * margin, rounded up, and charged through `BillingBackend.chargeAndLog` in the same
 * transaction as the LLM action. A failed charge aborts the step and resolves the session
 * `failed`; passing `maxCost` resolves it `aborted`. Neither can be silently absorbed — the
 * resolution event records which happened.
 *
 * On the `tempo` rail (`opts.tempo`) the meter is not `usage.cost` but the
 * voucher delta the transport hands back with the body: that is what left the agent's Tempo
 * wallet, and the gateway prices a request flat rather than per token, so the two are different
 * prices by construction and are never reconciled. `usage.cost` is recorded beside
 * the delta as `usageCost` and never charged. The user's side is unchanged — the same vault
 * debit, in the same transaction as the event — and what the session buys the user is the same;
 * only who pays the provider moves.
 */
export class AgentRuntime {
  readonly client: LathClient;
  readonly agentId: Bytes32;
  readonly store: TraceStore;
  readonly policy: RuntimePolicy;
  readonly policyVersionHash: Bytes32;
  readonly billing: BillingBackend;
  readonly margin: number;
  /** The channel this session pays the provider through, on the `tempo` rail only. */
  readonly tempo?: TempoChannel;
  readonly maxSteps: number;
  /** See `AgentRuntimeOptions.spendCeilingMicroUsdc`. */
  readonly spendCeilingMicroUsdc?: () => bigint | undefined;
  readonly compactActions: boolean;
  private readonly chargeRetryDelayMs: number;
  /** See `AgentRuntimeOptions.storePayloads`. */
  readonly storePayloads: boolean;
  readonly structures: boolean;
  readonly publishPolicy: boolean;
  /**
   * Where this agent *receives* delegated work: a consumable `Log` in its own namespace,
   * `OwnerOnly`, or an `AllowList` of `mailboxSenders` when that is configured (the owner can
   * append under either). `undefined` when `structures` is off.
   */
  readonly mailbox?: Mailbox;
  /** Where this agent *records* the work it hands out, one edge per delegation. */
  readonly graph?: TaskGraph;
  /** Where this agent publishes the policy its genesis events name. */
  readonly registry?: PolicyRegistry;
  /** Public so a `LoopRunner` can ask the same transport for a decision on the loop's channel. */
  readonly transport: ChatTransport;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly delegates: Map<string, DelegateDefinition>;
  /**
   * The clock. Protected so the sandboxed executor takes a step's `ZEROCLAW_NOW` from the same
   * clock the step's records are stamped with, which is also what makes it pinnable in a test.
   */
  protected readonly now: () => number;
  private readonly system?: string;
  /** Compact-mode logger for per-step actions; full-mode for the milestones. */
  private readonly steps: AgentLogger;
  private readonly milestones: AgentLogger;
  /** Present when `rollup` is on: per-step actions go here instead of `steps`. */
  readonly batcher?: RollupBatcher;
  /** The epoch store `rollup` was built with, for `flushAnchors`. */
  private readonly epochStore?: EpochStore;
  private readonly onEvent?: (event: RuntimeEvent) => void;
  /** Set when this runtime journals its writes instead of sending them; see the option. */
  readonly anchor?: { queue: AnchorQueue; drain: boolean };
  private epochsCommitted: EpochCommit[] = [];
  private batchedSteps = 0;
  /** See `AgentRuntimeOptions.noAnswer`. */
  private readonly noAnswer?: NoAnswerOptions;

  constructor(opts: AgentRuntimeOptions) {
    this.client = opts.client;
    this.agentId = opts.agentId;
    this.store = opts.store ?? new MemoryTraceStore();
    this.policy = toRuntimePolicy(opts.policy);
    this.transport = opts.transport;
    this.billing = opts.billing ?? new NoopBilling();
    this.margin = opts.margin ?? margin();
    this.tempo = opts.tempo;
    this.maxSteps = opts.maxSteps ?? 16;
    this.spendCeilingMicroUsdc = opts.spendCeilingMicroUsdc;
    this.compactActions = opts.compactActions ?? true;
    this.chargeRetryDelayMs = opts.chargeRetryDelayMs ?? CHARGE_RETRY_DELAY_MS;
    this.storePayloads = opts.storePayloads ?? false;
    this.structures = opts.structures ?? true;
    this.publishPolicy = opts.publishPolicy ?? this.structures;
    this.now = opts.now ?? Date.now;
    this.system = opts.system;
    this.tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.delegates = new Map((opts.delegates ?? []).map((d) => [d.name, d]));
    if (this.tools.has(DELEGATE_TOOL)) {
      throw new Error(`"${DELEGATE_TOOL}" is reserved; declare child agents via \`delegates\``);
    }
    // The prefix is what an undeclared call records; a declared tool under it would share an
    // id with whatever a model invents by the rest of the name.
    const prefixed = [...this.tools.keys()].filter((n) => n.startsWith(UNDECLARED_TOOL_PREFIX));
    if (prefixed.length) {
      throw new Error(`"${UNDECLARED_TOOL_PREFIX}" is reserved for undeclared calls: ${prefixed.join(", ")}`);
    }
    const declared = [...this.tools.keys(), ...(this.delegates.size ? [DELEGATE_TOOL] : [])].sort();
    // If tool allow list was not explicitly specified, default to declared tools
    const explicitTools = (opts.policy as any).toolAllowList ?? (opts.policy as any).tools;
    if (explicitTools === undefined && declared.length > 0) {
      this.policy.toolAllowList = declared;
    }
    const allowed = [...this.policy.toolAllowList].sort();
    const undeclared = declared.filter((n) => !allowed.includes(n));
    if (undeclared.length) {
      throw new Error(`tools not in the policy allow-list: ${undeclared.join(", ")}`);
    }
    this.policyVersionHash = policyVersionHash(this.policy);

    this.anchor = opts.anchor;
    this.noAnswer = opts.noAnswer;
    const shared = { store: this.store, now: this.now };
    // With an anchor queue the loggers journal instead of sending. Structures (cells) keep the
    // client: their heads fold `computeCellHead` over bytes this queue cannot predict, so they
    // stay synchronous (`runtime/src/anchor.ts`, header).
    const logging = { ...shared, storePayloads: this.storePayloads, writer: this.anchor?.queue.writer() };
    this.steps = new AgentLogger(this.client, this.agentId, { ...logging, compact: this.compactActions });
    this.milestones = new AgentLogger(this.client, this.agentId, { ...logging, compact: false });
    this.onEvent = opts.onEvent;
    if (opts.rollup) {
      this.epochStore = opts.rollup.store;
      const signals =
        opts.rollup.signals === true
          ? this.client.chainSignals()
          : opts.rollup.signals
          ? { ...this.client.chainSignals(), ...opts.rollup.signals }
          : undefined;
      this.batcher = new RollupBatcher(
        {
          batchSize: opts.rollup.batchSize ?? DEFAULT_AGENT_DYNAMIC_CONFIG.standardBatchSize,
          maxFlushDelayMs: opts.rollup.maxFlushDelayMs ?? 0,
          signals,
          // Every commit is recorded here, whichever trigger produced it: a `time` flush runs
          // from a timer and has no caller to hand its commit back to.
          onCommit: (commit) => this.recordEpoch(commit),
          onError: (e, trigger) =>
            this.emit({ type: "error", error: `epoch flush (${trigger}) failed: ${(e as any)?.message ?? e}` }),
        },
        this.anchor
          ? this.journalingCommitter(opts.rollup.store, this.anchor.queue)
          : this.client.createEpochCommitter(this.agentId, opts.rollup.store)
      );
    }
    if (this.structures) {
      // Never `Anyone`: that policy lets any key append a cell, and each append advances this
      // agent's `seq` and folds into its `head`. A header already on chain keeps the
      // policy it was created with — `ensureCreated` finds it and writes nothing — which is why
      // `deliverMandate` signs as the owner, the one key every policy admits.
      const senders = opts.mailboxSenders ?? [];
      this.mailbox = new Mailbox(this.client, this.agentId, opts.mailboxId ?? Mailbox.id("runtime-inbox"), {
        ...shared,
        ...(senders.length ? { senders: [...senders] } : { appendPolicy: AppendPolicy.OwnerOnly }),
      });
      this.graph = new TaskGraph(this.client, this.agentId, opts.graphId ?? TaskGraph.id("runtime-graph"), shared);
    }
    if (this.publishPolicy) {
      this.registry = new PolicyRegistry(
        this.client,
        this.agentId,
        opts.registryId ?? PolicyRegistry.id("runtime-policies"),
        shared
      );
    }
  }

  /**
   * The exact bytes `policyVersionHash` hashes. Publishing *these* is what makes a genesis
   * event's `policy_version_hash` resolve through `registry`. The document names `promptHash`
   * when the policy carries one; the prompt itself is a trace-store blob under that hash, so
   * the registry cell stays small.
   */
  get policyDocument(): string {
    return policyDocument(this.policy);
  }

  get authority(): PublicKey {
    return this.client.authority.publicKey;
  }

  /** Registers the agent's `AgentState` if it has none. Idempotent. */
  async ensureRegistered(): Promise<boolean> {
    const fresh = await this.milestones.ensureRegistered();
    await this.ensureStructures();
    return fresh;
  }

  /**
   * Puts a delegated mandate into this agent's mailbox, signed by **this** agent's key rather
   * than the delegating parent's. The parent holds this runtime (its factory built it), so it
   * holds the key too, and the owner is the one signer the program admits under every append
   * policy a `runtime-inbox` header can have (`create_cell`): `OwnerOnly`, the default; an
   * `AllowList` of any root, including a one-key root fixed to whichever parent delegated first;
   * and a legacy `Anyone`. So any number of parents can delegate to the same agent, which a
   * parent-signed allow-list cannot offer: its root is committed once and a second orchestrator
   * would be refused on every step.
   *
   * Nothing a reader relies on moves. A cell records no signer, and `key_slot` is still
   * `sha256(parent)` — the field `Mailbox.fromSender` and the hand-off check read — because it was
   * always a claim the writer makes, not a signature; the envelope names the parent as well. The
   * value slot is the mailbox's own encoding, so the consume check matches it byte for byte. What
   * differs from a parent-signed append is who signs and pays for it: the child, whose chain it
   * lands in.
   */
  async deliverMandate(
    from: PublicKey,
    envelope: string,
    opts: { tag?: number } = {}
  ): Promise<CellWriteResult & { index: bigint; slot: Bytes32 }> {
    if (!this.mailbox) throw new Error("this runtime has `structures` off, so it has no mailbox to deliver into");
    const { slot } = await this.mailbox.log.encode(envelope);
    const res = await this.client.createCell(this.agentId, this.mailbox.log.structId, {
      tag: opts.tag ?? 0,
      status: 0,
      keySlot: sha256(from.toBytes()),
      valueSlot: slot,
      // The owner branch of the program's check ignores the proof, so none is sent.
      timestamp: this.mailbox.log.now(),
    });
    return { ...res, index: res.cell.indexOrVersion, slot };
  }

  /**
   * Creates this agent's mailbox, task graph and policy registry, and publishes the policy.
   * Idempotent, and signed by **this** agent — a parent calls it on a child before sending
   * into the child's mailbox, because a structure lives in its owner's namespace and only its
   * owner can create it.
   */
  async ensureStructures(): Promise<void> {
    // Created eagerly: an `OwnerOnly` header has no root to fix
    // before a parent is known, so there is nothing to wait for, and a parent's `delegateTo`
    // finds the mailbox wherever the child was registered.
    if (this.mailbox) await this.mailbox.ensureCreated();
    if (this.graph) await this.graph.ensureCreated();
    if (this.registry) {
      await this.registry.ensureCreated();
      // `publish` proves *first* publication by proving the address did not exist, so a policy
      // already on the registry makes it fail — which is the success case on every run after
      // the first. Ask before writing rather than catching, so a real failure still throws.
      if (!(await this.registry.has(this.policyVersionHash))) {
        await this.registry.publish(this.policyDocument);
      }
    }
  }

  private emit(event: Omit<RuntimeEvent, "agentId" | "timestamp">): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({ agentId: hex(this.agentId), timestamp: this.now(), ...event });
    } catch {
      // An observer is a spectator; it must not be able to fail a session.
    }
  }

  private emitLogged(type: RuntimeEvent["type"], r: LogResult, extra: Partial<RuntimeEvent> = {}): void {
    // A journaled record comes back with no signature, because there is no transaction yet. Say
    // so rather than letting a console show an empty signature it cannot explain; the real one
    // arrives on the queue's `verified` transition.
    const anchorState: AnchorState | undefined = this.anchor && r.signature === "" ? "pending" : undefined;
    this.emit({ type, seq: r.seq.toString(), head: hex(r.head), signature: r.signature, anchorState, ...extra });
  }

  /**
   * Commits whatever is batched. Called before every individually logged write, so an epoch
   * always occupies the seqs it was given and nothing lands in the middle of it. An epoch `push`
   * committed on its own (`count`, `fee`, `time`) is not drained here — it was not this flush's —
   * and needs no drain for what follows it: a record journaled behind it is placed lazily (until
   * its locator cell has landed, `AnchorQueue.logEventInput`), a cell write drains first
   * (`writeCell`), and the next epoch drains before it is built (`AnchorQueue.epochTip`).
   */
  async flushEpochs(): Promise<EpochCommit | null> {
    if (!this.batcher) return null;
    const commit = await this.batcher.flush();
    // An epoch is a barrier when the writes are journaled: its locator cell folds into this
    // same chain at a seq only the confirmed commit reveals, so nothing may be journaled after
    // an epoch until that epoch — and the cell its `verified` transition writes — has landed.
    if (commit && this.anchor) await this.drainAnchor();
    return commit;
  }

  /**
   * Runs one synchronous cell write in the middle of a session — a tool's store write — without
   * breaking the chain's order.
   *
   * A cell write goes straight to the chain and folds bytes the queue cannot predict, so the
   * batched epoch and everything journaled ahead of it land first (the same barrier a delegation's
   * graph edge takes), and the queue is told afterwards that the chain has moved past the cell,
   * so its next read waits for an indexer that has seen it rather than handing out the cell's seq
   * a second time.
   */
  async writeCell(write: () => Promise<CellWriteResult>): Promise<CellWriteResult> {
    await this.flushEpochs();
    await this.drainAnchor();
    const result = await write();
    if (this.anchor) await this.anchor.queue.expect(this.agentId, BigInt(result.cell.opSeq) + 1n);
    return result;
  }

  /**
   * Waits for this agent's queue. Rejects with `AnchorFailed` when an entry is spent, which is
   * the caller's signal that the chain, not the work, is what failed.
   */
  private async drainAnchor(): Promise<void> {
    if (!this.anchor) return;
    await this.anchor.queue.drain(this.agentId);
  }

  /**
   * The `EpochCommitter` an anchored runtime batches into: it builds the root and the blob at
   * the *local* tip, uploads the bytes (the upload is not a chain write and has its own
   * fallback, so it stays on the path), and journals the commit instead of sending it. The
   * returned `EpochCommit` carries an empty signature for the same reason a journaled record
   * does — the transaction has not been sent yet.
   *
   * The locator cell is published from the entry's `verified` transition, because its head is
   * only computable once the epoch it follows is on chain.
   */
  private journalingCommitter(store: EpochStore, queue: AnchorQueue): EpochCommitter {
    return async (inputs): Promise<EpochCommit> => {
      if (inputs.length === 0) throw new Error("an epoch needs at least one step");
      // `epochTip`, not `tip`: an epoch `push` closed on a `count`, `fee` or `time` trigger has no
      // drain after it, unlike one `flushEpochs` closed, so this one may be built while the last
      // one's locator cell is still to land — at the seq that cell takes. `epochTip`
      // drains first whenever something ahead can still move the chain, which makes every epoch a
      // barrier for the next, whichever trigger closed it, at one confirmation per epoch.
      const { seq: startSeq, head: prevHead } = await queue.epochTip(this.agentId);
      const endSeq = startSeq + BigInt(inputs.length);
      const tree = createEpochMerkleTree(epochLeaves(startSeq, inputs));
      const blob = encodeEpochBlob(startSeq, inputs);
      // The bytes have to exist somewhere before the commit is journaled: a root the chain will
      // carry and nobody kept the steps for is worse than an epoch not committed at all.
      let anchorError: string | undefined;
      try {
        await store.put(tree.root, blob);
      } catch (e) {
        const fallback = (store as EpochStore & { fallback?: EpochStore }).fallback;
        if (!fallback) throw e;
        await fallback.put(tree.root, blob);
        anchorError = (e as any)?.message ?? String(e);
      }
      const head = computeEpochHead(prevHead, this.agentId, tree.root, startSeq, endSeq);
      // A blob that fell back to the local store is not on the backend, so there is no locator
      // to write — the same rule `finishEpochCommit` follows.
      const owesLocator = !!store.anchor && anchorError === undefined;
      await queue.enqueue(
        {
          kind: "epoch",
          agentId: hex(this.agentId),
          startSeq: startSeq.toString(),
          endSeq: endSeq.toString(),
          prevHead: hex(prevHead),
          head: hex(head),
          epochRoot: hex(tree.root),
          // Journaled alongside the commit, because the hook below is not: it closes over
          // `store` and dies with this process. The marker is what lets `flushAnchors` find an
          // epoch that some other process settled while nobody held the store.
          ...(owesLocator ? { locator: "owed" as const } : {}),
        },
        {
          onVerified: async () => {
            if (owesLocator) await store.anchor!(tree.root);
          },
        }
      );
      return {
        signature: "",
        epochRoot: tree.root,
        startSeq,
        endSeq,
        head,
        tree,
        blob,
        inputs,
        anchored: anchorError === undefined,
        // Whether the locator went on chain or into a manifest queue is not knowable here: it
        // is decided after the commit confirms. A console learns it from the `anchor` event.
        anchorPending: false,
        anchorError,
        anchorAttempts: 1,
      };
    };
  }

  /**
   * Publishes any epoch locators the store has queued for a manifest (`AnchoredEpochStore`
   * with `every > 1`). A store that anchors per epoch has nothing to flush. Call it when this
   * runtime is done for a while — a loop stopping, a process shutting down — so no epoch is
   * left on chain without a way to find its bytes.
   *
   * Writes nothing while the chain still carries journaled records. A locator or manifest cell is a direct write that
   * takes the next seq, and every record the journal holds was built for a seq of its own: publishing the locator of a
   * loop's unlanded epoch here, after an `anchor-failed` stop, would turn a retriable stop into `head diverged`. What
   * is skipped stays owed — on the entry, or in the store's manifest queue — and the Retry that drains the records is
   * what pays it.
   */
  async flushAnchors(): Promise<unknown> {
    if (this.anchor && (await this.anchor.queue.carried(this.agentId)).length > 0) return null;
    await this.publishOwedLocators();
    return this.epochStore?.flush?.() ?? null;
  }

  /**
   * Epochs this chain committed whose locator cell nobody wrote — the `onVerified` hook is in
   * memory, so a commit settled after a restart has no one to run it (`anchor.ts`, the note on
   * `AnchorEpochEntry.locator`). This runtime holds a store for the same chain, so it can pay
   * the debt the journal recorded.
   *
   * What it cannot reach is a chain no runtime opens again: for that the entry is the record
   * that a root has no pointer, and `reanchorEpochs` is the tool. A failure here leaves
   * the debt where it was — still owed, still findable — rather than dropping it.
   */
  private async publishOwedLocators(): Promise<void> {
    const store = this.epochStore;
    if (!this.anchor || !store?.anchor) return;
    for (const entry of await this.anchor.queue.locatorsOwed(this.agentId)) {
      const epochRoot = toBytes32(entry.epochRoot);
      try {
        await store.anchor(epochRoot);
        await this.anchor.queue.locatorPublished(entry);
        this.emit({ type: "anchor", epochRoot: entry.epochRoot, anchored: true });
      } catch (e) {
        this.emit({
          type: "anchor",
          epochRoot: entry.epochRoot,
          anchored: false,
          anchorError: (e as any)?.message ?? String(e),
        });
      }
    }
  }

  /**
   * One committed epoch, wherever it came from: this runtime's own flush, or a `push` that
   * filled the batch or found the fee market low. The trigger the batcher set travels with it,
   * so a console can say *why* the epoch closed.
   */
  private recordEpoch(commit: EpochCommit): void {
    this.epochsCommitted.push(commit);
    this.emit({
      type: "epoch",
      signature: commit.signature,
      head: hex(commit.head),
      startSeq: commit.startSeq.toString(),
      endSeq: commit.endSeq.toString(),
      epochRoot: hex(commit.epochRoot),
      steps: commit.inputs.length,
      trigger: commit.trigger,
      anchored: commit.anchored,
      anchorError: commit.anchorError,
      anchorAttempts: commit.anchorAttempts,
      anchorPending: commit.anchorPending,
    });
  }

  /**
   * One per-step action: stored, hashed, and either logged as its own (compact) record or
   * queued into the current epoch. Returns the record when there is one.
   */
  private async logAction(
    p: { toolId: string; args: any; result: any; statusCode: number },
    events: LogResult[],
    extra: Partial<RuntimeEvent> = {}
  ): Promise<LogResult | null> {
    if (!this.batcher) {
      const logged = (await this.steps.action(p)) as LogResult;
      events.push(logged);
      this.emitLogged("action", logged, { toolId: p.toolId, statusCode: p.statusCode, queued: false, ...extra });
      return logged;
    }
    const [argsHash, resultHash] = await Promise.all([
      this.store.put(toBlob(p.args)),
      this.store.put(toBlob(p.result)),
    ]);
    const payload: ActionPayload = {
      kind: EventKind.Action,
      toolId: p.toolId,
      argsHash,
      resultHash,
      statusCode: p.statusCode,
    };
    if (this.storePayloads) await this.store.put(payloadPreimage(payload));
    await this.batcher.push(payload, this.now());
    this.batchedSteps++;
    this.emit({ type: "action", toolId: p.toolId, statusCode: p.statusCode, queued: true, ...extra });
    return null;
  }

  /**
   * The record of one paid model call — an answer, or a failure the gateway was already paid for —
   * stored, hashed, charged and either batched or logged, with the session's meter
   * moved the moment the money has.
   *
   * The LLM step is the one event the runtime writes without `AgentLogger` — it goes through
   * `chargeAndLog` so the charge and the record share a transaction — so the preimage it would
   * have stored has to be stored here, or the dominant event kind in a session is the one an
   * auditor cannot walk.
   */
  private async recordLlmStep(
    step: LlmStep,
    user: PublicKey,
    events: LogResult[],
    meter: SessionMeter,
    // Told the Action's hashes the moment they are fixed — before the charge, which can throw — so
    // a session whose last call failed after it was recorded still names that call's trace.
    onTail?: (tail: LlmTail) => void
  ): Promise<void> {
    // The delta is already in micro units (USDC.e has six decimals) and never passes through a
    // float.
    const payment = step.payment;
    // An absorbed attempt is charged nothing: its amount is zero to every path below, so no charge
    // is journaled, composed or sent, and what it cost goes to `meter.absorbed` in base units.
    const deltaBase = payment ? BigInt(payment.cumulativeAfter) - BigInt(payment.cumulativeBefore) : 0n;
    const amount = step.absorbed
      ? 0n
      : payment
      ? toMicroUsdcFromBase(deltaBase, this.margin)
      : toMicroUsdc(step.stepUsd, this.margin);
    if (step.absorbed) meter.absorbed = (meter.absorbed ?? 0n) + deltaBase;
    meter.costUsd += step.stepUsd;

    const argsHash = await this.store.put(toBlob(step.req));
    const resultHash = await this.store.put(toBlob(step.result));
    const payload: ActionPayload = {
      kind: EventKind.Action,
      toolId: step.toolId,
      argsHash,
      resultHash,
      statusCode: step.statusCode,
    };
    if (this.storePayloads) await this.store.put(payloadPreimage(payload));
    const tail: LlmTail = {
      argsHash: hex(argsHash),
      resultHash: hex(resultHash),
      payloadHash: hex(hashPayload(payload)),
    };
    onTail?.(tail);
    const timestamp = this.now();
    const usage = step.usage;
    const usageFields: Partial<RuntimeEvent> = {
      costUsd: step.stepUsd,
      costMicroUsdc: amount.toString(),
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
      payment,
      ...(step.summary !== undefined ? { summary: step.summary } : {}),
      ...(step.absorbed ? { absorbed: true } : {}),
    };

    if (this.batcher) {
      // Batched: the charge cannot share a transaction with a record that does not exist
      // yet, so it goes first on its own and the step is queued only once it succeeded.
      const billable = step.billable && amount > 0n && !!this.billing.charge;
      if (billable) {
        // No second `admit` here. `paidChat` admitted this turn before the paid call, and by now
        // the gateway has been paid: a fresh balance read that throws — an RPC 429, or a payer that
        // dipped below one epoch's worth during a call longer than the sample — would leave before
        // the charge is journaled and before the push, so the treasury would have paid a voucher no
        // record names and the user would never be debited for it. The push below is `admitted`
        // for the same reason.
        try {
          // Journaled, the charge keeps its place in front of the step it pays for without
          // holding the session for a confirmation. A charge that will not land ends as a
          // `FAILED` entry, which is the chain failing, not the work.
          if (this.anchor) {
            await this.anchor.queue.enqueue({
              kind: "charge",
              agentId: hex(this.agentId),
              user: user.toBase58(),
              amountMicroUsdc: amount.toString(),
            });
          } else {
            await chargeWithRetry(this.chargeRetryDelayMs, () => this.billing.charge!(user, amount));
          }
        } catch (e) {
          throw new ChargeFailed(e);
        }
      }
      // Counted the moment the money moved and before the push, so a push that throws — a
      // count flush whose commit failed — still reports what was charged. Only a debit counts as
      // spend: a backend without `charge` leaves the step metered but unpaid, and the session
      // says so instead of reporting money that never moved.
      if (billable || amount === 0n) meter.spent += amount;
      else meter.unbilled += amount;
      // `admitted` in every case: the turn was admitted before its paid call, and a sample taken
      // since must not drop the only copy of a call the gateway has already been paid for.
      await this.batcher.push(payload, timestamp, { admitted: true });
      this.batchedSteps++;
      this.emit({
        type: "action",
        toolId: payload.toolId,
        statusCode: step.statusCode,
        queued: true,
        unbilled: !billable && amount > 0n ? true : undefined,
        ...usageFields,
      });
      return;
    }

    // Charge and log in one transaction; a charge failure aborts before the event lands.
    let logged: LogResult | null = null;
    try {
      if (this.anchor) {
        // Journaled, the charge travels *with* the record — the queue composes the backend's
        // `chargeIx` into the same transaction (SPEC §12), so the anchored path keeps the
        // property the synchronous one has. What it cannot keep is the ordering: a charge that
        // fails is discovered when the entry is sent, after the step has already been answered,
        // so it ends as a `FAILED` entry rather than a failed session.
        logged = await this.anchor.queue.logEvent(this.agentId, payload, {
          compact: this.compactActions,
          timestamp,
          charge: step.billable && amount > 0n ? { user, amountMicroUsdc: amount } : undefined,
        });
      } else if (step.billable) {
        // Sent once, never through `chargeWithRetry`: the charge rides on the record, and
        // `LathClient.logEvent` already retries a blockhash failure itself — with an in-doubt ledger
        // that finds an earlier attempt that did go out. A blockhash error surfacing here can be the
        // last of those attempts after an earlier one was forwarded, and a second `chargeAndLog`
        // starts a fresh ledger: a second Action and a second debit. Only `charge` above, whose
        // send fetches its blockhash before anything is signed, is retried out here.
        logged = await this.billing.chargeAndLog({
          user,
          amountMicroUsdc: amount,
          agentId: this.agentId,
          payload,
          compact: this.compactActions,
          timestamp,
        });
      }
    } catch (e) {
      throw new ChargeFailed(e);
    }
    if (step.billable) meter.spent += amount;
    else meter.unbilled += amount;
    const record =
      logged ?? (await this.client.logEvent(this.agentId, payload, { compact: this.compactActions, timestamp }));
    events.push(record);
    onTail?.({ ...tail, seq: record.seq.toString() });
    this.emitLogged("action", record, {
      toolId: payload.toolId,
      statusCode: step.statusCode,
      queued: false,
      unbilled: !step.billable && amount > 0n ? true : undefined,
      ...usageFields,
    });
  }

  /**
   * A tool's name as the model is allowed to see it.
   *
   * Lath names tools `namespace.verb` — `solana.slot`, `lath.verify_chain` — and that name
   * is what the policy hash commits to and what every Action record carries. The OpenAI function
   * schema most providers implement allows `[A-Za-z0-9_-]` only, and DeepSeek V4.1 Flash enforces
   * it: a dot is a 400 before a single step runs. So the dot becomes an underscore on the wire and
   * comes back on the way in. Nothing on chain changes, because nothing on chain is this name.
   *
   * Protected rather than private because the sandboxed executor's host tools go out under the
   * same wire names (`store_get`, `lath_verify_chain`), so the two must not drift.
   */
  protected static wireName(name: string): string {
    return name.replace(/\./g, "_");
  }

  /** The wire name back to the tool this runtime knows, or the name itself when it is already one. */
  protected toolName(wire: string): string {
    if (this.tools.has(wire)) return wire;
    for (const name of this.tools.keys()) if (AgentRuntime.wireName(name) === wire) return name;
    return wire;
  }

  /** The tool schemas handed to OpenRouter, including the synthetic `delegate` tool. */
  toolSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: AgentRuntime.wireName(t.name),
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }));
    if (this.delegates.size > 0) {
      schemas.push({
        type: "function",
        function: {
          name: DELEGATE_TOOL,
          description: "Hand a sub-task to another agent and wait for its result.",
          parameters: {
            type: "object",
            properties: {
              agent: { type: "string", enum: [...this.delegates.keys()], description: "Which agent to use." },
              task: { type: "string", description: "The sub-task prompt." },
              scope: { type: "object", description: "Optional capability scope for the delegate." },
            },
            required: ["agent", "task"],
          },
        },
      });
    }
    return schemas;
  }

  /**
   * Runs one session to completion and returns its outcome. Every path — clean finish, budget
   * stop, charge failure, tool crash, step ceiling — ends in exactly one `Resolution` event,
   * so a chain with a genesis and no resolution means the process died mid-session.
   */
  async start(opts: StartOptions): Promise<SessionResult> {
    const sessionId = opts.sessionId ?? `session-${hex(idFromString(`${opts.prompt}:${this.now()}`)).slice(0, 24)}`;
    const taskId = opts.taskId ?? sessionId;
    // Trimmed-empty is no goal at all. The console normalises a blank textarea away before it
    // reaches here; this is what keeps a caller that did not from
    // moving a session's genesis bytes and a loop's manifest with a goal made of whitespace.
    const goal = opts.goal?.trim() || undefined;
    const events: LogResult[] = [];
    const cells: CellWriteResult[] = [];
    this.batchedSteps = 0;

    // A session that opens on a chain with journaled records resubmits those first: the chain
    // is a hash chain, so a record that never landed at seq N blocks N + 1. A
    // `retry` puts the failed ones back under the head check; if the drain still rejects, this
    // throws `AnchorFailed` before a genesis is written, because the alternative is a session
    // whose records can never land.
    //
    // `retry` is unconditional because it loads this agent's journal on the way: a fresh
    // process has nothing in memory to test, and a journal that holds nothing makes it a no-op.
    if (this.anchor) {
      await this.anchor.queue.retry(this.agentId);
      await this.anchor.queue.drain(this.agentId);
    }

    // Anything still batched from an earlier session on this runtime (or a pending timer
    // flush) must land before the cell writes and the genesis below take their seqs.
    await this.flushEpochs();
    // The structures, the policy cell and the mandate below are synchronous writes the queue
    // never sees. The tip the genesis is journaled from is read through the same client that
    // made them, and `LathClient.getAgentState` waits for the indexer to show that client's
    // own last write — otherwise a session that opened right after those cells would seed its tip
    // from the state before them, and journal a head the chain could never confirm.
    await this.ensureRegistered();

    // The mandate comes first: before opening a session on delegated work, prove the work was
    // actually delivered to this agent. `consume` closes the mailbox cell, and the
    // `CellWritten{op: CLOSE}` fold in this agent's own chain is the receipt — an auditor
    // replaying it sees the acceptance ahead of the genesis event, in the same dense sequence.
    let consumedInbox: bigint | undefined;
    if (opts.inbox) {
      cells.push(await this.consumeMandate(opts.inbox));
      consumedInbox = opts.inbox.index;
    }

    const genesis = await this.milestones.genesis({
      sessionId,
      caller: opts.caller ?? opts.user,
      policyVersionHash: this.policyVersionHash,
      // `goalHash` rather than the goal: what done looks like is the owner's text, committed
      // without publishing it, exactly as `promptHash` commits the standing instruction. Spread
      // rather than written with an `undefined` value, so a session with no goal stores an input
      // blob with no goal key at all.
      input: {
        ...(opts.memory
          ? { prompt: opts.prompt, policy: this.policy, memoryHash: opts.memory.hash, memoryFrom: opts.memory.from }
          : { prompt: opts.prompt, policy: this.policy }),
        ...(goal ? { goalHash: goalHash(goal) } : {}),
      },
    });
    events.push(genesis);
    this.emitLogged("genesis", genesis);

    const messages = stepMessages({ ...opts, system: this.system, goal });

    const meter: SessionMeter = { spent: 0n, unbilled: 0n, delegated: 0n, costUsd: 0 };
    const s: SessionCtx = { sessionId, taskId, opts, events, cells, meter, steps: 0 };
    let status: SessionStatus = "success";
    let output = "";
    let reason: string | undefined;
    let budgetStop: BudgetExceeded | undefined;
    let noAnswer = false;

    try {
      ({ status, output, reason } = await this.runTurns(s, messages, opts));
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        status = "aborted";
        reason = e.message;
        budgetStop = e;
      } else if (e instanceof ChargeFailed) {
        status = "failed";
        reason = e.message;
      } else {
        status = "failed";
        reason = (e as any)?.message ?? String(e);
        // Read by type, never off `reason`, for the reason `budgetStop` is: the sentence is the
        // chain's and a reader that parsed it would miss the next wording.
        noAnswer = ModelNoAnswer.is(e);
      }
      output = reason ?? "";
    }

    // The answer exists now, whatever the chain does next; a console shows it here.
    if (opts.onAnswer) {
      try {
        opts.onAnswer({ output, status, reason });
      } catch {
        // An observer is a spectator; it cannot stop the session.
      }
    }

    // The closing flush is chain work like the session body's, so it is reported the same way:
    // a throw here must not skip the resolution and leave the chain with a genesis and nothing
    // after it. `createEpochCommitter` falls back to a local store when a blob upload fails, so
    // this is the second net — for a `commit_epoch` that will not land.
    // What the work came to, kept before the chain can overwrite it. The Resolution below carries
    // `status`, so the chain's account of a session whose drain failed is the transaction's; this
    // is for callers asking about the work rather than about the transaction.
    const workStatus = status;
    let tempo: TempoSettlement | undefined;
    try {
      // `drain: true` settles the chain before the closing flush, so a caller that checkpoints
      // the head here (a loop step) commits to the chain as it really is rather than to a tip
      // the queue has not reached yet. A drain that rejects is a write that failed, not work
      // that failed: the session still resolves, and its records wait in the journal for a
      // retry. The caller reads `anchor.failed` to see it.
      //
      // A drain that rejects must not skip the flush: the batch is the only copy of steps whose
      // charges are already journaled ahead of them (rollup.ts). Flushing into a halted queue is
      // safe — the journaling committer only appends — and the Resolution then journals lazily
      // behind the epoch, so `retry` lands the steps before the record that closes them.
      // The flush's own barrier drain rejects with the same `AnchorFailed` straight away, which
      // is what the catch below reports; with nothing batched, the saved failure is rethrown.
      let drainFailure: unknown;
      if (this.anchor?.drain) {
        await this.drainAnchor().catch((e) => {
          drainFailure = e;
        });
      }
      await this.flushEpochs();
      if (drainFailure !== undefined) throw drainFailure;
      // The channel closes here — after the last step's record is on its way and before the
      // Resolution, which is what carries the receipt. It returns its own failure rather than
      // throwing one: a session whose calls were paid for is not failed by its settlement, so
      // this cannot reach the `catch` below.
      tempo = await this.closeTempo();
    } catch (e) {
      status = "failed";
      reason = e instanceof AnchorFailed ? e.message : `epoch flush failed: ${(e as any)?.message ?? String(e)}`;
      // The flush failed before the close was reached. The channel still has to be settled —
      // money left open on a chain nobody is watching is the one failure mode with no record of
      // itself — and the session is already failed, so this cannot make it worse.
      if (!tempo) tempo = await this.closeTempo();
    }
    const resolution = await this.milestones.resolve({
      taskId,
      status:
        status === "success"
          ? ResolutionStatus.Success
          : status === "failed"
          ? ResolutionStatus.Failed
          : ResolutionStatus.Aborted,
      output: {
        output,
        reason,
        costMicroUsdc: meter.spent.toString(),
        unbilledMicroUsdc: meter.unbilled.toString(),
        // Only when a child spent something, so the blob of every session without a delegate
        // carries no such key.
        ...(meter.delegated > 0n ? { delegatedMicroUsdc: meter.delegated.toString() } : {}),
        // What Lath paid for attempts that got no answer, in base units, only when there were any:
        // the Resolution says the owner's `costMicroUsdc` left them out.
        ...((meter.absorbed ?? 0n) > 0n ? { absorbedBase: meter.absorbed!.toString() } : {}),
        costUsd: meter.costUsd,
        steps: s.steps,
        // The settlement of the `tempo` channel, on the record that closes the session it paid
        // for. Only when there is a transaction to name: a close that did not land leaves the
        // Resolution exactly as a vault session's, and the failure is reported on the snapshot.
        // The channel is named beside the transaction so a verifier walking past a session whose
        // close did not land can tell this settlement is another channel's, as it can for a
        // `loop.settlement`; the field is additive, and an older Resolution without it still reads.
        ...(tempo?.txHash
          ? {
              settlement: {
                txHash: tempo.txHash,
                spent: tempo.spent,
                ...(tempo.channelId ? { channelId: tempo.channelId } : {}),
              },
            }
          : {}),
      },
      totalStepCount: s.steps,
    });
    events.push(resolution);
    this.emitLogged("resolution", resolution, {
      status,
      output,
      reason,
      costMicroUsdc: meter.spent.toString(),
      costUsd: meter.costUsd,
    });

    // The resolution is the last record, so this is where a drained session waits for the whole
    // journal to land. A rejection here is reported, not thrown: the answer stands and the
    // records are still in the journal for the `FAILED` badge to retry.
    let anchorSummary: SessionResult["anchor"];
    if (this.anchor) {
      if (this.anchor.drain) {
        // Swallowed on purpose: the Resolution record already says what this session's status
        // was, and re-deciding it here would leave the chain and the return value disagreeing.
        // `anchor.failed` is what a caller checks — the loop's `anchor-failed` stop reads it.
        await this.drainAnchor().catch(() => undefined);
      }
      const tip = await this.anchor.queue.tip(this.agentId);
      anchorSummary = {
        pending: this.anchor.queue.pending(this.agentId).length,
        failed: this.anchor.queue.failed(this.agentId).length,
        seq: tip.seq.toString(),
        head: hex(tip.head),
      };
    }

    const epochs = this.epochsCommitted.splice(0);
    const llmTail = s.llmTail ? tailWithSeq(s.llmTail, epochs) : undefined;
    return {
      sessionId,
      taskId,
      status,
      workStatus,
      output,
      steps: s.steps,
      events,
      costMicroUsdc: meter.spent,
      costUsd: meter.costUsd,
      head: resolution.head,
      outputHash: resolution.outputHash,
      reason,
      consumedInbox,
      cells,
      epochs,
      batchedSteps: this.batchedSteps,
      unbilledMicroUsdc: meter.unbilled,
      ...(meter.delegated > 0n ? { delegatedMicroUsdc: meter.delegated } : {}),
      ...((meter.absorbed ?? 0n) > 0n ? { absorbedBase: meter.absorbed } : {}),
      anchor: anchorSummary,
      tempo,
      ...(budgetStop ? { budgetStop } : {}),
      ...(noAnswer ? { cause: "no-answer" as const } : {}),
      ...(llmTail ? { llmTail } : {}),
    };
  }

  /**
   * The ReAct kernel: one model turn, the tool calls it asked for, the results back as the next
   * turn's input, until the model answers without a tool call or `maxSteps` runs out. `messages`
   * is the conversation `start()` opened with — system prompt, goal, memory, prompt —
   * and grows as the turns go.
   *
   * Split out of `start()` so a subclass can drive the turns some other way (the sandboxed
   * executor, whose model runs in a sandbox and whose calls reach `paidChat` through a proxy) while
   * the Genesis before and the Resolution after stay `start()`'s, written by the same code. The
   * records are written by the same statements, in the same order, whichever drives the turns.
   */
  protected async runTurns(s: SessionCtx, messages: ChatMessage[], opts: StartOptions): Promise<TurnsOutcome> {
    while (s.steps < this.maxSteps) {
      const req: ChatRequest = {
        model: this.policy.model,
        messages: [...messages],
        temperature: this.policy.temperature,
        usage: { include: true },
      };
      const schemas = this.toolSchemas();
      if (schemas.length) req.tools = schemas;

      // `onToken` is what turns streaming on in the transport, so it is passed only when the
      // caller wants tokens: a session that does not is sent with no `stream: true`.
      // It reads the turn from `s.steps` when a delta arrives, which `paidChat` has already moved
      // to this turn's number before it calls the transport.
      const onToken = opts.onToken;
      const res = await this.paidChat(s, req, {
        onToken: onToken ? (delta: string) => onToken(delta, s.steps) : undefined,
      });

      const message = res.body.choices?.[0]?.message;
      if (!message) throw new Error("OpenRouter returned no choices");
      messages.push(message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) return { status: "success", output: message.content ?? "" };

      for (const call of calls) messages.push(await this.runToolCall(s, call));
      // Again after the tools, because a `delegate` call is the one tool that spends: the
      // child's cost lands in `meter.delegated`, and a parent over its budget must not buy
      // another turn on the strength of a check taken before the child ran. Without
      // a delegate nothing here moved the meter, so this is the check in `paidChat` repeated.
      this.checkCeiling(s.meter, this.spendCeilingOf(s));
    }
    const reason = `step ceiling reached (${this.maxSteps})`;
    return { status: "aborted", output: reason, reason };
  }

  /**
   * One paid model call and its record: admitted, sent, recorded — as an answer, or as a failure
   * the gateway was already paid for — and then held against the budget. The one path a
   * model call takes, whoever makes it: the ReAct loop above, or the sandbox's proxy, which is
   * what makes a call from inside the sandbox the same Action, the same charge in the same
   * transaction and the same ceiling as a call made here.
   *
   * Counts the turn in `s.steps` before anything else, so a turn refused
   * at admission is still a turn taken. A `PaidCallFailed` is recorded and rethrown; any other
   * throw from the transport wrote nothing and is rethrown as it is.
   */
  protected async paidChat(
    s: SessionCtx,
    req: ChatRequest,
    opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {}
  ): Promise<ChatResult> {
    // Taken first: a retrying call's time is ZeroClaw's 120 s per request, which was already running
    // when the proxy handed the call over, so the admission below spends it too.
    const startedAt = Date.now();
    s.steps++;
    // A loop budget that is already spent buys no call at all. Only the unhashed ceiling is
    // asked here, and only whether anything is left — `maxCost` keeps its after-the-call check
    // alone, so a session without a spend ceiling is not touched by this check.
    // Without this, a member started after session A used the budget up would still buy one call
    // before its first check, and so would each of its parallel siblings.
    this.checkSpendLeft(s.meter, this.spendCeilingOf(s));
    // Before the paid call, not at the push: a payer that cannot fund the epoch this step
    // would open is refused while nothing has been bought and nothing charged. Refusing at
    // `push` would come after both.
    if (this.batcher) await this.batcher.admit();
    if (!this.noAnswer) return this.paidAttempt(s, req, opts);
    return this.paidAttempts(s, req, opts, this.noAnswer, startedAt);
  }

  /**
   * One chat call as up to three paid attempts: the policy's model, the
   * same again, then the committed fallback — each its own voucher and its own `llm.*` Action, so
   * the channel stays contiguous and nothing is paid that the chain does not name. Only an attempt
   * that got no answer (`isNoAnswer`) is retried, and never one the caller's signal cut.
   *
   * One deadline for the whole call, from here: ZeroClaw abandons the request at 120 s, and an
   * answer that arrives after that reaches nobody. Each attempt but the last is also given a
   * first-data window and is streamed so the window can be measured — a call producing frames is
   * slow, not hung, and runs on to the deadline.
   *
   * Money: a paid attempt that got no answer is Lath's (`absorbed`, recorded `paidBy: "lath"`) and
   * moves no meter a ceiling reads, so the owner's `maxCost` and the loop's remainder are asked again
   * before a retry over the same meter they passed for the first attempt, and only the attempt that
   * answers is charged and checked after — the owner never pays more than one call's worth for one
   * call. What Lath may spend on retries is asked of `admitRetry` (the console: its decision share).
   */
  private async paidAttempts(
    s: SessionCtx,
    req: ChatRequest,
    opts: { onToken?: (delta: string) => void; signal?: AbortSignal },
    policy: NoAnswerOptions,
    startedAt: number
  ): Promise<ChatResult> {
    const deadlineAt = startedAt + (policy.callBudgetMs ?? CHAT_CALL_BUDGET_MS);
    const firstData = policy.firstDataMs?.length ? policy.firstDataMs : CHAT_FIRST_DATA_MS;
    const minAttemptMs = policy.minAttemptMs ?? CHAT_MIN_ATTEMPT_MS;
    const models = chatAttemptModels(this.policy);
    // Streaming is what makes a first-data window measurable. The request the record commits is
    // unchanged by it (`chatCore` adds `stream: true` on the wire only), and the body it commits is
    // the one `readStream` assembles — the shape every streamed session already records.
    const onToken = opts.onToken ?? (() => undefined);
    const gone = () => s.opts.signal?.aborted === true || opts.signal?.aborted === true;
    const failures: string[] = [];
    let tried = 0;
    for (let i = 0; i < models.length; i++) {
      if (i > 0) {
        if (deadlineAt - Date.now() < minAttemptMs) {
          failures.push(`no time left for attempt ${i + 1}`);
          break;
        }
        // A retry is a new paid call and answers to the checks a new call does — the policy's
        // ceiling and the loop's remainder, over a meter an absorbed attempt did not move — and to
        // the epoch admission, before anything is signed.
        this.checkCeiling(s.meter, this.spendCeilingOf(s));
        this.checkSpendLeft(s.meter, this.spendCeilingOf(s));
        // And Lath's share: an attempt that gets no answer is Lath's to pay, so a retry is asked of
        // the payer that would carry it. A refusal ends the call as one more missing answer.
        const admitted = policy.admitRetry ? policy.admitRetry() : true;
        if (admitted !== true) {
          failures.push(`no attempt ${i + 1}: ${admitted}`);
          break;
        }
        if (this.batcher) await this.batcher.admit();
      }
      const model = models[i];
      const last = i === models.length - 1;
      tried++;
      try {
        return await this.paidAttempt(
          s,
          model === req.model ? req : { ...req, model },
          { onToken, signal: opts.signal },
          {
            model,
            deadlineAt,
            ...(last ? {} : { firstDataMs: firstData[Math.min(i, firstData.length - 1)] }),
            label: `attempt ${i + 1} of ${models.length}, ${model}`,
          }
        );
      } catch (e) {
        if (!isNoAnswer(e) || gone()) throw e;
        failures.push(`attempt ${i + 1} (${model}): ${(e as any)?.message ?? String(e)}`);
      }
    }
    throw new ModelNoAnswer(
      `the model gave no answer after ${tried} attempt${tried === 1 ? "" : "s"}: ${failures.join("; ")}`,
      tried
    );
  }

  /**
   * One paid attempt and its record: sent, recorded — as an answer, or as a failure the gateway
   * was already paid for — and then held against the budget. `attempt` is set only by
   * `paidAttempts`; without it — every session but a console loop's — the call is one attempt,
   * sent with no deadline or first-data window of its own.
   */
  private async paidAttempt(
    s: SessionCtx,
    req: ChatRequest,
    opts: { onToken?: (delta: string) => void; signal?: AbortSignal },
    attempt?: { model: string; deadlineAt: number; firstDataMs?: number; label: string }
  ): Promise<ChatResult> {
    let res: ChatResult;
    try {
      res = await this.transport.chat(req, {
        onToken: opts.onToken,
        // A session the caller has abandoned must not leave its HTTP request running: on the
        // `tempo` rail that is an open channel signing vouchers for a stream nobody reads
        // A sandbox that closed this one request aborts it too.
        signal: anySignal(s.opts.signal, opts.signal),
        // Spread, so a call that is not an attempt hands the transport no attempt options.
        ...(attempt
          ? {
              deadlineAt: attempt.deadlineAt,
              ...(attempt.firstDataMs !== undefined ? { firstDataMs: attempt.firstDataMs } : {}),
              attempt: attempt.label,
            }
          : {}),
      });
    } catch (e) {
      if (!PaidCallFailed.is(e)) throw e;
      // The gateway was paid for this call whether or not its body arrived (mppx advances
      // the cumulative when it signs, and restores it only for a request that failed before
      // a 2xx). A record carrying the voucher keeps the channel contiguous for
      // `verifyChannels`; leaving it out would make the next record's `cumulativeBefore` jump.
      //
      // Charged like any call, whoever cut it — the provider, or our own signal. The gateway
      // redeems the voucher either way, so leaving it unbilled when the session's signal fired
      // would leave the operator paying for a stream the user's prompt ran past the deadline.
      // The amount is the voucher's delta, not a quote: exactly what was spent, and
      // this is the only record of the call, so it is charged once. A call the transport raised
      // before signing anything has a zero delta and moves nothing.
      //
      // Except an attempt that got no answer on a retrying runtime: the
      // owner bought nothing with it, so Lath pays its voucher and nobody is debited. The record
      // still carries the voucher — the channel stays contiguous — and says whose it was, as
      // `paidBy: "lath"` beside it, which is what `verifyChannels` accepts a zero debit against.
      // A call the caller's own signal cut is still the caller's, charged as above.
      const gone = s.opts.signal?.aborted === true || opts.signal?.aborted === true;
      const absorbed = !!attempt && isNoAnswer(e) && !gone;
      try {
        await this.recordLlmStep(
          {
            req,
            // `paidBy` only on an absorbed attempt, so every other failure stores `{ error, payment }`.
            result: absorbed
              ? { error: e.message, payment: e.payment, paidBy: "lath" }
              : { error: e.message, payment: e.payment },
            statusCode: e.status ?? 502,
            // The model this attempt asked for: the policy's on every call that is not a fallback
            // attempt, which is the id a call without retries carries.
            toolId: `llm.${attempt?.model ?? this.policy.model}`,
            payment: e.payment,
            stepUsd: 0,
            billable: !absorbed,
            ...(absorbed ? { absorbed: true } : {}),
            summary: summarize(e.message),
          },
          s.opts.user,
          s.events,
          s.meter,
          (tail) => (s.llmTail = tail)
        );
      } finally {
        this.reportMeter(s);
      }
      if (absorbed) {
        const costBase = BigInt(e.payment.cumulativeAfter) - BigInt(e.payment.cumulativeBefore);
        try {
          if (costBase > 0n) this.noAnswer?.onAbsorbed?.(costBase);
        } catch {
          // A spectator: the voucher is spent and recorded whatever it does.
        }
      }
      throw e;
    }
    // Which meter this step is charged on is decided by the receipt, not by a flag: the
    // transport returns a `payment` exactly when a voucher paid for the call. The voucher
    // goes into the blob the record hashes, beside the body rather than inside it, so
    // `result_hash` commits the Tempo payment that bought this completion and an auditor can
    // check the two against each other from the chain alone. With no payment the blob is the
    // body alone.
    const payment = res.payment;
    // `finally`: `recordLlmStep` can move the meter and then throw (a push whose count flush
    // failed after the charge), and money that moved is what a live reader has to be told about.
    try {
      await this.recordLlmStep(
        {
          req,
          result: payment ? { ...res.body, payment } : res.body,
          statusCode: res.status,
          // The model that served, as the gateway named it (a dated build, a fallback). An attempt
          // reads an empty name as none — a streamed body with no `model` in its chunks has `""` —
          // so its id is never the bare `llm.` the audit could not tie to a voucher.
          toolId: attempt ? `llm.${res.body.model || attempt.model}` : `llm.${res.body.model ?? this.policy.model}`,
          payment,
          stepUsd: res.body.usage?.cost ?? 0,
          usage: res.body.usage,
          billable: true,
        },
        s.opts.user,
        s.events,
        s.meter,
        (tail) => (s.llmTail = tail)
      );
    } finally {
      this.reportMeter(s);
    }

    this.checkCeiling(s.meter, this.spendCeilingOf(s));
    return res;
  }

  /**
   * Client-side ceiling, over everything the session *metered* rather than only what it
   * managed to debit. `Allowance.cap` enforces the same bound on-chain and sees
   * debits alone; this one is the session's own, and it has to see the rest, because in
   * rollup mode against a `BillingBackend` with no optional `charge` every step lands in
   * `unbilled` and `spent` never leaves 0 — the ceiling would never fire and the session
   * would run on to `maxSteps` with no budget in force.
   *
   * It runs *after* the step's charge, not before it: what a call costs is only known
   * once OpenRouter has answered, so the step that breaches the budget is paid for. What
   * this stops is the next one. Reporting stays split — `costMicroUsdc` is what moved,
   * `unbilledMicroUsdc` what did not — so the ceiling being generous is not the session
   * claiming money it never took. What a `delegate` child spent counts too: the
   * parent caused it, and `policy.maxCost` is the one budget the user reads.
   */
  protected checkCeiling(meter: SessionMeter, spendCeiling?: () => bigint | undefined): void {
    const metered = meter.spent + meter.unbilled + meter.delegated;
    if (metered > BigInt(this.policy.maxCost)) {
      const delegated = meter.delegated > 0n ? `, ${meter.delegated} by delegates` : "";
      throw new BudgetExceeded(
        `metered ${metered} µUSDC (${meter.spent} charged, ${meter.unbilled} unbilled${delegated}) of a ` +
          `${this.policy.maxCost} µUSDC budget`
      );
    }
    // The loop's remaining budget, after `maxCost` so a session over both reads as the policy
    // breach it also is. Over the same metered sum and for the same reason: an unbilled call is
    // still one the operator paid for, and a delegate's spend is still this session's doing.
    const ceiling = spendCeiling?.();
    if (ceiling !== undefined && metered > ceiling) {
      throw new LoopBudgetExhausted(
        metered,
        ceiling,
        `metered ${metered} µUSDC this session, over the ${ceiling < 0n ? 0n : ceiling} µUSDC left of the loop's budget`
      );
    }
  }

  /** The spend ceiling a session answers to: its own start option, else the runtime's. */
  protected spendCeilingOf(s: SessionCtx): (() => bigint | undefined) | undefined {
    return s.opts.spendCeilingMicroUsdc ?? this.spendCeilingMicroUsdc;
  }

  /**
   * Tells the session's `onMeter` what it has metered, with `childSpent` — what a running
   * `delegate` child has spent so far — counted in `delegated`, where it lands when the child
   * resolves. A copy, so the observer cannot move the meter; a throw is swallowed, because this
   * runs after a call that was already paid for.
   */
  protected reportMeter(s: SessionCtx, childSpent: bigint = 0n): void {
    const onMeter = s.opts.onMeter;
    if (!onMeter) return;
    const m = s.meter;
    try {
      onMeter({ spent: m.spent, unbilled: m.unbilled, delegated: m.delegated + childSpent, costUsd: m.costUsd });
    } catch {
      // A spectator; it cannot fail the session.
    }
  }

  /**
   * Refuses a call when the spend ceiling has nothing left above what this session has metered —
   * the before-the-call half of the spend ceiling. Strictly `≥`: a ceiling the meter has exactly reached leaves
   * no room for a call whose price is unknown until it is answered.
   */
  protected checkSpendLeft(meter: SessionMeter, spendCeiling?: () => bigint | undefined): void {
    const ceiling = spendCeiling?.();
    if (ceiling === undefined) return;
    const metered = meter.spent + meter.unbilled + meter.delegated;
    if (metered >= ceiling) {
      throw new LoopBudgetExhausted(
        metered,
        ceiling,
        `the loop's budget is spent (${ceiling < 0n ? 0n : ceiling} µUSDC left, ${metered} metered this session), ` +
          "so no further call was made"
      );
    }
  }

  /**
   * Settles the session's channel, once, and reports what happened instead of throwing it.
   *
   * There are three outcomes and all three are states a screen has to be able to show: no
   * channel at all (the vault rail, and nothing is returned); a channel closed with a
   * transaction; and a channel whose close failed, which leaves the operator's USDC.e held by
   * the escrow until something retries it. Only the operator's key can close a channel,
   * so the channel id is part of the report whether or not the close landed — it is what a
   * retry needs.
   */
  private async closeTempo(): Promise<TempoSettlement | undefined> {
    const channel = this.tempo;
    if (!channel) return undefined;
    const base = { payer: channel.payer, channelId: channel.channelId };
    // Nothing was ever opened: the session never made a paid call. Reported as closed because
    // there is nothing held anywhere, which is what `closed` is asking about.
    if (!channel.opened) return { ...base, closed: true };
    try {
      const receipt = await channel.close();
      return { ...base, channelId: channel.channelId, closed: true, txHash: receipt.txHash, spent: receipt.spent };
    } catch (e) {
      return { ...base, channelId: channel.channelId, closed: false, error: (e as any)?.message ?? String(e) };
    }
  }

  /**
   * Checks that the mailbox cell at `index` commits to the envelope this session was handed,
   * then dequeues it. The check is the point: without it a session would consume *some*
   * message and claim it ran the delegated task, and the chain would agree.
   */
  private async consumeMandate(inbox: { index: bigint; envelope: string }): Promise<CellWriteResult> {
    if (!this.mailbox) throw new Error("this runtime has `structures` off, so it has no mailbox to consume from");
    const pending = await this.mailbox.get(inbox.index);
    if (!pending) throw new Error(`mailbox message ${inbox.index} is not there to consume`);
    const expected = await this.mailbox.log.encode(inbox.envelope);
    if (hex(pending.cell.valueSlot) !== hex(expected.slot)) {
      throw new Error(
        `mailbox message ${inbox.index} does not commit to the task handed to this session ` +
          `(slot ${hex(pending.cell.valueSlot).slice(0, 16)}…, expected ${hex(expected.slot).slice(0, 16)}…)`
      );
    }
    return this.mailbox.consume(inbox.index);
  }

  /**
   * Executes one tool call and logs it. A thrown tool is logged with status 500 and its error
   * returned to the model — a tool failing is information the agent should react to, not a
   * reason to lose the session.
   */
  private async runToolCall(s: SessionCtx, call: ToolCall): Promise<ChatMessage> {
    // Back from the wire name: what the model called is what this runtime knows by dots.
    const name = this.toolName(call.function?.name ?? "");
    let args: any = {};
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      args = { _raw: call.function?.arguments ?? null };
    }

    // Only when there is a delegate to route to: `toolSchemas` offers `delegate` to no other runtime,
    // so a call to it there is a name the model invented and is `callTool`'s undeclared 404.
    if (name === DELEGATE_TOOL && this.delegates.size > 0) {
      return this.runDelegation(s, call, args);
    }

    const { result } = await this.callTool(s, name, args);
    return {
      role: "tool",
      tool_call_id: call.id,
      name: AgentRuntime.wireName(name),
      content: JSON.stringify(result ?? null),
    };
  }

  /**
   * Runs one of this runtime's tools and writes its Action: 404 for a name it does not know, 400
   * for arguments its schema refuses, 200 for a tool that returned, 500 for one that threw, with
   * the error as the result. The one path a tool call takes, whoever asks: the ReAct loop through
   * `runToolCall`, or the sandbox's host-tool listener, which is what makes a call from inside the
   * sandbox the same Action as one made here. `delegate` is not a tool here — it is `runToolCall`'s
   * to route — so it answers 404.
   *
   * `nameOrWire` is mapped back from the wire form (`store_get` → `store.get`), so the record
   * carries the dotted id whichever form the caller had. A name that maps to nothing is recorded as
   * `unknown:<name>` (`undeclaredToolId`), so no model call carries an id the host writes.
   *
   * The 400 is written like the 404, with the arguments as given: the attempt is the fact worth
   * committing, and nothing the model asked for is left off the chain. Only the tool never runs.
   */
  protected async callTool(
    s: SessionCtx,
    nameOrWire: string,
    args: any
  ): Promise<{ toolId: string; result: unknown; statusCode: number }> {
    const name = this.toolName(nameOrWire);
    const tool = this.tools.get(name);
    if (!tool) {
      const toolId = undeclaredToolId(name);
      const result = { error: `unknown tool "${name}"` };
      await this.logAction({ toolId, args, result, statusCode: 404 }, s.events, { summary: result.error });
      return { toolId, result, statusCode: 404 };
    }

    // A call with no arguments arrives as `null` from some providers and from the sandbox's serde
    // round trip; it carries nothing, so it is the empty object every tool expects. The record keeps
    // what was sent.
    const given = args === null || args === undefined ? {} : args;
    const problem = toolArgumentsProblem(tool.parameters, given);
    if (problem) {
      const result = { error: `invalid arguments for "${name}": ${problem}` };
      await this.logAction({ toolId: name, args, result, statusCode: 400 }, s.events, { summary: result.error });
      return { toolId: name, result, statusCode: 400 };
    }

    let result: any;
    let statusCode = 200;
    try {
      result = await tool.execute(given, {
        sessionId: s.sessionId,
        agentId: this.agentId,
        spentMicroUsdc: s.meter.spent,
      });
    } catch (e) {
      statusCode = 500;
      result = { error: (e as any)?.message ?? String(e) };
    }
    await this.logAction({ toolId: name, args, result, statusCode }, s.events, { summary: summarize(result) });
    return { toolId: name, result, statusCode };
  }

  /**
   * Writes the Action for a tool call this runtime did not run itself but saw run — the sandbox's
   * own `file_read` / `file_write`, whose arguments are in the model's reply and whose result is
   * in the next request. The same record `callTool` writes, stored and hashed the same way, so the
   * only difference on the chain is the tool id: the operator's claim of what ran, which is the
   * class every tool Action already has.
   */
  protected async recordToolAction(
    s: SessionCtx,
    p: { toolId: string; args: unknown; result: unknown; statusCode: number }
  ): Promise<void> {
    // Picked field by field: a caller may hand over a richer object (the proxy's carries the call
    // id), and nothing but these four is part of the record.
    const { toolId, args, result, statusCode } = p;
    await this.logAction({ toolId, args, result, statusCode }, s.events, { summary: summarize(result) });
  }

  /**
   * Hands a sub-task to a child runtime, three ways at once:
   *
   * 1. the **event**: a `Delegation` naming the child's authority as `to_agent` and the parent
   *    task as `parent_task_id`. The child's genesis names *this* agent as `caller` and the
   *    same task as its session — the pairing `verifyHandoff` checks.
   * 2. the **message**: the envelope goes into the child's `Mailbox`, and the child consumes it
   *    before its own genesis. The event says work was handed over; the mailbox cell and its
   *    close prove the child received it and accepted exactly that task. That is the half a
   *    self-attested event cannot supply.
   * 3. the **edge**: `this → child` in this agent's `TaskGraph`, so the call tree is one
   *    `memcmp` query rather than a walk over both agents' event chains.
   *
   * With `structures: false`, only (1) happens — the v0.1 behaviour.
   *
   * The `delegate` tool is `delegateTo` · the child's session · `closeDelegation`, in that
   * order, and nothing else (`runDelegation` below). It is three methods rather than one because
   * an orchestrator loop opens its members from the **runner**, between the orchestrator's
   * Resolution and its checkpoint, and waits for all of them at once. What reaches a chain is the
   * same records, in the same order, whichever caller drives them.
   */
  async delegateTo(
    spec: DelegateDefinition,
    task: string,
    taskId: string,
    user: PublicKey,
    scope?: unknown
  ): Promise<OpenedDelegation> {
    // A delegation is a milestone with its own record (and a graph edge, a cell): the epoch
    // in progress has to land before it so the seqs stay in order.
    await this.flushEpochs();
    const worker = await spec.create();
    const opened: OpenedDelegation = {
      spec,
      worker,
      task,
      taskId,
      user,
      scope: scope ?? { task, agent: spec.name },
      events: [],
      cells: [],
      openedAt: this.now(),
    };

    // The child owns its mailbox: its client creates it at registration and signs the delivery.
    if (this.structures && worker.mailbox) {
      await worker.ensureRegistered();
      const envelope = canonicalJson({
        from: this.authority.toBase58(),
        scope: opened.scope,
        task,
        taskId,
      });
      // Signed by the child, whose mailbox admits its owner under every policy.
      const delivered = await worker.deliverMandate(this.authority, envelope, { tag: EventKind.Delegation });
      opened.cells.push(delivered);
      opened.inbox = { index: delivered.index, envelope };
    }

    const delegation = await this.milestones.delegate({
      parentTaskId: taskId,
      to: worker.authority,
      from: this.authority,
      scope: opened.scope as any,
    });
    opened.events.push(delegation);
    this.emitLogged("delegation", delegation, {
      childAgentId: hex(worker.agentId),
      childAuthority: worker.authority.toBase58(),
      task,
    });

    if (this.graph) {
      // A cell write goes straight to the chain — its head folds bytes the queue cannot predict
      // — so everything journaled ahead of it has to land first, or the edge would take the seq
      // the delegation record is holding and both would be wrong.
      try {
        await this.drainAnchor();
        opened.cells.push(await this.graph.addEdge(this.authority, worker.authority, { tag: EventKind.Delegation }));
      } catch (e) {
        // The Delegation is on this chain (or journaled for it) and no child will ever run under
        // it, so it is closed here, with a 500 saying why, rather than left open for a reader to
        // take as work still in flight — the same close a crashed child gets.
        // Thrown after, because the caller did not get a delegation it can run; it carries the
        // records so the caller can put them where its own go.
        const output = `the delegation was recorded but not completed: ${(e as any)?.message ?? String(e)}`;
        await this.closeDelegation(opened, { status: "failed", output, costMicroUsdc: "0" }, 500);
        throw new DelegationFailed(opened, output);
      }
    }
    return opened;
  }

  /**
   * Closes a delegation this agent opened: one `Action{tool_id: "delegate.<name>"}` on **this**
   * agent's chain saying what the child came back with.
   *
   * The record is appended to `opened.events` rather than returned, so a caller holds one list
   * per delegation — the Delegation, then this Action — in the order the chain took them, and
   * the `delegate` tool can splice both lists into the session's own at the end without
   * tracking indices.
   *
   * `result` is the child's outcome as the caller saw it, not as the child reported it: a
   * runner whose worker's `start()` threw has no `SessionResult` at all and still owes the
   * chain the Action that closes the Delegation it wrote.
   */
  async closeDelegation(
    opened: OpenedDelegation,
    result: { status: string; output: string; costMicroUsdc: string },
    statusCode: number
  ): Promise<void> {
    await this.logAction(
      {
        toolId: `${DELEGATE_TOOL}.${opened.spec.name}`,
        args: {
          task: opened.task,
          childAgentId: hex(opened.worker.agentId),
          inboxIndex: opened.inbox ? Number(opened.inbox.index) : null,
        },
        result,
        statusCode,
      },
      opened.events,
      { summary: result.output.slice(0, 200), childAgentId: hex(opened.worker.agentId) }
    );
  }

  private async runDelegation(s: SessionCtx, call: ToolCall, args: any): Promise<ChatMessage> {
    const { taskId, opts, events, cells, meter } = s;
    const spec = this.delegates.get(String(args?.agent ?? ""));
    if (!spec) {
      const result = { error: `unknown delegate "${args?.agent}"` };
      await this.logAction({ toolId: DELEGATE_TOOL, args, result, statusCode: 404 }, events, { summary: result.error });
      return { role: "tool", tool_call_id: call.id, name: DELEGATE_TOOL, content: JSON.stringify(result) };
    }

    const childTaskId = `${taskId}:${spec.name}`;
    const task = String(args?.task ?? "");
    let opened: OpenedDelegation;
    try {
      opened = await this.delegateTo(spec, task, childTaskId, opts.user, args?.scope);
    } catch (e) {
      // Closed already, so the parent carries on the way it does for a crashed child. Anything
      // else — nothing written yet — is thrown.
      if (!(e instanceof DelegationFailed)) throw e;
      events.push(...e.opened.events);
      cells.push(...e.opened.cells);
      return {
        role: "tool",
        tool_call_id: call.id,
        name: DELEGATE_TOOL,
        content: JSON.stringify({ status: "failed", output: e.message }),
      };
    }

    // What the child has spent so far, as its own `onMeter` reports it: shown to the parent's
    // observer as `delegated` while the child runs, and what the parent answers for if the child
    // throws after paying for calls — a crash must not make its spend vanish from the loop's total.
    let childSpent = 0n;
    const parentCeiling = this.spendCeilingOf(s);
    let result: SessionResult;
    try {
      result = await opened.worker.start({
        user: opts.user,
        prompt: task,
        sessionId: childTaskId,
        taskId: childTaskId,
        caller: this.authority, // the child acknowledges *this agent*, not the end user
        inbox: opened.inbox,
        // The parent's deadline is the child's: a session its caller abandoned must not leave a
        // child running and paying for a reply nobody will read.
        signal: opts.signal,
        // The parent's remaining spend ceiling is the child's: what the parent may still meter,
        // less what it already has. Asked afresh, like every ceiling, so a loop sibling's spend
        // while the child runs counts against the child's next call. Only a parent with one
        // passes one — a child of an unbudgeted session gets no spend ceiling from it.
        ...(parentCeiling
          ? {
              spendCeilingMicroUsdc: () => {
                const left = parentCeiling();
                return left === undefined ? undefined : left - (meter.spent + meter.unbilled + meter.delegated);
              },
            }
          : {}),
        onMeter: (m: Readonly<SessionMeter>) => {
          // What the child spent and what its own children did, because that is what
          // `meter.delegated` takes from a resolved child: `spent` alone would drop a grandchild's
          // spend from this parent's ceiling, its Resolution and the loop's owner spend.
          const total = m.spent + m.delegated;
          if (total > childSpent) childSpent = total;
          this.reportMeter(s, childSpent);
        },
      });
    } catch (e) {
      meter.delegated += childSpent;
      this.reportMeter(s);
      // The Delegation is already on this chain; it owes its closing Action whatever the child
      // did, and a child crashing is information the parent should react to — the convention a
      // tool that throws already follows (`runToolCall`). Letting the throw out would leave the
      // Delegation with no `delegate.<name>` Action and fail the whole session over one child.
      const output = (e as any)?.message ?? String(e);
      await this.closeDelegation(opened, { status: "crashed", output, costMicroUsdc: "0" }, 500);
      events.push(...opened.events);
      cells.push(...opened.cells);
      return {
        role: "tool",
        tool_call_id: call.id,
        name: DELEGATE_TOOL,
        content: JSON.stringify({ status: "crashed", output }),
      };
    }
    // What the child spent is the parent's to answer for under its own `maxCost`: the
    // ceiling in `start()` reads it on the way out of this tool call. Kept out of `spent`, which
    // is this agent's own debits. The child's own `delegated` with it: a grandchild's spend is this
    // parent's to answer for too, and the child's `costMicroUsdc` is only its own debits.
    meter.delegated += result.costMicroUsdc + (result.delegatedMicroUsdc ?? 0n);
    this.reportMeter(s);
    await this.closeDelegation(
      opened,
      { status: result.status, output: result.output, costMicroUsdc: result.costMicroUsdc.toString() },
      result.status === "success" ? 200 : 500
    );
    // Spliced at the end rather than as each one lands: the order inside these two lists is
    // already the chain's, and nothing else appends to the session's while a delegation runs —
    // the child writes its own chain, not this one.
    events.push(...opened.events);
    cells.push(...opened.cells, ...result.cells);
    return {
      role: "tool",
      tool_call_id: call.id,
      name: DELEGATE_TOOL,
      content: JSON.stringify({ status: result.status, output: result.output }),
    };
  }
}
