/**
 * The audit engine's leaf: what every other `audit/*` file reads and nothing that reads them back.
 * The record decoders (`subHashes`, `recordFieldsOf`, `genesisPolicyVersionHash`), the Tempo rail's
 * record and reader types, the blob readers (`blobAt`, `openSessionAt`, `encryptedAt`) and the
 * chain walk (`walkChain`) the verifiers share. `sdk/src/loops.ts` imports from here, so this file
 * must not import `../loops`, or the two would form an `audit ↔ loops` import cycle. Nothing here
 * reaches for a Node built-in; it ships in the browser entry.
 */
import { isSessionScoped } from "../bundle";
import { EventKind } from "../events";
import { hex, idFromString, sha256 } from "../hash";
import { isEncryptedTraceBlob, type TraceStore } from "../trace-store";
import { type EpochStore, verifyEpochBlob } from "../rollup";

/**
 * Sub-hashes inside an encoded payload, at the fixed offsets of `encodePayload`. Every payload
 * is `kind`-tagged on-chain, so the layout is unambiguous.
 *
 * These are the **fetchable leaves** — the blobs `AgentLogger` actually stores — and not every
 * 32 bytes a payload commits to. A genesis commits four fields and only its `input_payload_hash`
 * names a blob, so that is the one this returns; `policy_version_hash` is a commitment to a
 * document that is derived rather than stored, and asking a trace store for it would be asking
 * for something that was never put there. `genesisPolicyVersionHash` below reads that one.
 *
 * `preimage` is the **encoding**, without the leading `kind` byte — every caller passes
 * `stored.slice(1)`, because what a trace store holds is `kind ‖ encodePayload(p)`. Offsets into
 * the stored blob are therefore one higher than the ones here.
 */
export function subHashes(kind: number, preimage: Uint8Array): Uint8Array[] {
  const at = (o: number) => preimage.slice(o, o + 32);
  switch (kind) {
    case EventKind.Genesis: // session_id ‖ caller ‖ policy_version_hash ‖ input_payload_hash
      return preimage.length >= 128 ? [at(96)] : [];
    case EventKind.Action: // tool_id ‖ args_hash ‖ result_hash ‖ status u16
      return preimage.length >= 98 ? [at(32), at(64)] : [];
    case EventKind.Delegation: // parent_task_id ‖ from ‖ to ‖ scope_hash
      return preimage.length >= 128 ? [at(96)] : [];
    case EventKind.Resolution: // task_id ‖ status u8 ‖ final_output_hash ‖ steps u32
      return preimage.length >= 69 ? [at(33)] : [];
    default:
      return [];
  }
}

/**
 * The `policy_version_hash` a genesis committed: what the agent's model, temperature, tool
 * allow-list, cost cap and prompt hashed to for *that session*.
 *
 * It is the one chain fact about an agent's configuration. A template id is not on chain and a
 * `template.hash` is the console's lineage key, so this is what a
 * reader compares when they want to know whether an agent changed what it was between two
 * sessions — and what *use version n* moves for the next one.
 *
 * At offset 64 of the encoding, after `session_id` and `caller`, both 32 bytes: 32 + 32. In the
 * blob a trace store holds it is at **65**, because that blob is `kind ‖ encodePayload(p)`.
 * `null` for any other kind, and for a genesis encoding that is short.
 */
export function genesisPolicyVersionHash(kind: number, preimage: Uint8Array): Uint8Array | null {
  if (kind !== EventKind.Genesis || preimage.length < 128) return null;
  return preimage.slice(64, 96);
}

/**
 * The record fields a payload encoding determines: `reference` and `status`, exactly as
 * `toEventInput` derives them (`events.ts` `referenceOf` / `statusOf`). A field is absent when the
 * encoding is too short to hold it, with the same guards `subHashes` uses, so a short test
 * preimage skips what it lacks rather than reading zeros as a disagreement.
 *
 * `preimage` is the encoding without the leading `kind` byte, like `subHashes`.
 */
