"use client";

import { createContext, useContext } from "react";
import { decodeDecisionBlob, decodeGoalCheckBlob } from "@lath/sdk/browser";
import { Badge, Copyable, EXTERNAL_LINK_CLASS, ExternalIcon, Facts, Info } from "@/components/ui";
import { OpenRouterMark, TempoLink, TempoMark } from "@/components/Tempo";
import { VERIFY_TERMS_COPY } from "@/components/loop-terms";
import { truncate } from "@/lib/format";
import { CommandBox } from "@/components/VerifyPanel";
import { TraceReaders, useTracePart } from "@/lib/traces";
import {
  CUSTODY_LINE,
  PAYER_LABEL,
  type SettlementCarrier,
  TEMPO_ESCROW_ADDRESS,
  TempoPaymentView,
  TempoSettlementView,
  VERDICT_LABEL,
  closeCoversCumulative,
  formatBaseUnits,
  gatewayPrice,
  isTreasuryPayer,
  payerKind,
  tempoBlockUrl,
  useChainSettlement,
  useTempoAgent,
  useTempoCloseDetails,
  useTempoReceipt,
  useTempoTreasury,
  verdictFor,
} from "@/lib/tempo";
import { tempoVerifyCommand } from "@/lib/verify";

/**
 * The `tempo` rail, for one Action — what the record says about the payment that bought this
 * completion, and how to check it somewhere that is not this page.
 *
 * The trace rendering an Action already has lives inside `EventTimeline.tsx` (its own private
 * `TracePanel`), so this file is the block rather than a second panel, and the timeline mounts it
 * under the payload preimage. What it shows comes out of the same bytes the browser has already
 * re-hashed: the result blob is the completion body with `payment` merged into it, so nothing here
 * is a claim of the console's.
 *
 * Two prices, two names, never one total: **this call's payment** is the voucher delta — what
 * actually left the payer's account, USDC.e — and **model cost** is the gateway's `usage.cost` in
 * USD when the body carried one. The gateway prices a request flat, so the two are different prices
 * of different things and reconciling them would be a fiction. The payment's testid is
 * `tempo-gateway-price`, the name the specs read.
 *
 * The payer is read out of the blob and named against the treasury this console is configured
 * with: the treasury on a record written under the pool, the agent's own derived address on an
 * older record written without it. The same comparison decides whether the audit line
 * carries `--payer` — a chain that switched has to tell the verifier the address it switched to,
 * and a chain that never did needs no flag because the verifier re-derives that address itself.
 */
export function paymentFromBlob(bytes: Uint8Array | undefined): TempoPaymentView | null {
  if (!bytes) return null;
  try {
    const payment = JSON.parse(new TextDecoder().decode(bytes))?.payment;
    return payment?.rail === "tempo" && payment.channelId ? (payment as TempoPaymentView) : null;
  } catch {
    return null;
  }
}

/**
 * The error of a paid call whose answer never arrived, or `null` for a completion.
 *
 * A call the gateway billed but whose body was cut, errored mid-stream or was aborted after its
 * voucher was signed is recorded as a failed `llm.*` Action whose result blob is
 * `{ error, payment }` rather than a completion (`runtime/src/transport/mpp.ts`
 * `PaidCallFailed`): there are no `choices`, only the reason and the voucher that paid for it.
 * `paymentFromBlob` reads that blob's `payment` unchanged; this is what lets a row say the call
 * failed instead of presenting a paid failure as an ordinary completion.
 */
export function paidCallErrorFromBlob(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || !body.payment) return null;
    // A completion carries `choices`; the failed-call shape is the one with an `error` and none.
    if (Array.isArray(body.choices)) return null;
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
    return null;
  } catch {
    return null;
  }
}

/**
 * Where a channel id lives. It is a `bytes32` key inside the escrow precompile, not an address, so
 * the explorer has no page for it; the escrow's page is where its `ChannelOpened` and
 * `ChannelClosed` events are, and those carry the id as their first indexed topic.
 */
