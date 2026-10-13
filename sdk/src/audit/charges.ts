/**
 * The charge sibling of the voucher checks: a loop's Tempo storage PUTs, each paid by one Tempo
 * transfer — the receipt and carry records, the TIP-20 transfer reading, `verifyStorageCharge` for
 * one Action and `verifyCharges` for a chain.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { EventKind } from "../events";
import { hex, idFromString, sha256, toBytes32, utf8 } from "../hash";
import { LOOP_STEP_TOOL } from "../loops";
import { encryptedTraceFor, isEncryptedTraceBlob, type TraceStore } from "../trace-store";
import type { EpochStore } from "../rollup";
import {
  type ChannelKeyVerdict,
  type CommittedTempoKey,
  type InferenceChain,
  type InferenceRecord,
  type InferenceVerdict,
  LOOP_SETTLEMENT_TOOL,
  TEMPO_CHAIN_ID,
  TEMPO_ESCROW,
  TEMPO_USDC_E,
  type TempoLog,
  type TempoReader,
  type TempoTxReceipt,
  type WalkedChain,
  blobAt,
  canonicalValue,
  decimal,
  encryptedAt,
  openSessionAt,
  payloadLeaf,
  paymentOf,
  recordFieldsOf,
  sameHex,
  subHashes,
  walkChain,
} from "./core";
import { manifestOf } from "./shared";
import { policyKeyAt } from "./keys";

// ---------------------------------------------------------------------------------------------
// The charge sibling: a loop's Tempo storage PUTs, each paid by one Tempo transfer

/**
 * The tool id of a report published to Tempo storage. Spelled again here for the reason
 * `LOOP_SETTLEMENT_TOOL` is: the runtime writes it (`runtime/src/loop-tempo.ts`) and the SDK does not
 * import the runtime, and it is the record's `reference`, so the Actions are found without a preimage.
 */
export const STORAGE_PUT_TOOL = "storage.put";

/**
 * The service a `storage.put`'s args commit to. An Action naming another one may be a real payment,
 * but it is not a report on Tempo storage, which is the only thing this verdict speaks for.
 */
export const TEMPO_STORAGE_SERVICE = "https://storage.mpp.tempo.xyz";

/**
 * USDC.e on Tempo mainnet: the token a charge is priced in, printed as dollars when it is this one.
 * Defined in `core.ts` since the model channels' token is held to it too, and re-exported.
 */
export { TEMPO_USDC_E } from "./core";

/**
 * `topic0` of TIP-20's `Transfer(address indexed from, address indexed to, uint256 amount)` — the
 * ERC-20 event, byte for byte — and of `TransferWithMemo(from, to, amount, bytes32 indexed memo)`,
 * which a charge's `transferWithMemo` emits beside or instead of it (mppx binds each charge to its
 * challenge through the memo). Constants rather than viem's `toEventSelector`, so this file stays
 * free of an EVM client; `tests/tempo-verify-charge.ts` pins both against viem.
 */
export const TIP20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TIP20_TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

/** The payment a storage receipt names: one `tempo.charge`, amounts in base units, decimal. */
export interface StorageChargePayment {
  intent: string;
  chainId: number;
  payer: string;
  recipient?: string;
  amount: string;
  currency: string;
  /** The Tempo transaction hash from the gateway's receipt; empty when none came back. */
  reference: string;
}

/**
 * The receipt blob of one `storage.put` (`StorageReceipt` in `runtime/src/loop-tempo.ts`): named by
 * no Action hash, because it comes back after the request fixed them, and committed instead by the
 * `receiptHash` of the carry blob the next leaf (or the stop record) names.
 */
export interface StorageReceiptRecord {
  key: string;
  /** The report's size — the plaintext `result_hash` commits — however the object was stored. */
  bytes: number;
  /** How the object on the gateway is encoded, and its size there; absent on older receipts (plain). */
  encoding?: "LTE2" | "plain";
  storedBytes?: number;
  path?: string;
  status?: number;
  payment?: StorageChargePayment;
  error?: string;
  /** The second PUT under `<loopId>-latest`, which only older receipts carry. */
  latest?: { key: string; status?: number; payment?: StorageChargePayment; error?: string };
}

/** A `storage.put` Action as a carry blob names it. */
export interface CarriedStorageRecord {
  ofStep: number;
  seq: string;
  key: string;
  statusCode: number;
  receiptHash: string;
}

/** A snapshot of a loop's Tempo state after one step's leaf (`TempoSnapshot` in the runtime). */
export interface TempoSnapshotRecord {
  ofStep: number;
  takenAt?: number;
  block?: string;
  channel?: { id: string; deposit?: string; settled?: string; cumulative?: string };
  treasury?: { usdcE?: string };
  rpc?: { channelId?: string; cumulative?: string };
  error?: string;
}

/** The carry blob under a manifest's fifteenth key, `tempoHash`. */
export interface TempoCarryRecord {
  v: 1;
  storage?: CarriedStorageRecord[];
  snapshots?: TempoSnapshotRecord[];
}

/** What a `loop.settlement` result blob says of the loop's Tempo services (`TempoServicesStop`). */
export interface TempoServicesRecord extends TempoCarryRecord {
  lastSnapshot?: TempoSnapshotRecord;
  closeBlock?: string;
  rpc?: { channelId?: string; closed: boolean; txHash?: string; spent?: string; error?: string };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

function paymentOfReceipt(v: unknown): StorageChargePayment | null {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (typeof p.intent !== "string" || !isInt(p.chainId) || typeof p.payer !== "string") return null;
  if (!decimal(p.amount) || typeof p.currency !== "string" || typeof p.reference !== "string") return null;
  if (p.recipient !== undefined && typeof p.recipient !== "string") return null;
  return p as unknown as StorageChargePayment;
}

/**
 * The receipt inside a blob, or `null` for bytes that are not one. Strict about the fields a verdict
 * reads and indifferent to the rest, so a later field added to the receipt does not fail an audit.
 */
export function storageReceiptFromBlob(blob: Uint8Array): StorageReceiptRecord | null {
  let r: any;
  try {
    r = JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || typeof r.key !== "string" || !isInt(r.bytes)) return null;
  if (r.status !== undefined && !isInt(r.status)) return null;
  if (r.payment !== undefined && !paymentOfReceipt(r.payment)) return null;
  return r as StorageReceiptRecord;
}

function snapshotOk(s: unknown): s is TempoSnapshotRecord {
  const x = s as Record<string, unknown> | null;
  if (!x || typeof x !== "object" || !isInt(x.ofStep)) return false;
  return x.block === undefined || decimal(x.block) !== null;
}

function carryFields(c: any): TempoCarryRecord | null {
  if (!c || typeof c !== "object" || c.v !== 1) return null;
  if (c.storage !== undefined) {
    if (!Array.isArray(c.storage)) return null;
    for (const s of c.storage) {
      if (!s || !isInt(s.ofStep) || !decimal(s.seq) || typeof s.key !== "string") return null;
      if (!isInt(s.statusCode) || !isHex64(s.receiptHash)) return null;
    }
  }
  if (c.snapshots !== undefined && !(Array.isArray(c.snapshots) && c.snapshots.every(snapshotOk))) return null;
  return c as TempoCarryRecord;
}

/** The carry blob under `tempoHash`, or `null` for bytes that are not one. */
export function tempoCarryFromBlob(blob: Uint8Array): TempoCarryRecord | null {
  try {
    return carryFields(JSON.parse(new TextDecoder().decode(blob)));
  } catch {
    return null;
  }
}

/**
 * The `services` of a `loop.settlement` result blob: `undefined` when the blob carries none — an
 * older settlement, or any loop whose host pays no Tempo service — and `null`
 * when it carries one that is not a services record, which is a different fact.
 */
export function tempoServicesFromBlob(blob: Uint8Array): TempoServicesRecord | null | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(blob));
  } catch {
    return undefined;
  }
  const s = parsed?.services;
  if (s === undefined) return undefined;
  if (!carryFields(s)) return null;
  if (s.lastSnapshot !== undefined && !snapshotOk(s.lastSnapshot)) return null;
  if (s.closeBlock !== undefined && !decimal(s.closeBlock)) return null;
  return s as TempoServicesRecord;
}