export function recordFieldsOf(kind: number, preimage: Uint8Array): { reference?: Uint8Array; status?: number } {
  switch (kind) {
    case EventKind.Genesis: // the caller, at 32; a genesis records status 0
      return preimage.length >= 128 ? { reference: preimage.slice(32, 64), status: 0 } : {};
    case EventKind.Action: // tool_id at 0, status u16le at 96
      return preimage.length >= 98
        ? { reference: preimage.slice(0, 32), status: preimage[96] | (preimage[97] << 8) }
        : {};
    case EventKind.Delegation: // the delegate, at 64; a delegation records status 0
      return preimage.length >= 128 ? { reference: preimage.slice(64, 96), status: 0 } : {};
    case EventKind.Resolution: // task_id at 0, status u8 at 32
      return preimage.length >= 69 ? { reference: preimage.slice(0, 32), status: preimage[32] } : {};
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------------------------
// The `tempo` rail: what a record commits about a payment, and what checks it
// ---------------------------------------------------------------------------------------------

/**
 * Tempo mainnet, as `eth_chainId` answers at `https://rpc.tempo.xyz`. Pinned rather than read:
 * a record names the chain it was paid on, and a record naming another one is not a payment this
 * verifier can speak about.
 */
export const TEMPO_CHAIN_ID = 4217;

/** The TIP-1034 escrow precompile every channel is opened at and every close is sent to. */
export const TEMPO_ESCROW = "0x4d50500000000000000000000000000000000000";

/**
 * USDC.e on Tempo mainnet: the token every model channel is opened in and every storage charge is
 * paid in. A channel in another token pays its payee in something else, whatever `finalAmount` says.
 */
export const TEMPO_USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";

/**
 * The tool id of the one record that settles a loop's channel. A one-shot session puts its
 * settlement in the Resolution instead, because a session has one; a loop's channel outlives
 * every Resolution its steps write. The runtime spells the same string
 * at `runtime/src/loop.ts`; it is repeated here because the SDK does not import the runtime, and
 * it is the record's `reference`, so a reader finds the settlement without any preimage.
 */
export const LOOP_SETTLEMENT_TOOL = "loop.settlement";

/**
 * What an Action's result blob carries on the `tempo` rail: the voucher that bought that one LLM
 * call. `cumulative*` are USDC.e base units as decimal strings — the channel's running total
 * before and after the call, so the delta is what that call cost and the pair brackets exactly
 * one call.
 */
export interface TempoPaymentRecord {
  rail: "tempo";
  chainId: number;
  payer: string;
  channelId: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
  /**
   * The gateway's `usage.cost` in USD when the body carried one: the model's token cost, which
   * is a different price from the gateway's flat quote and is never compared with it.
   */
  usageCost?: number;
  /** The access key that signed the vouchers, when a loop key did; `payer` is then the root. */
  signer?: string;
  /** The Tempo block the channel opened in, decimal: where `channelOpened` starts reading. */
  openBlock?: string;
}

/** A settlement, as a Resolution's output blob or a `loop.settlement` result blob carries it. */
export interface TempoSettlementRecord {
  txHash?: string;
  spent?: string;
  channelId?: string;
  payer?: string;
  closed?: boolean;
}

/** `getChannelState(channelId)` on the escrow. A **closed** channel reads as zeros. */
export interface TempoChannelState {
  settled: bigint;
  deposit: bigint;
  closeRequestedAt: number;
}

/** The `ChannelClosed` log a close emits, decoded. */
export interface ChannelClosedLog {
  channelId: string;
  payer: string;
  payee: string;
  finalAmount: bigint;
  refund: bigint;
}

/** The receipt of a settlement transaction, as much of it as a verdict depends on. */
export interface TempoCloseReceipt {
  /** 1 for a transaction that succeeded. A close that reverted paid nobody. */
  status: number;
  to: string | null;
  /**
   * The `ChannelClosed` event in the receipt's logs, when it carries one: the one for the channel
   * the caller asked about when the reader was told it, else the first.
   */
  closed?: ChannelClosedLog;
  /**
   * Every escrow `ChannelClosed` in the receipt, in log order, when the reader returns them all. In an
   * MPP session the payee submits the close, and a Tempo transaction can batch calls, so one gateway
   * transaction may close several channels; the verdict is about the one whose id it is verifying
   * (`closedLogFor`), and taking the first would fail an honest chain over another channel's log.
   */
  closures?: ChannelClosedLog[];
}

/**
 * The Tempo half of the verifier, behind an interface so the pure half stays browser-safe:
 * `sdk/src/tempo.ts` implements it over viem and a raw `eth_call`, a test implements it over a
 * fixture, and a caller with no RPC passes none and gets `pending`.
 */
export interface TempoReader {
  /** The channel as the escrow has it now, or `null` when the call did not answer. */
  channelState(channelId: string): Promise<TempoChannelState | null>;
  /**
   * The receipt of a settlement transaction, or `null` when the node does not have it. `channelId`
   * is the channel being verified, so a reader can answer with its `ChannelClosed` in `closed`;
   * readers that ignore it are read through `closedLogFor`, which looks in `closures` as well.
   */
  closeReceipt(txHash: string, channelId?: string): Promise<TempoCloseReceipt | null>;
  /**
   * Any transaction's receipt, logs raw, or `null` when the node does not have it: what a storage
   * charge is checked against (`verifyStorageCharge`). Optional, so a reader that does not read
   * charges still satisfies this interface; one without it leaves a charge _pending_.
   */
  txReceipt?(txHash: string): Promise<TempoTxReceipt | null>;
  /**
   * The escrow's `ChannelOpened` log for `channelId`, read from `fromBlock` (decimal), or `null` when
   * not found or not readable: what holds a channel's `authorizedSigner` to a loop's committed key.
   * Optional, for the reason `txReceipt` is; a reader without it leaves the key check `unchecked`.
   */
  channelOpened?(channelId: string, fromBlock?: string): Promise<ChannelOpenedLog | null>;
  /**
   * The `KeyAuthorized` event (and any `SpendingLimitUpdated` beside it) in the receipt of `txHash`,
   * or `null` when the node does not have it. `publicKey` is the key being checked, so a transaction
   * that authorized several is answered with that key's event rather than the first. Optional, like
   * `channelOpened`.
   */
  keyAuthorized?(txHash: string, publicKey?: string): Promise<KeyAuthorizedLog | null>;
  /**
   * The keychain's `getAllowedCalls(account, key)`: whether the key is scoped, and its scopes. `null`
   * when not readable. Optional, like `keyAuthorized`.
   */
  allowedCalls?(account: string, key: string): Promise<AllowedCallsLog | null>;
}

/**
 * One call scope of an access key, flattened the way `ox/tempo` `KeyAuthorization.Scope` spells it
 * and the way the policy commits it (`runtime/src/policy.ts` `TempoKeyScope`, spelled again here for
 * the reason `CommittedTempoKey` is): a contract, optionally one 4-byte selector on it — absent means
 * any selector — and for a TIP-20 transfer the recipients it may pay — absent means any recipient.
 */
export interface TempoScope {
  address: string;
  selector?: string;
  recipients?: string[];
}

/**
 * A key's call scopes as the keychain reports them: `getAllowedCalls`'s nested `(target,
 * selectorRules[])` flattened to one entry per selector rule, and a target with no rules to one entry
 * with no selector, so it compares directly with the committed list.
 */
export interface AllowedCallsLog {
  isScoped: boolean;
  scopes: TempoScope[];
  /**
   * The keychain says the key is revoked, or is no key of that account at all (`getKey`). Its live
   * scopes are then not evidence of anything — a stopped loop's key is revoked by design, and
   * what a revoked key's `getAllowedCalls` answers is the precompile's business, not a statement about
   * the scopes it was used under — so (d) reads the authorization instead. Absent means the reader
   * did not say, and the answer is taken as a live key's.
   */
  revoked?: boolean;
}

/** The TIP-1034 escrow's `ChannelOpened` log, decoded. */
export interface ChannelOpenedLog {
  channelId: string;
  payer: string;
  payee: string;
  token: string;
  authorizedSigner: string;
  deposit: bigint;
  /** Decimal. */
  blockNumber?: string;
  /** The transaction that opened it, when the node's log names one: what an explorer link opens. */
  txHash?: string;
}

/** An access key's authorization, as its transaction's receipt says it. */
export interface KeyAuthorizedLog {
  /** 1 for a transaction that succeeded. */
  status: number;
  /** The root account the key was authorized on (`KeyAuthorized.account`). */
  account: string;
  /** The key's address (`KeyAuthorized.publicKey`). */
  publicKey: string;
  /** Unix seconds. */
  expiry: number;
  /** Per-token limits set in the same transaction, from its `SpendingLimitUpdated` logs. */
  limits: { token: string; amount: bigint }[];
  /**
   * Where `limits` came from, when anything was read: `"logs"` when only `SpendingLimitUpdated`
   * logs were, `"authorization"` when the transaction's signed key authorization was read as well,
   * so `limits` is the whole set it authorized and a token missing from it was authorized with no
   * limit at all. Absent means nothing said what the limits were, and the limit half of (a) is
   * `unchecked` rather than failed: no log is not evidence of no limit.
   */
  limitsFrom?: "logs" | "authorization";
  /**
   * The call scopes the transaction's signed key authorization carried (its `allowedCalls`), present
   * only when that payload was read and carried the field. Absent says nothing: a node that does not
   * serve the field and an authorization with no scopes look alike from here, so (d) stays unchecked
   * on an absent one rather than reading it as unscoped. What (d) falls back to when the key is revoked.
   */
  scopes?: AllowedCallsLog;
  /** Decimal. */
  blockNumber?: string;
}

/** The key line of a channels report. */
export interface ChannelKeyVerdict {
  status: "ok" | "failed" | "unchecked";
  detail: string;
  /** The key the policy committed, for the report line; absent when no policy committed one. */
  address?: string;
}

/**
 * A loop's access key as its Genesis policy commits it: the `tempoKey` member `policyDocument`
 * writes (`runtime/src/policy.ts` `TempoKeyPolicy`), spelled again here because the SDK does not
 * import the runtime. Its presence is the gate on every key check: a policy without it is a
 * treasury-signed loop and is judged with no key check at all.
 */
export interface CommittedTempoKey {
  address: string;
  token?: string;
  /** Raw base units, decimal. */
  limitBase?: string;
  /** Unix seconds. */
  expiry?: number;
  authorizeTx?: string;
  /**
   * The calls the key may make, normalised (`normaliseScopes`) — lower case, sorted by address then
   * selector, each `recipients` sorted — so two
   * spellings of one set compare equal. Absent for an unscoped key, which gets no (d) at all.
   */
  scopes?: TempoScope[];
  /**
   * Set when the policy carries a `scopes` member that is not a list of scopes: (d) then fails by
   * name, as a malformed limit fails (a), rather than the member silently reading as absent.
   */
  badScopes?: true;
}

/** One log of a Tempo transaction, as `eth_getTransactionReceipt` answers it. */
export interface TempoLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/** A Tempo transaction's receipt, as much as a charge verdict reads. */
export interface TempoTxReceipt {
  /** 1 for a transaction that succeeded. A transfer inside one that reverted moved nothing. */
  status: number;
  /** Decimal. */
  blockNumber?: string;
  logs: readonly TempoLog[];
}

/**
 * What the verifier needs of a chain — `LathClient` satisfies it, and so does a fake. The
 * records are every event with an account, ascending by seq.
 *
 * `listEpochs` is optional because it answers a question only a rolled-up chain has: which seqs
 * were batched into an epoch and so have no account at all. A chain that does not implement it
 * is verified over its per-event records alone.
 */
export interface InferenceChain {
  listEvents(agentId: Uint8Array): Promise<readonly InferenceRecord[]>;
  listEpochs?(agentId: Uint8Array): Promise<readonly InferenceEpoch[]>;
}

/** The fields of an `EpochRecord` this verifier reads: which seqs the root covers, and the root. */
export interface InferenceEpoch {
  epochRoot: Uint8Array;
  /** First seq the epoch covers (inclusive). */
  startSeq: bigint;
  /** One past the last seq it covers. */
  endSeq: bigint;
}

/** The fields of an `EventRecord` a payment verdict reads. */
export interface InferenceRecord {
  seq: bigint;
  kind: number;
  reference: Uint8Array;
  payloadHash: Uint8Array;
}

/**
 * The four answers, and nothing else — `verifyInference` never throws, because every way this
 * can go wrong is something an auditor wants named rather than a stack trace.
 *
 * - `verified` — the close transaction the chain named paid out at least what this call's
 *   voucher committed to.
 * - `pending` — the channel is open and holds enough for it. Nothing is wrong; nothing is
 *   settled yet either. Also what an unreachable reader gets: unchecked, not wrong.
 * - `failed` — the chain and Tempo disagree, or the chain disagrees with itself.
 * - `no-preimage` — the bytes behind the hash are not available here, so there is nothing to
 *   check. The same answer `audit` gives for a blob a store does not hold.
 * - `encrypted` — the bytes *are* here and the owner encrypted them. Also nothing checked, and a
 *   different fact from nothing kept: one is answered by a key, the other by nobody. Same exit
 *   code as `no-preimage`.
 */
export type InferenceVerdict = "verified" | "pending" | "failed" | "no-preimage" | "encrypted";

export interface InferenceReport {
  agentId: string;
  seq: string;
  /**
   * Set when `seq` is not a record of its own but a step inside a committed epoch: which epoch
   * covered it and which member of that epoch it is. Absent for a per-event record, so a chain
   * written without the rollup carries no `epoch` field.
   */
  epoch?: { startSeq: string; endSeq: string; member: number };
  verdict: InferenceVerdict;
  /** The blob the record's `result_hash` names: the completion, with the voucher beside it. */
  blobHash?: string;
  payer?: string;
  channelId?: string;
  cumulativeBefore?: string;
  cumulativeAfter?: string;
  /** What the channel paid out, from the close receipt, or what it still holds while open. */
  settled?: string;
  /** The settlement transaction the chain named, when a settlement record covers this seq. */
  txHash?: string;
  /**
   * Whom the close paid (`ChannelClosed.payee`): the gateway, as `--payee` names it. Printed because
   * a close that paid the payer back, or paid an address the operator holds, pays no provider.
   */
  payee?: string;
  /** The channel's token from its `ChannelOpened`, held to USDC.e, on a close that verified otherwise. */
  token?: ChannelTokenVerdict;
  /** Why the verdict is not `verified`. Absent when it is. */
  reason?: string;
  /**
   * The loop key checks for this call, (a) and (b) together, when the session's Genesis policy
   * commits a `tempoKey`; absent otherwise, so a treasury-signed record carries no `key` field.
   */
  key?: ChannelKeyVerdict;
  /**
   * The model the call asked for (its args blob's `model`), held to the session's policy — its
   * `model` or committed `fallbackModel` — when both are readable; and the build that served it as
   * the gateway named it, which is reported and never compared. Absent when the blobs are not here,
   * so a report without them carries no `model` field.
   */
  model?: string;
  servedBy?: string;
  /**
   * `"lath"` when the call's blob records it as paid by Lath: a chat attempt that got no answer,
   * which the owner was not debited for (`verify-channel --refetch` holds the debit to zero). Absent
   * on every other call.
   */
  paidBy?: "lath";
}

export interface VerifyInferenceOptions {
  /** Where the preimages are read from. Without one the answer is `no-preimage`. */
  store?: TraceStore;
  /** The Tempo side. Without one nothing is settled or refuted, so the answer stays `pending`. */
  reader?: TempoReader;
  /**
   * Where epoch blobs are read from, keyed by the root the chain committed — the same store
   * `audit` takes. Without one a seq that an epoch batched cannot be resolved at all, because
   * the step's `payload_hash` exists only inside that blob.
   */
  epochs?: EpochStore;
  /**
   * The address the caller expects to have paid — the agent's derived Tempo account, from the
   * console or from `--payer`. Without it the payer is checked only against the agent's other
   * records and reported, because a verifier holds no agent secret and cannot re-derive it.
   */
  expectedPayer?: string;
  /**
   * The address the caller expects the closes to have paid — `--payee`, the model gateway's payee,
   * which the console reads from the gateway's 402. Without it a close is held only to not paying its
   * own payer, and `verifyChannels` holds every settled channel to the first one's payee.
   */
  expectedPayee?: string;
  /**
   * The key checks were asked for by name (`--key`). It changes no verdict: it only makes a report
   * whose policy commits no `tempoKey` say so in its `key` field, instead of leaving the field out,
   * so an auditor who asked is told why nothing was checked.
   */
  requireKey?: boolean;
}

/**
 * Addresses and hashes are hex either case; a verdict must not turn on which one a writer used.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** @internal — exported for a sibling `audit/*` file; not part of the barrel. */
export function decimal(v: unknown): string | null {
  return typeof v === "string" && /^[0-9]+$/.test(v) ? v : null;
}

/**
 * The voucher inside an Action's result blob, or `null` for a blob that carries none — which is
 * what an older record, written before this rail, and every `vault` record look like.
 */
export function paymentFromBlob(blob: Uint8Array): TempoPaymentRecord | null {
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return null;
  }
  return paymentRecordOf(parsed?.payment);
}

/**
 * A voucher object wherever a blob hangs it — `payment` at the top, or a trace audit's `confirm.payment`.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function paymentRecordOf(p: any): TempoPaymentRecord | null {
  if (!p || p.rail !== "tempo") return null;
  const before = decimal(p.cumulativeBefore);
  const after = decimal(p.cumulativeAfter);
  if (typeof p.payer !== "string" || typeof p.channelId !== "string" || !before || !after) return null;
  return {
    rail: "tempo",
    chainId: Number(p.chainId),
    payer: p.payer,
    channelId: p.channelId,
    cumulativeBefore: before,
    cumulativeAfter: after,
    ...(typeof p.usageCost === "number" ? { usageCost: p.usageCost } : {}),
    // Kept only as the strings the transport writes. Anything else is dropped rather than coerced,
    // because a `signer` the key check compares must be the bytes the record committed, and an
    // older record, written before loop keys, has neither field and must read without them.
    ...(typeof p.signer === "string" ? { signer: p.signer } : {}),
    ...(typeof p.openBlock === "string" ? { openBlock: p.openBlock } : {}),
  };
}

/**
 * The settlement inside a Resolution's output blob (`settlement: { txHash, spent }`) or inside a
 * `loop.settlement` Action's result blob (the whole `TempoSettlement`). One function, because the
 * only difference between the two is which key the object hangs from.
 */
export function settlementFromBlob(blob: Uint8Array): TempoSettlementRecord | null {
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return null;
  }
  const s = parsed?.settlement ?? parsed;
  if (!s || typeof s !== "object") return null;
  if (typeof s.txHash !== "string" && typeof s.channelId !== "string") return null;
  return {
    ...(typeof s.txHash === "string" ? { txHash: s.txHash } : {}),
    ...(typeof s.spent === "string" ? { spent: s.spent } : {}),
    ...(typeof s.channelId === "string" ? { channelId: s.channelId } : {}),
    ...(typeof s.payer === "string" ? { payer: s.payer } : {}),
    ...(typeof s.closed === "boolean" ? { closed: s.closed } : {}),
  };
}

