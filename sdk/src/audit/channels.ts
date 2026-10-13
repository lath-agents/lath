/**
 * `verifyChannels`: one channel, every call it paid for, and what it finally paid out, with the
 * decisions a `loop.step` manifest names folded into the channel's expected sum (`decisionBrackets`).
 */
import { EventKind } from "../events";
import { hex, idFromString, toBytes32 } from "../hash";
import { LOOP_STEP_TOOL, type LoopStepManifest } from "../loops";
import { DEFAULT_MARGIN_BPS, gateChargeMicroUsdc } from "../decision-pricing";
import type { TraceStore } from "../trace-store";
import {
  type ChannelKeyVerdict,
  type ChannelTokenVerdict,
  type CommittedTempoKey,
  type InferenceChain,
  type InferenceVerdict,
  LOOP_SETTLEMENT_TOOL,
  TEMPO_CHAIN_ID,
  type TempoChannelState,
  type TempoCloseReceipt,
  type TempoPaymentRecord,
  type TempoReader,
  type TempoSettlementRecord,
  type VerifyInferenceOptions,
  type WalkedChain,
  blobAt,
  channelTokenVerdict,
  closedLogFor,
  closeProblem,
  memoOpened,
  decimal,
  encryptedAt,
  openSessionAt,
  payloadLeaf,
  paidByLathAt,
  paymentOf,
  paymentRecordOf,
  sameHex,
  settlementFromBlob,
  silentCloseVerdict,
  silentSessionEnd,
  walkChain,
} from "./core";
import { manifestOf } from "./shared";
import {
  NO_TEMPO_KEY,
  TEMPO_KEY_POLICY_UNREAD,
  authorizeVerdict,
  lowerBlock,
  policyKeyAt,
  scopesVerdict,
  signerVerdict,
  worstKey,
} from "./keys";

// ---------------------------------------------------------------------------------------------
// The loop-level check: one channel, every call it paid for, and what it finally paid out
// ---------------------------------------------------------------------------------------------

/**
 * One channel of a chain, and whether what it paid out matches what its vouchers bought.
 *
 * `verifyInference` asks the narrow question — did *this* call get paid for — and answers it with
 * `finalAmount` covering that one call's cumulative, which is all one record can carry. A loop
 * holds one channel for all of its steps, so a chain carries the *whole* of a channel's
 * history and a stronger statement is available: the deltas of every voucher on the channel add
 * up to what the escrow paid out. That is what this report is.
 */
export interface ChannelReport {
  channelId: string;
  /** The one address every voucher on this channel names. */
  payer?: string;
  /** The seqs whose vouchers this store could produce, ascending. */
  seqs: string[];
  /** `cumulativeBefore` of the first voucher. `0` means the chain saw the channel from its open. */
  openedAt?: string;
  /** `cumulativeAfter` of the last voucher: the channel's running total, as the chain has it. */
  closedAt?: string;
  /** The per-call deltas added up, the decisions' included — what the chain says this channel bought. */
  delta?: string;
  /**
   * The decisions the loop's checkpoints commit on this channel (`decisionBrackets`), and what they
   * cost: the part of `delta` no Action records. Absent on a channel with none, older channels
   * paid before decision seats among them, so its report carries no `decisions` field.
   */
  decisions?: { count: number; delta: string };
  /** Each per-event Action's debit against its delta at the margin, when `debitOf` was given. */
  debits?: DebitCheck[];
  /** `ChannelClosed.finalAmount` from the settlement receipt, or the deposit of an open channel. */
  settled?: string;
  /** The settlement transaction the chain named, when a settlement record covers this channel. */
  txHash?: string;
  /** Whom the close paid (`ChannelClosed.payee`), when a close was read. */
  payee?: string;
  /** The channel's token from its `ChannelOpened`, held to USDC.e, on a close that verified otherwise. */
  token?: ChannelTokenVerdict;
  verdict: InferenceVerdict;
  reason?: string;
  /** (b): this channel's `authorizedSigner` is the committed key. Only when the policy carries `tempoKey`. */
  key?: ChannelKeyVerdict;
}

export interface ChannelsReport {
  agentId: string;
  channels: ChannelReport[];
  /** (a): the committed key was authorized by the payer with the committed limit and expiry. Only with `tempoKey`. */
  key?: ChannelKeyVerdict;
  /** (d): the key's scopes on Tempo equal the committed `tempoKey.scopes`. Only with scopes. */
  scopes?: ChannelKeyVerdict;
  /** The worst verdict of the channels: one channel that disagrees is a chain that disagrees. */
  verdict: InferenceVerdict;
  reason?: string;
}

export interface VerifyChannelsOptions extends VerifyInferenceOptions {
  /** One channel instead of every channel on the chain. `--channel` on the CLI. */
  channelId?: string;
  /**
   * What the transaction that wrote the record at `seq` debited through lath-billing `charge`,
   * micro-USDC; `null` when it cannot be read. The CLI's `--refetch` passes `checkpointDebitReader`.
   * With it, each per-event voucher Action's debit is held to
   * `ceil(delta × (1 + margin))`. A seq an epoch batched is not asked: its charge went in a
   * transaction of its own, which no record ties to the step (`runtime.ts` `recordLlmStep`).
   */
  debitOf?(agentId: string, seq: bigint): Promise<bigint | null>;
  /** `--margin`: the operator margin the debit is held to, in bps (`DEFAULT_MARGIN_BPS`). */
  marginBps?: number;
}