/** An address out of a 32-byte topic: its last 20 bytes, lower case. */
function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/** Every TIP-20 transfer a receipt's logs carry, with or without a memo, decoded without viem. */
export function tip20Transfers(
  logs: readonly TempoLog[]
): { token: string; from: string; to: string; amount: bigint; memo?: string }[] {
  const out: { token: string; from: string; to: string; amount: bigint; memo?: string }[] = [];
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    const memo = topic0 === TIP20_TRANSFER_WITH_MEMO_TOPIC;
    if (topic0 !== TIP20_TRANSFER_TOPIC && !memo) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    // `amount` is the one non-indexed word in both events.
    const word = typeof log.data === "string" ? log.data.slice(2, 66) : "";
    if (!from || !to || !/^[0-9a-fA-F]{64}$/.test(word)) continue;
    out.push({
      token: String(log.address).toLowerCase(),
      from,
      to,
      amount: BigInt(`0x${word}`),
      ...(memo && log.topics[3] ? { memo: log.topics[3] } : {}),
    });
  }
  return out;
}

/**
 * Why a receipt's logs do not pay what a charge says, or `null` when one transfer does: on the
 * currency's own contract — anyone may emit an event with the same topic — from the payer, to the
 * recipient, of exactly the amount. Exactly, not at least: one call is one transfer at the
 * challenge's price, so a different amount is a different payment.
 */
export function chargeTransferProblem(logs: readonly TempoLog[], payment: StorageChargePayment): string | null {
  const want = BigInt(payment.amount);
  const transfers = tip20Transfers(logs).filter((t) => sameHex(t.token, payment.currency));
  const fromPayer = transfers.filter((t) => sameHex(t.from, payment.payer));
  const match = fromPayer.find((t) => sameHex(t.to, payment.recipient) && t.amount === want);
  if (match) return null;
  const tx = payment.reference;
  if (fromPayer.length === 0) {
    return transfers.length === 0
      ? `${tx} carries no transfer of ${payment.currency}`
      : `${tx} moves ${payment.currency}, but none of it from the payer ${payment.payer}`;
  }
  const toRecipient = fromPayer.find((t) => sameHex(t.to, payment.recipient));
  if (toRecipient) return `${tx} moved ${toRecipient.amount} base units to the recipient, not the ${want} recorded`;
  return `${tx} paid ${fromPayer.map((t) => t.to).join(", ")}, not the recipient ${payment.recipient}`;
}

/**
 * The verdicts of one charge. Those `verifyInference` gives, read the same way, and one more:
 * `unpaid`, a PUT that moved no money — a charge refused before anything was signed, or an answer
 * nobody paid for — which is a failed Action the owner was not debited for, and nothing to check.
 */
export type ChargeVerdict = InferenceVerdict | "unpaid";

/** One `storage.put`, checked: the chain against its blobs, then the receipt against Tempo. */
export interface ChargeReport {
  seq: string;
  /** The step whose report this was, as the carry names it. */
  ofStep?: number;
  key?: string;
  /** The Action's status: the gateway's, 402 for a refused charge, 502 for no answer. */
  statusCode?: number;
  /** The record that carries the receipt: `seq N` of a leaf, or the stop record's. */
  carriedBy?: string;
  receiptHash?: string;
  /** Whether the report the store holds re-hashed to `result_hash`; absent when it is not here. */
  reportRehashed?: boolean;
  amount?: string;
  currency?: string;
  payer?: string;
  recipient?: string;
  txHash?: string;
  block?: string;
  verdict: ChargeVerdict;
  reason?: string;
  /**
   * (e): the transfer's MPP attribution memo names the loop — `keccak256(loopId)[0..9]` in bytes
   * 15..24. Only for a charge of a loop whose policy commits a `tempoKey`, and only once the charge
   * moved money; absent otherwise, so an unkeyed loop's report has no attribution field.
   */
  attribution?: { status: ChannelKeyVerdict["status"]; detail: string };
}

/**
 * What a charge's loop says about it, for (e): the loop's id, from the manifest of the checkpoint
 * whose carry names the charge, and the `tempoKey` its steps' policy commits — `null` for a loop
 * read and found unkeyed, absent when its policy is not readable here. Only a key gates (e).
 */
export interface ChargeLoop {
  loopId?: string;
  tempoKey?: CommittedTempoKey | null;
}

/** The first four bytes of `keccak256("mpp")`: mppx's attribution memo tag (`Attribution.tag`). */
export const MPP_MEMO_TAG = "ef1ed712";

/** `keccak256(utf8(clientId))[0..9]`, hex: what mppx writes into bytes 15..24 of a memo for a `clientId`. */
export function mppClientFingerprint(clientId: string): string {
  return hex(keccak_256(utf8(clientId)).slice(0, 10));
}

/**
 * (e) on the transfers of one charge transaction already held to the charge (`chargeTransferProblem`
 * found one). Pure. The memo must be an MPP attribution memo — tag and version 1 in bytes 0..4, the
 * layout in mppx's `Attribution.d.ts` — naming the loop in bytes 15..24. Anything else is `failed`:
 * a transfer with no memo event (Tempo emits `TransferWithMemo` beside `Transfer` for every memo
 * transfer, and mppx always sends one), a memo that is not an attribution memo, the anonymous zeros,
 * or another client's fingerprint. Not `unchecked` for a gateway's own memo: a keyed loop's charge
 * refuses a challenge carrying one before anything is signed (`MppChargeTransport.priced`), so no
 * charge this loop's code made can carry one, and leaving it unchecked would let a charge escape (e)
 * by using a plain memo. Only a charge whose loop is unknown is `unchecked`.
 */