/** A blob by hash, re-hashed on arrival: a store that answers with other bytes has answered nothing. */
export async function blobAt(store: TraceStore | undefined, hash: Uint8Array): Promise<Uint8Array | null> {
  if (!store) return null;
  const bytes = await store.get(hash);
  if (!bytes || hex(sha256(bytes)) !== hex(hash)) return null;
  return bytes;
}

/**
 * The sub-hash a record's payload names: `result_hash` for an Action, `final_output_hash` for a Resolution.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function payloadLeaf(
  store: TraceStore | undefined,
  rec: InferenceRecord,
  index: number
): Promise<Uint8Array | null> {
  const preimage = await blobAt(store, rec.payloadHash);
  if (!preimage || preimage[0] !== rec.kind) return null;
  return subHashes(rec.kind, preimage.slice(1))[index] ?? null;
}

/**
 * Opens the bundle of the session `rec` begins, on a store that reads bundles. A console session's
 * preimages and sub-blobs are one bundle keyed by its genesis payload hash, so a gateway reader
 * that never opened the session finds a direct cell for none of them and reports *no preimage* for
 * a voucher that is there.
 * `audit()` opens at every kind-0 record it walks; the two payment verifiers do the same here.
 */
export async function openSessionAt(store: TraceStore | undefined, rec: InferenceRecord): Promise<void> {
  if (rec.kind !== EventKind.Genesis || !isSessionScoped(store)) return;
  await store.openSession(rec.payloadHash).catch(() => undefined);
}