/** A channel under construction while the chain is walked once, ascending. */
interface ChannelAcc {
  channelId: string;
  payer?: string;
  seqs: bigint[];
  openedAt?: string;
  closedAt?: string;
  delta: bigint;
  /**
   * False once a voucher opens above where the previous one closed: a call this store cannot
   * produce sits between them, so the deltas here are a floor rather than the whole channel.
   */
  contiguous: boolean;
  /** The first thing found wrong on the chain's own terms, before Tempo is asked anything. */
  failure?: string;
  /** The seq of a settlement record for this channel whose bytes the store does not hold. */
  missingBlob?: bigint;
  settlement?: TempoSettlementRecord;
  /**
   * The Resolution that ended the session of the channel's last voucher without naming a settlement
   * (`silentSessionEnd`), on a channel no settlement names: what makes a zero-deposit channel after a
   * one-shot session whose close had not landed `pending`, not failed.
   */
  silentEnd?: { seq: bigint; readable: boolean } | null;
  /**
   * The key the policy in force at this channel's vouchers commits — the nearest Genesis before
   * them — when it commits one. Unset for every treasury-signed channel, which is what keeps an
   * old chain's report free of a `key` field.
   */
  tempoKey?: CommittedTempoKey;
  /** The vouchers that name a `signer`, for (b). */
  signers: { seq: bigint; signer: string }[];
  /** The smallest `openBlock` any voucher on it recorded: where the `ChannelOpened` read starts. */
  openBlock?: string;
  /**
   * The brackets of the decisions the loop's checkpoints commit on this channel (`decisionBrackets`):
   * paid calls with no Action of their own. Kept apart from the Actions' vouchers because the chain
   * commits them in a checkpoint, not at the point on the channel where they were paid, so they take
   * no part in the chain-order checks and are merged by cumulative in `judgeChannel`.
   */
  decisions: { before: bigint; after: bigint; what: string }[];
  /** The Actions' own brackets, in chain order, for the merge with `decisions`. */
  brackets: { before: bigint; after: bigint; what: string }[];
  /**
   * The lath-billing debit of each per-event voucher Action, against `ceil(delta × (1 + margin))`.
   * Only when the caller gave `debitOf`.
   */
  debits: DebitCheck[];
}

/** One Action's Solana debit beside what its voucher delta gives at the margin. */
export interface DebitCheck {
  seq: string;
  /** The voucher delta, base units. */
  deltaBase: string;
  /** `ceil(delta × (1 + margin))`, micro-USDC, the rule the runtime charges by (`toMicroUsdcFromBase`). */
  expectedMicroUsdc: string;
  /** What the record's transaction debited through `charge`; absent when it could not be read. */
  debitMicroUsdc?: string;
  /**
   * `absorbed`: a chat attempt that got no answer, which its result blob records as Lath's
   * (`paidBy: "lath"`), and which debited the owner nothing — the rule for it, so it passes. Such a
   * record that debited anything is a `mismatch`: the chain says Lath paid and the owner was
   * charged. Never on an older record, which carries no marker.
   */
  status: "ok" | "uncharged" | "mismatch" | "unchecked" | "absorbed";
  /** Set when the record's blob says Lath paid for the call (`paidBy: "lath"`). */
  paidByLath?: true;
}

/**
 * The vouchers of the decisions a `loop.step` manifest commits, each one more paid call on the loop's
 * channel that no Action records: the step's verify or goal check. Without them a channel with a Jev
 * seat opens gaps between its Actions' cumulatives, and `verifyChannels` would read the channel as
 * one it held only part of — `Σdelta ≤ paid`, which would let an inflated step claim the rest. Read
 * through `blobAt`, so an edited blob is a gap here and `verify-step`'s finding, not a bracket;
 * deduplicated by hash.
 *
 * A step a roadmap feature wrote (a trace audit and its confirm call, a team member's verdict and
 * routing, a gate log's asks) paid for decisions this build does not name: they stay gaps, so such a
 * channel is held to the weaker claim, never failed for them. This build does not verify those
 * decisions.
 */
export async function decisionBrackets(
  store: TraceStore | undefined,
  manifest: LoopStepManifest
): Promise<{ hash: string; payment: TempoPaymentRecord; what: string }[]> {
  const step = `step ${manifest.step}`;
  const named: [string, string][] = [];
  if (manifest.verifyHash) named.push([manifest.verifyHash, `${step}'s verify decision`]);
  if (manifest.goalCheckHash) named.push([manifest.goalCheckHash, `${step}'s goal check`]);
  const out: { hash: string; payment: TempoPaymentRecord; what: string }[] = [];
  const seen = new Set<string>();
  for (const [hash, what] of named) {
    if (!/^[0-9a-fA-F]{64}$/.test(hash) || seen.has(hash.toLowerCase())) continue;
    seen.add(hash.toLowerCase());
    const bytes = await blobAt(store, toBytes32(hash)).catch(() => null);
    if (!bytes) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    const payment = paymentRecordOf(parsed?.payment);
    if (payment) out.push({ hash, payment, what });
  }
  return out;
}