export function attributionVerdict(
  logs: readonly TempoLog[],
  payment: StorageChargePayment,
  loopId: string | undefined
): { status: ChannelKeyVerdict["status"]; detail: string } {
  if (loopId === undefined) {
    return { status: "unchecked", detail: "no checkpoint on this chain names the loop this charge paid for" };
  }
  const want = mppClientFingerprint(loopId);
  const memos = tip20Transfers(logs)
    .filter(
      (t) =>
        t.memo &&
        sameHex(t.token, payment.currency) &&
        sameHex(t.from, payment.payer) &&
        sameHex(t.to, payment.recipient) &&
        t.amount === BigInt(payment.amount)
    )
    .map((t) => t.memo!.toLowerCase().replace(/^0x/, ""))
    .filter((m) => /^[0-9a-f]{64}$/.test(m));
  if (!memos.length) {
    return {
      status: "failed",
      detail: `the transfer carries no memo, and a keyed loop's charges name the loop: want 0x${want} for ${loopId}`,
    };
  }
  const attributed = memos.filter((m) => m.slice(0, 8) === MPP_MEMO_TAG && m.slice(8, 10) === "01");
  if (!attributed.length) {
    return {
      status: "failed",
      detail:
        `the memo 0x${memos[0]} is not an MPP attribution memo, and a keyed loop refuses a gateway's own memo ` +
        `before signing: want client 0x${want} for ${loopId}`,
    };
  }
  // Bytes 15..24 are hex characters 30..49.
  const clients = attributed.map((m) => m.slice(30, 50));
  if (clients.includes(want)) return { status: "ok", detail: `the memo names loop ${loopId} (client 0x${want})` };
  const got = clients[0];
  if (/^0+$/.test(got)) {
    return {
      status: "failed",
      detail: `the memo is anonymous (client 0x${got}), and a keyed loop's charges name the loop: want 0x${want} for ${loopId}`,
    };
  }
  return { status: "failed", detail: `the memo names client 0x${got}, not loop ${loopId} (0x${want})` };
}

export interface VerifyChargeOptions {
  store?: TraceStore;
  /** Tempo, for the transfer. Without one, or one with no `txReceipt`, a paid charge is `pending`. */
  reader?: TempoReader;
  /**
   * The address the caller expects every charge to have been paid by — `--payer`, the operator's
   * Tempo treasury, as `verify-inference` takes it. A receipt naming another payer fails before Tempo
   * is read: without this a receipt could cite a stranger's transfer to the storage payee and verify.
   * `verifyCharges` fills it in when the flag is absent, from the
   * chain's own vouchers; a single charge checked on its own is held to it only when it is given.
   */
  expectedPayer?: string;
  /**
   * The transactions the charges already checked in this run named, lowercased hash → seq. One
   * transfer pays one charge, so a receipt naming a transaction an earlier charge already named is
   * a phantom charge and fails, whatever the transaction says. Run-scoped: `verifyCharges`
   * threads one map through every charge of the chain, and a caller checking one charge passes none.
   */
  references?: Map<string, string>;
  /**
   * The address the caller expects every charge to have paid — `--recipient`, the storage gateway's
   * payee. The receipt is the operator's own record of whom it paid, and the transfer is held to
   * *that* recipient, so without a pin a receipt could cite any treasury transfer of the right amount
   * — the treasury paying the operator, or depositing into a model channel — as a storage payment
   * `verifyCharges` fills it in when the flag is absent from the chain's first paid charge,
   * the way it fills in the payer; a keyed loop whose key is scoped is held as well to the recipients
   * its policy commits. A single charge checked on its own is held to it only when it is given.
   */
  expectedRecipient?: string;
}

/**
 * TIP-20's two transfer selectors, `transferWithMemo(address,uint256,bytes32)` — the call mppx pays a
 * charge with, and the one a loop key is scoped to (`_lib/tempo-keys.ts` `loopKeyScopes`) — and
 * `transfer(address,uint256)`: the calls by which a scoped key could pay a storage gateway.
 */
export const TIP20_TRANSFER_WITH_MEMO_SELECTOR = "0x95777d59";
export const TIP20_TRANSFER_SELECTOR = "0xa9059cbb";

/**
 * The recipients a scoped loop key may pay USDC.e to — the storage payee the console read at the
 * loop's start and committed in the policy — or `undefined` when nothing pins
 * them: an unscoped key, or a USDC.e scope that admits any selector or any recipient. `[]` for a
 * scoped key that may make no USDC.e transfer at all. Tempo refuses the key every other recipient,
 * so a charge of a scoped loop that paid someone else was not paid by the loop's key.
 */
export function scopedStorageRecipients(key: CommittedTempoKey | null | undefined): string[] | undefined {
  if (!key?.scopes) return undefined;
  const rules = key.scopes.filter(
    (s) =>
      sameHex(s.address, TEMPO_USDC_E) &&
      (s.selector === undefined ||
        sameHex(s.selector, TIP20_TRANSFER_WITH_MEMO_SELECTOR) ||
        sameHex(s.selector, TIP20_TRANSFER_SELECTOR))
  );
  if (rules.some((s) => s.selector === undefined || !s.recipients)) return undefined;
  return rules.flatMap((s) => s.recipients!.map((r) => r.toLowerCase()));
}

/** `{"key":…,"service":…}`, canonical — the bytes the runtime's `storageArgsBytes` writes. */
function storageArgsCanonical(key: string, service: string): string {
  return `{"key":${JSON.stringify(key)},"service":${JSON.stringify(service)}}`;
}

/**
 * Did the `storage.put` at `rec` store what it says and pay what it says?
 *
 * The chain first, all of it pure: the Action's args blob is exactly `{ key, service }` on Tempo's
 * storage; the key is `<loopId>-<sha256>` over the Action's own `result_hash`, so the key the
 * gateway holds names the bytes the chain committed; the report, when the store holds it, re-hashes
 * to `result_hash`; the receipt re-hashes to the `receiptHash` the carry names and agrees with the
 * Action and the carry on key, status and size. Then Tempo: the receipt's `reference` is a
 * transaction that succeeded on chain 4217 and carries a TIP-20 transfer of `amount` of `currency`
 * from `payer` to `recipient`. The auditor reads it over the free RPC and pays nothing.
 *
 * `carried` is the carry entry that names this seq; without one — a PUT written since the last leaf
 * of a loop still running — the chain half is checked and the verdict waits.
 *
 * `loop` is the loop the carry belongs to. When its policy commits a `tempoKey`, the transfer's memo
 * is held to the loop as well (`attributionVerdict`, (e)); without a key, nothing about the memo is
 * read and the report has no attribution field.
 */
