/**
 * `verifyInference`: did this one LLM call get paid for, and can anyone else see it? Everything it
 * does with the chain and the blobs is pure — the RPC lives behind `TempoReader`, and viem behind
 * that, so this file ships in the browser entry.
 */
import { EventKind } from "../events";
import { hex, idFromString } from "../hash";
import { LOOP_STEP_TOOL } from "../loops";
import {
  type InferenceChain,
  type InferenceReport,
  LOOP_SETTLEMENT_TOOL,
  TEMPO_CHAIN_ID,
  type TempoChannelState,
  type TempoCloseReceipt,
  type TempoPaymentRecord,
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
  paidByLathAt,
  payloadLeaf,
  paymentOf,
  sameHex,
  settlementFromBlob,
  silentCloseVerdict,
  silentSessionEnd,
  voucherAt,
  walkChain,
} from "./core";
import {
  type ChannelSigners,
  NO_TEMPO_KEY,
  TEMPO_KEY_POLICY_UNREAD,
  authorizeVerdict,
  lowerBlock,
  policyKeyAt,
  signerVerdict,
  worstKey,
} from "./keys";
import { chatModelsAt, committedModelsAt, modelProblem } from "./models";

/**
 * Did this one LLM call get paid for, and can anyone else see it?
 *
 * The record at `seq` commits a voucher: the channel's cumulative total before and after that
 * call, signed against a TIP-1034 channel, inside the same blob `result_hash` commits to. So the
 * chain proves *what was owed for this call* and Tempo proves *that the channel paid it*. This
 * joins the two, in three checks that get progressively more expensive:
 *
 * 1. The record itself — the rail, the chain id, and the payer against `expectedPayer` when one
 *    was given. Nothing beyond the chain read.
 * 2. The chain against itself — who paid, and that the cumulatives on one channel never go
 *    backwards. Vouchers sharing a **channel id** must name one payer: a channel has one signer,
 *    so two payers on one channel is an edited record. *Across* channels a chain may change payer
 *    **once**, and only to the payer of the record being verified (`expectedPayer` when one was
 *    given): that is the move from the agent's own derived Tempo address, which older records
 *    name, to the operator's treasury. Never back, and never to a third address. A chain written
 *    entirely under either payer has one payer and passes. A chain that disagrees with itself is
 *    `failed` before any Tempo call is made, which is why that case needs no reader.
 * 3. Tempo — the receipt of the settlement the chain named, or, when nothing has settled yet,
 *    what the channel still holds.
 *
 * A closed channel reads as zeros, so `verified` comes from the close *receipt* and never
 * from the channel's state: status 1, sent to the escrow, and a `ChannelClosed` log whose channel
 * id and payer match the record and whose `finalAmount` covers this call's cumulative.
 *
 * `seq` may name either a per-event record or a step an epoch batched. The two are the
 * same thing to every check above — a member carries the same kind, reference and `payload_hash`
 * a record would have — so a member is resolved out of its epoch blob and then verified by the
 * identical path, and the report says which epoch it came out of. That is also what puts epoch
 * members into check 2: without it, a console chain whose only vouchers are epoch members would
 * have an empty cross-seq check, because `listEvents` sees none of them.
 */