/**
 * Every Tempo channel this chain paid through, checked against the escrow's own close.
 *
 * A loop opens one channel and closes it once, so a channel's whole history is on one
 * chain: every `tempo`-rail Action names it, the deltas of those vouchers are what the calls
 * cost, and the `ChannelClosed` receipt the settlement record names says what the escrow paid the
 * gateway. When the chain saw the channel from its open — the first voucher's `cumulativeBefore`
 * is `0` — and no voucher between its calls is missing from the store, those two are the same
 * number and this demands equality. Otherwise the chain holds only part of the channel and the
 * honest claim is the weaker one: what it can see was paid for, and no more.
 *
 * Everything else it says is a restatement of `verifyInference`'s chain-only checks over a whole
 * channel rather than one seq — one payer per channel, one chain id, a cumulative that never goes
 * backwards — so a chain that disagrees with itself is `failed` before Tempo is opened.
 *
 * A loop that paid through its own access key commits a `tempoKey` in the policy its steps' Genesis
 * records name, and only for such a chain does the report gain `key` fields: (a) on the report, the
 * authorize; (b) on each channel written under the key, its `authorizedSigner` and its vouchers'
 * signers; and (d), `scopes` on the report, when the key's policy also commits call scopes. The
 * policy is what gates them, never the records — a chain whose policies commit no key is walked and
 * judged without them, and its report carries no `key` field. Any of the three left `unchecked`
 * holds a report whose channels verified at `pending`, not `verified`.
 *
 * Pure: the RPC is behind `TempoReader`, so nothing viem-typed reaches the browser entry.
 */