/**
 * Were the bytes behind `hash` withheld rather than lost? A store without the key answers a trace
 * blob with its ciphertext, which re-hashes to nothing and is therefore invisible to `blobAt`;
 * the verdict says which of the two happened because they are answered by different people.
 */
export async function encryptedAt(store: TraceStore | undefined, hash: Uint8Array): Promise<boolean> {
  if (!store) return false;
  const bytes = await store.get(hash).catch(() => null);
  return !!bytes && isEncryptedTraceBlob(bytes);
}

/**
 * Is the Action at `rec` an LLM call — the one record whose result blob is the runtime's own
 * `{ ...body, payment }` — given that blob?
 *
 * Its tool id must be `llm.<m>` for the model its result body names, or, when that does not match,
 * for the model its args (the request) name: the two ids `runtime.ts` `paidChat` writes, `llm.${
 * body.model ?? policy.model}` for an answer and `llm.${policy.model}` for a paid failure whose result
 * is `{ error, payment }` — the request carries the policy's model on both paths, the sandbox's proxy
 * included — and it writes them for every voucher the `tempo` rail carries. So every honest voucher
 * is bound, and nothing else is: every other Action's result is bytes somebody else chose — the report
 * the sandboxed model wrote (`storage.put` commits it raw), the text a sandbox file tool handed back,
 * a host tool's answer — and a `payment` object inside one was never a voucher. Read as one, it
 * could open a channel's cumulative at an absurd height and fail every honest audit of the chain, or
 * name a payer the storage charges are then held to.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function isLlmCall(
  store: TraceStore | undefined,
  rec: InferenceRecord,
  resultBlob: Uint8Array
): Promise<boolean> {
  if (rec.kind !== EventKind.Action) return false;
  const reference = hex(rec.reference);
  const names = (model: unknown) =>
    typeof model === "string" && model.length > 0 && hex(idFromString(`llm.${model}`)) === reference;
  const json = (bytes: Uint8Array): any => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  };
  if (names(json(resultBlob)?.model)) return true;
  const argsHash = await payloadLeaf(store, rec, 0);
  const args = argsHash ? await blobAt(store, argsHash) : null;
  return !!args && names(json(args)?.model);
}

/**
 * The voucher a record committed, when both the payload preimage and the result blob are readable
 * and the record is an LLM call (`isLlmCall`); `notLlm` when the result carries a voucher-shaped
 * object and the record is not one, so `verifyInference` can say which it was.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function voucherAt(
  store: TraceStore | undefined,
  rec: InferenceRecord
): Promise<{ payment: TempoPaymentRecord; blobHash: Uint8Array } | { notLlm: true; blobHash: Uint8Array } | null> {
  if (rec.kind !== EventKind.Action) return null;
  const resultHash = await payloadLeaf(store, rec, 1);
  if (!resultHash) return null;
  const blob = await blobAt(store, resultHash);
  if (!blob) return null;
  const payment = paymentFromBlob(blob);
  if (!payment) return null;
  return (await isLlmCall(store, rec, blob))
    ? { payment, blobHash: resultHash }
    : { notLlm: true, blobHash: resultHash };
}

/**
 * The voucher a record committed, when both the payload preimage and the result blob are readable
 * and the record is an LLM call — `null` for every other Action, whatever its result says.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
/**
 * Whether the blob under `blobHash` records its call as paid by Lath (`paidBy: "lath"`): a chat
 * attempt that got no answer, which the owner is not debited for. False for any blob without the
 * marker — every older record — and for one not readable.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function paidByLathAt(store: TraceStore | undefined, blobHash: Uint8Array): Promise<boolean> {
  const bytes = await blobAt(store, blobHash).catch(() => null);
  if (!bytes) return false;
  try {
    return JSON.parse(new TextDecoder().decode(bytes))?.paidBy === "lath";
  } catch {
    return false;
  }
}

export async function paymentOf(
  store: TraceStore | undefined,
  rec: InferenceRecord
): Promise<{ payment: TempoPaymentRecord; blobHash: Uint8Array } | null> {
  const found = await voucherAt(store, rec);
  return found && "payment" in found ? found : null;
}

/**
 * The steps a committed epoch batched, as the records they would have been.
 *
 * `commit_epoch` anchors one Merkle root for a whole run of seqs and writes no `EventRecord`
 * account for any of them (`rollup.ts`), so on a chain with the rollup on — which is every
 * console session, since the console turns it on whenever the deployed program has
 * `commit_epoch` — a paid Action is a *member* of an epoch and `listEvents` cannot see it. The
 * blob keyed by the root is the ordered `EventInput`s, and `verifyEpochBlob` rebuilds the root
 * from them before any of it is believed: a store that answers with other bytes has answered
 * nothing, which is what `blobAt` is for traces. Members come back carrying the same four fields
 * a record does, so every check downstream treats a member and a record alike.
 *
 * An epoch whose blob is missing or does not rebuild its root contributes no members rather than
 * failing the verdict: bytes nobody kept are `no-preimage`, never a disagreement.
 */