export async function verifyInference(
  chain: InferenceChain,
  agentId: Uint8Array,
  seq: bigint | number | string,
  opts: VerifyInferenceOptions = {}
): Promise<InferenceReport> {
  const want = BigInt(seq);
  opts = { ...opts, reader: memoOpened(opts.reader) };
  const report: InferenceReport = { agentId: hex(agentId), seq: want.toString(), verdict: "failed" };
  const fail = (reason: string): InferenceReport => ({ ...report, verdict: "failed", reason });
  // "Nothing said so yet", which is the honest answer both for an open channel and for a reader
  // that could not be reached — the CLI gives both exit 4, the audit's code for *unchecked*.
  const unchecked = (reason: string): InferenceReport => ({ ...report, verdict: "pending", reason });
  const noPreimage = (reason: string): InferenceReport => ({ ...report, verdict: "no-preimage", reason });

  let walked: WalkedChain;
  try {
    walked = await walkChain(chain, agentId, opts.epochs);
  } catch (e) {
    return unchecked(`the chain could not be read: ${(e as any)?.message ?? String(e)}`);
  }
  const records = walked.records;
  const { epochs, memberships } = walked;

  const target = records.find((r) => r.seq === want);
  const membership = memberships.get(want.toString());
  if (membership) {
    report.epoch = {
      startSeq: membership.epoch.startSeq.toString(),
      endSeq: membership.epoch.endSeq.toString(),
      member: membership.index,
    };
  }
  /** How this seq is named in a message: a member says which epoch it was resolved through. */
  const at = report.epoch
    ? `seq ${want} (epoch ${report.epoch.startSeq}–${report.epoch.endSeq}, member ${report.epoch.member})`
    : `seq ${want}`;
  if (!target) {
    const covering = epochs.find((e) => want >= e.startSeq && want < e.endSeq);
    if (covering) {
      // The chain does account for this seq — an epoch covers it — and the step lives in the
      // blob that root names. Nothing disagrees with anything here; the bytes are out of reach,
      // which is the same answer a missing trace preimage gets.
      const span = `the epoch ${covering.startSeq}–${covering.endSeq}`;
      return noPreimage(
        opts.epochs
          ? `seq ${want} is a step of ${span}, whose blob ${hex(covering.epochRoot)} is not available here`
          : `seq ${want} is a step of ${span}; pass an epoch store (--epochs, or --gateway) to read its steps`
      );
    }
    return fail(`agent ${report.agentId} has no record at seq ${want}`);
  }
  if (target.kind !== EventKind.Action) {
    return fail(`${at} is kind ${target.kind}, and only an Action carries a voucher`);
  }

  for (const rec of records) if (rec.seq <= want) await openSessionAt(opts.store, rec);
  let read: Awaited<ReturnType<typeof voucherAt>>;
  try {
    read = await voucherAt(opts.store, target);
  } catch (e) {
    return noPreimage(`the blobs seq ${want} commits to could not be read: ${(e as any)?.message ?? String(e)}`);
  }
  if (read && "notLlm" in read) {
    // A voucher-shaped object in a result nobody's transport wrote — a report the sandboxed model
    // stored, a tool's answer — is not a payment, and nothing here is about one.
    return noPreimage(
      `${at} is not a paid call: its result carries a payment object, and its tool id is not the llm.<model> ` +
        "the call names, so the object is the tool's output rather than a voucher"
    );
  }
  const mine: { payment: TempoPaymentRecord; blobHash: Uint8Array } | null = read && "payment" in read ? read : null;
  if (!mine) {
    if (await encryptedAt(opts.store, target.payloadHash)) {
      return {
        ...report,
        verdict: "encrypted",
        reason: `the blobs seq ${want} commits to are encrypted by their owner; pass --trace-key <hex|path> to read them`,
      };
    }
    // Either the bytes are gone or the record never carried a voucher, and from outside the store
    // those look alike: both leave nothing to check, which is what `no-preimage` says.
    return noPreimage(
      `no readable tempo voucher in the blob seq ${want} commits to (a vault-rail record carries none)`
    );
  }
  const { payment, blobHash } = mine;
  report.blobHash = hex(blobHash);
  // Said, not judged: whether the owner was debited is the Solana transaction's, which
  // `verify-channel --refetch` reads; here it is what the record claims about whose voucher it was.
  if (await paidByLathAt(opts.store, blobHash)) report.paidBy = "lath";
  report.payer = payment.payer;
  report.channelId = payment.channelId;
  report.cumulativeBefore = payment.cumulativeBefore;
  report.cumulativeAfter = payment.cumulativeAfter;

  if (payment.chainId !== TEMPO_CHAIN_ID) {
    return fail(`the record names chain ${payment.chainId}, and this verifier speaks only for ${TEMPO_CHAIN_ID}`);
  }
  if (opts.expectedPayer && !sameHex(opts.expectedPayer, payment.payer)) {
    return fail(`the record was paid by ${payment.payer}, not by ${opts.expectedPayer}`);
  }
  const owed = BigInt(payment.cumulativeAfter);
  if (owed < BigInt(payment.cumulativeBefore)) {
    return fail(`seq ${want} has a cumulative that goes backwards inside one call`);
  }

  // 2. The chain against itself: every voucher below this one the store can still produce. A blob
  //    that is gone cannot be checked, and a chain is not failed for bytes nobody kept.
  let previous: { seq: bigint; payment: TempoPaymentRecord } | null = null;
  /** The payer of the last voucher walked, and how many times the chain has changed payer. */
  let payerSoFar: { seq: bigint; payer: string } | null = null;
  let switched = false;
  /** The payer a chain is allowed to switch *to*: the one this record names, which is what the
   * caller asserted when it passed `--payer`. Everything before it may be one other address. */
  const destination = opts.expectedPayer ?? payment.payer;
  const channelPayers = new Map<string, { seq: bigint; payer: string }>();
  /** This call's channel as (b) reads it: the signers its vouchers up to this seq name. */
  const onThisChannel: ChannelSigners = { channelId: payment.channelId, signers: [], vouchers: 0 };
  for (const rec of records) {
    if (rec.seq > want) break;
    let found: { payment: TempoPaymentRecord; blobHash: Uint8Array } | null = null;
    try {
      found = rec.seq === want ? mine : await paymentOf(opts.store, rec);
    } catch {
      continue;
    }
    if (!found) continue;
    const seen = found.payment;

    // A channel has one signer. Two payers on one channel id is an edited record, whichever
    // payer the chain was written under.
    const onChannel = [...channelPayers.entries()].find(([id]) => sameHex(id, seen.channelId));
    if (onChannel && !sameHex(onChannel[1].payer, seen.payer)) {
      return fail(
        `seq ${rec.seq} and seq ${onChannel[1].seq} share channel ${seen.channelId} but name different payers ` +
          `(${seen.payer} and ${onChannel[1].payer}) — one channel has one payer`
      );
    }
    if (!onChannel) channelPayers.set(seen.channelId, { seq: rec.seq, payer: seen.payer });

    // Across channels: at most one change, and only ever to the payer this verdict is about.
    if (payerSoFar && !sameHex(payerSoFar.payer, seen.payer)) {
      if (switched) {
        return fail(
          `this chain changes payer more than once: seq ${rec.seq} is paid by ${seen.payer} after ` +
            `${payerSoFar.payer} at seq ${payerSoFar.seq} — a chain may move to the operator's pool once, never back`
        );
      }
      if (!sameHex(seen.payer, destination)) {
        return fail(
          `seq ${rec.seq} on the same chain was paid by ${seen.payer}, not by ${destination} — ` +
            `a chain may change payer once, and only to the payer this record names`
        );
      }
      switched = true;
    }
    payerSoFar = { seq: rec.seq, payer: seen.payer };

    if (rec.seq < want && sameHex(seen.channelId, payment.channelId)) previous = { seq: rec.seq, payment: seen };
    if (sameHex(seen.channelId, payment.channelId)) {
      onThisChannel.vouchers++;
      if (seen.signer) onThisChannel.signers.push({ seq: rec.seq, signer: seen.signer });
      onThisChannel.openBlock = lowerBlock(onThisChannel.openBlock, decimal(seen.openBlock) ?? undefined);
    }
  }
  if (previous && BigInt(payment.cumulativeBefore) < BigInt(previous.payment.cumulativeAfter)) {
    return fail(
      `seq ${want} opens at ${payment.cumulativeBefore} on channel ${payment.channelId}, below the ` +
        `${previous.payment.cumulativeAfter} seq ${previous.seq} had already committed to — a voucher total never goes down`
    );
  }

  // The policy this call ran under is the one the nearest Genesis before this seq names: a loop
  // step's session opens with it, and a chat session's opens with its own.
  const genesis = [...records].reverse().find((r) => r.seq < want && r.kind === EventKind.Genesis);

  // 2a. The model: the call asked for the policy's model or the fallback it
  //     commits, and for nothing else. A call served by a model the Genesis never allowed is a record
  //     the policy does not cover, so it fails here, before any Tempo read. Unreadable blobs or no
  //     readable policy leave the line out: the call is not checked, which is not the same as wrong.
  const models = genesis ? await committedModelsAt(opts.store, genesis, new Map()) : undefined;
  const called = await chatModelsAt(opts.store, target).catch(() => null);
  if (called) {
    report.model = called.asked;
    if (called.served) report.servedBy = called.served;
    const problem = models ? modelProblem(called.asked, models) : null;
    if (problem) return fail(`${at} ${problem}`);
  }

  // 2b. The loop key, only when the session's Genesis policy commits one. A chat session's
  //     policy commits no key and so adds nothing here.
  const committed = genesis ? await policyKeyAt(opts.store, genesis, new Map()) : undefined;
  if (committed) {
    const a = await authorizeVerdict(committed, opts.expectedPayer ?? payment.payer, opts.reader);
    const b = await signerVerdict(onThisChannel, committed, opts.reader);
    report.key = worstKey(
      [
        { ...a, detail: `(a) ${a.detail}` },
        { ...b, detail: `(b) ${b.detail}` },
      ],
      committed.address
    );
    if (report.key.status === "failed") return fail(report.key.detail);
  } else if (opts.requireKey) {
    report.key = { status: "unchecked", detail: committed === null ? NO_TEMPO_KEY : TEMPO_KEY_POLICY_UNREAD };
  }

  // 3. Tempo. The settlement that covers this call is the Resolution of its own session, or the
  //    `loop.settlement` Action of its loop. A Resolution can settle only the session it closes: a
  //    one-shot session's close can fail and leave its Resolution with no settlement (`runtime.ts`
  //    `closeTempo`), and the next session's Resolution then names *its* channel — so taking "the
  //    first settlement after this seq" would judge an honest call by another channel's receipt and
  //    fail it. Resolutions are therefore read only until this call's session is over — at its own
  //    Resolution, or at the next Genesis when it never resolved — and after that only a
  //    `loop.settlement` counts, which is what settles a loop step's calls many Resolutions later. A
  //    Resolution that names its `channelId` (older ones do not) and names another channel is
  //    skipped as a loop settlement's is.
  const settlementTool = hex(idFromString(LOOP_SETTLEMENT_TOOL));
  const stepTool = hex(idFromString(LOOP_STEP_TOOL));
  let settlement: TempoSettlementRecord | null = null;
  let sessionOver = false;
  for (const rec of records) {
    if (rec.seq <= want) continue;
    await openSessionAt(opts.store, rec);
    if (rec.kind === EventKind.Genesis) {
      sessionOver = true;
      continue;
    }
    const isLoopSettlement = rec.kind === EventKind.Action && hex(rec.reference) === settlementTool;
    const isResolution = rec.kind === EventKind.Resolution;
    if (!isLoopSettlement && !isResolution) continue;
    if (isResolution) {
      if (sessionOver) continue;
      sessionOver = true;
    }
    let blob: Uint8Array | null = null;
    try {
      const leaf = await payloadLeaf(opts.store, rec, isResolution ? 0 : 1);
      blob = leaf ? await blobAt(opts.store, leaf) : null;
    } catch {
      blob = null;
    }
    if (!blob) {
      // A Resolution whose blob is missing may not have been a settlement at all; a
      // `loop.settlement` record is one by its tool id, and reading past it would judge this
      // voucher by a later channel's receipt.
      // A silent or unreadable Resolution of this call's own session is `silentSessionEnd`'s, below.
      if (isLoopSettlement) {
        return noPreimage(`the settlement record at seq ${rec.seq} commits bytes this store does not hold`);
      }
      continue;
    }
    const found = settlementFromBlob(blob);
    if (!found?.txHash) continue;
    // A loop can open a second channel after a close, so a settlement naming another channel is
    // not this call's: keep walking rather than judge this voucher by it.
    if (found.channelId && !sameHex(found.channelId, payment.channelId)) continue;
    settlement = found;
    break;
  }
  if (settlement?.txHash) report.txHash = settlement.txHash;

  if (!opts.reader) {
    return unchecked(
      settlement?.txHash
        ? `the chain names settlement ${settlement.txHash}; pass a Tempo RPC to read it`
        : "no settlement record covers this seq, and no Tempo RPC was given to read the channel"
    );
  }

  if (settlement?.txHash) {
    let receipt: TempoCloseReceipt | null;
    try {
      receipt = await opts.reader.closeReceipt(settlement.txHash, payment.channelId);
    } catch (e) {
      return unchecked(`${settlement.txHash} could not be read on Tempo: ${(e as any)?.message ?? String(e)}`);
    }
    if (!receipt) return unchecked(`the Tempo node does not have ${settlement.txHash} yet`);
    const payee = closedLogFor(receipt, payment.channelId)?.payee;
    if (payee) report.payee = payee;
    const problem = closeProblem(
      receipt,
      settlement.txHash,
      payment.channelId,
      payment.payer,
      opts.expectedPayee ? { address: opts.expectedPayee, whose: "the gateway --payee names" } : undefined
    );
    if (problem) return fail(problem);
    const closed = closedLogFor(receipt, payment.channelId)!;
    report.settled = closed.finalAmount.toString();
    if (closed.finalAmount < owed) {
      return fail(
        `the channel paid out ${closed.finalAmount} base units, below the ${owed} this call's voucher committed to`
      );
    }
    // In what: the close names an amount and a payee, and only the open names the token.
    report.token = await channelTokenVerdict(opts.reader, payment.channelId, onThisChannel.openBlock);
    if (report.token.status === "failed") return fail(report.token.detail);
    // A key the policy commits whose (a) or (b) did not run is a check nobody made, so VERIFIED —
    // exit 0 — would say this call's cap was held to Tempo when it was not: `pending`, as
    // `verifyChannels` holds the same gap. `--key`'s placeholder on a policy that commits no key is not
    // one; there was nothing to check.
    if (committed && report.key?.status === "unchecked") {
      return unchecked(`this call settled, and the loop's Tempo key is unchecked: ${report.key.detail}`);
    }
    return { ...report, verdict: "verified" };
  }

  // Nothing settled yet: the channel itself is the evidence, and only while it is open.
  let state: TempoChannelState | null;
  try {
    state = await opts.reader.channelState(payment.channelId);
  } catch (e) {
    return unchecked(`channel ${payment.channelId} could not be read: ${(e as any)?.message ?? String(e)}`);
  }
  if (!state || state.deposit === BigInt(0)) {
    // Zeros are what a *closed* channel reads as, so this is a channel settled by a transaction no
    // record on this chain names. With no Resolution of this call's session on the chain — or with
    // a loop step's, which never names one — that is a settlement record that never landed, and
    // failed. With a one-shot session's, the chain itself says what happened: the session resolved
    // and its close had not landed, and whatever closed the channel since — the operator's retry,
    // by hand — wrote no record. The chain is silent about the payment rather than contradicted by
    // it, which is *unchecked*, exit 4; and when that Resolution's bytes are not here, whether it
    // named a settlement is unknown. The rule is `silentSessionEnd`'s, shared with `verify-channel`.
    const end = await silentSessionEnd(opts.store, records, want, stepTool);
    if (end) {
      const said = silentCloseVerdict(payment.channelId, end, "this call's session");
      return said.verdict === "no-preimage" ? noPreimage(said.reason) : unchecked(said.reason);
    }
    return fail(`channel ${payment.channelId} holds nothing and no settlement record names it`);
  }
  report.settled = state.deposit.toString();
  if (state.deposit < owed) {
    return fail(`channel ${payment.channelId} holds ${state.deposit} base units, below the ${owed} this call owes`);
  }
  return {
    ...report,
    verdict: "pending",
    reason: `channel ${payment.channelId} is open and holds ${state.deposit} base units; it has not settled yet`,
  };
}