export function EscrowLink() {
  // A `TempoLink`, so the escrow reads like every other Tempo object; what it is goes in the link's
  // popover rather than a `title`, where touch and keyboard can reach it.
  return (
    <TempoLink
      kind="address"
      value={TEMPO_ESCROW_ADDRESS}
      label="in escrow"
      testId="tempo-escrow-link"
      details={
        <p className="text-2xs leading-relaxed text-ink-3">
          The payment channel&apos;s id is a bytes32 inside Tempo&apos;s escrow contract, not an address of its own; the
          escrow&apos;s ChannelOpened and ChannelClosed events carry it. Funds are locked in the escrow while the
          channel is open; closing it pays OpenRouter and refunds the rest.
        </p>
      }
    />
  );
}

/** The block a channel was opened in, when the payment recorded it; `null` for every older row. */
function openBlockOf(payment: object | null | undefined): string | null {
  const v = (payment as { openBlock?: unknown } | null | undefined)?.openBlock;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * A payment channel, everywhere one is named: its id short (it has no explorer page, so it is a
 * copyable value and not a link), the escrow it lives in as a `TempoLink`, and the block it was
 * opened in when the payment recorded one (`openBlock`, which older rows do not carry). The close
 * transaction is the settlement's, and the settlement line beside it links that.
 */
export function ChannelRef({
  channelId,
  openBlock,
  testId,
}: {
  channelId: string;
  openBlock?: string | null;
  testId?: string;
}) {
  const blockUrl = tempoBlockUrl(openBlock ?? null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <Copyable value={channelId} display={truncate(channelId, 10, 8)} />
      <EscrowLink />
      {blockUrl && (
        <a
          href={blockUrl}
          target="_blank"
          rel="noreferrer"
          className={EXTERNAL_LINK_CLASS}
          data-testid="tempo-channel-open-block"
          aria-label={`Block ${openBlock} on the Tempo explorer, where this channel was opened`}
        >
          <TempoMark />
          opened in block {openBlock}
          <ExternalIcon />
        </a>
      )}
    </span>
  );
}

/**
 * What a settlement paid, checked in this browser: the close receipt's `ChannelClosed` for
 * this channel, decoded here, shown only while `useTempoCloseDetails` says the receipt is this
 * channel's close (`ok === true`). Until then — not mined, not this channel, a reverted close — it
 * says nothing, because a figure read off a log nobody has matched to this channel is not a payment
 * anyone has checked. `cumulativeAfter`, when the caller holds this call's voucher, adds whether the
 * close covered it.
 */
export function CloseReceived({
  txHash,
  channelId,
  payer,
  cumulativeAfter,
}: {
  txHash: string | null | undefined;
  channelId: string | null | undefined;
  payer?: string | null;
  cumulativeAfter?: string | null;
}) {
  const close = useTempoCloseDetails(txHash, channelId, payer);
  const details = close.data?.ok === true ? close.data.details : null;
  if (!details) return null;
  const covers = cumulativeAfter ? closeCoversCumulative(details, cumulativeAfter) : null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-ink-3"
      data-testid="tempo-close-received"
    >
      <OpenRouterMark />
      <span>
        OpenRouter received <span className="num text-ink-1">{formatBaseUnits(details.finalAmountBase)}</span> USDC.e
      </span>
      <span>· checked against Tempo in this browser</span>
      <span className="inline-flex items-center gap-1">
        · payee <TempoLink kind="address" value={details.payee} testId="tempo-close-payee" />
      </span>
      <Info label="What the close paid" wide>
        <Facts
          items={[
            {
              label: "paid to the payee",
              value: `${formatBaseUnits(details.finalAmountBase)} USDC.e`,
              source: "tempo",
            },
            { label: "refunded to the payer", value: `${formatBaseUnits(details.refundBase)} USDC.e`, source: "tempo" },
            ...(covers === null
              ? []
              : [
                  {
                    label: "covers this call's payment",
                    value: covers ? "yes" : "no",
                    source: "tempo" as const,
                  },
                ]),
          ]}
        />
        <p className="text-2xs leading-relaxed text-ink-3">
          Decoded in this browser from the escrow&apos;s ChannelClosed log on the close receipt, read from Tempo&apos;s
          public RPC: the payee, the final amount and the refund, for this channel and this payer.
        </p>
      </Info>
    </div>
  );
}