async function epochMembers(
  epochs: readonly InferenceEpoch[],
  store: EpochStore
): Promise<{ record: InferenceRecord; epoch: InferenceEpoch; index: number }[]> {
  const out: { record: InferenceRecord; epoch: InferenceEpoch; index: number }[] = [];
  for (const e of epochs) {
    let blob: Uint8Array | null = null;
    try {
      blob = await store.get(e.epochRoot);
    } catch {
      continue;
    }
    const decoded = blob ? verifyEpochBlob(blob, e.epochRoot, e.startSeq, e.endSeq) : null;
    if (!decoded) continue;
    decoded.inputs.forEach((input, index) => {
      out.push({
        record: {
          seq: e.startSeq + BigInt(index),
          kind: input.kind,
          reference: input.reference,
          payloadHash: input.payloadHash,
        },
        epoch: e,
        index,
      });
    });
  }
  return out;
}

/**
 * What a close receipt must say before it can verify anything, or `null` when it says it all:
 * a transaction that succeeded, went to the escrow, and closed *this* channel against *this*
 * payer. Shared by the per-call and the per-channel verdicts so the two cannot drift — the
 * amount is the only part of the check that differs between them.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function closeProblem(
  receipt: TempoCloseReceipt,
  txHash: string,
  channelId: string,
  payer: string | undefined,
  payee?: { address: string; whose: string }
): string | null {
  if (receipt.status !== 1) return `the settlement transaction ${txHash} reverted (status ${receipt.status})`;
  if (!sameHex(receipt.to, TEMPO_ESCROW)) {
    return `${txHash} was sent to ${receipt.to ?? "a contract creation"}, not to the escrow ${TEMPO_ESCROW}`;
  }
  const closed = closedLogFor(receipt, channelId);
  if (!closed) return `${txHash} closed no channel: its receipt carries no ChannelClosed log`;
  if (!sameHex(closed.channelId, channelId)) return `${txHash} closed channel ${closed.channelId}, not ${channelId}`;
  if (payer && !sameHex(closed.payer, payer)) {
    return `channel ${channelId} was closed against payer ${closed.payer}, not ${payer}`;
  }
  // Whom it paid. A channel the treasury opened to itself closes like any other and pays
  // its `finalAmount` straight back, so the chain could bill users for calls no provider was paid
  // for at the cost of gas; no honest channel's payee is its payer. Beyond that the payee is held to
  // the gateway the caller names, or to the one the chain's other closes paid.
  if (sameHex(closed.payee, closed.payer)) {
    return `channel ${channelId} was closed to its own payer ${closed.payer}: it paid no provider`;
  }
  if (payee && !sameHex(closed.payee, payee.address)) {
    return `channel ${channelId} paid ${closed.payee}, not ${payee.address}, ${payee.whose}`;
  }
  return null;
}

/**
 * `reader` with its `ChannelOpened` reads memoised for one verification: the token check and a keyed
 * loop's signer check (b) both read a channel's open, and one read answers both. A read that fails is
 * dropped from the cache, so the next asker tries again. Every other read goes to `reader` itself.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function memoOpened(reader: TempoReader | undefined): TempoReader | undefined {
  if (!reader?.channelOpened) return reader;
  const cache = new Map<string, Promise<ChannelOpenedLog | null>>();
  const memo: TempoReader = Object.create(reader);
  // Bound to the memo, so the read shares the connection every other read through it makes.
  const read = reader.channelOpened.bind(memo);
  memo.channelOpened = (channelId: string, fromBlock?: string) => {
    const key = `${channelId.toLowerCase()}@${fromBlock ?? ""}`;
    let p = cache.get(key);
    if (!p) {
      p = read(channelId, fromBlock);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  };
  return memo;
}

/** Whether a model channel was opened in USDC.e, by its `ChannelOpened`. */
export interface ChannelTokenVerdict {
  status: "ok" | "failed" | "unchecked";
  detail: string;
  /** The token the open names, when it was read. */
  address?: string;
}