/** The human-readable rendering of an inference verdict, as lines. `cli.ts` prints them. */
export function formatInference(r: InferenceReport): string[] {
  const epoch = r.epoch ? ` (epoch ${r.epoch.startSeq}–${r.epoch.endSeq}, member ${r.epoch.member})` : "";
  const out = [`agent      ${r.agentId}`, `seq        ${r.seq}${epoch}`];
  if (r.blobHash) out.push(`blob       ${r.blobHash}`);
  if (r.model)
    out.push(`model      ${r.model}${r.servedBy && r.servedBy !== r.model ? ` (served by ${r.servedBy})` : ""}`);
  if (r.payer) out.push(`payer      ${r.payer}`);
  if (r.paidBy === "lath") out.push("paid by    Lath: the call got no answer, and the owner is owed no debit for it");
  if (r.channelId) out.push(`channel    ${r.channelId}`);
  if (r.cumulativeBefore && r.cumulativeAfter) {
    const delta = BigInt(r.cumulativeAfter) - BigInt(r.cumulativeBefore);
    out.push(`voucher    ${r.cumulativeBefore} → ${r.cumulativeAfter} (${delta} USDC.e base units for this call)`);
  }
  if (r.settled !== undefined) {
    // A pending call with a close tx settled; it is pending on its key, not still on deposit.
    out.push(`settled    ${r.settled}${r.verdict === "pending" && !r.txHash ? " (still on deposit)" : ""}`);
  }
  if (r.txHash) out.push(`tx         ${r.txHash}`);
  if (r.payee) out.push(`payee      ${r.payee}`);
  if (r.token) out.push(`token      ${r.token.status}: ${r.token.detail}`);
  if (r.key)
    out.push(
      r.key.address ? `key        ${r.key.address} ${r.key.status}: ${r.key.detail}` : `key        ${r.key.detail}`
    );
  if (r.reason) out.push(`  ${r.reason}`);
  // `no-preimage` is not a disagreement — nothing was read, so nothing failed — and the last line
  // is what a person copies into a report, so it says so the way the audit's own unreached head does.
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
 * `0` the payment verifies, `4` nothing is settled yet or nothing could be read, `2` there is
 * nothing to check — the same codes and the same meanings as the audit's: 4 is *unchecked*, 2 is
 * *the bytes are missing*.
 */
export function inferenceExitCode(r: InferenceReport): number {
  if (r.verdict === "verified") return 0;
  if (r.verdict === "pending") return 4;
  return 2;
}