export async function verifyChannels(
  chain: InferenceChain,
  agentId: Uint8Array,
  opts: VerifyChannelsOptions = {}
): Promise<ChannelsReport> {
  const id = hex(agentId);
  opts = { ...opts, reader: memoOpened(opts.reader) };
  let walked: WalkedChain;
  try {
    walked = await walkChain(chain, agentId, opts.epochs);
  } catch (e) {
    return {
      agentId: id,
      channels: [],
      verdict: "pending",
      reason: `the chain could not be read: ${(e as any)?.message ?? String(e)}`,
    };
  }

  const settlementTool = hex(idFromString(LOOP_SETTLEMENT_TOOL));
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  /** Keyed by lowercased channel id, in the order the chain first names them. */
  const channels = new Map<string, ChannelAcc>();
  const accFor = (channelId: string, payer: string): ChannelAcc => {
    const key = channelId.toLowerCase();
    let acc = channels.get(key);
    if (!acc) {
      acc = {
        channelId,
        payer,
        seqs: [],
        delta: BigInt(0),
        contiguous: true,
        signers: [],
        decisions: [],
        brackets: [],
        debits: [],
      };
      channels.set(key, acc);
    }
    return acc;
  };
  /** The channel the last voucher named, so a settlement that names none is attributed to it. */
  let lastChannel: string | null = null;
  /**
   * Whether the session of `lastChannel`'s last voucher is still the one being walked: no Genesis
   * and no Resolution since. The session ends where `silentSessionEnd` ends it — at its own
   * Resolution, or at the next Genesis when it never resolved. A Resolution that names no channel
   * (an older one) settles only its own session's channel; attributed to "the last channel walked"
   * across a session boundary, the next session's `{ txHash, spent }` — a session that paid through
   * no voucher this walk could read — would be held against channel A, whose close had not landed,
   * and an honest chain would fail as "closed channel B, not A".
   */
  let lastSessionOpen = false;
  /** Whether any record's blobs were there and encrypted, which changes what "nothing found" means. */
  let sawEncrypted = false;
  /**
   * The `tempoKey` of the policy in force — the last Genesis walked — `null` when that policy has
   * none, `undefined` when it could not be read. Each step of a loop opens with a Genesis naming the
   * loop's policy, so the vouchers after it are the loop's; a chat session's Genesis names a policy
   * with no key, and resets this, so its channel is never held to a loop's key.
   */
  let inForce: CommittedTempoKey | null | undefined;
  /** Every distinct committed key, by lowercased address, for (a); and whether any policy was read. */
  const committedKeys = new Map<string, CommittedTempoKey>();
  let readAPolicy = false;
  const policyCache = new Map<string, CommittedTempoKey | null | undefined>();

  for (const rec of walked.records) {
    await openSessionAt(opts.store, rec);
    if (rec.kind === EventKind.Genesis) {
      lastSessionOpen = false;
      inForce = await policyKeyAt(opts.store, rec, policyCache);
      if (inForce !== undefined) readAPolicy = true;
      if (inForce) committedKeys.set(inForce.address.toLowerCase(), inForce);
      continue;
    }
    const isLoopSettlement = rec.kind === EventKind.Action && hex(rec.reference) === settlementTool;
    if (rec.kind === EventKind.Action && hex(rec.reference) === stepTool) {
      // A checkpoint's result is a leaf, never a voucher; what it carries for a channel is the
      // decisions its manifest commits. An unreadable manifest leaves the gaps it would have closed.
      const manifest = await manifestOf(opts.store, rec).catch(() => null);
      for (const d of manifest ? await decisionBrackets(opts.store, manifest) : []) {
        if (d.payment.chainId !== TEMPO_CHAIN_ID) continue;
        const acc = accFor(d.payment.channelId, d.payment.payer);
        if (!sameHex(acc.payer, d.payment.payer)) {
          acc.failure ??= `${d.what} names payer ${d.payment.payer} on channel ${acc.channelId}, which is ${acc.payer}'s — one channel has one payer`;
        }
        const before = BigInt(d.payment.cumulativeBefore);
        const after = BigInt(d.payment.cumulativeAfter);
        if (after < before) acc.failure ??= `${d.what}'s voucher runs backwards, ${before} → ${after}`;
        else acc.decisions.push({ before, after, what: d.what });
      }
      continue;
    }
    if (rec.kind === EventKind.Action && !isLoopSettlement) {
      let found: { payment: TempoPaymentRecord; blobHash: Uint8Array } | null = null;
      try {
        found = await paymentOf(opts.store, rec);
        // Withheld, not lost: remembered so that a chain whose every voucher is ciphertext says
        // so instead of reading like a chain that never paid over Tempo at all.
        if (!found && !sawEncrypted) sawEncrypted = await encryptedAt(opts.store, rec.payloadHash);
      } catch {
        // Bytes nobody kept are not a disagreement: a voucher that cannot be read leaves a gap
        // `contiguous` notices, and the channel is judged on what is left.
        found = null;
      }
      if (!found) continue;
      const seen = found.payment;
      const key = seen.channelId.toLowerCase();
      const acc = accFor(seen.channelId, seen.payer);
      if (acc.seqs.length === 0) acc.openedAt = seen.cumulativeBefore;
      // The debit, only for a record with a transaction of its own (not an epoch member) and only
      // when asked: one chain read per Action is the caller's choice, as `--refetch` is.
      if (opts.debitOf && !walked.memberships.has(rec.seq.toString())) {
        const deltaBase = BigInt(seen.cumulativeAfter) - BigInt(seen.cumulativeBefore);
        // A call that got no answer and that the record says Lath paid for is owed no debit at all;
        // every other call is owed the margin rule. The marker is read off the same
        // blob `result_hash` commits, so it cannot be added to a record after the fact.
        const lath = await paidByLathAt(opts.store, found.blobHash);
        const expected = lath ? BigInt(0) : gateChargeMicroUsdc(deltaBase, opts.marginBps ?? DEFAULT_MARGIN_BPS);
        const debit = await opts.debitOf(id, rec.seq).catch(() => null);
        acc.debits.push({
          seq: rec.seq.toString(),
          deltaBase: deltaBase.toString(),
          expectedMicroUsdc: expected.toString(),
          ...(debit !== null ? { debitMicroUsdc: debit.toString() } : {}),
          ...(lath ? { paidByLath: true as const } : {}),
          status:
            debit === null
              ? "unchecked"
              : lath
              ? debit === BigInt(0)
                ? "absorbed"
                : "mismatch"
              : debit === expected
              ? "ok"
              : debit === BigInt(0)
              ? "uncharged"
              : "mismatch",
        });
      }
      // The first committed key a voucher on the channel was written under is the channel's. A loop
      // never shares a channel with another loop, so there is no second one to reconcile.
      if (inForce && !acc.tempoKey) acc.tempoKey = inForce;
      if (seen.signer) acc.signers.push({ seq: rec.seq, signer: seen.signer });
      acc.openBlock = lowerBlock(acc.openBlock, decimal(seen.openBlock) ?? undefined);
      if (seen.chainId !== TEMPO_CHAIN_ID) {
        acc.failure ??= `seq ${rec.seq} names chain ${seen.chainId}, and this verifier speaks only for ${TEMPO_CHAIN_ID}`;
      }
      // A channel has one signer, so two payers on one channel id is an edited record — the same
      // check `verifyInference` makes across seqs, made here over a whole channel.
      if (!sameHex(acc.payer, seen.payer)) {
        acc.failure ??=
          `seq ${rec.seq} names payer ${seen.payer} on channel ${acc.channelId}, which seq ${acc.seqs[0]} ` +
          `opened against ${acc.payer} — one channel has one payer`;
      }
      const before = BigInt(seen.cumulativeBefore);
      const after = BigInt(seen.cumulativeAfter);
      if (after < before) acc.failure ??= `seq ${rec.seq} has a cumulative that goes backwards inside one call`;
      if (acc.closedAt !== undefined) {
        const prev = BigInt(acc.closedAt);
        if (before < prev) {
          acc.failure ??=
            `seq ${rec.seq} opens at ${before} on channel ${acc.channelId}, below the ${prev} an earlier ` +
            `record already committed to — a voucher total never goes down`;
        } else if (before > prev) {
          acc.contiguous = false;
        }
      }
      acc.seqs.push(rec.seq);
      acc.delta += after > before ? after - before : BigInt(0);
      if (after >= before) acc.brackets.push({ before, after, what: `seq ${rec.seq}` });
      acc.closedAt = seen.cumulativeAfter;
      lastChannel = key;
      lastSessionOpen = true;
      continue;
    }

    if (!isLoopSettlement && rec.kind !== EventKind.Resolution) continue;
    // Read before this Resolution closes the session, for the attribution below.
    const ownSession = lastSessionOpen;
    if (rec.kind === EventKind.Resolution) lastSessionOpen = false;
    let blob: Uint8Array | null = null;
    try {
      const leaf = await payloadLeaf(opts.store, rec, isLoopSettlement ? 1 : 0);
      blob = leaf ? await blobAt(opts.store, leaf) : null;
    } catch {
      blob = null;
    }
    if (!blob) {
      // A Resolution whose blob is missing may have settled nothing at all; a `loop.settlement`
      // record is a settlement by its tool id, so its missing bytes are what stop the verdict.
      if (isLoopSettlement && lastChannel) channels.get(lastChannel)!.missingBlob ??= rec.seq;
      continue;
    }
    const found = settlementFromBlob(blob);
    if (!found) continue;
    // A one-shot session's Resolution carries `{ txHash, spent }` and names no channel, so it
    // settles the channel its own calls were paid on — the last one walked, and only while that
    // channel's session is the one this Resolution closes (`lastSessionOpen`). A `loop.settlement`
    // settles many sessions later and keeps the last channel walked.
    const attributable = isLoopSettlement || ownSession;
    const key = (
      found.channelId ?? (attributable ? channels.get(lastChannel ?? "")?.channelId : undefined)
    )?.toLowerCase();
    const acc = key ? channels.get(key) : undefined;
    // A loop settles a channel once, so the first settlement naming it is its close; one
    // naming a channel no voucher here used is some other chain's business.
    if (acc && !acc.settlement) acc.settlement = found;
  }

  const wanted = opts.channelId;
  const reports: ChannelReport[] = [];
  const judged: ChannelAcc[] = [];
  /**
   * Whom every close is held to paying: `--payee`, else the payee of the chain's first channel that
   * verified. One console pays one model gateway, so a later channel closed to another address — one
   * the operator holds, say — is held to the first, as a later payer is.
   */
  let firstPayee: string | undefined;
  for (const acc of channels.values()) {
    if (wanted && !sameHex(acc.channelId, wanted)) continue;
    if (!acc.settlement?.txHash && acc.seqs.length) {
      acc.silentEnd = await silentSessionEnd(opts.store, walked.records, acc.seqs[acc.seqs.length - 1], stepTool);
    }
    const payee = opts.expectedPayee
      ? { address: opts.expectedPayee, whose: "the gateway --payee names" }
      : firstPayee
      ? { address: firstPayee, whose: "whom this chain's first settled channel paid" }
      : undefined;
    const report = await withChannelKey(await judgeChannel(acc, opts, payee), acc, opts.reader);
    if (!firstPayee && report.payee && report.verdict === "verified") firstPayee = report.payee;
    reports.push(report);
    judged.push(acc);
  }

  // (a), once per distinct key the reported channels were written under — or, on a chain with no
  // voucher yet, per key any policy committed, since an authorize can be wrong before anything
  // was paid through it. Held to the payer the caller named, else the payer of the key's channels.
  const keyed = judged.filter((a) => a.tempoKey);
  const toCheck = new Map<string, CommittedTempoKey>();
  for (const a of keyed) toCheck.set(a.tempoKey!.address.toLowerCase(), a.tempoKey!);
  if (judged.length === 0 && !wanted) for (const [addr, k] of committedKeys) toCheck.set(addr, k);
  const payerOf = (k: CommittedTempoKey) =>
    opts.expectedPayer ??
    keyed.find((a) => sameHex(a.tempoKey!.address, k.address))?.payer ??
    judged.find((a) => a.payer)?.payer;
  let keyVerdict: ChannelKeyVerdict | undefined;
  if (toCheck.size > 0) {
    const parts: ChannelKeyVerdict[] = [];
    for (const k of toCheck.values()) parts.push(await authorizeVerdict(k, payerOf(k), opts.reader));
    keyVerdict =
      parts.length === 1 ? parts[0] : worstKey(parts, [...toCheck.values()].map((k) => k.address).join(", "));
  } else if (opts.requireKey) {
    keyVerdict = { status: "unchecked", detail: readAPolicy ? NO_TEMPO_KEY : TEMPO_KEY_POLICY_UNREAD };
  }
  // (d), for the same keys, and only those whose policy commits scopes: an unscoped key — an older
  // key, or any key with `LATH_TEMPO_KEY_SCOPES=off` — leaves no `scopes` field.
  const scoped = [...toCheck.values()].filter((k) => k.scopes || k.badScopes);
  let scopeVerdict: ChannelKeyVerdict | undefined;
  if (scoped.length > 0) {
    const parts: ChannelKeyVerdict[] = [];
    for (const k of scoped) parts.push(await scopesVerdict(k, payerOf(k), opts.reader));
    scopeVerdict = parts.length === 1 ? parts[0] : worstKey(parts, scoped.map((k) => k.address).join(", "));
  }
  const withKey = { ...(keyVerdict ? { key: keyVerdict } : {}), ...(scopeVerdict ? { scopes: scopeVerdict } : {}) };
  // An authorize that contradicts the policy fails the chain the way a channel that does would: the
  // cap the loop committed is not the cap Tempo enforces. So do scopes that contradict it: the calls
  // a leaked key could make are not the ones the chain committed to.
  const keyFailure =
    keyVerdict?.status === "failed"
      ? `the loop's Tempo key: ${keyVerdict.detail}`
      : scopeVerdict?.status === "failed"
      ? `the loop's Tempo key scopes: ${scopeVerdict.detail}`
      : undefined;

  if (reports.length === 0) {
    if (sawEncrypted && !wanted) {
      return {
        agentId: id,
        channels: [],
        ...withKey,
        verdict: keyFailure ? "failed" : "encrypted",
        reason:
          keyFailure ??
          "every voucher on this chain is encrypted by its owner; pass --trace-key <hex|path> to read them",
      };
    }
    return {
      agentId: id,
      channels: [],
      ...withKey,
      // A channel nobody on this chain paid through is a question about another chain; a chain
      // with no voucher at all is every vault-rail chain, and nothing about it failed.
      verdict: wanted || keyFailure ? "failed" : "no-preimage",
      reason: wanted
        ? `no readable voucher on this chain names channel ${wanted}`
        : keyFailure ?? "no readable tempo voucher on this chain (a vault-rail chain carries none)",
    };
  }
  // Worst first: a disagreement outranks an unchecked channel, which outranks missing bytes.
  const worst: InferenceVerdict =
    reports.find((r) => r.verdict === "failed")?.verdict ??
    reports.find((r) => r.verdict === "pending")?.verdict ??
    reports.find((r) => r.verdict === "no-preimage")?.verdict ??
    "verified";
  if (keyFailure) return { agentId: id, channels: reports, ...withKey, verdict: "failed", reason: keyFailure };
  // A committed key whose (a), (b) or (d) did not run is a check the policy asked for and nobody
  // made, so VERIFIED — exit 0 — would say the loop's cap was held to Tempo when it was not. It is
  // held at `pending`, the slot an unreadable Tempo gets everywhere in this verifier (exit 4): not
  // wrong, not checked. `--key`'s placeholder on a chain that commits no key is not one of these —
  // there was nothing to check — and a treasury-signed chain carries no key field at all.
  const keyGaps = [
    ...(toCheck.size > 0 && keyVerdict?.status === "unchecked" ? [`(a) ${keyVerdict.detail}`] : []),
    ...reports.filter((r) => r.key?.status === "unchecked").map((r) => `(b) ${r.key!.detail}`),
    ...(scopeVerdict?.status === "unchecked" ? [`(d) ${scopeVerdict.detail}`] : []),
  ];
  if (worst === "verified" && keyGaps.length) {
    return {
      agentId: id,
      channels: reports,
      ...withKey,
      verdict: "pending",
      reason: `the channels balance, and the loop's Tempo key is unchecked: ${keyGaps.join("; ")}`,
    };
  }
  return { agentId: id, channels: reports, ...withKey, verdict: worst };
}