/**
 * The channel's token, from the escrow's `ChannelOpened`: a close says what it paid and to whom, but
 * not in what, and a channel opened in a token anyone can mint closes for any `finalAmount` the payer
 * likes. Read only for a close that verified otherwise. `unchecked` whenever the open cannot be read
 * — no reader that reads it, not found, or answered for another id — since a node that does not say
 * has said nothing about the token; `failed` for an open in anything but USDC.e.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function channelTokenVerdict(
  reader: TempoReader | undefined,
  channelId: string,
  openBlock?: string
): Promise<ChannelTokenVerdict> {
  if (!reader?.channelOpened) {
    return { status: "unchecked", detail: "not read: no Tempo reader that reads ChannelOpened was given" };
  }
  let log: ChannelOpenedLog | null;
  try {
    log = await reader.channelOpened(channelId, openBlock);
  } catch (e) {
    return { status: "unchecked", detail: `the ChannelOpened log could not be read: ${(e as any)?.message ?? e}` };
  }
  if (!log || !sameHex(log.channelId, channelId)) {
    return { status: "unchecked", detail: `the ChannelOpened log of ${channelId} could not be read` };
  }
  if (!sameHex(log.token, TEMPO_USDC_E)) {
    return {
      status: "failed",
      address: log.token,
      detail: `channel ${channelId} was opened in ${log.token}, not USDC.e (${TEMPO_USDC_E})`,
    };
  }
  return { status: "ok", address: log.token, detail: "USDC.e" };
}

/**
 * The `ChannelClosed` of `channelId` in a close receipt: among `closures` when the reader returned
 * them all, else `closed`. When none is this channel's it is `closed` — the first — so `closeProblem`
 * names the channel the transaction did close.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function closedLogFor(receipt: TempoCloseReceipt, channelId: string): ChannelClosedLog | undefined {
  if (receipt.closed && sameHex(receipt.closed.channelId, channelId)) return receipt.closed;
  return receipt.closures?.find((c) => sameHex(c.channelId, channelId)) ?? receipt.closed;
}

/**
 * The Resolution that ended a voucher's session without naming a settlement, when the chain has one:
 * the first Resolution after `after` and before the next Genesis, whose output blob names no
 * settlement transaction (`readable: true`) or is not here to say (`readable: false`) — unless the
 * session was a loop step, whose checkpoint (`stepTool`, the hex id of `loop.step`) follows its
 * Resolution before the next Genesis: a step's Resolution never names a settlement, since the loop
 * settles once and later, so its silence says nothing about the channel. `null` otherwise — the
 * session never resolved, or its Resolution named a settlement, which is then the evidence.
 *
 * What it is for: a channel that reads as zeros was closed by a transaction no record names, which
 * is a failure — except after a one-shot session whose Resolution says its close had not landed:
 * whatever closed the channel since left no record, and the chain is silent about the payment rather
 * than contradicted by it. One helper for `verify-inference` and `verify-channel`, so that the two
 * cannot disagree about the same honest chain.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function silentSessionEnd(
  store: TraceStore | undefined,
  records: readonly InferenceRecord[],
  after: bigint,
  stepTool: string
): Promise<{ seq: bigint; readable: boolean } | null> {
  let end: { seq: bigint; readable: boolean } | null = null;
  for (const rec of records) {
    if (rec.seq <= after) continue;
    if (end) {
      if (rec.kind === EventKind.Genesis) break;
      if (rec.kind === EventKind.Action && hex(rec.reference) === stepTool) return null;
      continue;
    }
    if (rec.kind === EventKind.Genesis) return null;
    if (rec.kind !== EventKind.Resolution) continue;
    let blob: Uint8Array | null = null;
    try {
      const leaf = await payloadLeaf(store, rec, 0);
      blob = leaf ? await blobAt(store, leaf) : null;
    } catch {
      blob = null;
    }
    if (blob && settlementFromBlob(blob)?.txHash) return null;
    end = { seq: rec.seq, readable: !!blob };
  }
  return end;
}

/**
 * What a zero-deposit channel after a silent session end says (`silentSessionEnd`): `no-preimage`
 * when the Resolution's bytes are not here, so whether it named a settlement is unknown, else
 * `pending` with the reason `silentSessionEnd` gives. `whose` names the session in the message.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function silentCloseVerdict(
  channelId: string,
  end: { seq: bigint; readable: boolean },
  whose: string
): { verdict: "no-preimage" | "pending"; reason: string } {
  if (!end.readable) {
    return {
      verdict: "no-preimage",
      reason:
        `channel ${channelId} holds nothing, and the Resolution of ${whose} at seq ${end.seq} commits bytes ` +
        "this store does not hold, so whether it names a settlement is unknown",
    };
  }
  return {
    verdict: "pending",
    reason:
      `channel ${channelId} holds nothing, and the Resolution of ${whose} at seq ${end.seq} names no ` +
      "settlement: its close had not landed when the session resolved, and whatever closed the channel " +
      "since left no record on this chain, so what it paid cannot be checked",
  };
}

/** @internal — exported for a sibling `audit/*` file; not part of the barrel. */
export interface WalkedChain {
  /** Every record and every epoch member, ascending by seq, indistinguishable from one another. */
  records: readonly InferenceRecord[];
  epochs: readonly InferenceEpoch[];
  /** Which epoch a member seq came out of, keyed by seq, for the report line and the messages. */
  memberships: Map<string, { epoch: InferenceEpoch; index: number }>;
  /**
   * The epochs whose steps are not in `records`: no epoch store was given, or the blob under the root
   * is missing or does not rebuild it. Their seqs exist on the chain and are not here, so a check that
   * needs every record up to a seq is a floor past the first of them.
   */
  unopened: readonly InferenceEpoch[];
  /** The chain's epochs could not be listed at all, so whether any were left unopened is unknown. */
  epochsUnlisted: boolean;
}