export async function verifyStorageCharge(
  rec: InferenceRecord,
  carried: (CarriedStorageRecord & { carriedBy?: string }) | undefined,
  opts: VerifyChargeOptions = {},
  loop?: ChargeLoop
): Promise<ChargeReport> {
  const report: ChargeReport = { seq: rec.seq.toString(), verdict: "failed" };
  if (carried) {
    report.ofStep = carried.ofStep;
    report.receiptHash = carried.receiptHash;
    if (carried.carriedBy) report.carriedBy = carried.carriedBy;
  }
  const fail = (reason: string): ChargeReport => ({ ...report, verdict: "failed", reason });
  const pending = (reason: string): ChargeReport => ({ ...report, verdict: "pending", reason });
  const unread = async (what: string, hash: Uint8Array): Promise<ChargeReport> =>
    (await encryptedAt(opts.store, hash).catch(() => false))
      ? {
          ...report,
          verdict: "encrypted",
          reason: `${what} is encrypted by the agent's owner; pass --trace-key <hex|path> to read it`,
        }
      : { ...report, verdict: "no-preimage", reason: `${what} is not available here` };

  if (rec.kind !== EventKind.Action || hex(rec.reference) !== hex(idFromString(STORAGE_PUT_TOOL))) {
    return fail(`seq ${rec.seq} is not a \`${STORAGE_PUT_TOOL}\` Action`);
  }
  const preimage = await blobAt(opts.store, rec.payloadHash).catch(() => null);
  if (!preimage || preimage[0] !== rec.kind) return unread(`the payload at seq ${rec.seq}`, rec.payloadHash);
  const [argsHash, resultHash] = subHashes(rec.kind, preimage.slice(1));
  const status = recordFieldsOf(rec.kind, preimage.slice(1)).status;
  if (status !== undefined) report.statusCode = status;

  const argsBytes = await blobAt(opts.store, argsHash).catch(() => null);
  if (!argsBytes) return unread(`the args blob of seq ${rec.seq}`, argsHash);
  let args: any;
  try {
    args = JSON.parse(new TextDecoder().decode(argsBytes));
  } catch {
    args = null;
  }
  if (
    !args ||
    typeof args.key !== "string" ||
    typeof args.service !== "string" ||
    new TextDecoder().decode(argsBytes) !== storageArgsCanonical(args.key, args.service)
  ) {
    return fail(`the args blob of seq ${rec.seq} is not the canonical { key, service } a storage.put commits`);
  }
  report.key = args.key;
  if (args.service !== TEMPO_STORAGE_SERVICE) {
    return fail(`seq ${rec.seq} stored to ${args.service}, not to Tempo storage (${TEMPO_STORAGE_SERVICE})`);
  }
  // The committed key names the content: a gateway object under it is the report the chain commits.
  if (!args.key.endsWith(`-${hex(resultHash)}`)) {
    return fail(
      `the key ${args.key} does not end in the sha256 of the report seq ${rec.seq} commits (${hex(resultHash)})`
    );
  }
  const stored = opts.store ? await opts.store.get(resultHash).catch(() => null) : null;
  // Ciphertext is the one answer that skips the re-hash, so it has to be ciphertext *of this
  // report*: an LTE2 header naming `result_hash`. A bare magic is not enough: four bytes would hide
  // an edited report and drop its size check. LTE2 only, because no genuine report on Tempo storage
  // is in the older LTE1 format, and an LTE1 blob, which names no hash, is re-hashed and read as the
  // edit it is.
  if (stored && encryptedTraceFor(stored, resultHash) !== "lte2") {
    if (hex(sha256(stored)) !== hex(resultHash)) {
      return fail(`the report under ${hex(resultHash)} hashes to ${hex(sha256(stored))} — it was edited`);
    }
    report.reportRehashed = true;
  }

  if (!carried) return pending(`no leaf or stop record on this chain carries the receipt of seq ${rec.seq} yet`);
  if (carried.key !== args.key)
    return fail(`the carry names key ${carried.key} for seq ${rec.seq}, which stored ${args.key}`);
  if (status !== undefined && carried.statusCode !== status) {
    return fail(`the carry says seq ${rec.seq} answered ${carried.statusCode}, and its record carries ${status}`);
  }

  const receiptHash = toBytes32(carried.receiptHash);
  const raw = opts.store ? await opts.store.get(receiptHash).catch(() => null) : null;
  if (!raw) return unread(`the receipt blob ${carried.receiptHash}`, receiptHash);
  // Header-bound for the report's reason: no receipt is written in LTE1, so only an LTE2 header
  // naming this hash is the owner's ciphertext, and anything else is re-hashed.
  if (encryptedTraceFor(raw, receiptHash) === "lte2") {
    return unread(`the receipt blob ${carried.receiptHash}`, receiptHash);
  }
  if (hex(sha256(raw)) !== carried.receiptHash) {
    return fail(`the bytes under ${carried.receiptHash} hash to ${hex(sha256(raw))} — the receipt was edited`);
  }
  const receipt = storageReceiptFromBlob(raw);
  if (!receipt) return fail(`the bytes under ${carried.receiptHash} are not a storage receipt`);
  if (receipt.key !== args.key)
    return fail(`the receipt names key ${receipt.key}, and seq ${rec.seq} stored ${args.key}`);
  if (stored && report.reportRehashed && receipt.bytes !== stored.length) {
    return fail(`the receipt says ${receipt.bytes} bytes were stored, and the report is ${stored.length}`);
  }
  // The same size check for a report held as ciphertext. `receipt.bytes` is the plaintext's size and
  // AES-GCM adds no padding, so the owner's LTE2 copy is exactly that plus its header, nonce and tag
  // — what binds a header naming `result_hash` to more than the thirty-six cleartext bytes anyone
  // can write.
  if (stored && !report.reportRehashed && !encryptedTraceFor(stored, resultHash, receipt.bytes)) {
    return fail(
      `the receipt says ${receipt.bytes} bytes were stored, and the encrypted report under ${hex(resultHash)} ` +
        `is ${stored.length} bytes, which is not ciphertext of that size`
    );
  }
  if (receipt.status !== undefined && status !== undefined && receipt.status !== status) {
    return fail(`the receipt says the gateway answered ${receipt.status}, and seq ${rec.seq} carries ${status}`);
  }

  const payment = receipt.payment;
  if (!payment) {
    return {
      ...report,
      verdict: "unpaid",
      reason: `no payment was made${receipt.error ? `: ${receipt.error.slice(0, 160)}` : ""}`,
    };
  }
  report.amount = payment.amount;
  report.currency = payment.currency;
  report.payer = payment.payer;
  if (payment.recipient) report.recipient = payment.recipient;
  // (e) is said from here on for a keyed loop: money moved, so the memo it moved with matters, and
  // until the transaction is read and held to the charge the memo is not read either.
  if (loop?.tempoKey) {
    report.attribution = {
      status: "unchecked",
      detail: "the charge transaction was not read, so neither was its memo",
    };
  }
  if (payment.intent !== "charge") return fail(`the receipt's payment is a ${payment.intent}, not a charge`);
  if (payment.chainId !== TEMPO_CHAIN_ID) {
    return fail(`the receipt names chain ${payment.chainId}, and this verifier speaks only for ${TEMPO_CHAIN_ID}`);
  }
  // The transfer below is looked for on the receipt's own `currency`, and the receipt is the
  // operator's record: any contract can emit a TIP-20 `Transfer` from the treasury, so a currency
  // that is not USDC.e would let a log nobody's money moved in pay a charge. Every genuine charge
  // is USDC.e: the console's charge transport is built on it and refuses any other before signing.
  if (!sameHex(payment.currency, TEMPO_USDC_E)) {
    return fail(
      `the receipt names currency ${payment.currency}, and a storage charge is paid in USDC.e (${TEMPO_USDC_E})`
    );
  }
  // The receipt is the loop's own account of who paid, and the transfer below is held to *that*
  // payer, so a receipt naming someone else's transfer would hold the transfer to someone else and
  // pass. The payer is pinned here, before Tempo is read, to the one the caller or the chain names.
  if (opts.expectedPayer && !sameHex(opts.expectedPayer, payment.payer)) {
    return fail(`the receipt names payer ${payment.payer}, not ${opts.expectedPayer}, who pays this chain's charges`);
  }
  // And to whom, for the same reason: a treasury transfer to itself is net zero, one into the escrow
  // is a model channel's deposit, and neither is a payment to a storage gateway, whatever a receipt
  // says. Beyond those two, the recipient is held to the one the caller or the chain names, and a
  // scoped loop key's to the payees its policy commits.
  if (payment.recipient) {
    if (sameHex(payment.recipient, payment.payer)) {
      return fail(`the receipt names the payer ${payment.payer} as its own recipient, which pays no gateway`);
    }
    if (sameHex(payment.recipient, TEMPO_ESCROW)) {
      return fail(
        `the receipt names the escrow ${TEMPO_ESCROW} as recipient, which is a channel deposit, not a charge`
      );
    }
    if (opts.expectedRecipient && !sameHex(opts.expectedRecipient, payment.recipient)) {
      return fail(
        `the receipt names recipient ${payment.recipient}, not ${opts.expectedRecipient}, whom this chain's charges pay`
      );
    }
    const scoped = scopedStorageRecipients(loop?.tempoKey);
    if (scoped && !scoped.some((r) => sameHex(r, payment.recipient))) {
      return fail(
        `the receipt names recipient ${payment.recipient}, and loop ${loop?.loopId ?? "?"}'s key may pay only ` +
          `${scoped.length ? scoped.join(", ") : "no USDC.e recipient"}, as its policy's scopes commit`
      );
    }
  }
  if (!payment.reference) {
    // Signed for, and the answer that would have named the transaction was lost.
    return pending("the charge was signed for and no receipt came back, so it names no transaction to read");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payment.reference)) {
    return fail(`the receipt's reference ${payment.reference} is not a Tempo transaction hash`);
  }
  report.txHash = payment.reference;
  // One transfer pays one charge: a second receipt citing the same transaction is a PUT nobody paid
  // for, dressed in a payment that was made once. Failed on the chain's own terms, so Tempo is not
  // asked about a transaction it would rightly say moved the money.
  const consumedBy = opts.references?.get(payment.reference.toLowerCase());
  if (consumedBy !== undefined && consumedBy !== report.seq) {
    return fail(
      `the receipt names ${payment.reference}, which the charge at seq ${consumedBy} already named — one transfer pays one charge`
    );
  }
  opts.references?.set(payment.reference.toLowerCase(), report.seq);
  if (!payment.recipient) return pending("the receipt names no recipient, so the transfer cannot be held to one");
  if (!opts.reader?.txReceipt) return pending(`the receipt names ${payment.reference}; pass a Tempo RPC to read it`);
  let tx: TempoTxReceipt | null;
  try {
    tx = await opts.reader.txReceipt(payment.reference);
  } catch (e) {
    return pending(`${payment.reference} could not be read on Tempo: ${(e as any)?.message ?? String(e)}`);
  }
  if (!tx) return pending(`the Tempo node does not have ${payment.reference} yet`);
  if (tx.blockNumber) report.block = tx.blockNumber;
  if (tx.status !== 1) return fail(`the charge transaction ${payment.reference} reverted (status ${tx.status})`);
  const problem = chargeTransferProblem(tx.logs ?? [], payment);
  if (problem) return fail(problem);
  if (loop?.tempoKey) {
    report.attribution = attributionVerdict(tx.logs ?? [], payment, loop.loopId);
    // The money moved, and the memo it moved with does not name this loop: Tempo's own record of the
    // charge attributes it elsewhere, which is a disagreement, not a gap.
    if (report.attribution.status === "failed") return fail(`loop attribution: ${report.attribution.detail}`);
  }
  return { ...report, verdict: "verified" };
}