/**
 * (b) on one channel's report, when the policy its vouchers were written under commits a key. A
 * different signer fails the channel, whatever the escrow said about its amounts — the vouchers
 * were not signed by the key the cap is on. An unreadable Tempo leaves the verdict as it was.
 * A channel with no committed key comes back untouched: no `key` field, the same object.
 */
async function withChannelKey(
  report: ChannelReport,
  acc: ChannelAcc,
  reader: TempoReader | undefined
): Promise<ChannelReport> {
  if (!acc.tempoKey) return report;
  const key = await signerVerdict(
    { channelId: acc.channelId, signers: acc.signers, vouchers: acc.seqs.length, openBlock: acc.openBlock },
    acc.tempoKey,
    reader
  );
  if (key.status === "failed" && report.verdict !== "failed") {
    return { ...report, key, verdict: "failed", reason: key.detail };
  }
  return { ...report, key };
}

/** One channel's verdict: the chain's own arithmetic first, then the escrow. */
async function judgeChannel(
  acc: ChannelAcc,
  opts: VerifyChannelsOptions,
  payee?: { address: string; whose: string }
): Promise<ChannelReport> {
  // Every bracket on the channel as one list by cumulative: the Actions' vouchers, which the walk
  // held to chain order, and the decisions, which it could not. A channel is *whole* when the list
  // starts at 0 and each bracket opens where the last closed; two that overlap are one payment
  // counted twice, which no honest pair of calls produces. On a channel with no decision the list is
  // the walk's own order, so `whole` is the walk's contiguity.
  const all = [...acc.brackets, ...acc.decisions].sort((a, b) =>
    a.before < b.before ? -1 : a.before > b.before ? 1 : 0
  );
  let joined = all.length > 0 && all[0].before === BigInt(0);
  let overlap: string | undefined;
  for (let i = 1; i < all.length; i++) {
    if (all[i].before < all[i - 1].after) {
      overlap ??= `${all[i - 1].what} and ${all[i].what} name overlapping vouchers on channel ${
        acc.channelId
      }, so one payment is counted twice`;
    } else if (all[i].before > all[i - 1].after) joined = false;
  }
  const decisionDelta = acc.decisions.reduce((sum, d) => sum + (d.after - d.before), BigInt(0));
  const delta = acc.delta + decisionDelta;
  const top = all.reduce((max, b) => (b.after > max ? b.after : max), BigInt(0));
  const base: ChannelReport = {
    channelId: acc.channelId,
    payer: acc.payer,
    seqs: acc.seqs.map((s) => s.toString()),
    openedAt: acc.decisions.length && all.length ? all[0].before.toString() : acc.openedAt,
    closedAt: acc.decisions.length ? top.toString() : acc.closedAt,
    delta: delta.toString(),
    ...(acc.decisions.length ? { decisions: { count: acc.decisions.length, delta: decisionDelta.toString() } } : {}),
    ...(acc.debits.length ? { debits: acc.debits } : {}),
    verdict: "failed",
    ...(acc.settlement?.txHash ? { txHash: acc.settlement.txHash } : {}),
  };
  const fail = (reason: string): ChannelReport => ({ ...base, verdict: "failed", reason });
  const unchecked = (reason: string): ChannelReport => ({ ...base, verdict: "pending", reason });

  if (acc.failure) return fail(acc.failure);
  if (overlap) return fail(overlap);
  // The debit is the user's side of the same call: a transaction that charged other than the rule
  // gives is a disagreement between the two ledgers the record joins. One that charged nothing is an
  // unfunded or unbilled session and is reported, not failed — the user was not overcharged.
  const wrong = acc.debits.find((d) => d.status === "mismatch");
  if (wrong?.paidByLath) {
    return fail(
      `seq ${wrong.seq} records a call that got no answer as paid by Lath, and its transaction debited the owner ` +
        `${wrong.debitMicroUsdc} µUSDC for it — such a call is owed no debit`
    );
  }
  if (wrong) {
    return fail(
      `seq ${wrong.seq} debited ${wrong.debitMicroUsdc} µUSDC for a voucher delta of ${wrong.deltaBase} base units, ` +
        `and ceil(delta × (1 + margin)) at ${(opts.marginBps ?? DEFAULT_MARGIN_BPS) / 10_000} gives ` +
        `${wrong.expectedMicroUsdc} (pass --margin if the operator charged under another)`
    );
  }
  if (opts.expectedPayer && !sameHex(opts.expectedPayer, acc.payer)) {
    return fail(`channel ${acc.channelId} was paid by ${acc.payer}, not by ${opts.expectedPayer}`);
  }
  if (acc.missingBlob !== undefined) {
    return {
      ...base,
      verdict: "no-preimage",
      reason: `the settlement record at seq ${acc.missingBlob} commits bytes this store does not hold`,
    };
  }
  if (!opts.reader) {
    return unchecked(
      acc.settlement?.txHash
        ? `the chain names settlement ${acc.settlement.txHash}; pass a Tempo RPC to read it`
        : `no settlement record names channel ${acc.channelId}, and no Tempo RPC was given to read it`
    );
  }

  const txHash = acc.settlement?.txHash;
  if (!txHash) {
    // Nothing settled yet — or a close that landed with no transaction to show for it, which is
    // what a restart writes when the channel was closed from outside the process. Either
    // way the channel itself is the only evidence, and only while it is open.
    let state: TempoChannelState | null;
    try {
      state = await opts.reader.channelState(acc.channelId);
    } catch (e) {
      return unchecked(`channel ${acc.channelId} could not be read: ${(e as any)?.message ?? String(e)}`);
    }
    if (!state || state.deposit === BigInt(0)) {
      // Zeros are what a closed channel reads as: this one was settled by a transaction no record on
      // this chain names. After a one-shot session whose Resolution says its close had not landed,
      // that is the chain being silent rather than contradicted, exactly as `verify-inference` says
      // it of the same call.
      if (acc.silentEnd) {
        const said = silentCloseVerdict(acc.channelId, acc.silentEnd, "the session of its last call");
        return said.verdict === "no-preimage"
          ? { ...base, verdict: "no-preimage", reason: said.reason }
          : unchecked(said.reason);
      }
      return fail(`channel ${acc.channelId} holds nothing and no settlement record names it`);
    }
    const held = state.deposit;
    const owed = acc.decisions.length ? top : BigInt(acc.closedAt ?? "0");
    if (held < owed) {
      return fail(`channel ${acc.channelId} holds ${held} base units, below the ${owed} its vouchers commit to`);
    }
    return {
      ...base,
      settled: held.toString(),
      verdict: "pending",
      reason: `channel ${acc.channelId} is open and holds ${held} base units; it has not settled yet`,
    };
  }

  let receipt: TempoCloseReceipt | null;
  try {
    receipt = await opts.reader.closeReceipt(txHash, acc.channelId);
  } catch (e) {
    return unchecked(`${txHash} could not be read on Tempo: ${(e as any)?.message ?? String(e)}`);
  }
  if (!receipt) return unchecked(`the Tempo node does not have ${txHash} yet`);
  const paidTo = closedLogFor(receipt, acc.channelId)?.payee;
  if (paidTo) base.payee = paidTo;
  const problem = closeProblem(receipt, txHash, acc.channelId, acc.payer, payee);
  if (problem) return fail(problem);
  const paid = closedLogFor(receipt, acc.channelId)!.finalAmount;
  const out: ChannelReport = { ...base, settled: paid.toString() };
  /** The chain holds the channel from its open and misses nothing in between. */
  const whole = joined;
  const calls = acc.decisions.length
    ? `${acc.seqs.length} calls and ${acc.decisions.length} decisions`
    : `${acc.seqs.length} calls`;
  // In what: the close names an amount and a payee, and only the open names the token. A channel
  // whose amounts disagree has failed already and is not read further.
  if (!(whole && delta !== paid) && !(!whole && delta > paid)) {
    out.token = await channelTokenVerdict(opts.reader, acc.channelId, acc.openBlock);
    if (out.token.status === "failed") return { ...out, verdict: "failed", reason: out.token.detail };
  }
  if (whole && delta !== paid) {
    return {
      ...out,
      verdict: "failed",
      reason:
        `channel ${acc.channelId} paid out ${paid} base units and the ${calls} on it commit ` +
        `to ${delta} — a channel this chain saw from its open pays for exactly what it bought`,
    };
  }
  if (!whole && delta > paid) {
    return {
      ...out,
      verdict: "failed",
      reason: `channel ${acc.channelId} paid out ${paid} base units, below the ${delta} the calls on this chain commit to`,
    };
  }
  return {
    ...out,
    verdict: "verified",
    ...(whole
      ? {}
      : {
          reason:
            `this chain holds part of channel ${acc.channelId}: it opens at ${base.openedAt}` +
            `${acc.contiguous ? "" : " and a voucher between its calls is not readable here"}, so ${delta} ` +
            `of the ${paid} paid out is what it can account for`,
        }),
  };
}