/**
 * The chain as one ascending list, with the steps an epoch batched folded in.
 *
 * Shared by the two verifiers, because a voucher is a voucher whether it is asked about by seq or
 * by channel, and a check that saw only `listEvents` would miss every console-written Action. Both
 * halves stay optional: a chain that cannot name its epochs, or a caller with no epoch store, gets
 * the per-event list alone.
 */
export async function walkChain(
  chain: InferenceChain,
  agentId: Uint8Array,
  epochStore: EpochStore | undefined
): Promise<WalkedChain> {
  const bySeq = (a: InferenceRecord, b: InferenceRecord) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
  let records = [...(await chain.listEvents(agentId))].sort(bySeq);
  let epochs: readonly InferenceEpoch[] = [];
  let epochsUnlisted = false;
  if (chain.listEpochs) {
    try {
      epochs = await chain.listEpochs(agentId);
    } catch {
      // Epochs come from a walk of transaction history, which is the one read here that an RPC
      // can refuse on its own. Refusing it is not evidence about the payment — but it is a reason a
      // record up to a seq may be missing here, which a caller that needs all of them is told.
      epochs = [];
      epochsUnlisted = true;
    }
  }
  const memberships = new Map<string, { epoch: InferenceEpoch; index: number }>();
  const opened = new Set<InferenceEpoch>();
  if (epochs.length > 0 && epochStore) {
    const members = await epochMembers(epochs, epochStore);
    if (members.length > 0) {
      for (const m of members) {
        memberships.set(m.record.seq.toString(), { epoch: m.epoch, index: m.index });
        opened.add(m.epoch);
      }
      records = [...records, ...members.map((m) => m.record)].sort(bySeq);
    }
  }
  const unopened = epochs.filter((e) => !opened.has(e));
  return { records, epochs, memberships, unopened, epochsUnlisted };
}