/** A leaf or a stop record that carries a loop's Tempo services. */
export interface TempoCarrier {
  seq: string;
  /** The carrying leaf's step; absent on the stop record, which comes after every step. */
  step?: number;
  carry: TempoCarryRecord;
  /** The stop record's own fields. */
  services?: TempoServicesRecord;
}

/** One loop's Tempo services as the chain carries them: its steps, and every carry naming them. */
export interface LoopTempoView {
  loopId: string;
  /** Each step's checkpoint seq, by step. */
  steps: Map<number, string>;
  carriers: TempoCarrier[];
  /** Carries that are there and are not what they claim: an edited blob, bytes that are not a carry. */
  problems: TempoPairingNote[];
  /** Carries or checkpoints that could not be read here. Nothing wrong; nothing checked. */
  unchecked: TempoPairingNote[];
  /** Checkpoints after this loop's first whose manifest was unreadable: a step they hold is unknown. */
  unreadCheckpoints: number;
  /**
   * The `tempoKey` the loop's step policies commit, for (e): the key when any step's does, `null` when
   * every step policy read here commits none, absent when none was readable. Read from each step's
   * Genesis — the session `idFromString("<loopId>:step-<k>")` — never inferred from the records.
   */
  tempoKey?: CommittedTempoKey | null;
}

/** A finding about one carry: the record that carries it and, when it is about one entry, its step. */
export interface TempoPairingNote {
  carrierSeq: string;
  ofStep?: number;
  text: string;
}

/**
 * Every loop on the chain with what its leaves and its stop record carry of its Tempo services,
 * keyed by loop id. A `loop.settlement` is the stop of the loop whose checkpoint came last before it.
 * Opens each session's bundle as it walks, so a gateway reader finds the carry blobs.
 */