/** The human-readable rendering of a channel report, as lines. `cli.ts` prints them. */
export function formatChannels(r: ChannelsReport): string[] {
  const out = [`agent      ${r.agentId}`];
  out.push(...formatKeyLines(r));
  for (const c of r.channels) {
    out.push("", `channel    ${c.channelId}`);
    if (c.payer) out.push(`payer      ${c.payer}`);
    out.push(`calls      ${c.seqs.length}${c.seqs.length ? ` (seq ${c.seqs.join(", ")})` : ""}`);
    if (c.openedAt !== undefined && c.closedAt !== undefined) {
      out.push(`vouchers   ${c.openedAt} → ${c.closedAt} (${c.delta} USDC.e base units bought on this chain)`);
    }
    if (c.decisions) {
      out.push(
        `decisions  ${c.decisions.count} committed by the loop's checkpoints, ${c.decisions.delta} base units of the above`
      );
    }
    if (c.debits?.length) {
      const by = (status: DebitCheck["status"]) => c.debits!.filter((d) => d.status === status);
      const summary = `${by("ok").length} match ceil(delta × (1 + margin))`;
      const rest = [
        by("uncharged").length ? `${by("uncharged").length} debited nothing` : "",
        by("absorbed").length ? `${by("absorbed").length} paid by Lath (no answer), debited nothing` : "",
        by("unchecked").length ? `${by("unchecked").length} not read` : "",
        by("mismatch").length ? `${by("mismatch").length} differ` : "",
      ].filter(Boolean);
      out.push(`debits     ${c.debits.length} per-event calls: ${[summary, ...rest].join(", ")}`);
    }
    if (c.settled !== undefined) {
      out.push(`settled    ${c.settled}${c.verdict === "pending" ? " (still on deposit)" : ""}`);
    }
    if (c.txHash) out.push(`tx         ${c.txHash}`);
    if (c.payee) out.push(`payee      ${c.payee}`);
    if (c.token) out.push(`token      ${c.token.status}: ${c.token.detail}`);
    if (c.key) out.push(`key        ${c.key.status}: ${c.key.detail}`);
    if (c.reason) out.push(`  ${c.reason}`);
  }
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

/**
 * The key block of a channels report, as lines: nothing at all when the report has no `key`, which
 * is every treasury-signed chain, so its rendering carries no key block. Otherwise the key, (a), (b)
 * summarised over the channels written under it, and audit (c), which is on the roadmap and printed
 * as unchecked so nobody reads its absence as a pass, then (d) when the policy commits scopes.
 * Exported for `lath-audit --key`, which prints the block under the chain audit.
 */
export function formatKeyLines(r: ChannelsReport): string[] {
  const k = r.key;
  if (!k) return [];
  if (!k.address) return [`key        ${k.detail}`];
  const keyed = r.channels.filter((c) => c.key);
  const failed = keyed.filter((c) => c.key!.status === "failed");
  const unread = keyed.filter((c) => c.key!.status === "unchecked");
  let b: string;
  if (keyed.length === 0) b = "unchecked: no channel on this chain was paid under the key yet";
  else if (failed.length) b = `failed: ${failed.length} of ${keyed.length} channels — ${failed[0].key!.detail}`;
  else if (unread.length)
    b = `unchecked: ${unread.length} of ${keyed.length} channels not read — ${unread[0].key!.detail}`;
  else b = `ok: ${keyed.length} of ${keyed.length} channels opened with the key as authorizedSigner`;
  return [
    `key        ${k.address}`,
    `  (a) authorized   ${k.status}: ${k.detail}`,
    `  (b) signed       ${b}`,
    `  limit reconciles: unchecked (audit (c), every SpendingLimitUpdated against the reconcile, is Q4)`,
    // (d) only for a key whose policy commits scopes, so an unscoped key's block has no (d) line.
    ...(r.scopes ? [`  (d) scopes       ${r.scopes.status}: ${r.scopes.detail}`] : []),
  ];
}

/** The same codes and meanings as `inferenceExitCode`: 0 verified, 4 unchecked, 2 everything else. */
export function channelsExitCode(r: ChannelsReport): number {
  if (r.verdict === "verified") return 0;
  if (r.verdict === "pending") return 4;
  return 2;
}