/**
 * Why a record strictly between `from` and `want` may be missing here: the epochs could not be
 * listed, or one not opened covers a seq in that window. `undefined` when the window is all here.
 *
 * This is the question every "most recent earlier checkpoint" search has to ask of what it found.
 * The search only sees what it could read, so with the real previous checkpoint inside an unopened
 * epoch it lands on an older one, or on none — and a step compared with the wrong predecessor, or
 * taken as a loop's first, can turn FAILED into VERIFIED for whoever withholds one epoch blob.
 * `from` is `-1n` when the search found nothing, which makes the window the whole chain below `want`.
 *
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function blindBetween(walked: WalkedChain, from: bigint, want: bigint): string | undefined {
  if (walked.epochsUnlisted) return "the chain's epochs could not be listed";
  // An epoch covers [startSeq, endSeq); it holds a seq of the open window (from, want) iff the two
  // ranges overlap.
  const e = walked.unopened.find((x) => x.startSeq < want && x.endSeq > from + 1n);
  return e ? `the epoch ${e.startSeq}–${e.endSeq} is not opened here (pass --epochs or --gateway)` : undefined;
}

/**
 * Four answers about one verified step, and nothing else — like `verifyInference`, this never
 * throws, because every way it can go wrong is something an auditor wants named.
 *
 * - `ok` — the blob under the manifest's `verifyHash` re-hashes to it, its verdict matches what
 *   the step actually did with its memory, and the voucher that paid for it rode the loop's own
 *   channel.
 * - `mismatch` — the blob has been edited since the step committed it, or the chain and the
 *   verdict disagree: the verifier said `retry`/`escalate` and the memory moved on anyway, or it
 *   said `accept` and the memory did not.
 * - `payer` — the decision was paid on a channel that is not this loop's. A decision is one more
 *   request on the loop's one channel, so a voucher naming another channel was
 *   not bought by this loop.
 * - `no-preimage` — the manifest or the blob is not available here, or the step carries no
 *   `verifyHash` at all because nothing verified it. The same answer `audit` gives for bytes a
 *   store does not hold: nothing was checked, and nothing is wrong.
 */
export type StepVerifyVerdict = "ok" | "mismatch" | "payer" | "no-preimage" | "encrypted";

/**
 * Keys sorted at every depth — `decisionBlobBytes`'s own rule, applied to one field of the blob
 * so that two spellings of the same questions compare equal and two different questions do not.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalValue(child);
    }
    return out;
  }
  return value;
}

/**
 * The record's own status, read off its payload preimage; `undefined` when that is not here.
 * @internal — exported for a sibling `audit/*` file; not part of the barrel.
 */
export async function statusOf(store: TraceStore | undefined, rec: InferenceRecord): Promise<number | undefined> {
  const preimage = await blobAt(store, rec.payloadHash);
  if (!preimage || preimage[0] !== rec.kind) return undefined;
  return recordFieldsOf(rec.kind, preimage.slice(1)).status;
}