/** The voucher terms behind _this call's payment_, folded into an `Info`. */
export function PaymentTermsInfo({
  payment,
}: {
  payment?: Pick<TempoPaymentView, "cumulativeBefore" | "cumulativeAfter">;
}) {
  return (
    <Info label="What this call's payment is">
      <p className="text-2xs leading-relaxed text-ink-3">
        A signed voucher on the payment channel; the delta between it and the one before is the price. It is paid to
        OpenRouter&apos;s Tempo gateway with Tempo&apos;s Machine Payments Protocol, in USDC.e with 6 decimals.
      </p>
      {payment && (
        <Facts
          items={[
            { label: "voucher before", value: formatBaseUnits(payment.cumulativeBefore), mono: true },
            { label: "voucher after", value: formatBaseUnits(payment.cumulativeAfter), mono: true },
          ]}
        />
      )}
    </Info>
  );
}

/**
 * The chain's settlement carriers, for a payment block that is not handed its settlement: the
 * timeline provides them once, and every `llm.*` block under it finds its own channel's close
 * (`useChainSettlement`). Absent, a block is only ever as settled as its `settlement` prop says.
 */
export const SettlementCarriersContext = createContext<{
  store: TraceReaders | null;
  carriers: readonly SettlementCarrier[];
} | null>(null);

export function TempoPaymentBlock({
  agentId,
  seq,
  payment,
  settlement,
  failed,
}: {
  agentId: string;
  seq: string;
  payment: TempoPaymentView;
  /** The session's or the loop's close, when this page has read it. Absent while it is running. */
  settlement?: TempoSettlementView | null;
  /** Set when this call was paid and its answer never arrived: the blob's `error`. */
  failed?: string | null;
}) {
  // One public JSON-RPC read, and only when a settlement names a transaction. Everything else the
  // badge needs is already in the blobs. The close is held against *this payment's* channel and
  // payer: a settlement that closed some other channel says nothing about this call.
  const receipt = useTempoReceipt(settlement?.txHash ?? null, payment.channelId, payment.payer);
  const verdict = verdictFor(settlement, receipt.data ? receipt.data.ok : undefined);
  const badge = VERDICT_LABEL[verdict];

  const treasury = useTempoTreasury();
  const row = useTempoAgent(agentId);
  const treasuryAddress = treasury.data?.enabled ? treasury.data.address : undefined;
  const kind = payerKind(payment.payer, treasuryAddress, row.data?.tempoAddress);
  // Only a record the treasury paid needs the flag; without a configured treasury there is nothing
  // to pass and the line stays what it was.
  const command = tempoVerifyCommand(
    agentId,
    seq,
    undefined,
    undefined,
    isTreasuryPayer(payment.payer, treasuryAddress) ? treasuryAddress : null
  );

  return (
    <div className="space-y-2 rounded-lg border border-line/[0.06] bg-line/[0.02] p-3" data-testid="tempo-payment">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow inline-flex items-center gap-1.5" data-testid="tempo-payment-title">
          <OpenRouterMark /> Paid to OpenRouter via <TempoMark /> Tempo
          {/* The two-prices paragraph is the block's explanation, so it sits behind its title rather
              than on screen under every block. */}
          <Info label="About this payment" wide>
            <p className="text-2xs leading-relaxed text-ink-3">
              This call&apos;s payment is what left the payer&apos;s account for this call, signed as a voucher against
              the payment channel above; the model cost is what OpenRouter said the tokens were worth. They are two
              prices of two things and neither is derived from the other. {CUSTODY_LINE}
            </p>
            <p className="text-2xs leading-relaxed text-ink-3">
              Each call is paid to OpenRouter&apos;s Tempo gateway with Tempo&apos;s Machine Payments Protocol.
            </p>
          </Info>
        </span>
        <Badge tone={badge.tone} dot={verdict === "verified"} title={receipt.data?.problem ?? undefined}>
          {badge.text}
        </Badge>
      </div>

      {failed && (
        <p className="text-2xs leading-relaxed text-amber-300/80" data-testid="tempo-paid-call-failed">
          This call was paid and its answer never arrived: {failed}. The voucher below is what the gateway was paid; the
          record carries it so the channel&apos;s vouchers stay contiguous.
        </p>
      )}

      <dl className="grid gap-x-4 gap-y-1.5 text-xs text-ink-2 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="w-32 flex-none text-ink-3">payment channel</dt>
          <dd>
            <ChannelRef channelId={payment.channelId} openBlock={openBlockOf(payment)} testId="tempo-channel" />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 flex-none text-ink-3">payer</dt>
          {/* A `TempoLink`, so the payer opens on the explorer like every other Tempo address on
              this page. */}
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="tempo-payer" data-payer-kind={kind}>
            <TempoLink kind="address" value={payment.payer} />
            {PAYER_LABEL[kind] && <span className="text-2xs text-ink-3">{PAYER_LABEL[kind]}</span>}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="flex w-32 flex-none items-center gap-1 text-ink-3">
            this call&apos;s payment <PaymentTermsInfo payment={payment} />
          </dt>
          <dd className="num text-ink-1" data-testid="tempo-gateway-price">
            {formatBaseUnits(gatewayPrice(payment))} <span className="text-ink-3">USDC.e</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 flex-none text-ink-3">model cost</dt>
          <dd className="num text-ink-1" data-testid="tempo-model-cost">
            {/* Absent when the gateway said nothing about it, which is not the same as free. */}
            {typeof payment.usageCost === "number" ? (
              <>
                ${payment.usageCost.toFixed(6)} <span className="text-ink-3">USD</span>
              </>
            ) : (
              <span className="text-ink-3">not reported by the gateway</span>
            )}
          </dd>
        </div>
      </dl>

      {settlement?.txHash && (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-ink-3">
            settled on Tempo in <TempoLink kind="tx" value={settlement.txHash} testId="tempo-settlement-link" />
            {settlement.spent ? <span>· {formatBaseUnits(settlement.spent)} USDC.e paid out</span> : null}
          </p>
          {/* The same receipt the badge reads, decoded further, for this call's channel. */}
          <CloseReceived
            txHash={settlement.txHash}
            channelId={payment.channelId}
            payer={payment.payer}
            cumulativeAfter={payment.cumulativeAfter}
          />
        </div>
      )}
      {!settlement && (
        // Not an error: vouchers are signed per call, and the channel settles once, when its
        // session or loop ends. Until this page has read that close the call is PENDING.
        <p className="text-2xs text-ink-3" data-testid="tempo-settlement-pending">
          The payment channel is not closed yet, or its close is not readable on this page: it settles on Tempo once,
          when its session or loop ends, and the settlement transaction is linked here then.
        </p>
      )}
      {settlement?.closed === false && (
        <p className="text-2xs text-amber-300/80">
          The payment channel was not closed: {settlement.error ?? "the close did not land"}. The calls were paid for;
          the deposit is settled by a retry.
        </p>
      )}

      <CommandBox command={command} testId="tempo-verify-command" />
    </div>
  );
}