export async function collectLoopTempo(
  records: readonly InferenceRecord[],
  store: TraceStore | undefined
): Promise<Map<string, LoopTempoView>> {
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  const settlementTool = hex(idFromString(LOOP_SETTLEMENT_TOOL));
  const views = new Map<string, LoopTempoView>();
  let current: LoopTempoView | undefined;
  /** Each Genesis's committed key, by its session id, for the loops' `tempoKey` after the walk. */
  const sessionKeys = new Map<string, CommittedTempoKey | null>();
  const policyCache = new Map<string, CommittedTempoKey | null | undefined>();
  for (const rec of records) {
    await openSessionAt(store, rec);
    if (rec.kind === EventKind.Genesis) {
      const read = await genesisSessionKey(store, rec, policyCache);
      if (read && read.key !== undefined) sessionKeys.set(read.session, read.key);
      continue;
    }
    if (rec.kind !== EventKind.Action) continue;
    const ref = hex(rec.reference);
    const seq = rec.seq.toString();
    if (ref === stepTool) {
      const manifest = await manifestOf(store, rec).catch(() => null);
      if (!manifest) {
        if (current) {
          current.unreadCheckpoints += 1;
          current.unchecked.push({ carrierSeq: seq, text: `the checkpoint at seq ${seq} is not readable here` });
        }
        continue;
      }
      current = views.get(manifest.loopId);
      if (!current) {
        current = {
          loopId: manifest.loopId,
          steps: new Map(),
          carriers: [],
          problems: [],
          unchecked: [],
          unreadCheckpoints: 0,
        };
        views.set(manifest.loopId, current);
      }
      current.steps.set(manifest.step, seq);
      if (!manifest.tempoHash) continue;
      const hash = manifest.tempoHash;
      const raw = store ? await store.get(toBytes32(hash)).catch(() => null) : null;
      if (!raw || isEncryptedTraceBlob(raw)) {
        current.unchecked.push({
          carrierSeq: seq,
          text: `the carry blob ${hash} step ${manifest.step} commits is ${raw ? "encrypted" : "not available here"}`,
        });
        continue;
      }
      if (hex(sha256(raw)) !== hash) {
        current.problems.push({
          carrierSeq: seq,
          text: `the bytes under ${hash} hash to ${hex(sha256(raw))} — the carry was edited`,
        });
        continue;
      }
      const carry = tempoCarryFromBlob(raw);
      if (!carry) {
        current.problems.push({ carrierSeq: seq, text: `the bytes under ${hash} are not a Tempo carry blob` });
        continue;
      }
      current.carriers.push({ seq, step: manifest.step, carry });
    } else if (ref === settlementTool && current) {
      const leaf = await payloadLeaf(store, rec, 1).catch(() => null);
      const blob = leaf ? await blobAt(store, leaf).catch(() => null) : null;
      if (!blob) {
        // Said only of a loop that carried something: an older settlement has no services, and an
        // unreadable one of those is `verify-channel`'s business, not this line's.
        if (current.carriers.length)
          current.unchecked.push({ carrierSeq: seq, text: `the stop record at seq ${seq} is not readable here` });
        continue;
      }
      const services = tempoServicesFromBlob(blob);
      if (services === undefined) continue;
      if (services === null) {
        current.problems.push({
          carrierSeq: seq,
          text: `the stop record at seq ${seq} carries services that are not a services record`,
        });
        continue;
      }
      current.carriers.push({ seq, carry: services, services });
    }
  }
  // A loop has one key, so any step whose policy commits one makes it a keyed loop; a policy read
  // without one is a fact about that step, and an unread one is nothing at all.
  for (const view of views.values()) {
    for (const step of view.steps.keys()) {
      const key = sessionKeys.get(hex(idFromString(`${view.loopId}:step-${step}`)));
      if (key) view.tempoKey = view.tempoKey || key;
      else if (key === null && view.tempoKey === undefined) view.tempoKey = null;
    }
  }
  return views;
}

/**
 * A Genesis's session id and the `tempoKey` its policy commits (`null` none, `undefined` unread), or
 * `undefined` when the Genesis itself is not readable. The policy is found as `policyKeyAt` finds it.
 */
async function genesisSessionKey(
  store: TraceStore | undefined,
  rec: InferenceRecord,
  cache: Map<string, CommittedTempoKey | null | undefined>
): Promise<{ session: string; key: CommittedTempoKey | null | undefined } | undefined> {
  if (!store) return undefined;
  const preimage = await blobAt(store, rec.payloadHash).catch(() => null);
  if (!preimage || preimage[0] !== rec.kind) return undefined;
  return { session: hex(preimage.slice(1, 33)), key: await policyKeyAt(store, rec, cache) };
}

/**
 * Whether every snapshot and every storage entry a loop's carries name pairs with a step: each
 * names a step the loop has a checkpoint for, earlier than the leaf that carries it (the stop
 * record comes after every step); no step's snapshot is carried twice, and no Action either; each
 * storage entry's seq is a `storage.put` on this chain, written before the record that carries it.
 * The stop record's `lastSnapshot` repeats a snapshot some carry already holds, so it is held to that
 * one's bytes rather than counted twice.
 *
 * Pure. A step no readable checkpoint names, on a loop with a checkpoint this store could not read,
 * is unchecked rather than wrong.
 */
export function pairTempoCarries(
  view: LoopTempoView,
  records: readonly InferenceRecord[]
): { problems: TempoPairingNote[]; unchecked: TempoPairingNote[] } {
  const problems: TempoPairingNote[] = [...view.problems];
  const unchecked: TempoPairingNote[] = [...view.unchecked];
  const storageTool = hex(idFromString(STORAGE_PUT_TOOL));
  const bySeq = new Map(records.map((r) => [r.seq.toString(), r]));
  const blind = view.unreadCheckpoints > 0;
  const snapshotAt = new Map<number, { carrier: TempoCarrier; snapshot: TempoSnapshotRecord }>();
  const actionAt = new Map<string, string>();
  const where = (c: TempoCarrier) =>
    c.step === undefined ? `the stop record (seq ${c.seq})` : `step ${c.step} (seq ${c.seq})`;

  const named = (c: TempoCarrier, ofStep: number, what: string): boolean => {
    if (!view.steps.has(ofStep)) {
      (blind ? unchecked : problems).push({
        carrierSeq: c.seq,
        ofStep,
        text: `${where(c)} carries ${what} of step ${ofStep}, and ${blind ? "no readable" : "no"} checkpoint of loop ${
          view.loopId
        } is step ${ofStep}`,
      });
      return false;
    }
    if (c.step !== undefined && ofStep >= c.step) {
      problems.push({
        carrierSeq: c.seq,
        ofStep,
        text: `${where(c)} carries ${what} of step ${ofStep}, which is not earlier than it`,
      });
      return false;
    }
    return true;
  };

  for (const c of view.carriers) {
    for (const snapshot of c.carry.snapshots ?? []) {
      if (!named(c, snapshot.ofStep, "a snapshot")) continue;
      const seen = snapshotAt.get(snapshot.ofStep);
      if (seen) {
        problems.push({
          carrierSeq: c.seq,
          ofStep: snapshot.ofStep,
          text: `step ${snapshot.ofStep}'s snapshot is carried twice, by ${where(seen.carrier)} and by ${where(c)}`,
        });
        continue;
      }
      snapshotAt.set(snapshot.ofStep, { carrier: c, snapshot });
    }
    for (const s of c.carry.storage ?? []) {
      if (!named(c, s.ofStep, `the storage.put at seq ${s.seq}`)) continue;
      const twice = actionAt.get(s.seq);
      if (twice) {
        problems.push({
          carrierSeq: c.seq,
          ofStep: s.ofStep,
          text: `the storage.put at seq ${s.seq} is carried twice, by seq ${twice} and by seq ${c.seq}`,
        });
        continue;
      }
      actionAt.set(s.seq, c.seq);
      const rec = bySeq.get(s.seq);
      if (!rec) {
        problems.push({
          carrierSeq: c.seq,
          ofStep: s.ofStep,
          text: `${where(c)} names a storage.put at seq ${s.seq}, and this chain has no record there`,
        });
      } else if (rec.kind !== EventKind.Action || hex(rec.reference) !== storageTool) {
        problems.push({
          carrierSeq: c.seq,
          ofStep: s.ofStep,
          text: `${where(c)} names seq ${s.seq} as a storage.put, and it is not one`,
        });
      } else if (BigInt(s.seq) >= BigInt(c.seq)) {
        problems.push({
          carrierSeq: c.seq,
          ofStep: s.ofStep,
          text: `${where(c)} carries the storage.put at seq ${s.seq}, which comes after it`,
        });
      }
    }
  }
  for (const c of view.carriers) {
    const last = c.services?.lastSnapshot;
    if (!last || !named(c, last.ofStep, "the last snapshot")) continue;
    const seen = snapshotAt.get(last.ofStep);
    if (seen && JSON.stringify(canonicalValue(seen.snapshot)) !== JSON.stringify(canonicalValue(last))) {
      problems.push({
        carrierSeq: c.seq,
        ofStep: last.ofStep,
        text: `the stop record's last snapshot of step ${last.ofStep} is not the one ${where(seen.carrier)} carries`,
      });
    }
  }
  return { problems, unchecked };
}

/**
 * Every storage entry a loop's carries name, seq → the first carry naming it (with the record that
 * carried it), and the loop each belongs to, for (e) and the scoped-key recipients. A seq two
 * carries name is a pairing problem `pairTempoCarries` reports; the charge is checked once, as the
 * first carry has it.
 * @internal — shared by `verifyCharges` and `verify-step`'s storage lines.
 */
export function carriedStorageOf(views: ReadonlyMap<string, LoopTempoView>): {
  carried: Map<string, CarriedStorageRecord & { carriedBy: string }>;
  loopOf: Map<string, LoopTempoView>;
} {
  const carried = new Map<string, CarriedStorageRecord & { carriedBy: string }>();
  const loopOf = new Map<string, LoopTempoView>();
  for (const view of views.values()) {
    for (const c of view.carriers) {
      const carriedBy = c.step === undefined ? `the stop record (seq ${c.seq})` : `seq ${c.seq}`;
      for (const s of c.carry.storage ?? []) {
        if (carried.has(s.seq)) continue;
        carried.set(s.seq, { ...s, carriedBy });
        loopOf.set(s.seq, view);
      }
    }
  }
  return { carried, loopOf };
}

/**
 * The run-wide pins one chain's storage charges are held to, threaded through them in seq order:
 * one transfer pays one charge, every charge is paid by one payer and to one recipient.
 * `optsAt(index)` is the options the charge at `records[index]` is checked with, and
 * `note(report)` is what it said, which the charges after it are held to.
 *
 * One helper, because `verify-charge` and `verify-step` check the same charges: were only one of
 * them to hold a charge to the chain's payer and to the transactions earlier charges consumed, a
 * receipt citing a stranger's transfer, or one transfer cited twice, would fail under one command
 * and print `verified` under the other.
 *
 * The payer, when `--payer` is absent, is the payer of the chain's own vouchers — the treasury the
 * loop's channel was signed against, the same address a charge's `payment.payer` carries, keyed loop
 * or not, since the key signs *for* the treasury (`MppChargePayment`). It is read nearest-first, so a
 * chain that moved to the pool is pinned to the payer in force at the charge, not to its first
 * voucher. On a chain with no readable voucher at all, the first charge that names a payer sets it:
 * one console runs an agent, and one treasury pays its charges, so a later charge naming someone
 * else is held to the first.
 *
 * The recipient, when `--recipient` is absent, is the first paid charge's that the checks did not
 * fail, since one storage gateway is paid by one console.
 * @internal — shared by `verifyCharges` and `verify-step`'s storage lines.
 */
export function chargePins(
  records: readonly InferenceRecord[],
  opts: VerifyChargeOptions
): { optsAt(index: number): Promise<VerifyChargeOptions>; note(report: ChargeReport): void } {
  const references = new Map<string, string>();
  const payerCache = new Map<string, string | null>();
  const voucherPayerAt = async (index: number): Promise<string | null> => {
    const rec = records[index];
    // `paymentOf` reads a voucher only off an LLM call, so a report a `storage.put` stored — or any
    // tool's answer — that spells a `payment` cannot move this pin.
    if (rec.kind !== EventKind.Action) return null;
    const key = rec.seq.toString();
    if (!payerCache.has(key)) {
      const paid = await paymentOf(opts.store, rec).catch(() => null);
      payerCache.set(key, paid?.payment.payer ?? null);
    }
    return payerCache.get(key)!;
  };
  const nearestVoucherPayer = async (at: number): Promise<string | undefined> => {
    for (let i = at - 1; i >= 0; i--) {
      const payer = await voucherPayerAt(i);
      if (payer) return payer;
    }
    for (let i = at + 1; i < records.length; i++) {
      const payer = await voucherPayerAt(i);
      if (payer) return payer;
    }
    return undefined;
  };
  let firstChargePayer: string | undefined;
  let firstChargeRecipient: string | undefined;
  return {
    async optsAt(index) {
      const expectedPayer = opts.expectedPayer ?? (await nearestVoucherPayer(index)) ?? firstChargePayer;
      const expectedRecipient = opts.expectedRecipient ?? firstChargeRecipient;
      return {
        ...opts,
        references,
        ...(expectedPayer ? { expectedPayer } : {}),
        ...(expectedRecipient ? { expectedRecipient } : {}),
      };
    },
    note(report) {
      if (!firstChargePayer && report.payer) firstChargePayer = report.payer;
      if (!firstChargeRecipient && report.recipient && report.verdict !== "failed") {
        firstChargeRecipient = report.recipient;
      }
    },
  };
}