/**
 * The same block for a record whose result blob has not been fetched yet: resolves it through the
 * reader the timeline is already holding, and renders nothing when the Action carries no payment
 * — which is every Action on the vault rail and every older Action that carries none.
 */
/**
 * The decision blob behind one step's verdict, opened exactly the way an inference blob is: the
 * `verifyHash` the step's manifest committed is asked of the trace readers, the bytes that come
 * back are re-hashed against it by `useTracePart`, and only then are they decoded. So nothing
 * here is the console's word for what the second model said — it is the bytes the ninth manifest
 * key commits to, or it is nothing.
 *
 * What it shows is the three things a reader cannot get from the chip: **which build** answered
 * (the dated one the gateway resolved, not the pinned slug the policy names), **both
 * answers with their confidences**, and **what the decision cost**, on the loop's own channel.
 * The last is why the voucher is here at all: a verdict paid for out of a different channel than
 * the loop's is the one way this could be somebody else's answer, and `verify-step` checks it.
 */
export function VerifyDecisionBlock({
  store,
  hash,
  genesis,
}: {
  store: TraceReaders | null;
  /** `verifyHash` from the step's manifest — the trace panel's whole input. */
  hash: string;
  /** The step's session genesis, so the bundle is opened before the blob is asked for by hash. */
  genesis?: Uint8Array;
}) {
  const part = useTracePart(store, hash, true, genesis);
  const status = part.data?.status;
  // A goal-only blob (the manifest's fourteenth key) carries no `verdict`, so
  // the verdict decoder refuses it; the goal decoder reads it, and the answers render the same way.
  const blob =
    part.data?.status === "ok" ? decodeDecisionBlob(part.data.bytes!) ?? decodeGoalCheckBlob(part.data.bytes!) : null;

  if (part.isLoading) return <p className="text-2xs text-ink-3">Opening the decision blob…</p>;
  if (!blob) {
    // Each of these means something different and none of them is a verdict changing: the chain
    // holds the hash either way, and what is missing is the bytes behind it. A blob written encrypted
    // gets no reason at all: only the commitment, which is the part a reader can check.
    const why =
      status === "encrypted"
        ? null
        : status === "unconfigured"
        ? "this console has no trace gateway configured"
        : status === "ok"
        ? "the bytes served under this hash are not a decision blob"
        : "the bytes behind this hash were not served";
    return (
      <p className="text-2xs text-ink-3" data-testid="verify-decision-missing">
        {stillCommits(why, "step's manifest")} <span className="font-mono">{truncate(hash, 8, 6)}</span>.
      </p>
    );
  }

  const payment = blob.payment?.rail === "tempo" && blob.payment.channelId ? blob.payment : null;
  const answers = Object.entries(blob.answers).filter(([, a]) => !!a);

  return (
    <div className="space-y-2 rounded-lg border border-line/[0.06] bg-line/[0.02] p-3" data-testid="verify-decision">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">The second model&apos;s answer</span>
        <span className="font-mono text-2xs text-ink-2" data-testid="verify-decision-model">
          {blob.model}
        </span>
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-xs text-ink-2 sm:grid-cols-2">
        {answers.map(([question, answer]) => (
          <div key={question} className="flex gap-2">
            <dt className="w-28 flex-none text-ink-3">{question}</dt>
            <dd className="num text-ink-1" data-testid={`verify-answer-${question}`}>
              {answer!.choice ?? (typeof answer!.noul === "number" ? answer!.noul.toFixed(2) : "—")}
              {typeof answer!.confidence === "number" && (
                <span className="text-ink-3"> · confidence {answer!.confidence.toFixed(2)}</span>
              )}
            </dd>
          </div>
        ))}
        {payment && (
          <>
            <div className="flex gap-2">
              <dt className="w-28 flex-none text-ink-3">paid via Tempo</dt>
              <dd className="num text-ink-1" data-testid="verify-decision-price">
                {formatBaseUnits(gatewayPrice(payment))} <span className="text-ink-3">USDC.e</span>
              </dd>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <dt className="w-28 flex-none text-ink-3">payment channel</dt>
              <dd data-testid="verify-decision-channel">
                <ChannelRef channelId={payment.channelId} openBlock={openBlockOf(payment)} />
              </dd>
            </div>
          </>
        )}
      </dl>

      <p className="text-2xs leading-relaxed text-ink-3">{VERIFY_TERMS_COPY}</p>
    </div>
  );
}