/** `verify-charge`: every `storage.put` on the chain, and every loop's carries paired. */
export interface ChargesReport {
  agentId: string;
  charges: ChargeReport[];
  problems: string[];
  unchecked: string[];
  verdict: InferenceVerdict;
  reason?: string;
}

/**
 * The charge sibling of `verifyChannels`: where that one holds a loop's model channel to the
 * escrow's close, this holds each Tempo storage PUT the chain records to the one transfer that paid
 * for it (`verifyStorageCharge`), and pairs every loop's snapshots and receipts with their steps
 * (`pairTempoCarries`). Never throws. A chain with no `storage.put` and no carry — an older chain,
 * or one whose loops' host pays no Tempo service — is `no-preimage` with that said, as a vault-rail
 * chain is to `verifyChannels`.
 */
export async function verifyCharges(
  chain: InferenceChain,
  agentId: Uint8Array,
  opts: VerifyChargeOptions & { epochs?: EpochStore } = {}
): Promise<ChargesReport> {
  const id = hex(agentId);
  let walked: WalkedChain;
  try {
    walked = await walkChain(chain, agentId, opts.epochs);
  } catch (e) {
    return {
      agentId: id,
      charges: [],
      problems: [],
      unchecked: [],
      verdict: "pending",
      reason: `the chain could not be read: ${(e as any)?.message ?? String(e)}`,
    };
  }
  const records = walked.records;
  const views = await collectLoopTempo(records, opts.store);
  const problems: string[] = [];
  const unchecked: string[] = [];
  let carriers = 0;
  for (const view of views.values()) {
    const paired = pairTempoCarries(view, records);
    problems.push(...paired.problems.map((n) => n.text));
    unchecked.push(...paired.unchecked.map((n) => n.text));
    carriers += view.carriers.length;
  }
  const { carried, loopOf } = carriedStorageOf(views);
  const storageTool = hex(idFromString(STORAGE_PUT_TOOL));
  const charges: ChargeReport[] = [];
  const pins = chargePins(records, opts);
  for (const [index, rec] of records.entries()) {
    if (rec.kind !== EventKind.Action || hex(rec.reference) !== storageTool) continue;
    const seq = rec.seq.toString();
    const view = loopOf.get(seq);
    const report = await verifyStorageCharge(
      rec,
      carried.get(seq),
      await pins.optsAt(index),
      view ? { loopId: view.loopId, tempoKey: view.tempoKey } : undefined
    );
    pins.note(report);
    charges.push(report);
  }
  if (charges.length === 0 && carriers === 0 && problems.length === 0) {
    return {
      agentId: id,
      charges,
      problems,
      unchecked,
      verdict: "no-preimage",
      reason: "no storage.put and no Tempo carry on this chain (a loop whose host pays no Tempo service writes none)",
    };
  }
  // Worst first, as `verifyChannels` ranks: a disagreement, then an unchecked charge, then missing
  // bytes. An unpaid PUT moved nothing and is not a finding.
  const verdicts = charges.map((c) => c.verdict);
  const verdict: InferenceVerdict =
    problems.length || verdicts.includes("failed")
      ? "failed"
      : verdicts.includes("pending")
      ? "pending"
      : verdicts.includes("encrypted")
      ? "encrypted"
      : verdicts.includes("no-preimage")
      ? "no-preimage"
      : "verified";
  return { agentId: id, charges, problems, unchecked, verdict };
}

/** Base units of `currency` as a reader says them: dollars for USDC.e (six decimals), base units otherwise. */
export function chargeAmountText(amount: string | undefined, currency: string | undefined): string {
  if (amount === undefined) return "no amount";
  if (!sameHex(currency, TEMPO_USDC_E)) return `${amount} base units of ${currency ?? "an unnamed token"}`;
  const v = BigInt(amount);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole}${frac ? `.${frac}` : ""} USDC.e`;
}

const CHARGE_WORD: Record<ChargeVerdict, string> = {
  verified: "verified",
  pending: "unchecked",
  failed: "FAILED",
  unpaid: "no charge",
  "no-preimage": "no preimage",
  encrypted: "encrypted",
};

/** One storage line: the step's report, where it went, what it cost, the transaction and the verdict. */
export function storageLine(c: ChargeReport): string {
  const key = c.key ? (c.key.length > 44 ? `${c.key.slice(0, 44)}…` : c.key) : "unread key";
  const tx = c.txHash
    ? `, tx ${c.txHash.slice(0, 10)}…${c.txHash.slice(-4)}${c.block ? ` at block ${c.block}` : ""}`
    : "";
  // Whom it paid, beside what: the recipient is what the run-wide pin holds every charge to, so a
  // reader comparing it with the gateway's payee needs it on the line.
  const to = c.recipient ? ` to ${c.recipient}` : "";
  const cost =
    c.verdict === "unpaid" || c.amount === undefined ? "" : `, ${chargeAmountText(c.amount, c.currency)}${to}`;
  const status = c.statusCode !== undefined ? ` (${c.statusCode})` : "";
  const why = c.reason && c.verdict !== "verified" ? `: ${c.reason}` : "";
  return `storage    seq ${c.seq} ${key}${status}${cost}${tx}, ${CHARGE_WORD[c.verdict]}${why}`;
}

/** The storage line, and under it (e) for a keyed loop's charge; an unkeyed charge is its one line. */
export function storageLines(c: ChargeReport): string[] {
  const line = storageLine(c);
  return c.attribution ? [line, `  (e) attributed ${c.attribution.status}: ${c.attribution.detail}`] : [line];
}

/** `verify-channel`'s codes: 0 verified, 4 unchecked, 2 everything else. */
export function chargesExitCode(r: ChargesReport): number {
  if (r.verdict === "verified") return 0;
  if (r.verdict === "pending") return 4;
  return 2;
}

/** The human-readable rendering of a charges report, as lines. `cli.ts` prints them. */
export function formatCharges(r: ChargesReport): string[] {
  const out = [`agent      ${r.agentId}`];
  if (r.charges.length) out.push("");
  for (const c of r.charges) {
    out.push(...storageLines(c));
    if (c.ofStep !== undefined || c.carriedBy) {
      out.push(`  step ${c.ofStep ?? "?"}'s report${c.carriedBy ? `, receipt carried by ${c.carriedBy}` : ""}`);
    }
  }
  for (const p of r.problems) out.push(`pairing    FAIL: ${p}`);
  for (const u of r.unchecked) out.push(`pairing    not checkable: ${u}`);
  if (r.reason) out.push("", `  ${r.reason}`);
  const last = {
    verified: "VERIFIED",
    pending: "PENDING",
    failed: "FAILED",
    "no-preimage": "NOT VERIFIED (no preimage)",
    encrypted: "NOT VERIFIED (encrypted)",
  };
  out.push("", last[r.verdict]);
  return out;
}