export function TempoTraceBlock({
  agentId,
  seq,
  store,
  genesis,
  resultHash,
  settlement,
}: {
  agentId: string;
  seq: string;
  store: TraceReaders | null;
  genesis?: Uint8Array;
  resultHash?: string;
  settlement?: TempoSettlementView | null;
}) {
  const part = useTracePart(store, resultHash ?? null, !!resultHash, genesis);
  const bytes = part.data?.status === "ok" ? part.data.bytes : undefined;
  const payment = paymentFromBlob(bytes);
  // A settlement handed in wins; otherwise the chain's own close for this payment's channel, when
  // the timeline above provided the records that can carry one. Called before the early return so
  // the hooks run in the same order on every render.
  const chain = useContext(SettlementCarriersContext);
  const found = useChainSettlement(
    chain?.store ?? store,
    chain?.carriers ?? [],
    settlement === undefined && chain ? BigInt(seq) : null,
    payment?.channelId,
    genesis
  );
  if (!payment) return null;
  return (
    <TempoPaymentBlock
      agentId={agentId}
      seq={seq}
      payment={payment}
      settlement={settlement ?? found}
      failed={paidCallErrorFromBlob(bytes)}
    />
  );
}

/** The lead-in of a missing blob's line: its reason, when there is one to give, then what still commits to it. */
function stillCommits(why: string | null, by: string): string {
  return why ? `${why} — the ${by} still commits to` : `The ${by} still commits to`;
}
